import express from "express";
import cors from "cors";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import mqtt from "mqtt";
import Database from "better-sqlite3";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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
        await bot.sendMessage(chatId, `🚨 FACTORY ALERT: ${message}`);
      }
    } catch (err: any) {
      console.error("Failed to send Telegram alert:", err.message);
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
    AND datetime(last_heartbeat, '+${watchdogTimeout} minutes') < CURRENT_TIMESTAMP
  `
    )
    .all();

  offlineNodes.forEach((node: any) => {
    db.prepare("UPDATE nodes SET status = 'offline' WHERE id = ?").run(node.id);
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
const requireAdmin = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  const accessLevel = req.headers["x-access-level"];
  if (accessLevel !== "Admin") {
    return res.status(403).json({ error: "Forbidden: Admin access required" });
  }
  next();
};

app.get("/api/nodes", (req, res) => {
  try {
    const nodes = db.prepare("SELECT * FROM nodes").all();
    res.json(nodes);
  } catch (err: any) {
    console.error("Error fetching nodes:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/nodes/:id/alias", (req, res) => {
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

app.get("/api/nodes/:id/telemetry", async (req, res) => {
  const { id } = req.params;
  const { range = "7d" } = req.query;

  try {
    const days = range === "30d" ? 30 : 7;
    const records = db
      .prepare(
        `
      SELECT 
        date(off_time) as date,
        SUM(duration_minutes) / 60.0 as hours
      FROM telemetry
      WHERE device_id = ?
        AND off_time >= datetime('now', '-' || ? || ' days')
      GROUP BY date(off_time)
      ORDER BY date(off_time) ASC
    `
      )
      .all(id, days) as any[];

    const datesMap = new Map();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ymd = d.toISOString().split("T")[0];
      datesMap.set(ymd, 0);
    }
    for (const row of records) {
      if (row.date) datesMap.set(row.date, row.hours);
    }

    const result = Array.from(datesMap.entries()).map(([dateStr, hours]) => {
      const d = new Date(dateStr);
      return {
        rawDate: dateStr,
        date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        hours,
      };
    });

    res.json(result);
  } catch (err: any) {
    console.error("SQLite telemetry query failed:", err.message || err);
    res.status(500).json({ error: "Query failed" });
  }
});

app.get("/api/nodes/:id/telemetry/details", async (req, res) => {
  const { id } = req.params;
  const { date } = req.query; // Expected format: YYYY-MM-DD or similar

  if (!date || typeof date !== "string") {
    return res.status(400).json({ error: "Date is required" });
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
        AND date(off_time) = ?
      ORDER BY off_time ASC
    `
      )
      .all(id, date);

    res.json(records);
  } catch (err: any) {
    console.error("SQLite telemetry details query failed:", err.message);
    res.status(500).json({ error: "Query failed" });
  }
});

app.get("/api/nodes/:id/lifetime-hours", async (req, res) => {
  const { id } = req.params;

  try {
    const row = db
      .prepare(
        `
      SELECT SUM(duration_minutes) / 60.0 as hours
      FROM telemetry
      WHERE device_id = ?
    `
      )
      .get(id) as any;
    res.json({ hours: row?.hours || 0 });
  } catch (err: any) {
    res.json({ hours: 0 });
  }
});

app.get("/api/nodes/:id/logs", (req, res) => {
  const logs = db
    .prepare(
      "SELECT * FROM maintenance_logs WHERE node_id = ? ORDER BY created_at DESC"
    )
    .all(req.params.id);
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
  db.prepare(
    "UPDATE nodes SET lifetime_anchor_date = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(req.params.id);
  res.json({ success: true });
});

app.get("/api/config", requireAdmin, (req, res) => {
  const config = db.prepare("SELECT key, value FROM config").all();
  res.json(config);
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

app.post("/api/config", requireAdmin, (req, res) => {
  const { key, value } = req.body;
  if (key && value) {
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
      key,
      value
    );
    res.json({ success: true });
  } else {
    res.status(400).json({ error: "Missing key or value" });
  }
});

app.get("/api/notifications", (req, res) => {
  try {
    const notifications = db
      .prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50")
      .all();
    res.json(notifications);
  } catch (err: any) {
    console.error("Error fetching notifications:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/notifications/:id/read", (req, res) => {
  db.prepare("UPDATE notifications SET is_read = 1 WHERE id = ?").run(
    req.params.id
  );
  res.json({ success: true });
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
