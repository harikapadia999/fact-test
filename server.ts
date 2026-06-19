import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import mqtt from "mqtt";
import Database from "better-sqlite3";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

const JWT_SECRET = process.env.JWT_SECRET || "fallback_super_secret_key_123!";

app.use(express.json());
app.use(cookieParser());

// --- Database Setup (SQLite for Metadata) ---
const db = new Database("factory.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    alias TEXT,
    last_heartbeat DATETIME,
    status TEXT DEFAULT 'offline',
    lifetime_anchor_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    xray_active_since DATETIME,
    alert_offline_sent INTEGER DEFAULT 0,
    alert_safety_sent INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT,
    message TEXT,
    type TEXT, -- 'offline', 'safety', 'maintenance'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_read INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS maintenance_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT,
    technician_name TEXT,
    event_type TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT DEFAULT 'Technician'
  );

  CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    on_time DATETIME,
    off_time DATETIME,
    duration_minutes REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  INSERT OR IGNORE INTO nodes (id, alias, status) VALUES ('line_01', 'X-Ray Monitor - Line 01', 'online');
  INSERT OR IGNORE INTO config (key, value) VALUES ('telegram_chat_id', '${process.env.TELEGRAM_CHAT_ID || ""}');
  INSERT OR IGNORE INTO config (key, value) VALUES ('telegram_bot_token', '${process.env.TELEGRAM_BOT_TOKEN || ""}');
  INSERT OR IGNORE INTO config (key, value) VALUES ('watchdog_timeout_min', '6');
  INSERT OR IGNORE INTO config (key, value) VALUES ('shift_start_hour', '6');
  INSERT OR IGNORE INTO config (key, value) VALUES ('shift_end_hour', '22');
  INSERT OR IGNORE INTO config (key, value) VALUES ('safety_timeout_min', '5');
`);

const userCount = db
  .prepare("SELECT COUNT(*) as count FROM users")
  .get() as any;
if (userCount.count === 0) {
  const adminHash = bcrypt.hashSync("admin", 10);
  db.prepare(
    "INSERT INTO users (username, password, role) VALUES (?, ?, ?)"
  ).run("admin@schips.in", adminHash, "Admin");
}

try {
  db.exec("ALTER TABLE nodes ADD COLUMN alert_offline_sent INTEGER DEFAULT 0;");
} catch (e) {
  // Column might already exist
}

try {
  db.exec("ALTER TABLE nodes ADD COLUMN alert_safety_sent INTEGER DEFAULT 0;");
} catch (e) {
  // Column might already exist
}

const activeNodes = db
  .prepare(
    "SELECT id, xray_active_since FROM nodes WHERE xray_active_since IS NOT NULL"
  )
  .all();

activeNodes.forEach((n: any) => {
  console.log(
    `Recovered active session for ${n.id} since ${n.xray_active_since}`
  );
});

// --- Telegram Bot Setup ---
let bot: TelegramBot | null = null;
let currentBotToken = "";

// A simple queue to avoid hitting Telegram's rate limits (e.g., 1 message per second per chat)
const telegramQueue: Array<{
  chatId: string;
  message: string;
  retries: number;
}> = [];
let isProcessingQueue = false;

const processTelegramQueue = async () => {
  if (isProcessingQueue || telegramQueue.length === 0 || !bot) return;
  isProcessingQueue = true;

  while (telegramQueue.length > 0) {
    const task = telegramQueue[0];
    try {
      await bot.sendMessage(task.chatId, task.message);
      telegramQueue.shift(); // Success, remove from queue
      await new Promise((resolve) => setTimeout(resolve, 1500)); // Respect Telegram's 1 msg/sec limit per group
    } catch (err: any) {
      console.error(
        "Failed to send Telegram alert, retrying later:",
        err.message
      );
      task.retries += 1;
      if (task.retries > 5) {
        console.error("Max retries reached for message. Dropping.");
        telegramQueue.shift(); // Drop after 5 failed attempts
      } else {
        // Wait before retrying (exponential backoff)
        const delay = Math.pow(2, task.retries) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  isProcessingQueue = false;
};

const sendAlert = async (
  message: string,
  nodeId?: string,
  type: string = "alert"
) => {
  const chatId = db
    .prepare("SELECT value FROM config WHERE key = 'telegram_chat_id'")
    .get()?.value;
  const token = db
    .prepare("SELECT value FROM config WHERE key = 'telegram_bot_token'")
    .get()?.value;

  // Save to notifications table for frontend
  db.prepare(
    "INSERT INTO notifications (node_id, message, type) VALUES (?, ?, ?)"
  ).run(nodeId || null, message, type);

  if (token && chatId) {
    try {
      if (token !== currentBotToken) {
        bot = new TelegramBot(token, { polling: false });
        currentBotToken = token;
      }
      if (bot) {
        telegramQueue.push({
          chatId,
          message: `🚨 FACTORY ALERT: ${message}`,
          retries: 0,
        });
        processTelegramQueue(); // Fire and forget
      }
    } catch (err: any) {
      console.error("Failed to enqueue Telegram alert:", err.message);
    }
  }
};

// --- MQTT Setup ---
const mqttUrl = process.env.MQTT_BROKER_URL || "mqtt://localhost:1883";
const mqttClient = mqtt.connect(mqttUrl, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
});

mqttClient.on("connect", () => {
  console.log("Connected to MQTT Broker");
  mqttClient.subscribe("factory/southern_chips/nodes/+/heartbeat");
  mqttClient.subscribe("factory/southern_chips/nodes/+/state");
});

mqttClient.on("error", (err) => {
  if (
    !err.message.includes("connack timeout") &&
    !err.message.includes("ECONNREFUSED")
  ) {
    console.error("MQTT Client Error:", err.message);
  }
});

mqttClient.on("offline", () => {
  if (!(mqttClient as any)._offlineLogged) {
    console.log(
      "⚠️  MQTT Client Offline. Note: AI Studio runs in the cloud. If your broker is on a local IP (e.g., 192.168.x.x), it cannot connect unless you expose it via ngrok or use a public broker."
    );
    (mqttClient as any)._offlineLogged = true;
  }
});

mqttClient.on("message", (topic, message) => {
  const payload = JSON.parse(message.toString());
  const nodeId = topic.split("/")[3];

  if (topic.endsWith("/heartbeat")) {
    handleHeartbeat(nodeId, payload);
  } else if (topic.endsWith("/state")) {
    handleEvent(nodeId, payload);
  }
});

const handleHeartbeat = (nodeId: string, payload: any) => {
  db.prepare(
    "UPDATE nodes SET last_heartbeat = CURRENT_TIMESTAMP, status = 'online', alert_offline_sent = 0, alert_safety_sent = 0 WHERE id = ?"
  ).run(nodeId);
};

const handleEvent = (nodeId: string, payload: any) => {
  if (payload.event_type === "xray_status") {
    if (payload.is_active) {
      db.prepare(
        "UPDATE nodes SET xray_active_since = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(nodeId);
    } else {
      const row = db
        .prepare("SELECT xray_active_since FROM nodes WHERE id = ?")
        .get(nodeId) as any;

      if (row?.xray_active_since) {
        const start = new Date(row.xray_active_since).getTime();
        const end = new Date().getTime();
        const minutes = (end - start) / 60000;

        db.prepare(
          "INSERT INTO telemetry (device_id, on_time, off_time, duration_minutes) VALUES (?, ?, ?, ?)"
        ).run(
          nodeId,
          new Date(start).toISOString(),
          new Date(end).toISOString(),
          minutes
        );

        db.prepare(
          "UPDATE nodes SET xray_active_since = NULL WHERE id = ?"
        ).run(nodeId);
      }
    }
  }
};

// --- Watchdog Service ---
setInterval(() => {
  const now = new Date();
  const currentHour = now.getHours();

  const config = Object.fromEntries(
    db
      .prepare("SELECT key, value FROM config")
      .all()
      .map((c) => [c.key, c.value])
  );

  const shiftStart = parseInt(config.shift_start_hour || "6");
  const shiftEnd = parseInt(config.shift_end_hour || "22");
  const watchdogTimeout = parseInt(config.watchdog_timeout_min || "6");
  const safetyTimeout = parseInt(config.safety_timeout_min || "5");

  // Shift-Awareness
  const isOnShift = currentHour >= shiftStart && currentHour < shiftEnd;

  // 1. Check for Offline Nodes
  const offlineNodes = db
    .prepare(
      `
    SELECT id, alias, alert_offline_sent FROM nodes 
    WHERE status = 'online' 
    AND (last_heartbeat IS NULL OR datetime(last_heartbeat, '+${watchdogTimeout} minutes') < CURRENT_TIMESTAMP)
  `
    )
    .all();

  offlineNodes.forEach((node: any) => {
    db.prepare("UPDATE nodes SET status = 'offline' WHERE id = ?").run(node.id);

    // Close out telemetry if left hanging
    const row = db
      .prepare(
        "SELECT xray_active_since, last_heartbeat FROM nodes WHERE id = ?"
      )
      .get(node.id) as any;
    if (row?.xray_active_since) {
      const activeStr = new Date(row.xray_active_since).toISOString();
      const start = new Date(activeStr).getTime();
      const end = row.last_heartbeat
        ? new Date(row.last_heartbeat).getTime()
        : new Date().getTime(); // use last heartbeat to be safe, or now

      // Only insert if start is before end
      if (end > start) {
        const minutes = (end - start) / 60000;
        db.prepare(
          "INSERT INTO telemetry (device_id, on_time, off_time, duration_minutes) VALUES (?, ?, ?, ?)"
        ).run(node.id, activeStr, new Date(end).toISOString(), minutes);
      }
      db.prepare("UPDATE nodes SET xray_active_since = NULL WHERE id = ?").run(
        node.id
      );
    }

    if (isOnShift && node.alert_offline_sent === 0) {
      sendAlert(`Device Offline: ${node.alias || node.id}`, node.id, "offline");
      db.prepare("UPDATE nodes SET alert_offline_sent = 1 WHERE id = ?").run(
        node.id
      );
    }
  });

  // 2. Check for Safety Alerts (X-Ray active too long)
  const safetyViolations = db
    .prepare(
      `
    SELECT id, alias, alert_safety_sent FROM nodes 
    WHERE xray_active_since IS NOT NULL 
    AND datetime(xray_active_since, '+${safetyTimeout} minutes') < CURRENT_TIMESTAMP
  `
    )
    .all();

  safetyViolations.forEach((node: any) => {
    if (isOnShift && node.alert_safety_sent === 0) {
      sendAlert(
        `SAFETY ALERT: X-Ray active for > ${safetyTimeout} mins on ${node.alias || node.id}`,
        node.id,
        "safety"
      );
      db.prepare("UPDATE nodes SET alert_safety_sent = 1 WHERE id = ?").run(
        node.id
      );
    }
  });
}, 60000);

// --- API Routes ---

// RBAC Middleware
const requireAuth = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  const token = req.cookies.token || req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ error: "Unauthorized: Missing token" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    (req as any).user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized: Invalid token" });
  }
};

const requireAdmin = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  requireAuth(req, res, () => {
    if (
      (req as any).user?.role !== "Admin" ||
      (req as any).user?.username?.toLowerCase() !== "admin@schips.in"
    ) {
      return res
        .status(403)
        .json({ error: "Forbidden: Admin access required" });
    }
    next();
  });
};

app.get("/api/nodes", requireAuth, (req, res) => {
  try {
    const rawNodes = db.prepare("SELECT * FROM nodes").all() as any[];
    const nodes = rawNodes.map((n) => {
      const fixDate = (d: string | null) => {
        if (!d) return d;
        if (typeof d !== "string") return new Date(d).toISOString();
        if (d.endsWith("Z")) return d;
        return d.replace(" ", "T") + "Z";
      };
      return {
        ...n,
        last_heartbeat: fixDate(n.last_heartbeat),
        lifetime_anchor_date: fixDate(n.lifetime_anchor_date),
        xray_active_since: fixDate(n.xray_active_since),
      };
    });
    res.json(nodes);
  } catch (err: any) {
    console.error("Error fetching nodes:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/nodes/:id/alias", requireAdmin, (req, res) => {
  const { alias } = req.body;
  db.prepare("UPDATE nodes SET alias = ? WHERE id = ?").run(
    alias,
    req.params.id
  );
  res.json({ success: true });
});

app.post("/api/nodes", requireAdmin, (req, res) => {
  const { id, alias } = req.body;
  if (!id) return res.status(400).json({ error: "ID is required" });

  try {
    db.prepare(
      "INSERT INTO nodes (id, alias, status, last_heartbeat, lifetime_anchor_date) VALUES (?, ?, 'offline', datetime('now'), datetime('now'))"
    ).run(id, alias || id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: "Node ID already exists" });
  }
});

app.delete("/api/nodes/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
  db.prepare("DELETE FROM maintenance_logs WHERE node_id = ?").run(id);
  db.prepare("DELETE FROM notifications WHERE node_id = ?").run(id);
  res.json({ success: true });
});

app.get("/api/nodes/:id/telemetry", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { range = "7d" } = req.query;

  try {
    const days = range === "30d" ? 30 : 7;
    const records = db
      .prepare(
        `
      SELECT 
        date(off_time, '+5 hours', '+30 minutes') as date,
        SUM(duration_minutes) / 60.0 as hours
      FROM telemetry
      WHERE device_id = ?
        AND off_time >= datetime('now', '-' || ? || ' days', '-5 hours', '-30 minutes')
      GROUP BY date(off_time, '+5 hours', '+30 minutes')
      ORDER BY date(off_time, '+5 hours', '+30 minutes') ASC
    `
      )
      .all(id, days) as any[];

    const datesMap = new Map();
    const nowIST = new Date(Date.now() + 5.5 * 3600000);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(nowIST.getTime() - i * 86400000);
      const ymd = d.toISOString().split("T")[0];
      datesMap.set(ymd, 0);
    }
    for (const row of records) {
      if (row.date) datesMap.set(row.date, row.hours);
    }

    const activeNode = db
      .prepare("SELECT xray_active_since FROM nodes WHERE id = ?")
      .get(id) as any;
    if (activeNode?.xray_active_since) {
      const activeStr = new Date(activeNode.xray_active_since).toISOString();
      const activeStart = new Date(activeStr).getTime();
      const activeDurationHours = (Date.now() - activeStart) / 3600000; // milliseconds to hours
      const todayStr = nowIST.toISOString().split("T")[0];
      if (datesMap.has(todayStr)) {
        datesMap.set(todayStr, datesMap.get(todayStr) + activeDurationHours);
      }
    }

    const result = Array.from(datesMap.entries()).map(([dateStr, hours]) => {
      const d = new Date(dateStr);
      return {
        rawDate: dateStr,
        date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        hours: Number(hours.toFixed(2)),
      };
    });

    res.json(result);
  } catch (err: any) {
    console.error("SQLite telemetry query failed:", err.message || err);
    res.status(500).json({ error: "Query failed" });
  }
});

app.get("/api/nodes/:id/telemetry/details", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { startDate, endDate } = req.query;

  if (
    !startDate ||
    !endDate ||
    typeof startDate !== "string" ||
    typeof endDate !== "string"
  ) {
    return res
      .status(400)
      .json({ error: "startDate and endDate are required" });
  }

  try {
    const records = db
      .prepare(
        `
      SELECT 
        on_time as onTime,
        off_time as offTime,
        duration_minutes as durationMinutes
      FROM telemetry
      WHERE device_id = ?
        AND date(off_time, '+5 hours', '+30 minutes') >= ?
        AND date(off_time, '+5 hours', '+30 minutes') <= ?
      ORDER BY off_time ASC
    `
      )
      .all(id, startDate, endDate) as any[];

    const safeRecords = records.map((r) => ({
      onTime: r.onTime.endsWith("Z")
        ? r.onTime
        : r.onTime.replace(" ", "T") + "Z",
      offTime: r.offTime.endsWith("Z")
        ? r.offTime
        : r.offTime.replace(" ", "T") + "Z",
      durationMinutes: r.durationMinutes,
    }));

    res.json(safeRecords);
  } catch (err: any) {
    console.error("SQLite telemetry details query failed:", err.message);
    res.status(500).json({ error: "Query failed" });
  }
});

app.get("/api/nodes/:id/lifetime-hours", requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const anchorRow = db
      .prepare("SELECT lifetime_anchor_date FROM nodes WHERE id = ?")
      .get(id) as any;
    const anchorDate = anchorRow?.lifetime_anchor_date || null;

    let query = `SELECT SUM(duration_minutes) / 60.0 as hours FROM telemetry WHERE device_id = ?`;
    const params: any[] = [id];
    if (anchorDate) {
      query += ` AND off_time >= ?`;
      params.push(anchorDate);
    }
    const row = db.prepare(query).get(...params) as any;

    let hours = row?.hours || 0;

    // Add active session if any
    const activeNode = db
      .prepare("SELECT xray_active_since FROM nodes WHERE id = ?")
      .get(id) as any;
    if (activeNode?.xray_active_since) {
      const activeStr = new Date(activeNode.xray_active_since).toISOString();
      const activeStart = new Date(activeStr).getTime();
      if (!anchorDate || activeStart >= new Date(anchorDate).getTime()) {
        hours += (Date.now() - activeStart) / 3600000;
      }
    }

    res.json({ hours: Number(hours.toFixed(2)) });
  } catch (err: any) {
    res.json({ hours: 0 });
  }
});

app.get("/api/nodes/:id/logs", requireAuth, (req, res) => {
  const rawLogs = db
    .prepare(
      "SELECT * FROM maintenance_logs WHERE node_id = ? ORDER BY created_at DESC"
    )
    .all(req.params.id) as any[];
  const logs = rawLogs.map((l) => ({
    ...l,
    created_at: !l.created_at
      ? l.created_at
      : typeof l.created_at !== "string"
        ? new Date(l.created_at).toISOString()
        : l.created_at.endsWith("Z")
          ? l.created_at
          : l.created_at.replace(" ", "T") + "Z",
  }));
  res.json(logs);
});

app.post("/api/nodes/:id/logs", requireAdmin, (req, res) => {
  const { technician_name, event_type, notes } = req.body;
  db.prepare(
    "INSERT INTO maintenance_logs (node_id, technician_name, event_type, notes) VALUES (?, ?, ?, ?)"
  ).run(req.params.id, technician_name, event_type, notes);
  res.json({ success: true });
});

app.post("/api/nodes/:id/reset-lifetime", requireAdmin, (req, res) => {
  const { id } = req.params;
  try {
    const anchorRow = db
      .prepare("SELECT lifetime_anchor_date FROM nodes WHERE id = ?")
      .get(id) as any;
    const anchorDate = anchorRow?.lifetime_anchor_date || null;

    let query = `SELECT SUM(duration_minutes) / 60.0 as hours FROM telemetry WHERE device_id = ?`;
    const params: any[] = [id];
    if (anchorDate) {
      query += ` AND off_time >= ?`;
      params.push(anchorDate);
    }
    const row = db.prepare(query).get(...params) as any;
    let hours = row?.hours || 0;

    const activeNode = db
      .prepare("SELECT xray_active_since FROM nodes WHERE id = ?")
      .get(id) as any;
    if (activeNode?.xray_active_since) {
      const activeStr = new Date(activeNode.xray_active_since).toISOString();
      const activeStart = new Date(activeStr).getTime();
      if (!anchorDate || activeStart >= new Date(anchorDate).getTime()) {
        hours += (Date.now() - activeStart) / 3600000;
      }
    }

    db.prepare(
      "INSERT INTO maintenance_logs (node_id, technician_name, event_type, notes) VALUES (?, ?, ?, ?)"
    ).run(
      id,
      "System Record",
      "Filament Reset",
      `Filament lifetime counter was reset. Previous filament operated for ${hours.toFixed(2)} hours.`
    );

    db.prepare(
      "UPDATE nodes SET lifetime_anchor_date = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(id);
    res.json({ success: true });
  } catch (err: any) {
    console.error("Failed to reset lifetime:", err.message);
    res.status(500).json({ error: "Failed to reset lifetime counter" });
  }
});

app.get("/api/database-dump", requireAdmin, (req, res) => {
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      )
      .all() as { name: string }[];
    const result: Record<string, any[]> = {};
    for (const t of tables) {
      result[t.name] = db.prepare(`SELECT * FROM ${t.name}`).all();
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/config", requireAdmin, (req, res) => {
  const config = db.prepare("SELECT key, value FROM config").all();
  res.json(config);
});

app.post("/api/config", requireAdmin, (req, res) => {
  const { key, value } = req.body;
  if (key && typeof value !== "undefined") {
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
      key,
      value
    );
    res.json({ success: true });
  } else {
    res.status(400).json({ error: "Missing key or value" });
  }
});

app.post("/api/test-telegram", requireAdmin, async (req, res) => {
  try {
    await sendAlert("Manual Test Alert from System UI", undefined, "alert");
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/notifications", requireAuth, (req, res) => {
  try {
    const rawNotifications = db
      .prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50")
      .all() as any[];
    const notifications = rawNotifications.map((n) => ({
      ...n,
      created_at: !n.created_at
        ? n.created_at
        : typeof n.created_at !== "string"
          ? new Date(n.created_at).toISOString()
          : n.created_at.endsWith("Z")
            ? n.created_at
            : n.created_at.replace(" ", "T") + "Z",
    }));
    res.json(notifications);
  } catch (err: any) {
    console.error("Error fetching notifications:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/notifications/:id/read", requireAuth, (req, res) => {
  db.prepare("UPDATE notifications SET is_read = 1 WHERE id = ?").run(
    req.params.id
  );
  res.json({ success: true });
});

app.get("/api/users", requireAdmin, (req, res) => {
  try {
    const users = db.prepare("SELECT id, username, role FROM users").all();
    res.json(users);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/users", requireAdmin, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !role)
    return res
      .status(400)
      .json({ error: "Username, password and role are required" });

  try {
    const hash = await bcrypt.hash(password, 10);
    db.prepare(
      "INSERT INTO users (username, password, role) VALUES (?, ?, ?)"
    ).run(username, hash, role);
    res.json({ success: true, role });
  } catch (err: any) {
    if (err.message.includes("UNIQUE constraint")) {
      return res.status(400).json({ error: "Username already taken" });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/users/:id", requireAdmin, (req, res) => {
  try {
    // Prevent deleting the last admin
    const adminCount = db
      .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'Admin'")
      .get() as any;
    const deletingUser = db
      .prepare("SELECT role FROM users WHERE id = ?")
      .get(req.params.id) as any;

    if (deletingUser?.role === "Admin" && adminCount.count <= 1) {
      return res.status(400).json({ error: "Cannot delete the last admin" });
    }

    db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Username and password required" });

  const user = db
    .prepare(
      "SELECT id, username, password, role FROM users WHERE username = ?"
    )
    .get(username) as any;

  if (user && (await bcrypt.compare(password, user.password))) {
    const activeRole =
      user.username.toLowerCase() === "admin@schips.in"
        ? "Admin"
        : "Technician";
    if (user.role !== activeRole) {
      db.prepare("UPDATE users SET role = ? WHERE id = ?").run(
        activeRole,
        user.id
      );
    }
    const token = jwt.sign(
      { id: user.id, username: user.username, role: activeRole },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({
      success: true,
      token,
      user: { username: user.username, role: activeRole },
    });
  } else {
    res.status(401).json({ error: "Invalid credentials" });
  }
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ success: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: (req as any).user });
});

// --- Vite Integration ---
if (process.env.NODE_ENV !== "production") {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  const distPath = path.join(process.cwd(), "dist");
  app.use(express.static(distPath));
  app.get("*", (req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    console.error("Express error:", err);
    if (!res.headersSent) {
      res
        .status(err.status || 500)
        .json({ error: err.message || "Internal Server Error" });
    }
  }
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

process.on("SIGINT", () => {
  process.exit();
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err.message);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
