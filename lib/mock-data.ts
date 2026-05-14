export type NodeStatus = 'active' | 'idle' | 'offline';

export interface MaintenanceEntry {
  id: string;
  date: string;
  technician: string;
  eventType: string;
  notes: string;
}

export interface NodeData {
  id: string;
  alias: string;
  status: NodeStatus;
  lastHeartbeat: Date;
  uptimeSec: number;
  machinePowerActive: boolean;
  xrayStatus: boolean;
  weeklyRunHours: { day: string; hours: number }[];
  monthlyRunHours: { week: string; hours: number }[];
  lifetimeRunHours: number;
  lifetimeAnchorDate: string;
  maintenanceLog: MaintenanceEntry[];
}

export const generateMockNodes = (): NodeData[] => {
  return Array.from({ length: 20 }).map((_, i) => {
    const id = `line_${(i + 1).toString().padStart(2, '0')}`;
    // Random status
    const statuses: NodeStatus[] = ['active', 'idle', 'offline'];
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    
    // If active, it means power active and xray active.
    // If idle, power active, xray inactive.
    // If offline, power inactive, xray inactive (or watchdog timeout).
    
    const isMaintenance = Math.random() > 0.5;
    
    return {
      id,
      alias: i === 0 ? 'X-Ray Monitor - Line 01' : `Sensor System - Line ${String(i + 1).padStart(2, '0')}`,
      status,
      lastHeartbeat: status === 'offline' ? new Date(Date.now() - 1000 * 60 * 15) : new Date(Date.now() - 1000 * 30),
      uptimeSec: status === 'offline' ? 0 : Math.floor(Math.random() * 86400 * 10),
      machinePowerActive: status !== 'offline',
      xrayStatus: status === 'active',
      weeklyRunHours: [
        { day: 'Mon', hours: Math.random() * 8 },
        { day: 'Tue', hours: Math.random() * 8 },
        { day: 'Wed', hours: Math.random() * 8 },
        { day: 'Thu', hours: Math.random() * 8 },
        { day: 'Fri', hours: Math.random() * 8 },
        { day: 'Sat', hours: Math.random() * 4 },
        { day: 'Sun', hours: Math.random() * 2 },
      ],
      monthlyRunHours: [
        { week: 'Week 1', hours: Math.random() * 40 },
        { week: 'Week 2', hours: Math.random() * 40 },
        { week: 'Week 3', hours: Math.random() * 40 },
        { week: 'Week 4', hours: Math.random() * 40 },
      ],
      lifetimeRunHours: Math.floor(Math.random() * 1000) + 100,
      lifetimeAnchorDate: '2026-01-01T00:00:00Z',
      maintenanceLog: Array.from({ length: 5 }).map((_, j) => ({
        id: Math.random().toString(36).substring(7),
        date: new Date(Date.now() - 1000 * 60 * 60 * 24 * j * 7).toISOString(),
        technician: ['Alice', 'Bob', 'Charlie'][Math.floor(Math.random() * 3)],
        eventType: ['Calibration', 'Hardware Replaced', 'Cleaning', 'Firmware Update'][Math.floor(Math.random() * 4)],
        notes: `Routine checks passed for ${j}. Everything looks good.`,
      })),
    };
  });
};
