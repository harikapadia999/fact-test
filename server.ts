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
import * as cron from "node-cron";
import nodemailer from "nodemailer";
import ExcelJS from "exceljs";

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

  CREATE TABLE IF NOT EXISTS filament_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT,
    reset_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    hours_operated REAL
  );

  CREATE TABLE IF NOT EXISTS email_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emails TEXT, -- comma separated
    schedule_time TEXT, -- HH:mm format
    smtp_host TEXT,
    smtp_port INTEGER,
    smtp_user TEXT,
    smtp_pass TEXT
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
  const adminHash = bcrypt.hashSync("admin@123", 10);
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
    if ((req as any).user?.role !== "Admin") {
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
      if (row.date && datesMap.has(row.date)) {
        datesMap.set(row.date, row.hours);
      }
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

    const result = Array.from(datesMap.entries())
      .map(([dateStr, hours]) => {
        const d = new Date(dateStr);
        return {
          rawDate: dateStr,
          date: d.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          }),
          hours: Number(hours.toFixed(2)),
        };
      })
      .sort((a, b) => a.rawDate.localeCompare(b.rawDate))
      .slice(-days);

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
      "INSERT INTO filament_history (node_id, hours_operated) VALUES (?, ?)"
    ).run(id, hours);

    db.prepare(
      "UPDATE nodes SET lifetime_anchor_date = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(id);
    res.json({ success: true });
  } catch (err: any) {
    console.error("Failed to reset lifetime:", err.message);
    res.status(500).json({ error: "Failed to reset lifetime counter" });
  }
});

app.get("/api/nodes/:id/filament-history", requireAuth, (req, res) => {
  const { id } = req.params;
  const history = db
    .prepare(
      "SELECT * FROM filament_history WHERE node_id = ? ORDER BY reset_date DESC"
    )
    .all(id);
  res.json(history);
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

app.post("/api/test-email", requireAdmin, async (req, res) => {
  try {
    const settings = db
      .prepare("SELECT * FROM email_settings LIMIT 1")
      .get() as any;
    if (!settings || !settings.emails) {
      return res.status(400).json({ error: "Email settings not configured" });
    }
    const info = await sendDailyReportEmail(settings, true);
    let previewUrl = null;
    if (
      info &&
      info.messageId &&
      settings.smtp_host === "smtp.ethereal.email"
    ) {
      previewUrl = nodemailer.getTestMessageUrl(info);
    }
    res.json({ success: true, previewUrl });
  } catch (err: any) {
    let errorMessage = err.message || "Unknown error";
    const isAuthError =
      errorMessage.includes("535") ||
      errorMessage.toLowerCase().includes("invalid login") ||
      errorMessage.toLowerCase().includes("credentials");
    if (isAuthError) {
      console.warn(
        "Test email authentication failed (535): Invalid username or App Password."
      );
      errorMessage =
        "SMTP login failed (535). Please verify that your SMTP username is correct. If using Gmail, you must use a 16-character App Password (e.g. xxxx-xxxx-xxxx-xxxx with or without spaces) generated from Google Account Settings, not your standard Gmail password. Ensure the App Password corresponds exactly to the Gmail address entered in SMTP User.";
    } else {
      console.error("Test email failed:", err);
    }
    res.status(500).json({ error: errorMessage });
  }
});

app.post("/api/generate-ethereal", requireAdmin, async (req, res) => {
  try {
    const testAccount = await nodemailer.createTestAccount();
    const emails = req.body.emails || "test@example.com";
    const existing = db.prepare("SELECT id FROM email_settings LIMIT 1").get();
    if (existing) {
      db.prepare(
        "UPDATE email_settings SET emails = ?, smtp_host = ?, smtp_port = ?, smtp_user = ?, smtp_pass = ? WHERE id = ?"
      ).run(
        emails,
        testAccount.smtp.host,
        testAccount.smtp.port,
        testAccount.user,
        testAccount.pass,
        (existing as any).id
      );
    } else {
      db.prepare(
        "INSERT INTO email_settings (emails, schedule_time, smtp_host, smtp_port, smtp_user, smtp_pass) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        emails,
        "20:00",
        testAccount.smtp.host,
        testAccount.smtp.port,
        testAccount.user,
        testAccount.pass
      );
    }
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
    const parsedRole = role.toLowerCase() === "admin" ? "Admin" : "Technician";
    db.prepare(
      "INSERT INTO users (username, password, role) VALUES (?, ?, ?)"
    ).run(username, hash, parsedRole);
    res.json({ success: true, role: parsedRole });
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

app.put("/api/users/:id/password", requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Password is required" });
  try {
    const hash = await bcrypt.hash(password, 10);
    db.prepare("UPDATE users SET password = ? WHERE id = ?").run(
      hash,
      Number(req.params.id)
    );
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
      "SELECT id, username, password, role FROM users WHERE LOWER(username) = LOWER(?)"
    )
    .get(username) as any;

  if (user && (await bcrypt.compare(password, user.password))) {
    let activeRole = user.role === "admin" ? "Admin" : user.role;
    if (
      user.username.toLowerCase() === "admin@schips.in" &&
      activeRole !== "Admin"
    ) {
      activeRole = "Admin";
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
    console.log(
      `Failed login for user: ${username}, password: ${password}, user found: ${!!user}`
    );
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

app.get("/api/email-settings", requireAdmin, (req, res) => {
  let settings = db.prepare("SELECT * FROM email_settings LIMIT 1").get();
  if (!settings) {
    db.prepare(
      "INSERT INTO email_settings (emails, schedule_time, smtp_host, smtp_port, smtp_user, smtp_pass) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("", "20:00", "", 587, "", "");
    settings = db.prepare("SELECT * FROM email_settings LIMIT 1").get();
  }
  res.json(settings);
});

app.post("/api/email-settings", requireAdmin, (req, res) => {
  const { emails, schedule_time, smtp_host, smtp_port, smtp_user, smtp_pass } =
    req.body;

  const cleanEmails = (emails || "")
    .split(",")
    .map((e: string) => e.trim())
    .filter(Boolean)
    .join(", ");
  const cleanHost = (smtp_host || "").trim();
  const cleanUser = (smtp_user || "").trim();
  let cleanPass = (smtp_pass || "").trim();

  // If password contains spaces (common when copying 16-char Google app passwords like 'xxxx xxxx xxxx xxxx'), strip all spaces
  if (cleanPass.replace(/\s/g, "").length === 16) {
    cleanPass = cleanPass.replace(/\s/g, "");
  }

  const existing = db.prepare("SELECT id FROM email_settings LIMIT 1").get();
  if (existing) {
    db.prepare(
      "UPDATE email_settings SET emails = ?, schedule_time = ?, smtp_host = ?, smtp_port = ?, smtp_user = ?, smtp_pass = ? WHERE id = ?"
    ).run(
      cleanEmails,
      schedule_time,
      cleanHost,
      smtp_port,
      cleanUser,
      cleanPass,
      (existing as any).id
    );
  } else {
    db.prepare(
      "INSERT INTO email_settings (emails, schedule_time, smtp_host, smtp_port, smtp_user, smtp_pass) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      cleanEmails,
      schedule_time,
      cleanHost,
      smtp_port,
      cleanUser,
      cleanPass
    );
  }
  setupCronJob();
  res.json({ success: true });
});

let emailCronJob: cron.ScheduledTask | null = null;

function setupCronJob() {
  if (emailCronJob) {
    emailCronJob.stop();
  }
  const settings = db
    .prepare("SELECT * FROM email_settings LIMIT 1")
    .get() as any;
  if (!settings || !settings.schedule_time || !settings.emails) return;

  const [hour, minute] = settings.schedule_time.split(":");
  if (!hour || !minute) return;

  emailCronJob = cron.schedule(`${minute} ${hour} * * *`, async () => {
    try {
      console.log("Running scheduled email job...");
      await sendDailyReportEmail(settings);
    } catch (err: any) {
      const isAuthError =
        err.message &&
        (err.message.includes("535") ||
          err.message.toLowerCase().includes("invalid login") ||
          err.message.toLowerCase().includes("credentials"));
      if (isAuthError) {
        console.warn(
          "Scheduled email failed: SMTP authentication error (535). Please verify SMTP User & App Password."
        );
      } else {
        console.error("Failed to send scheduled email:", err);
      }
    }
  });
}

function formatDurationHHMMSS(minutes: number) {
  const hrs = Math.floor(minutes / 60);
  const mins = Math.floor(minutes % 60);
  const secs = Math.floor((minutes * 60) % 60);
  return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function formatDurationInWords(minutes: number) {
  const hrs = Math.floor(minutes / 60);
  const mins = Math.floor(minutes % 60);
  const secs = Math.floor((minutes * 60) % 60);

  const parts = [];
  if (hrs > 0) parts.push(`${hrs} hour${hrs !== 1 ? "s" : ""}`);
  if (mins > 0) parts.push(`${mins} minute${mins !== 1 ? "s" : ""}`);
  if (secs > 0 || (hrs === 0 && mins === 0))
    parts.push(`${secs} second${secs !== 1 ? "s" : ""}`);

  return parts.join(" ");
}

async function sendDailyReportEmail(settings: any, isTest: boolean = false) {
  if (
    !settings.smtp_host ||
    !settings.smtp_port ||
    !settings.smtp_user ||
    !settings.smtp_pass
  ) {
    console.error("SMTP settings are incomplete");
    if (isTest) throw new Error("SMTP settings are incomplete");
    return;
  }

  const cleanHost = settings.smtp_host.trim();
  const cleanUser = settings.smtp_user.trim();
  let cleanPass = settings.smtp_pass.trim();

  if (cleanPass.replace(/\s/g, "").length === 16) {
    cleanPass = cleanPass.replace(/\s/g, "");
  }

  const transporter = nodemailer.createTransport({
    host: cleanHost,
    port: settings.smtp_port,
    secure: settings.smtp_port === 465,
    auth: {
      user: cleanUser,
      pass: cleanPass,
    },
  });

  // Generate report's date string.
  // If schedule_time is late in the day (e.g., >= 12:00), we report on "today".
  // Otherwise, if scheduled in the morning, we report on "yesterday".
  const reportDate = new Date();
  const scheduleTime = settings.schedule_time || "20:00";
  const [hourStr] = scheduleTime.split(":");
  const hourVal = parseInt(hourStr || "20", 10);

  if (hourVal < 12) {
    reportDate.setDate(reportDate.getDate() - 1);
  }

  const startOfDay = new Date(reportDate.setHours(0, 0, 0, 0)).toISOString();
  const endOfDay = new Date(reportDate.setHours(23, 59, 59, 999)).toISOString();

  const nodes = db.prepare("SELECT id, alias FROM nodes").all() as any[];
  const reportData: any = {};

  for (const node of nodes) {
    const logs = db
      .prepare(
        "SELECT * FROM telemetry WHERE device_id = ? AND on_time >= ? AND on_time <= ? ORDER BY on_time DESC"
      )
      .all(node.id, startOfDay, endOfDay) as any[];
    reportData[node.alias || node.id] = logs;
  }

  // Create Excel buffer
  const workbook = new ExcelJS.Workbook();
  let hasData = false;

  for (const [nodeName, logs] of Object.entries(reportData)) {
    const data = logs as any[];
    if (data.length === 0) continue;
    hasData = true;

    // clean sheet name
    const sheetName = nodeName.substring(0, 31).replace(/[\\/*?:\[\]]/g, "");
    const sheet = workbook.addWorksheet(sheetName);

    const startDate = startOfDay;
    const endDate = endOfDay;

    sheet.addRow([`Telemetry Report for Node: ${nodeName}`]);
    sheet.addRow([`Date: ${new Date(startDate).toLocaleDateString("en-US")}`]);
    sheet.addRow([]);

    sheet.getCell("A1").font = { size: 16, bold: true };
    sheet.getCell("A2").font = { size: 14 };

    const headerRow = sheet.addRow([
      "Date",
      "ON Time",
      "OFF Time",
      "Working Time",
      "Working Time(In Words)",
    ]);

    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF2980B9" },
      };
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });

    data.forEach((log) => {
      sheet.addRow([
        new Date(log.on_time).toLocaleDateString("en-US"),
        new Date(log.on_time).toLocaleString("en-US"),
        new Date(log.off_time).toLocaleString("en-US"),
        formatDurationHHMMSS(log.duration_minutes),
        formatDurationInWords(log.duration_minutes),
      ]);
    });

    const totalMinutes = data.reduce(
      (acc, curr) => acc + curr.duration_minutes,
      0
    );
    const totalRow = sheet.addRow([
      "Total",
      "",
      "",
      formatDurationHHMMSS(totalMinutes),
      formatDurationInWords(totalMinutes),
    ]);

    totalRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF2980B9" },
      };
    });

    sheet.columns.forEach((column, index) => {
      let maxLength = 0;
      column.eachCell({ includeEmpty: true }, (cell, rowNumber) => {
        if (rowNumber > 3) {
          const columnLength = cell.value ? cell.value.toString().length : 10;
          if (columnLength > maxLength) {
            maxLength = columnLength;
          }
        }
      });
      column.width = maxLength < 10 ? 10 : maxLength + 2;
    });
  }

  if (!hasData) {
    if (isTest) {
      console.log(
        "No data for the report date. Sending test email without attachment."
      );
      const mailOptions = {
        from: `"Factory Portal" <${settings.smtp_user}>`,
        to: settings.emails,
        subject: `Test Daily Telemetry Report - ${new Date(startOfDay).toLocaleDateString("en-US")}`,
        text: `This is a test email from Factory Portal. There is no telemetry data for ${new Date(startOfDay).toLocaleDateString("en-US")}, so no Excel file is attached.`,
      };
      const info = await transporter.sendMail(mailOptions);
      console.log("Test report email sent to", settings.emails);
      return info;
    }
    console.log(
      `No data for ${new Date(startOfDay).toLocaleDateString("en-US")}. Skipping email report.`
    );
    return null;
  }

  const buffer = await workbook.xlsx.writeBuffer();

  const mailOptions = {
    from: `"Factory Portal" <${settings.smtp_user}>`,
    to: settings.emails,
    subject: `Daily Telemetry Report - ${new Date(startOfDay).toLocaleDateString("en-US")}`,
    text: "Please find the attached daily telemetry report.",
    attachments: [
      {
        filename: `Daily_Report_${new Date(startOfDay).toISOString().split("T")[0]}.xlsx`,
        content: Buffer.from(buffer),
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ],
  };

  const info = await transporter.sendMail(mailOptions);
  console.log("Daily report email sent to", settings.emails);
  return info;
}

setupCronJob();

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

// import express from "express";
// import { createServer as createViteServer } from "vite";
// import path from "path";
// import { fileURLToPath } from "url";
// import mqtt from "mqtt";
// import Database from "better-sqlite3";
// import TelegramBot from "node-telegram-bot-api";
// import dotenv from "dotenv";
// import bcrypt from "bcryptjs";
// import jwt from "jsonwebtoken";
// import cookieParser from "cookie-parser";
// import * as cron from "node-cron";
// import nodemailer from "nodemailer";
// import ExcelJS from "exceljs";

// dotenv.config();

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// const app = express();
// const PORT = 3000;

// const JWT_SECRET = process.env.JWT_SECRET || "fallback_super_secret_key_123!";

// app.use(express.json());
// app.use(cookieParser());

// // --- Database Setup (SQLite for Metadata) ---
// const db = new Database("factory.db");
// db.exec(`
//   CREATE TABLE IF NOT EXISTS nodes (
//     id TEXT PRIMARY KEY,
//     alias TEXT,
//     last_heartbeat DATETIME,
//     status TEXT DEFAULT 'offline',
//     lifetime_anchor_date DATETIME DEFAULT CURRENT_TIMESTAMP,
//     xray_active_since DATETIME,
//     alert_offline_sent INTEGER DEFAULT 0,
//     alert_safety_sent INTEGER DEFAULT 0
//   );

//   CREATE TABLE IF NOT EXISTS notifications (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     node_id TEXT,
//     message TEXT,
//     type TEXT, -- 'offline', 'safety', 'maintenance'
//     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//     is_read INTEGER DEFAULT 0
//   );

//   CREATE TABLE IF NOT EXISTS maintenance_logs (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     node_id TEXT,
//     technician_name TEXT,
//     event_type TEXT,
//     notes TEXT,
//     created_at DATETIME DEFAULT CURRENT_TIMESTAMP
//   );

//   CREATE TABLE IF NOT EXISTS config (
//     key TEXT PRIMARY KEY,
//     value TEXT
//   );

//   CREATE TABLE IF NOT EXISTS users (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     username TEXT UNIQUE,
//     password TEXT,
//     role TEXT DEFAULT 'Technician'
//   );

//   CREATE TABLE IF NOT EXISTS telemetry (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     device_id TEXT,
//     on_time DATETIME,
//     off_time DATETIME,
//     duration_minutes REAL,
//     created_at DATETIME DEFAULT CURRENT_TIMESTAMP
//   );

//   CREATE TABLE IF NOT EXISTS filament_history (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     node_id TEXT,
//     reset_date DATETIME DEFAULT CURRENT_TIMESTAMP,
//     hours_operated REAL
//   );

//   CREATE TABLE IF NOT EXISTS email_settings (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     emails TEXT, -- comma separated
//     schedule_time TEXT, -- HH:mm format
//     smtp_host TEXT,
//     smtp_port INTEGER,
//     smtp_user TEXT,
//     smtp_pass TEXT
//   );

//   INSERT OR IGNORE INTO nodes (id, alias, status) VALUES ('line_01', 'X-Ray Monitor - Line 01', 'online');
//   INSERT OR IGNORE INTO nodes (id, alias, status) VALUES ('line_02', 'X-Ray Monitor - Line 02', 'offline');
//   INSERT OR IGNORE INTO nodes (id, alias, status) VALUES ('line_03', 'X-Ray Monitor - Line 03', 'online');
//   INSERT OR IGNORE INTO nodes (id, alias, status) VALUES ('line_04', 'X-Ray Monitor - Line 04', 'maintenance');
//   INSERT OR IGNORE INTO config (key, value) VALUES ('telegram_chat_id', '${process.env.TELEGRAM_CHAT_ID || ""}');
//   INSERT OR IGNORE INTO config (key, value) VALUES ('telegram_bot_token', '${process.env.TELEGRAM_BOT_TOKEN || ""}');
//   INSERT OR IGNORE INTO config (key, value) VALUES ('watchdog_timeout_min', '6');
//   INSERT OR IGNORE INTO config (key, value) VALUES ('shift_start_hour', '6');
//   INSERT OR IGNORE INTO config (key, value) VALUES ('shift_end_hour', '22');
//   INSERT OR IGNORE INTO config (key, value) VALUES ('safety_timeout_min', '5');
// `);

// const userCount = db
//   .prepare("SELECT COUNT(*) as count FROM users")
//   .get() as any;
// if (userCount.count === 0) {
//   const adminHash = bcrypt.hashSync("admin@123", 10);
//   db.prepare(
//     "INSERT INTO users (username, password, role) VALUES (?, ?, ?)"
//   ).run("admin@schips.in", adminHash, "Admin");
// }

// try {
//   db.exec("ALTER TABLE nodes ADD COLUMN alert_offline_sent INTEGER DEFAULT 0;");
// } catch (e) {
//   // Column might already exist
// }

// try {
//   db.exec("ALTER TABLE nodes ADD COLUMN alert_safety_sent INTEGER DEFAULT 0;");
// } catch (e) {
//   // Column might already exist
// }

// const activeNodes = db
//   .prepare(
//     "SELECT id, xray_active_since FROM nodes WHERE xray_active_since IS NOT NULL"
//   )
//   .all();

// activeNodes.forEach((n: any) => {
//   console.log(
//     `Recovered active session for ${n.id} since ${n.xray_active_since}`
//   );
// });

// // --- Telegram Bot Setup ---
// let bot: TelegramBot | null = null;
// let currentBotToken = "";

// // A simple queue to avoid hitting Telegram's rate limits (e.g., 1 message per second per chat)
// const telegramQueue: Array<{
//   chatId: string;
//   message: string;
//   retries: number;
// }> = [];
// let isProcessingQueue = false;

// const processTelegramQueue = async () => {
//   if (isProcessingQueue || telegramQueue.length === 0 || !bot) return;
//   isProcessingQueue = true;

//   while (telegramQueue.length > 0) {
//     const task = telegramQueue[0];
//     try {
//       await bot.sendMessage(task.chatId, task.message);
//       telegramQueue.shift(); // Success, remove from queue
//       await new Promise((resolve) => setTimeout(resolve, 1500)); // Respect Telegram's 1 msg/sec limit per group
//     } catch (err: any) {
//       console.error(
//         "Failed to send Telegram alert, retrying later:",
//         err.message
//       );
//       task.retries += 1;
//       if (task.retries > 5) {
//         console.error("Max retries reached for message. Dropping.");
//         telegramQueue.shift(); // Drop after 5 failed attempts
//       } else {
//         // Wait before retrying (exponential backoff)
//         const delay = Math.pow(2, task.retries) * 1000;
//         await new Promise((resolve) => setTimeout(resolve, delay));
//       }
//     }
//   }
//   isProcessingQueue = false;
// };

// const sendAlert = async (
//   message: string,
//   nodeId?: string,
//   type: string = "alert"
// ) => {
//   const chatId = db
//     .prepare("SELECT value FROM config WHERE key = 'telegram_chat_id'")
//     .get()?.value;
//   const token = db
//     .prepare("SELECT value FROM config WHERE key = 'telegram_bot_token'")
//     .get()?.value;

//   // Save to notifications table for frontend
//   db.prepare(
//     "INSERT INTO notifications (node_id, message, type) VALUES (?, ?, ?)"
//   ).run(nodeId || null, message, type);

//   if (token && chatId) {
//     try {
//       if (token !== currentBotToken) {
//         bot = new TelegramBot(token, { polling: false });
//         currentBotToken = token;
//       }
//       if (bot) {
//         telegramQueue.push({
//           chatId,
//           message: `🚨 FACTORY ALERT: ${message}`,
//           retries: 0,
//         });
//         processTelegramQueue(); // Fire and forget
//       }
//     } catch (err: any) {
//       console.error("Failed to enqueue Telegram alert:", err.message);
//     }
//   }
// };

// // --- MQTT Setup ---
// const mqttUrl = process.env.MQTT_BROKER_URL || "mqtt://localhost:1883";
// const mqttClient = mqtt.connect(mqttUrl, {
//   username: process.env.MQTT_USERNAME,
//   password: process.env.MQTT_PASSWORD,
// });

// mqttClient.on("connect", () => {
//   console.log("Connected to MQTT Broker");
//   mqttClient.subscribe("factory/southern_chips/nodes/+/heartbeat");
//   mqttClient.subscribe("factory/southern_chips/nodes/+/state");
// });

// mqttClient.on("error", (err) => {
//   if (
//     !err.message.includes("connack timeout") &&
//     !err.message.includes("ECONNREFUSED")
//   ) {
//     console.error("MQTT Client Error:", err.message);
//   }
// });

// mqttClient.on("offline", () => {
//   if (!(mqttClient as any)._offlineLogged) {
//     console.log(
//       "⚠️  MQTT Client Offline. Note: AI Studio runs in the cloud. If your broker is on a local IP (e.g., 192.168.x.x), it cannot connect unless you expose it via ngrok or use a public broker."
//     );
//     (mqttClient as any)._offlineLogged = true;
//   }
// });

// mqttClient.on("message", (topic, message) => {
//   const payload = JSON.parse(message.toString());
//   const nodeId = topic.split("/")[3];

//   if (topic.endsWith("/heartbeat")) {
//     handleHeartbeat(nodeId, payload);
//   } else if (topic.endsWith("/state")) {
//     handleEvent(nodeId, payload);
//   }
// });

// const handleHeartbeat = (nodeId: string, payload: any) => {
//   db.prepare(
//     "UPDATE nodes SET last_heartbeat = CURRENT_TIMESTAMP, status = 'online', alert_offline_sent = 0, alert_safety_sent = 0 WHERE id = ?"
//   ).run(nodeId);
// };

// const handleEvent = (nodeId: string, payload: any) => {
//   if (payload.event_type === "xray_status") {
//     if (payload.is_active) {
//       db.prepare(
//         "UPDATE nodes SET xray_active_since = CURRENT_TIMESTAMP WHERE id = ?"
//       ).run(nodeId);
//     } else {
//       const row = db
//         .prepare("SELECT xray_active_since FROM nodes WHERE id = ?")
//         .get(nodeId) as any;

//       if (row?.xray_active_since) {
//         const start = new Date(row.xray_active_since).getTime();
//         const end = new Date().getTime();
//         const minutes = (end - start) / 60000;

//         db.prepare(
//           "INSERT INTO telemetry (device_id, on_time, off_time, duration_minutes) VALUES (?, ?, ?, ?)"
//         ).run(
//           nodeId,
//           new Date(start).toISOString(),
//           new Date(end).toISOString(),
//           minutes
//         );

//         db.prepare(
//           "UPDATE nodes SET xray_active_since = NULL WHERE id = ?"
//         ).run(nodeId);
//       }
//     }
//   }
// };

// // --- Watchdog Service ---
// setInterval(() => {
//   const now = new Date();
//   const currentHour = now.getHours();

//   const config = Object.fromEntries(
//     db
//       .prepare("SELECT key, value FROM config")
//       .all()
//       .map((c) => [c.key, c.value])
//   );

//   const shiftStart = parseInt(config.shift_start_hour || "6");
//   const shiftEnd = parseInt(config.shift_end_hour || "22");
//   const watchdogTimeout = parseInt(config.watchdog_timeout_min || "6");
//   const safetyTimeout = parseInt(config.safety_timeout_min || "5");

//   // Shift-Awareness
//   const isOnShift = currentHour >= shiftStart && currentHour < shiftEnd;

//   // 1. Check for Offline Nodes
//   const offlineNodes = db
//     .prepare(
//       `
//     SELECT id, alias, alert_offline_sent FROM nodes
//     WHERE status = 'online'
//     AND (last_heartbeat IS NULL OR datetime(last_heartbeat, '+${watchdogTimeout} minutes') < CURRENT_TIMESTAMP)
//   `
//     )
//     .all();

//   offlineNodes.forEach((node: any) => {
//     db.prepare("UPDATE nodes SET status = 'offline' WHERE id = ?").run(node.id);

//     // Close out telemetry if left hanging
//     const row = db
//       .prepare(
//         "SELECT xray_active_since, last_heartbeat FROM nodes WHERE id = ?"
//       )
//       .get(node.id) as any;
//     if (row?.xray_active_since) {
//       const activeStr = new Date(row.xray_active_since).toISOString();
//       const start = new Date(activeStr).getTime();
//       const end = row.last_heartbeat
//         ? new Date(row.last_heartbeat).getTime()
//         : new Date().getTime(); // use last heartbeat to be safe, or now

//       // Only insert if start is before end
//       if (end > start) {
//         const minutes = (end - start) / 60000;
//         db.prepare(
//           "INSERT INTO telemetry (device_id, on_time, off_time, duration_minutes) VALUES (?, ?, ?, ?)"
//         ).run(node.id, activeStr, new Date(end).toISOString(), minutes);
//       }
//       db.prepare("UPDATE nodes SET xray_active_since = NULL WHERE id = ?").run(
//         node.id
//       );
//     }

//     if (isOnShift && node.alert_offline_sent === 0) {
//       sendAlert(`Device Offline: ${node.alias || node.id}`, node.id, "offline");
//       db.prepare("UPDATE nodes SET alert_offline_sent = 1 WHERE id = ?").run(
//         node.id
//       );
//     }
//   });

//   // 2. Check for Safety Alerts (X-Ray active too long)
//   const safetyViolations = db
//     .prepare(
//       `
//     SELECT id, alias, alert_safety_sent FROM nodes
//     WHERE xray_active_since IS NOT NULL
//     AND datetime(xray_active_since, '+${safetyTimeout} minutes') < CURRENT_TIMESTAMP
//   `
//     )
//     .all();

//   safetyViolations.forEach((node: any) => {
//     if (isOnShift && node.alert_safety_sent === 0) {
//       sendAlert(
//         `SAFETY ALERT: X-Ray active for > ${safetyTimeout} mins on ${node.alias || node.id}`,
//         node.id,
//         "safety"
//       );
//       db.prepare("UPDATE nodes SET alert_safety_sent = 1 WHERE id = ?").run(
//         node.id
//       );
//     }
//   });
// }, 60000);

// // --- API Routes ---

// // RBAC Middleware
// const requireAuth = (
//   req: express.Request,
//   res: express.Response,
//   next: express.NextFunction
// ) => {
//   const token = req.cookies.token || req.headers.authorization?.split(" ")[1];
//   if (!token) {
//     return res.status(401).json({ error: "Unauthorized: Missing token" });
//   }

//   try {
//     const decoded = jwt.verify(token, JWT_SECRET) as any;
//     (req as any).user = decoded;
//     next();
//   } catch (err) {
//     return res.status(401).json({ error: "Unauthorized: Invalid token" });
//   }
// };

// const requireAdmin = (
//   req: express.Request,
//   res: express.Response,
//   next: express.NextFunction
// ) => {
//   requireAuth(req, res, () => {
//     if ((req as any).user?.role !== "Admin") {
//       return res
//         .status(403)
//         .json({ error: "Forbidden: Admin access required" });
//     }
//     next();
//   });
// };

// app.get("/api/nodes", requireAuth, (req, res) => {
//   try {
//     const rawNodes = db.prepare("SELECT * FROM nodes").all() as any[];
//     const nodes = rawNodes.map((n) => {
//       const fixDate = (d: string | null) => {
//         if (!d) return d;
//         if (typeof d !== "string") return new Date(d).toISOString();
//         if (d.endsWith("Z")) return d;
//         return d.replace(" ", "T") + "Z";
//       };
//       return {
//         ...n,
//         last_heartbeat: fixDate(n.last_heartbeat),
//         lifetime_anchor_date: fixDate(n.lifetime_anchor_date),
//         xray_active_since: fixDate(n.xray_active_since),
//       };
//     });
//     res.json(nodes);
//   } catch (err: any) {
//     console.error("Error fetching nodes:", err);
//     res.status(500).json({ error: err.message });
//   }
// });

// app.post("/api/nodes/:id/alias", requireAdmin, (req, res) => {
//   const { alias } = req.body;
//   db.prepare("UPDATE nodes SET alias = ? WHERE id = ?").run(
//     alias,
//     req.params.id
//   );
//   res.json({ success: true });
// });

// app.post("/api/nodes", requireAdmin, (req, res) => {
//   const { id, alias } = req.body;
//   if (!id) return res.status(400).json({ error: "ID is required" });

//   try {
//     db.prepare(
//       "INSERT INTO nodes (id, alias, status, last_heartbeat, lifetime_anchor_date) VALUES (?, ?, 'offline', datetime('now'), datetime('now'))"
//     ).run(id, alias || id);
//     res.json({ success: true });
//   } catch (err) {
//     res.status(400).json({ error: "Node ID already exists" });
//   }
// });

// app.delete("/api/nodes/:id", requireAdmin, (req, res) => {
//   const { id } = req.params;
//   db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
//   db.prepare("DELETE FROM maintenance_logs WHERE node_id = ?").run(id);
//   db.prepare("DELETE FROM notifications WHERE node_id = ?").run(id);
//   res.json({ success: true });
// });

// app.get("/api/nodes/:id/telemetry", requireAuth, async (req, res) => {
//   const { id } = req.params;
//   const { range = "7d" } = req.query;

//   try {
//     const days = range === "30d" ? 30 : 7;
//     const records = db
//       .prepare(
//         `
//       SELECT
//         date(off_time, '+5 hours', '+30 minutes') as date,
//         SUM(duration_minutes) / 60.0 as hours
//       FROM telemetry
//       WHERE device_id = ?
//         AND off_time >= datetime('now', '-' || ? || ' days', '-5 hours', '-30 minutes')
//       GROUP BY date(off_time, '+5 hours', '+30 minutes')
//       ORDER BY date(off_time, '+5 hours', '+30 minutes') ASC
//     `
//       )
//       .all(id, days) as any[];

//     const datesMap = new Map();
//     const nowIST = new Date(Date.now() + 5.5 * 3600000);
//     for (let i = days - 1; i >= 0; i--) {
//       const d = new Date(nowIST.getTime() - i * 86400000);
//       const ymd = d.toISOString().split("T")[0];
//       datesMap.set(ymd, 0);
//     }
//     for (const row of records) {
//       if (row.date && datesMap.has(row.date)) {
//         datesMap.set(row.date, row.hours);
//       }
//     }

//     const activeNode = db
//       .prepare("SELECT xray_active_since FROM nodes WHERE id = ?")
//       .get(id) as any;
//     if (activeNode?.xray_active_since) {
//       const activeStr = new Date(activeNode.xray_active_since).toISOString();
//       const activeStart = new Date(activeStr).getTime();
//       const activeDurationHours = (Date.now() - activeStart) / 3600000; // milliseconds to hours
//       const todayStr = nowIST.toISOString().split("T")[0];
//       if (datesMap.has(todayStr)) {
//         datesMap.set(todayStr, datesMap.get(todayStr) + activeDurationHours);
//       }
//     }

//     const result = Array.from(datesMap.entries())
//       .map(([dateStr, hours]) => {
//         const d = new Date(dateStr);
//         return {
//           rawDate: dateStr,
//           date: d.toLocaleDateString("en-US", {
//             month: "short",
//             day: "numeric",
//           }),
//           hours: Number(hours.toFixed(2)),
//         };
//       })
//       .sort((a, b) => a.rawDate.localeCompare(b.rawDate))
//       .slice(-days);

//     res.json(result);
//   } catch (err: any) {
//     console.error("SQLite telemetry query failed:", err.message || err);
//     res.status(500).json({ error: "Query failed" });
//   }
// });

// app.get("/api/nodes/:id/telemetry/details", requireAuth, async (req, res) => {
//   const { id } = req.params;
//   const { startDate, endDate } = req.query;

//   if (
//     !startDate ||
//     !endDate ||
//     typeof startDate !== "string" ||
//     typeof endDate !== "string"
//   ) {
//     return res
//       .status(400)
//       .json({ error: "startDate and endDate are required" });
//   }

//   try {
//     const records = db
//       .prepare(
//         `
//       SELECT
//         on_time as onTime,
//         off_time as offTime,
//         duration_minutes as durationMinutes
//       FROM telemetry
//       WHERE device_id = ?
//         AND date(off_time, '+5 hours', '+30 minutes') >= ?
//         AND date(off_time, '+5 hours', '+30 minutes') <= ?
//       ORDER BY off_time ASC
//     `
//       )
//       .all(id, startDate, endDate) as any[];

//     const safeRecords = records.map((r) => ({
//       onTime: r.onTime.endsWith("Z")
//         ? r.onTime
//         : r.onTime.replace(" ", "T") + "Z",
//       offTime: r.offTime.endsWith("Z")
//         ? r.offTime
//         : r.offTime.replace(" ", "T") + "Z",
//       durationMinutes: r.durationMinutes,
//     }));

//     res.json(safeRecords);
//   } catch (err: any) {
//     console.error("SQLite telemetry details query failed:", err.message);
//     res.status(500).json({ error: "Query failed" });
//   }
// });

// app.get("/api/nodes/:id/lifetime-hours", requireAuth, async (req, res) => {
//   const { id } = req.params;

//   try {
//     const anchorRow = db
//       .prepare("SELECT lifetime_anchor_date FROM nodes WHERE id = ?")
//       .get(id) as any;
//     const anchorDate = anchorRow?.lifetime_anchor_date || null;

//     let query = `SELECT SUM(duration_minutes) / 60.0 as hours FROM telemetry WHERE device_id = ?`;
//     const params: any[] = [id];
//     if (anchorDate) {
//       query += ` AND off_time >= ?`;
//       params.push(anchorDate);
//     }
//     const row = db.prepare(query).get(...params) as any;

//     let hours = row?.hours || 0;

//     // Add active session if any
//     const activeNode = db
//       .prepare("SELECT xray_active_since FROM nodes WHERE id = ?")
//       .get(id) as any;
//     if (activeNode?.xray_active_since) {
//       const activeStr = new Date(activeNode.xray_active_since).toISOString();
//       const activeStart = new Date(activeStr).getTime();
//       if (!anchorDate || activeStart >= new Date(anchorDate).getTime()) {
//         hours += (Date.now() - activeStart) / 3600000;
//       }
//     }

//     res.json({ hours: Number(hours.toFixed(2)) });
//   } catch (err: any) {
//     res.json({ hours: 0 });
//   }
// });

// app.get("/api/nodes/:id/logs", requireAuth, (req, res) => {
//   const rawLogs = db
//     .prepare(
//       "SELECT * FROM maintenance_logs WHERE node_id = ? ORDER BY created_at DESC"
//     )
//     .all(req.params.id) as any[];
//   const logs = rawLogs.map((l) => ({
//     ...l,
//     created_at: !l.created_at
//       ? l.created_at
//       : typeof l.created_at !== "string"
//         ? new Date(l.created_at).toISOString()
//         : l.created_at.endsWith("Z")
//           ? l.created_at
//           : l.created_at.replace(" ", "T") + "Z",
//   }));
//   res.json(logs);
// });

// app.post("/api/nodes/:id/logs", requireAdmin, (req, res) => {
//   const { technician_name, event_type, notes } = req.body;
//   db.prepare(
//     "INSERT INTO maintenance_logs (node_id, technician_name, event_type, notes) VALUES (?, ?, ?, ?)"
//   ).run(req.params.id, technician_name, event_type, notes);
//   res.json({ success: true });
// });

// app.post("/api/nodes/:id/reset-lifetime", requireAdmin, (req, res) => {
//   const { id } = req.params;
//   try {
//     const anchorRow = db
//       .prepare("SELECT lifetime_anchor_date FROM nodes WHERE id = ?")
//       .get(id) as any;
//     const anchorDate = anchorRow?.lifetime_anchor_date || null;

//     let query = `SELECT SUM(duration_minutes) / 60.0 as hours FROM telemetry WHERE device_id = ?`;
//     const params: any[] = [id];
//     if (anchorDate) {
//       query += ` AND off_time >= ?`;
//       params.push(anchorDate);
//     }
//     const row = db.prepare(query).get(...params) as any;
//     let hours = row?.hours || 0;

//     const activeNode = db
//       .prepare("SELECT xray_active_since FROM nodes WHERE id = ?")
//       .get(id) as any;
//     if (activeNode?.xray_active_since) {
//       const activeStr = new Date(activeNode.xray_active_since).toISOString();
//       const activeStart = new Date(activeStr).getTime();
//       if (!anchorDate || activeStart >= new Date(anchorDate).getTime()) {
//         hours += (Date.now() - activeStart) / 3600000;
//       }
//     }

//     db.prepare(
//       "INSERT INTO filament_history (node_id, hours_operated) VALUES (?, ?)"
//     ).run(id, hours);

//     db.prepare(
//       "UPDATE nodes SET lifetime_anchor_date = CURRENT_TIMESTAMP WHERE id = ?"
//     ).run(id);
//     res.json({ success: true });
//   } catch (err: any) {
//     console.error("Failed to reset lifetime:", err.message);
//     res.status(500).json({ error: "Failed to reset lifetime counter" });
//   }
// });

// app.get("/api/nodes/:id/filament-history", requireAuth, (req, res) => {
//   const { id } = req.params;
//   const history = db
//     .prepare(
//       "SELECT * FROM filament_history WHERE node_id = ? ORDER BY reset_date DESC"
//     )
//     .all(id);
//   res.json(history);
// });

// app.get("/api/database-dump", requireAdmin, (req, res) => {
//   try {
//     const tables = db
//       .prepare(
//         "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
//       )
//       .all() as { name: string }[];
//     const result: Record<string, any[]> = {};
//     for (const t of tables) {
//       result[t.name] = db.prepare(`SELECT * FROM ${t.name}`).all();
//     }
//     res.json(result);
//   } catch (err: any) {
//     res.status(500).json({ error: err.message });
//   }
// });

// app.get("/api/config", requireAdmin, (req, res) => {
//   const config = db.prepare("SELECT key, value FROM config").all();
//   res.json(config);
// });

// app.post("/api/config", requireAdmin, (req, res) => {
//   const { key, value } = req.body;
//   if (key && typeof value !== "undefined") {
//     db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
//       key,
//       value
//     );
//     res.json({ success: true });
//   } else {
//     res.status(400).json({ error: "Missing key or value" });
//   }
// });

// app.post("/api/test-telegram", requireAdmin, async (req, res) => {
//   try {
//     await sendAlert("Manual Test Alert from System UI", undefined, "alert");
//     res.json({ success: true });
//   } catch (err: any) {
//     res.status(500).json({ error: err.message });
//   }
// });

// app.post("/api/test-email", requireAdmin, async (req, res) => {
//   try {
//     const settings = db
//       .prepare("SELECT * FROM email_settings LIMIT 1")
//       .get() as any;
//     if (!settings || !settings.emails) {
//       return res.status(400).json({ error: "Email settings not configured" });
//     }
//     const info = await sendDailyReportEmail(settings, true);
//     let previewUrl = null;
//     if (
//       info &&
//       info.messageId &&
//       settings.smtp_host === "smtp.ethereal.email"
//     ) {
//       previewUrl = nodemailer.getTestMessageUrl(info);
//     }
//     res.json({ success: true, previewUrl });
//   } catch (err: any) {
//     let errorMessage = err.message || "Unknown error";
//     const isAuthError =
//       errorMessage.includes("535") ||
//       errorMessage.toLowerCase().includes("invalid login") ||
//       errorMessage.toLowerCase().includes("credentials");
//     if (isAuthError) {
//       console.warn(
//         "Test email authentication failed (535): Invalid username or App Password."
//       );
//       errorMessage =
//         "SMTP login failed (535). Please verify that your SMTP username is correct. If using Gmail, you must use a 16-character App Password (e.g. xxxx-xxxx-xxxx-xxxx with or without spaces) generated from Google Account Settings, not your standard Gmail password. Ensure the App Password corresponds exactly to the Gmail address entered in SMTP User.";
//     } else {
//       console.error("Test email failed:", err);
//     }
//     res.status(500).json({ error: errorMessage });
//   }
// });

// app.post("/api/generate-ethereal", requireAdmin, async (req, res) => {
//   try {
//     const testAccount = await nodemailer.createTestAccount();
//     const emails = req.body.emails || "test@example.com";
//     const existing = db.prepare("SELECT id FROM email_settings LIMIT 1").get();
//     if (existing) {
//       db.prepare(
//         "UPDATE email_settings SET emails = ?, smtp_host = ?, smtp_port = ?, smtp_user = ?, smtp_pass = ? WHERE id = ?"
//       ).run(
//         emails,
//         testAccount.smtp.host,
//         testAccount.smtp.port,
//         testAccount.user,
//         testAccount.pass,
//         (existing as any).id
//       );
//     } else {
//       db.prepare(
//         "INSERT INTO email_settings (emails, schedule_time, smtp_host, smtp_port, smtp_user, smtp_pass) VALUES (?, ?, ?, ?, ?, ?)"
//       ).run(
//         emails,
//         "20:00",
//         testAccount.smtp.host,
//         testAccount.smtp.port,
//         testAccount.user,
//         testAccount.pass
//       );
//     }
//     res.json({ success: true });
//   } catch (err: any) {
//     res.status(500).json({ error: err.message });
//   }
// });

// app.post("/api/seed-mock-data", requireAdmin, (req, res) => {
//   try {
//     // 1. Clear existing dynamic tables
//     db.exec("DELETE FROM telemetry;");
//     db.exec("DELETE FROM maintenance_logs;");
//     db.exec("DELETE FROM notifications;");
//     db.exec("DELETE FROM filament_history;");
//     db.exec("DELETE FROM nodes;");

//     // 2. Insert standard nodes
//     const nodes = [
//       {
//         id: "line_01",
//         alias: "X-Ray Monitor - Line 01",
//         status: "online",
//         alert_offline_sent: 0,
//         alert_safety_sent: 0,
//       },
//       {
//         id: "line_02",
//         alias: "X-Ray Monitor - Line 02",
//         status: "offline",
//         alert_offline_sent: 1,
//         alert_safety_sent: 0,
//       },
//       {
//         id: "line_03",
//         alias: "X-Ray Monitor - Line 03",
//         status: "online",
//         alert_offline_sent: 0,
//         alert_safety_sent: 0,
//       },
//       {
//         id: "line_04",
//         alias: "X-Ray Monitor - Line 04",
//         status: "maintenance",
//         alert_offline_sent: 0,
//         alert_safety_sent: 0,
//       },
//     ];

//     const insertNode = db.prepare(`
//       INSERT INTO nodes (id, alias, status, last_heartbeat, lifetime_anchor_date, xray_active_since, alert_offline_sent, alert_safety_sent)
//       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
//     `);

//     const now = new Date();
//     const nowStr = now.toISOString();

//     const minusHours = (date: Date, h: number) =>
//       new Date(date.getTime() - h * 60 * 60 * 1000);
//     const minusDays = (date: Date, d: number) =>
//       new Date(date.getTime() - d * 24 * 60 * 60 * 1000);

//     for (const node of nodes) {
//       let lastHeartbeat = nowStr;
//       let xrayActiveSince = null;

//       if (node.status === "offline") {
//         lastHeartbeat = minusHours(now, 3).toISOString();
//       } else if (node.status === "maintenance") {
//         lastHeartbeat = minusHours(now, 1).toISOString();
//       } else if (node.status === "online") {
//         xrayActiveSince = minusHours(now, 0.75).toISOString();
//       }

//       const anchorDate = minusDays(now, 45).toISOString();

//       insertNode.run(
//         node.id,
//         node.alias,
//         node.status,
//         lastHeartbeat,
//         anchorDate,
//         xrayActiveSince,
//         node.alert_offline_sent,
//         node.alert_safety_sent
//       );
//     }

//     // 3. Generate Telemetry for the last 45 days
//     const insertTelemetry = db.prepare(`
//       INSERT INTO telemetry (device_id, on_time, off_time, duration_minutes)
//       VALUES (?, ?, ?, ?)
//     `);

//     for (let d = 45; d >= 0; d--) {
//       const targetDay = minusDays(now, d);
//       for (const node of nodes) {
//         const isNodeActiveThisDay =
//           node.id === "line_04" && d < 3 ? false : Math.random() > 0.08;
//         if (!isNodeActiveThisDay) continue;

//         const sessionsCount = Math.floor(Math.random() * 4) + 2;
//         let currentHour = 6 + Math.random() * 2;

//         for (let s = 0; s < sessionsCount; s++) {
//           if (currentHour >= 21) break;

//           const durationMinutes = Math.floor(Math.random() * 150) + 30;
//           const onTime = new Date(targetDay);
//           onTime.setUTCHours(
//             Math.floor(currentHour),
//             Math.floor((currentHour % 1) * 60),
//             0,
//             0
//           );
//           const offTime = new Date(
//             onTime.getTime() + durationMinutes * 60 * 1000
//           );

//           insertTelemetry.run(
//             node.id,
//             onTime.toISOString(),
//             offTime.toISOString(),
//             durationMinutes
//           );
//           currentHour += durationMinutes / 60 + 1 + Math.random() * 2;
//         }
//       }
//     }

//     // 4. Seed Maintenance Logs
//     const insertLog = db.prepare(`
//       INSERT INTO maintenance_logs (node_id, technician_name, event_type, notes, created_at)
//       VALUES (?, ?, ?, ?, ?)
//     `);

//     const logsData = [
//       {
//         node_id: "line_01",
//         technician_name: "Rajesh Kumar",
//         event_type: "Filament Replacement",
//         notes:
//           "Replaced the aging X-Ray emitter filament. Initialized burn-in cycle. Operational parameters stable.",
//         created_at: minusDays(now, 28).toISOString(),
//       },
//       {
//         node_id: "line_02",
//         technician_name: "Amit Patel",
//         event_type: "Calibration",
//         notes:
//           "Completed standard safety shutter and beam alignment calibration. Margin of error: < 0.02%.",
//         created_at: minusDays(now, 20).toISOString(),
//       },
//       {
//         node_id: "line_03",
//         technician_name: "Suresh Sharma",
//         event_type: "Routine Check",
//         notes:
//           "Inspected power supplies, cooling fans, and high-voltage connections. Everything in excellent condition.",
//         created_at: minusDays(now, 15).toISOString(),
//       },
//       {
//         node_id: "line_04",
//         technician_name: "Vijay Singh",
//         event_type: "Software Update",
//         notes:
//           "Upgraded safety controller firmware to v2.4.1. Tested watchdog fail-safe loop successfully.",
//         created_at: minusDays(now, 2).toISOString(),
//       },
//       {
//         node_id: "line_01",
//         technician_name: "Rajesh Kumar",
//         event_type: "Lens Cleaning",
//         notes:
//           "Cleaned collimator optical elements and dust filters. Increased clarity of detection scan.",
//         created_at: minusDays(now, 5).toISOString(),
//       },
//     ];

//     for (const log of logsData) {
//       insertLog.run(
//         log.node_id,
//         log.technician_name,
//         log.event_type,
//         log.notes,
//         log.created_at
//       );
//     }

//     // 5. Seed Filament History
//     const insertFilament = db.prepare(`
//       INSERT INTO filament_history (node_id, reset_date, hours_operated)
//       VALUES (?, ?, ?)
//     `);

//     const filamentData = [
//       {
//         node_id: "line_01",
//         reset_date: minusDays(now, 28).toISOString(),
//         hours_operated: 412.5,
//       },
//       {
//         node_id: "line_02",
//         reset_date: minusDays(now, 40).toISOString(),
//         hours_operated: 385.2,
//       },
//       {
//         node_id: "line_03",
//         reset_date: minusDays(now, 10).toISOString(),
//         hours_operated: 120.4,
//       },
//     ];

//     for (const fil of filamentData) {
//       insertFilament.run(fil.node_id, fil.reset_date, fil.hours_operated);
//     }

//     // 6. Seed Notifications
//     const insertNotification = db.prepare(`
//       INSERT INTO notifications (node_id, message, type, created_at, is_read)
//       VALUES (?, ?, ?, ?, ?)
//     `);

//     const notificationsData = [
//       {
//         node_id: "line_02",
//         message: "Line 02 is offline: Heartbeat lost for more than 6 minutes.",
//         type: "offline",
//         created_at: minusHours(now, 3).toISOString(),
//         is_read: 0,
//       },
//       {
//         node_id: "line_04",
//         message: "Line 04 status updated to Maintenance by admin@schips.in.",
//         type: "maintenance",
//         created_at: minusHours(now, 5).toISOString(),
//         is_read: 0,
//       },
//       {
//         node_id: "line_01",
//         message:
//           "Safety warning: Line 01 active for over 5 minutes without heartbeat.",
//         type: "safety",
//         created_at: minusDays(now, 1).toISOString(),
//         is_read: 1,
//       },
//       {
//         node_id: "line_03",
//         message: "Routine maintenance completed successfully for Line 03.",
//         type: "maintenance",
//         created_at: minusDays(now, 3).toISOString(),
//         is_read: 1,
//       },
//     ];

//     for (const notif of notificationsData) {
//       insertNotification.run(
//         notif.node_id,
//         notif.message,
//         notif.type,
//         notif.created_at,
//         notif.is_read
//       );
//     }

//     res.json({ success: true });
//   } catch (err: any) {
//     res.status(500).json({ error: err.message });
//   }
// });

// app.get("/api/notifications", requireAuth, (req, res) => {
//   try {
//     const rawNotifications = db
//       .prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50")
//       .all() as any[];
//     const notifications = rawNotifications.map((n) => ({
//       ...n,
//       created_at: !n.created_at
//         ? n.created_at
//         : typeof n.created_at !== "string"
//           ? new Date(n.created_at).toISOString()
//           : n.created_at.endsWith("Z")
//             ? n.created_at
//             : n.created_at.replace(" ", "T") + "Z",
//     }));
//     res.json(notifications);
//   } catch (err: any) {
//     console.error("Error fetching notifications:", err);
//     res.status(500).json({ error: err.message });
//   }
// });

// app.post("/api/notifications/:id/read", requireAuth, (req, res) => {
//   db.prepare("UPDATE notifications SET is_read = 1 WHERE id = ?").run(
//     req.params.id
//   );
//   res.json({ success: true });
// });

// app.get("/api/users", requireAdmin, (req, res) => {
//   try {
//     const users = db.prepare("SELECT id, username, role FROM users").all();
//     res.json(users);
//   } catch (err: any) {
//     res.status(500).json({ error: err.message });
//   }
// });

// app.post("/api/users", requireAdmin, async (req, res) => {
//   const { username, password, role } = req.body;
//   if (!username || !password || !role)
//     return res
//       .status(400)
//       .json({ error: "Username, password and role are required" });

//   try {
//     const hash = await bcrypt.hash(password, 10);
//     const parsedRole = role.toLowerCase() === "admin" ? "Admin" : "Technician";
//     db.prepare(
//       "INSERT INTO users (username, password, role) VALUES (?, ?, ?)"
//     ).run(username, hash, parsedRole);
//     res.json({ success: true, role: parsedRole });
//   } catch (err: any) {
//     if (err.message.includes("UNIQUE constraint")) {
//       return res.status(400).json({ error: "Username already taken" });
//     }
//     res.status(500).json({ error: err.message });
//   }
// });

// app.delete("/api/users/:id", requireAdmin, (req, res) => {
//   try {
//     // Prevent deleting the last admin
//     const adminCount = db
//       .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'Admin'")
//       .get() as any;
//     const deletingUser = db
//       .prepare("SELECT role FROM users WHERE id = ?")
//       .get(req.params.id) as any;

//     if (deletingUser?.role === "Admin" && adminCount.count <= 1) {
//       return res.status(400).json({ error: "Cannot delete the last admin" });
//     }

//     db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
//     res.json({ success: true });
//   } catch (err: any) {
//     res.status(500).json({ error: err.message });
//   }
// });

// app.put("/api/users/:id/password", requireAdmin, async (req, res) => {
//   const { password } = req.body;
//   if (!password) return res.status(400).json({ error: "Password is required" });
//   try {
//     const hash = await bcrypt.hash(password, 10);
//     db.prepare("UPDATE users SET password = ? WHERE id = ?").run(
//       hash,
//       Number(req.params.id)
//     );
//     res.json({ success: true });
//   } catch (err: any) {
//     res.status(500).json({ error: err.message });
//   }
// });

// app.post("/api/login", async (req, res) => {
//   const { username, password } = req.body;
//   if (!username || !password)
//     return res.status(400).json({ error: "Username and password required" });

//   const user = db
//     .prepare(
//       "SELECT id, username, password, role FROM users WHERE LOWER(username) = LOWER(?)"
//     )
//     .get(username) as any;

//   if (user && (await bcrypt.compare(password, user.password))) {
//     let activeRole = user.role === "admin" ? "Admin" : user.role;
//     if (
//       user.username.toLowerCase() === "admin@schips.in" &&
//       activeRole !== "Admin"
//     ) {
//       activeRole = "Admin";
//       db.prepare("UPDATE users SET role = ? WHERE id = ?").run(
//         activeRole,
//         user.id
//       );
//     }
//     const token = jwt.sign(
//       { id: user.id, username: user.username, role: activeRole },
//       JWT_SECRET,
//       { expiresIn: "7d" }
//     );
//     res.cookie("token", token, {
//       httpOnly: true,
//       secure: process.env.NODE_ENV === "production",
//       sameSite: "strict",
//       maxAge: 7 * 24 * 60 * 60 * 1000,
//     });
//     res.json({
//       success: true,
//       token,
//       user: { username: user.username, role: activeRole },
//     });
//   } else {
//     console.log(
//       `Failed login for user: ${username}, password: ${password}, user found: ${!!user}`
//     );
//     res.status(401).json({ error: "Invalid credentials" });
//   }
// });

// app.post("/api/logout", (req, res) => {
//   res.clearCookie("token");
//   res.json({ success: true });
// });

// app.get("/api/me", requireAuth, (req, res) => {
//   res.json({ user: (req as any).user });
// });

// app.get("/api/email-settings", requireAdmin, (req, res) => {
//   let settings = db.prepare("SELECT * FROM email_settings LIMIT 1").get();
//   if (!settings) {
//     db.prepare(
//       "INSERT INTO email_settings (emails, schedule_time, smtp_host, smtp_port, smtp_user, smtp_pass) VALUES (?, ?, ?, ?, ?, ?)"
//     ).run("", "20:00", "", 587, "", "");
//     settings = db.prepare("SELECT * FROM email_settings LIMIT 1").get();
//   }
//   res.json(settings);
// });

// app.post("/api/email-settings", requireAdmin, (req, res) => {
//   const { emails, schedule_time, smtp_host, smtp_port, smtp_user, smtp_pass } =
//     req.body;

//   const cleanEmails = (emails || "")
//     .split(",")
//     .map((e: string) => e.trim())
//     .filter(Boolean)
//     .join(", ");
//   const cleanHost = (smtp_host || "").trim();
//   const cleanUser = (smtp_user || "").trim();
//   let cleanPass = (smtp_pass || "").trim();

//   // If password contains spaces (common when copying 16-char Google app passwords like 'xxxx xxxx xxxx xxxx'), strip all spaces
//   if (cleanPass.replace(/\s/g, "").length === 16) {
//     cleanPass = cleanPass.replace(/\s/g, "");
//   }

//   const existing = db.prepare("SELECT id FROM email_settings LIMIT 1").get();
//   if (existing) {
//     db.prepare(
//       "UPDATE email_settings SET emails = ?, schedule_time = ?, smtp_host = ?, smtp_port = ?, smtp_user = ?, smtp_pass = ? WHERE id = ?"
//     ).run(
//       cleanEmails,
//       schedule_time,
//       cleanHost,
//       smtp_port,
//       cleanUser,
//       cleanPass,
//       (existing as any).id
//     );
//   } else {
//     db.prepare(
//       "INSERT INTO email_settings (emails, schedule_time, smtp_host, smtp_port, smtp_user, smtp_pass) VALUES (?, ?, ?, ?, ?, ?)"
//     ).run(
//       cleanEmails,
//       schedule_time,
//       cleanHost,
//       smtp_port,
//       cleanUser,
//       cleanPass
//     );
//   }
//   setupCronJob();
//   res.json({ success: true });
// });

// let emailCronJob: cron.ScheduledTask | null = null;

// function setupCronJob() {
//   if (emailCronJob) {
//     emailCronJob.stop();
//   }
//   const settings = db
//     .prepare("SELECT * FROM email_settings LIMIT 1")
//     .get() as any;
//   if (!settings || !settings.schedule_time || !settings.emails) return;

//   const [hour, minute] = settings.schedule_time.split(":");
//   if (!hour || !minute) return;

//   emailCronJob = cron.schedule(`${minute} ${hour} * * *`, async () => {
//     try {
//       console.log("Running scheduled email job...");
//       await sendDailyReportEmail(settings);
//     } catch (err: any) {
//       const isAuthError =
//         err.message &&
//         (err.message.includes("535") ||
//           err.message.toLowerCase().includes("invalid login") ||
//           err.message.toLowerCase().includes("credentials"));
//       if (isAuthError) {
//         console.warn(
//           "Scheduled email failed: SMTP authentication error (535). Please verify SMTP User & App Password."
//         );
//       } else {
//         console.error("Failed to send scheduled email:", err);
//       }
//     }
//   });
// }

// function formatDurationHHMMSS(minutes: number) {
//   const hrs = Math.floor(minutes / 60);
//   const mins = Math.floor(minutes % 60);
//   const secs = Math.floor((minutes * 60) % 60);
//   return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
// }

// function formatDurationInWords(minutes: number) {
//   const hrs = Math.floor(minutes / 60);
//   const mins = Math.floor(minutes % 60);
//   const secs = Math.floor((minutes * 60) % 60);

//   const parts = [];
//   if (hrs > 0) parts.push(`${hrs} hour${hrs !== 1 ? "s" : ""}`);
//   if (mins > 0) parts.push(`${mins} minute${mins !== 1 ? "s" : ""}`);
//   if (secs > 0 || (hrs === 0 && mins === 0))
//     parts.push(`${secs} second${secs !== 1 ? "s" : ""}`);

//   return parts.join(" ");
// }

// async function sendDailyReportEmail(settings: any, isTest: boolean = false) {
//   if (
//     !settings.smtp_host ||
//     !settings.smtp_port ||
//     !settings.smtp_user ||
//     !settings.smtp_pass
//   ) {
//     console.error("SMTP settings are incomplete");
//     if (isTest) throw new Error("SMTP settings are incomplete");
//     return;
//   }

//   const cleanHost = settings.smtp_host.trim();
//   const cleanUser = settings.smtp_user.trim();
//   let cleanPass = settings.smtp_pass.trim();

//   if (cleanPass.replace(/\s/g, "").length === 16) {
//     cleanPass = cleanPass.replace(/\s/g, "");
//   }

//   const transporter = nodemailer.createTransport({
//     host: cleanHost,
//     port: settings.smtp_port,
//     secure: settings.smtp_port === 465,
//     auth: {
//       user: cleanUser,
//       pass: cleanPass,
//     },
//   });

//   // Generate report's date string.
//   // If schedule_time is late in the day (e.g., >= 12:00), we report on "today".
//   // Otherwise, if scheduled in the morning, we report on "yesterday".
//   let reportDate = new Date();
//   const scheduleTime = settings.schedule_time || "20:00";
//   const [hourStr] = scheduleTime.split(":");
//   const hourVal = parseInt(hourStr || "20", 10);

//   if (hourVal < 12) {
//     reportDate.setDate(reportDate.getDate() - 1);
//   }

//   let startOfDay = new Date(reportDate.setHours(0, 0, 0, 0)).toISOString();
//   let endOfDay = new Date(reportDate.setHours(23, 59, 59, 999)).toISOString();

//   const nodes = db.prepare("SELECT id, alias FROM nodes").all() as any[];
//   let reportData: any = {};
//   let hasData = false;

//   for (const node of nodes) {
//     const logs = db
//       .prepare(
//         "SELECT * FROM telemetry WHERE device_id = ? AND on_time >= ? AND on_time <= ? ORDER BY on_time DESC"
//       )
//       .all(node.id, startOfDay, endOfDay) as any[];
//     reportData[node.alias || node.id] = logs;
//     if (logs.length > 0) {
//       hasData = true;
//     }
//   }

//   // If sending a test email and there is no telemetry for the computed date,
//   // automatically fall back to the most recent day with telemetry data to guarantee an Excel attachment.
//   if (!hasData && isTest) {
//     // If absolutely no telemetry exists in the database, insert a dummy entry so we have something to attach!
//     const telemetryCountObj = db
//       .prepare("SELECT COUNT(*) as count FROM telemetry")
//       .get() as any;
//     if (!telemetryCountObj || telemetryCountObj.count === 0) {
//       console.log(
//         "No telemetry exists in the entire DB. Inserting dummy telemetry for test email."
//       );
//       const dummyOn = new Date();
//       dummyOn.setHours(9, 0, 0, 0);
//       const dummyOff = new Date();
//       dummyOff.setHours(11, 30, 0, 0);
//       db.prepare(
//         "INSERT INTO telemetry (device_id, on_time, off_time, duration_minutes) VALUES (?, ?, ?, ?)"
//       ).run("line_01", dummyOn.toISOString(), dummyOff.toISOString(), 150);
//     }

//     const latestTelemetry = db
//       .prepare("SELECT on_time FROM telemetry ORDER BY on_time DESC LIMIT 1")
//       .get() as any;
//     if (latestTelemetry && latestTelemetry.on_time) {
//       const fallbackDate = new Date(latestTelemetry.on_time);
//       startOfDay = new Date(fallbackDate.setHours(0, 0, 0, 0)).toISOString();
//       endOfDay = new Date(fallbackDate.setHours(23, 59, 59, 999)).toISOString();

//       // Re-fetch using fallback date
//       reportData = {};
//       for (const node of nodes) {
//         const logs = db
//           .prepare(
//             "SELECT * FROM telemetry WHERE device_id = ? AND on_time >= ? AND on_time <= ? ORDER BY on_time DESC"
//           )
//           .all(node.id, startOfDay, endOfDay) as any[];
//         reportData[node.alias || node.id] = logs;
//         if (logs.length > 0) {
//           hasData = true;
//         }
//       }
//       console.log(
//         `Test email fallback active: Found latest telemetry data on ${new Date(startOfDay).toLocaleDateString("en-US")}. Generating attachment for this date.`
//       );
//     }
//   }

//   // Create Excel buffer
//   const workbook = new ExcelJS.Workbook();
//   hasData = false;

//   for (const [nodeName, logs] of Object.entries(reportData)) {
//     const data = logs as any[];
//     if (data.length === 0) continue;
//     hasData = true;

//     // clean sheet name
//     const sheetName = nodeName.substring(0, 31).replace(/[\\/*?:\[\]]/g, "");
//     const sheet = workbook.addWorksheet(sheetName);

//     const startDate = startOfDay;
//     const endDate = endOfDay;

//     sheet.addRow([`Telemetry Report for Node: ${nodeName}`]);
//     sheet.addRow([`Date: ${new Date(startDate).toLocaleDateString("en-US")}`]);
//     sheet.addRow([]);

//     sheet.getCell("A1").font = { size: 16, bold: true };
//     sheet.getCell("A2").font = { size: 14 };

//     const headerRow = sheet.addRow([
//       "Date",
//       "ON Time",
//       "OFF Time",
//       "Working Time",
//       "Working Time(In Words)",
//     ]);

//     headerRow.eachCell((cell) => {
//       cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
//       cell.fill = {
//         type: "pattern",
//         pattern: "solid",
//         fgColor: { argb: "FF2980B9" },
//       };
//       cell.alignment = { vertical: "middle", horizontal: "center" };
//     });

//     data.forEach((log) => {
//       sheet.addRow([
//         new Date(log.on_time).toLocaleDateString("en-US"),
//         new Date(log.on_time).toLocaleString("en-US"),
//         new Date(log.off_time).toLocaleString("en-US"),
//         formatDurationHHMMSS(log.duration_minutes),
//         formatDurationInWords(log.duration_minutes),
//       ]);
//     });

//     const totalMinutes = data.reduce(
//       (acc, curr) => acc + curr.duration_minutes,
//       0
//     );
//     const totalRow = sheet.addRow([
//       "Total",
//       "",
//       "",
//       formatDurationHHMMSS(totalMinutes),
//       formatDurationInWords(totalMinutes),
//     ]);

//     totalRow.eachCell((cell) => {
//       cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
//       cell.fill = {
//         type: "pattern",
//         pattern: "solid",
//         fgColor: { argb: "FF2980B9" },
//       };
//     });

//     sheet.columns.forEach((column, index) => {
//       let maxLength = 0;
//       column.eachCell({ includeEmpty: true }, (cell, rowNumber) => {
//         if (rowNumber > 3) {
//           const columnLength = cell.value ? cell.value.toString().length : 10;
//           if (columnLength > maxLength) {
//             maxLength = columnLength;
//           }
//         }
//       });
//       column.width = maxLength < 10 ? 10 : maxLength + 2;
//     });
//   }

//   if (!hasData) {
//     if (isTest) {
//       console.log(
//         "No data for the report date. Sending test email without attachment."
//       );
//       const mailOptions = {
//         from: `"Factory Portal" <${settings.smtp_user}>`,
//         to: settings.emails,
//         subject: `Test Daily Telemetry Report - ${new Date(startOfDay).toLocaleDateString("en-US")}`,
//         text: `This is a test email from Factory Portal. There is no telemetry data for ${new Date(startOfDay).toLocaleDateString("en-US")}, so no Excel file is attached.`,
//       };
//       const info = await transporter.sendMail(mailOptions);
//       console.log("Test report email sent to", settings.emails);
//       return info;
//     }
//     console.log(
//       `No data for ${new Date(startOfDay).toLocaleDateString("en-US")}. Skipping email report.`
//     );
//     return null;
//   }

//   const buffer = await workbook.xlsx.writeBuffer();

//   const mailOptions = {
//     from: `"Factory Portal" <${settings.smtp_user}>`,
//     to: settings.emails,
//     subject: `Daily Telemetry Report - ${new Date(startOfDay).toLocaleDateString("en-US")}`,
//     text: "Please find the attached daily telemetry report.",
//     attachments: [
//       {
//         filename: `Daily_Report_${new Date(startOfDay).toISOString().split("T")[0]}.xlsx`,
//         content: Buffer.from(buffer),
//         contentType:
//           "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
//       },
//     ],
//   };

//   const info = await transporter.sendMail(mailOptions);
//   console.log("Daily report email sent to", settings.emails);
//   return info;
// }

// setupCronJob();

// // --- Vite Integration ---
// if (process.env.NODE_ENV !== "production") {
//   const vite = await createViteServer({
//     server: { middlewareMode: true },
//     appType: "spa",
//   });
//   app.use(vite.middlewares);
// } else {
//   const distPath = path.join(process.cwd(), "dist");
//   app.use(express.static(distPath));
//   app.get("*", (req, res) => {
//     res.sendFile(path.join(distPath, "index.html"));
//   });
// }

// app.use(
//   (
//     err: any,
//     req: express.Request,
//     res: express.Response,
//     next: express.NextFunction
//   ) => {
//     console.error("Express error:", err);
//     if (!res.headersSent) {
//       res
//         .status(err.status || 500)
//         .json({ error: err.message || "Internal Server Error" });
//     }
//   }
// );

// app.listen(PORT, "0.0.0.0", () => {
//   console.log(`Server running on http://localhost:${PORT}`);
// });

// process.on("SIGINT", () => {
//   process.exit();
// });

// process.on("uncaughtException", (err) => {
//   console.error("Uncaught Exception:", err.message);
// });

// process.on("unhandledRejection", (reason, promise) => {
//   console.error("Unhandled Rejection at:", promise, "reason:", reason);
// });
