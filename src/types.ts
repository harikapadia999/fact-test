export interface Node {
  id: string;
  alias: string;
  status: "online" | "offline";
  last_heartbeat: string;
  lifetime_anchor_date: string;
  xray_active_since?: string;
}

export interface TelemetryData {
  date: string;
  hours: number;
}

export interface MaintenanceLog {
  id: number;
  technician_name: string;
  event_type: string;
  notes: string;
  created_at: string;
}

export interface Notification {
  id: number;
  node_id: string | null;
  message: string;
  type: "offline" | "safety" | "alert";
  created_at: string;
  is_read: number;
}

export interface TelemetryDetails {
  onTime: string;
  offTime: string;
  durationMinutes: number;
}
