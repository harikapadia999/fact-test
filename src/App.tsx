import React, { useState, useEffect } from "react";
import {
  Lock,
  ChevronRight,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  Bell,
  AlertTriangle,
  X,
  Settings,
  Menu,
  Pencil,
  Plus,
  Trash2,
  Database,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  LabelList,
} from "recharts";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "./lib/utils";
import { useIsMobile } from "../hooks/use-mobile";
import { io } from "socket.io-client";

const baseUrl = import.meta.env.VITE_API_URL || "";
const socket = io(baseUrl || window.location.origin);

// --- Types ---
interface Node {
  id: string;
  alias: string;
  status: "online" | "offline";
  last_heartbeat: string;
  lifetime_anchor_date: string;
}

interface TelemetryData {
  date: string;
  hours: number;
}

interface MaintenanceLog {
  id: number;
  technician_name: string;
  event_type: string;
  notes: string;
  created_at: string;
}

interface Notification {
  id: number;
  node_id: string | null;
  message: string;
  type: "offline" | "safety" | "alert";
  created_at: string;
  is_read: number;
}

interface TelemetryDetails {
  onTime: string;
  offTime: string;
  durationMinutes: number;
}

const formatDuration = (minutes: number) => {
  if (minutes === 0) return "0 sec";
  if (minutes < 1) {
    return `${Math.round(minutes * 60)} sec`;
  } else if (minutes < 60) {
    return `${minutes.toFixed(1)} min`;
  } else {
    return `${(minutes / 60).toFixed(2)} hrs`;
  }
};

const fetchJson = async (endpoint: string, options?: RequestInit) => {
  const baseUrl = import.meta.env.VITE_API_URL || "";
  const url = endpoint.startsWith("http") ? endpoint : `${baseUrl}${endpoint}`;
  const res = await fetch(url, options);
  const contentType = res.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP error ${res.status}`);
    return data;
  }
  if (!res.ok) throw new Error(`HTTP error ${res.status}`);
  return null;
};

export default function App() {
  const isMobile = useIsMobile();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryData[]>([]);
  const [logs, setLogs] = useState<MaintenanceLog[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [accessLevel, setAccessLevel] = useState<"Admin" | "Technician">(
    "Technician"
  );
  const [analyticsView, setAnalyticsView] = useState<"Weekly" | "Monthly">(
    "Weekly"
  );
  const [loading, setLoading] = useState(true);
  const [showLogModal, setShowLogModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isEditingSelectedAlias, setIsEditingSelectedAlias] = useState(false);
  const [editingAlias, setEditingAlias] = useState("");
  const [showAddNodeModal, setShowAddNodeModal] = useState(false);
  const [nodeToDelete, setNodeToDelete] = useState<string | null>(null);
  const [newNodeId, setNewNodeId] = useState("");
  const [newNodeAlias, setNewNodeAlias] = useState("");
  const [addNodeError, setAddNodeError] = useState<string | null>(null);
  const [newLog, setNewLog] = useState({
    technician_name: "",
    event_type: "Maintenance",
    notes: "",
  });
  const [config, setConfig] = useState<Record<string, string>>({});

  const [lifetimeHours, setLifetimeHours] = useState<number>(0);
  const [showDetailedReport, setShowDetailedReport] = useState(false);
  const [detailedReportDate, setDetailedReportDate] = useState<string>(
    new Date(Date.now() + 5.5 * 3600000).toISOString().split("T")[0]
  );
  const [detailedReportData, setDetailedReportData] = useState<
    TelemetryDetails[]
  >([]);
  const [loadingDetails, setLoadingDetails] = useState(false);

  const [showDbViewer, setShowDbViewer] = useState(false);
  const [dbData, setDbData] = useState<Record<string, any[]>>({});
  const [selectedTable, setSelectedTable] = useState<string>("");

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || nodes[0];

  useEffect(() => {
    if (selectedNode) {
      setEditingAlias(selectedNode.alias || selectedNode.id);
    }
  }, [selectedNodeId, nodes]);

  const handleUpdateAlias = async () => {
    if (!selectedNode) return;
    try {
      await fetchJson(`/api/nodes/${selectedNode.id}/alias`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: editingAlias }),
      });
      setIsEditingSelectedAlias(false);
      fetchNodes();
    } catch (err) {
      console.error("Failed to update alias:", err);
    }
  };

  const handleAddNode = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddNodeError(null);
    try {
      await fetchJson("/api/nodes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-access-level": accessLevel,
        },
        body: JSON.stringify({ id: newNodeId, alias: newNodeAlias }),
      });
      setShowAddNodeModal(false);
      setNewNodeId("");
      setNewNodeAlias("");
      fetchNodes();
    } catch (err: any) {
      console.error("Failed to add node:", err);
      setAddNodeError(err.message || "An unexpected error occurred");
    }
  };

  const handleDeleteNode = async () => {
    if (!nodeToDelete) return;
    try {
      await fetchJson(`/api/nodes/${nodeToDelete}`, {
        method: "DELETE",
        headers: { "x-access-level": accessLevel },
      });
      if (selectedNodeId === nodeToDelete) setSelectedNodeId(null);
      setNodeToDelete(null);
      fetchNodes();
    } catch (err) {
      console.error("Failed to delete node:", err);
    }
  };

  useEffect(() => {
    fetchNodes();
    fetchNotifications();

    socket.on("status_update", (data) => {
      setNodes((prev) =>
        prev.map((n) =>
          n.id === data.nodeId
            ? {
                ...n,
                status: data.status,
                last_heartbeat: new Date().toISOString(),
              }
            : n
        )
      );
    });

    socket.on("xray_status_update", (data) => {
      setNodes((prev) =>
        prev.map((n) =>
          n.id === data.nodeId
            ? {
                ...n,
                xray_active_since: data.isActive
                  ? new Date().toISOString()
                  : null,
              }
            : n
        )
      );
    });

    socket.on("telemetry_update", (data) => {
      if (selectedNodeId === data.nodeId) {
        fetchTelemetry(data.nodeId);
        fetchJson(`/api/nodes/${data.nodeId}/lifetime-hours`)
          .then((res) => setLifetimeHours(res.hours || 0))
          .catch(console.error);
      }
    });

    socket.on("new_node", () => {
      fetchNodes();
    });

    socket.on("new_notification", () => {
      fetchNotifications();
    });

    return () => {
      socket.off("status_update");
      socket.off("xray_status_update");
      socket.off("telemetry_update");
      socket.off("new_node");
      socket.off("new_notification");
    };
  }, [selectedNodeId, analyticsView]);

  useEffect(() => {
    if (selectedNodeId) {
      fetchTelemetry(selectedNodeId);
      fetchLogs(selectedNodeId);
      fetchJson(`/api/nodes/${selectedNodeId}/lifetime-hours`)
        .then((data) => setLifetimeHours(data.hours || 0))
        .catch(console.error);

      // Periodically refresh telemetry to show live ticking updates when machine is active
      const interval = setInterval(() => {
        fetchTelemetry(selectedNodeId);
        fetchJson(`/api/nodes/${selectedNodeId}/lifetime-hours`)
          .then((data) => setLifetimeHours(data.hours || 0))
          .catch(console.error);
      }, 10000);

      return () => clearInterval(interval);
    }
  }, [selectedNodeId, analyticsView]);

  const fetchNodes = async () => {
    try {
      const data = await fetchJson("/api/nodes");
      const nodesData = data || [];
      setNodes(nodesData);
      if (!selectedNodeId && nodesData.length > 0) {
        setSelectedNodeId(nodesData[0].id);
      }
      setLoading(false);
    } catch (err) {
      console.error("Failed to fetch nodes:", err);
      setLoading(false);
    }
  };

  const fetchNotifications = async () => {
    try {
      const data = await fetchJson("/api/notifications");
      setNotifications(data || []);
    } catch (err) {
      console.error("Failed to fetch notifications:", err);
    }
  };

  const markNotificationAsRead = async (id: number) => {
    try {
      await fetchJson(`/api/notifications/${id}/read`, { method: "POST" });
      fetchNotifications();
    } catch (err) {
      console.error("Failed to mark notification as read:", err);
    }
  };

  const fetchTelemetry = async (id: string) => {
    try {
      const range = analyticsView === "Weekly" ? "7d" : "30d";
      const data = await fetchJson(`/api/nodes/${id}/telemetry?range=${range}`);
      const telemetryData = data || [];
      const processedData = telemetryData.map((d: any) => ({
        ...d,
        hours: d.hours || 0,
        rawDate:
          d.rawDate ||
          new Date(
            Date.now() +
              5.5 * 3600000 -
              (telemetryData.length - 1 - telemetryData.indexOf(d)) *
                24 *
                60 *
                60 *
                1000
          )
            .toISOString()
            .split("T")[0], // Approximation for click handler
      }));
      setTelemetry(processedData);
    } catch (err) {
      console.error("Failed to fetch telemetry:", err);
    }
  };

  useEffect(() => {
    if (showDetailedReport && selectedNodeId && detailedReportDate) {
      const fetchDetails = async () => {
        setLoadingDetails(true);
        try {
          const details = await fetchJson(
            `/api/nodes/${selectedNodeId}/telemetry/details?date=${detailedReportDate}`
          );
          setDetailedReportData(details || []);
        } catch (err) {
          console.error("Failed to fetch detailed report:", err);
          setDetailedReportData([]);
        } finally {
          setLoadingDetails(false);
        }
      };
      fetchDetails();
    }
  }, [showDetailedReport, selectedNodeId, detailedReportDate]);

  const fetchLogs = async (id: string) => {
    try {
      const data = await fetchJson(`/api/nodes/${id}/logs`);
      setLogs(data || []);
    } catch (err) {
      console.error("Failed to fetch logs:", err);
    }
  };

  const fetchConfig = async () => {
    if (accessLevel !== "Admin") return;
    try {
      const data = await fetchJson("/api/config", {
        headers: { "x-access-level": accessLevel },
      });
      if (data) {
        const configObj = data.reduce(
          (acc: any, curr: any) => ({ ...acc, [curr.key]: curr.value }),
          {}
        );
        setConfig(configObj);
      }
    } catch (err) {
      console.error("Failed to fetch config:", err);
    }
  };

  useEffect(() => {
    if (accessLevel === "Admin") {
      fetchConfig();
    }
  }, [accessLevel]);

  const handleSaveConfig = async (key: string, value: string) => {
    try {
      await fetchJson("/api/config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-access-level": accessLevel,
        },
        body: JSON.stringify({ key, value }),
      });
      fetchConfig();
    } catch (err) {
      console.error("Failed to save config:", err);
    }
  };

  const fetchDatabaseDump = async () => {
    try {
      const data = await fetchJson("/api/database-dump", {
        headers: { "x-access-level": accessLevel },
      });
      setDbData(data || {});
      if (data && Object.keys(data).length > 0) {
        setSelectedTable(Object.keys(data)[0]);
      }
    } catch (err) {
      console.error("Failed to fetch DB dump:", err);
    }
  };

  const handleAddLog = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedNodeId) return;
    try {
      await fetchJson(`/api/nodes/${selectedNodeId}/logs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-access-level": accessLevel,
        },
        body: JSON.stringify(newLog),
      });
      setShowLogModal(false);
      setNewLog({ technician_name: "", event_type: "Maintenance", notes: "" });
      fetchLogs(selectedNodeId);
    } catch (err) {
      console.error("Failed to add log:", err);
    }
  };

  const handleResetLifetime = async () => {
    if (!selectedNode || accessLevel !== "Admin") return;
    try {
      await fetchJson(`/api/nodes/${selectedNode.id}/reset-lifetime`, {
        method: "POST",
        headers: { "x-access-level": accessLevel },
      });
      fetchNodes();
    } catch (err) {
      console.error("Failed to reset lifetime:", err);
    }
  };

  // Old block removed

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f4f4f5] flex items-center justify-center p-4">
        <div className="animate-pulse text-slate-500 font-medium">
          Loading Factory System...
        </div>
      </div>
    );
  }

  if (!selectedNode) {
    return (
      <div className="min-h-screen bg-[#f4f4f5] flex flex-col items-center justify-center p-4">
        <div className="bg-white p-8 rounded-2xl shadow-xl flex flex-col items-center max-w-md text-center">
          <h2 className="text-2xl font-bold text-slate-800 mb-2">
            No Devices Available
          </h2>
          <p className="text-slate-500 mb-6">
            Could not connect to the backend system, or no factory nodes are
            provisioned. Please check your connection or setup VITE_API_URL.
          </p>
          <button
            onClick={() => fetchNodes()}
            className="px-6 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  const sinceDate = new Date(
    selectedNode.lifetime_anchor_date
  ).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });

  return (
    <div className="min-h-screen bg-[#f4f4f5] flex items-center justify-center p-0 md:p-8 font-sans">
      {/* Main Container Card */}
      <div className="w-full max-w-7xl bg-white rounded-none md:rounded-2xl shadow-xl overflow-hidden flex flex-col border-0 md:border md:border-slate-200 min-h-screen md:min-h-[85vh]">
        {/* Header Section */}
        <div className="px-4 md:px-8 py-4 md:py-6 flex flex-col lg:flex-row items-start lg:items-center justify-between border-b border-slate-100 gap-4 lg:gap-0">
          <div className="flex items-center justify-between w-full lg:w-auto gap-4">
            <div className="flex items-center gap-2 md:gap-4">
              <button
                onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                className="p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-500 md:mr-2"
                title="Main menu"
              >
                <Menu className="w-6 h-6" />
              </button>
              <h1 className="text-xl md:text-2xl font-medium text-slate-800 tracking-tight">
                Factory Data Board
              </h1>
            </div>

            {/* Notifications & Settings */}
            <div className="relative flex items-center gap-1 md:gap-2 ml-auto lg:ml-4">
              <button
                onClick={() => setShowNotifications(!showNotifications)}
                className="p-2 hover:bg-slate-100 rounded-full transition-colors relative"
              >
                <Bell className="w-5 h-5 text-slate-400" />
                {notifications.some((n) => !n.is_read) && (
                  <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full border-2 border-white" />
                )}
              </button>

              {accessLevel === "Admin" && (
                <>
                  <button
                    onClick={() => {
                      setShowDbViewer(true);
                      fetchDatabaseDump();
                    }}
                    className="p-2 hover:bg-slate-100 rounded-full transition-colors relative"
                    title="Database Viewer"
                  >
                    <Database className="w-5 h-5 text-slate-400" />
                  </button>
                  <button
                    onClick={() => setShowSettingsModal(true)}
                    className="p-2 hover:bg-slate-100 rounded-full transition-colors relative"
                    title="Settings"
                  >
                    <Settings className="w-5 h-5 text-slate-400" />
                  </button>
                </>
              )}

              <AnimatePresence>
                {showNotifications && (
                  <motion.div
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.95 }}
                    className="absolute top-full left-0 mt-2 w-80 bg-white rounded-2xl shadow-2xl border border-slate-100 z-50 overflow-hidden"
                  >
                    <div className="p-4 border-b border-slate-50 flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-800 uppercase tracking-widest">
                        Notifications
                      </span>
                      <button onClick={() => setShowNotifications(false)}>
                        <X className="w-4 h-4 text-slate-400" />
                      </button>
                    </div>
                    <div className="max-h-96 overflow-y-auto">
                      {notifications.length > 0 ? (
                        notifications.map((n) => (
                          <div
                            key={n.id}
                            onClick={() => markNotificationAsRead(n.id)}
                            className={cn(
                              "p-4 border-b border-slate-50 last:border-0 hover:bg-slate-50 transition-colors cursor-pointer flex gap-3",
                              !n.is_read && "bg-blue-50/50"
                            )}
                          >
                            <div
                              className={cn(
                                "w-8 h-8 rounded-full flex items-center justify-center shrink-0",
                                n.type === "safety"
                                  ? "bg-red-100 text-red-600"
                                  : "bg-blue-100 text-blue-600"
                              )}
                            >
                              {n.type === "safety" ? (
                                <AlertTriangle className="w-4 h-4" />
                              ) : (
                                <Bell className="w-4 h-4" />
                              )}
                            </div>
                            <div className="space-y-1">
                              <p className="text-xs text-slate-700 leading-tight">
                                {n.message}
                              </p>
                              <span className="text-[10px] text-slate-400">
                                {new Date(n.created_at).toLocaleTimeString(
                                  "en-US",
                                  { timeZone: "Asia/Kolkata" }
                                )}
                              </span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="p-8 text-center text-slate-400 text-xs italic">
                          No notifications
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          <div className="flex gap-4 md:gap-6 overflow-x-auto w-full lg:w-auto pb-2 lg:pb-0 no-scrollbar items-center">
            <div className="flex flex-col shrink-0">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">
                Status
              </span>
              <span className="text-sm font-bold text-slate-900 font-mono tracking-tight">
                {selectedNode.status === "online" ? "ACTIVE" : "OFFLINE"}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">
                Bulb Usage
              </span>
              <span className="text-sm font-bold text-slate-900 font-mono tracking-tight">
                {Math.round(lifetimeHours)} / 1000 hrs
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">
                Since
              </span>
              <span className="text-sm font-bold text-slate-900 font-mono tracking-tight">
                {sinceDate}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">
                Role
              </span>
              <span className="text-sm font-bold text-slate-900 font-mono tracking-tight">
                {accessLevel}
              </span>
            </div>
          </div>
        </div>

        {/* Body Section */}
        <div className="flex flex-col md:flex-row flex-1 min-h-[550px] relative">
          {/* Sidebar Desktop/Mobile Overlays */}
          {!isSidebarCollapsed && isMobile && (
            <div
              className="absolute inset-0 bg-slate-900/20 backdrop-blur-sm z-30"
              onClick={() => setIsSidebarCollapsed(true)}
            />
          )}

          {/* Sidebar */}
          <motion.div
            initial={false}
            animate={{
              width: isSidebarCollapsed
                ? isMobile
                  ? 0
                  : 80
                : isMobile
                  ? "100%"
                  : 256,
            }}
            className="bg-[#f8fafc] border-r border-slate-100 flex flex-col overflow-hidden absolute md:relative z-40 h-full max-w-[85vw] md:max-w-none shadow-2xl md:shadow-none"
          >
            <div
              className={cn(
                "px-6 py-4 flex items-center justify-between transition-opacity duration-200",
                isSidebarCollapsed ? "opacity-0" : "opacity-100"
              )}
            >
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">
                Node List
              </span>
              {accessLevel === "Admin" && (
                <button
                  onClick={() => setShowAddNodeModal(true)}
                  className="p-1 hover:bg-slate-200 rounded-md text-slate-400 hover:text-blue-600 transition-colors"
                  title="Add Node"
                >
                  <Plus className="w-4 h-4" />
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">
              {nodes.map((node) => (
                <div key={node.id} className="group relative">
                  <button
                    onClick={() => setSelectedNodeId(node.id)}
                    className={cn(
                      "w-full px-6 py-3 flex items-center transition-all duration-200 border-l-4",
                      isSidebarCollapsed
                        ? "justify-center px-0 border-l-0"
                        : "gap-3",
                      selectedNodeId === node.id
                        ? "bg-[#e0e7ff] border-blue-600 text-blue-900"
                        : "border-transparent hover:bg-slate-50 text-slate-700"
                    )}
                    title={
                      isSidebarCollapsed ? node.alias || node.id : undefined
                    }
                  >
                    <div
                      className={cn(
                        "w-2.5 h-2.5 rounded-full shrink-0 shadow-sm",
                        node.status === "online"
                          ? "bg-green-500"
                          : "bg-slate-300"
                      )}
                    />
                    {!isSidebarCollapsed && (
                      <span className="text-sm font-medium truncate flex-1">
                        {node.alias || node.id}
                      </span>
                    )}
                  </button>

                  {!isSidebarCollapsed && accessLevel === "Admin" && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setNodeToDelete(node.id);
                      }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                      title="Delete Node"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </motion.div>

          {/* Main Content Area */}
          <div className="flex-1 p-4 md:p-8 flex flex-col bg-white overflow-y-auto">
            {/* Node Title & Icon */}
            <div className="flex flex-col md:flex-row items-start justify-between mb-6 md:mb-8 gap-4 md:gap-0">
              <div className="space-y-2 w-full">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 md:gap-0">
                  <div className="flex flex-wrap items-center gap-3">
                    {isEditingSelectedAlias && accessLevel === "Admin" ? (
                      <input
                        autoFocus
                        className="text-3xl font-bold text-slate-800 tracking-tight bg-white border border-blue-300 rounded px-2 py-1 w-full max-w-xl focus:outline-none"
                        value={editingAlias}
                        onChange={(e) => setEditingAlias(e.target.value)}
                        onBlur={handleUpdateAlias}
                        onKeyDown={(e) =>
                          e.key === "Enter" && handleUpdateAlias()
                        }
                      />
                    ) : (
                      <div
                        className="group flex items-center gap-2 cursor-pointer"
                        onClick={() =>
                          accessLevel === "Admin" &&
                          setIsEditingSelectedAlias(true)
                        }
                      >
                        <h2 className="text-3xl font-bold text-slate-800 tracking-tight group-hover:text-blue-600 transition-colors">
                          {selectedNode.alias || selectedNode.id}
                        </h2>
                        {accessLevel === "Admin" && (
                          <Pencil className="w-5 h-5 text-slate-300 group-hover:text-blue-400 opacity-0 group-hover:opacity-100 transition-all" />
                        )}
                      </div>
                    )}
                    {selectedNode.xray_active_since && (
                      <motion.div
                        animate={{ scale: [1, 1.1, 1] }}
                        transition={{ repeat: Infinity, duration: 2 }}
                        className="flex items-center gap-1.5 px-3 py-1 bg-red-100 text-red-600 rounded-full border border-red-200"
                      >
                        <AlertTriangle className="w-3.5 h-3.5" />
                        <span className="text-[10px] font-bold uppercase tracking-wider">
                          Safety Warning
                        </span>
                      </motion.div>
                    )}
                  </div>

                  {accessLevel === "Admin" && (
                    <button
                      onClick={() => setNodeToDelete(selectedNode.id)}
                      className="flex items-center justify-center gap-2 px-4 py-2 text-red-600 hover:bg-red-50 rounded-xl transition-colors text-xs font-bold uppercase tracking-wider border border-transparent hover:border-red-100 w-full md:w-auto mt-2 md:mt-0 shadow-sm md:shadow-none bg-red-50 md:bg-transparent"
                    >
                      <Trash2 className="w-4 h-4" />
                      Delete Node
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Cards Area */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-6 mb-6 md:mb-8 max-w-full md:max-w-2xl">
              <div className="bg-[#f1f5f9] rounded-2xl p-6 aspect-square w-full max-h-48 flex flex-col justify-center items-center shadow-sm border border-slate-200 relative overflow-hidden">
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest absolute top-4 left-4">
                  X-Ray Status
                </span>
                {selectedNode.xray_active_since ? (
                  <>
                    <ShieldAlert className="w-10 h-10 text-red-500 mb-2" />
                    <h3 className="text-xl font-black text-slate-800 tracking-tight uppercase">
                      ACTIVE
                    </h3>
                    <span className="text-[10px] font-medium text-red-500 uppercase tracking-widest">
                      EMITTING RADIATION
                    </span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-10 h-10 text-green-500 mb-2" />
                    <h3 className="text-xl font-black text-slate-800 tracking-tight uppercase">
                      INACTIVE
                    </h3>
                    <span className="text-[10px] font-medium text-green-500 uppercase tracking-widest">
                      SAFE
                    </span>
                  </>
                )}
              </div>
              <div className="bg-[#f1f5f9] rounded-2xl p-6 aspect-square w-full max-h-48 flex flex-col justify-center items-center shadow-sm border border-slate-200 relative overflow-hidden">
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest absolute top-4 left-4">
                  Access Control
                </span>
                <Lock className="w-10 h-10 text-blue-300 mb-2" />
                <h3 className="text-xl font-black text-slate-800 tracking-tight uppercase">
                  {accessLevel}
                </h3>
                <span className="text-[10px] font-medium text-slate-500 uppercase tracking-widest">
                  {accessLevel === "Admin" ? "FULL ACCESS" : "READ ONLY"}
                </span>
              </div>
            </div>

            {/* Chart Area */}
            <div className="flex-1 min-h-[200px] mt-auto flex flex-col">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-medium text-slate-500 block">
                  ↑ Usage (Hours)
                </span>
                <button
                  onClick={() => setShowDetailedReport(true)}
                  className="text-[10px] font-bold text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded transition-colors"
                >
                  Detailed Report
                </button>
              </div>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={telemetry}
                  margin={{ top: 20, right: 0, left: -20, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="#f1f5f9"
                  />
                  <XAxis
                    dataKey="date"
                    axisLine={true}
                    tickLine={false}
                    tick={{ fontSize: 11, fill: "#64748b" }}
                    minTickGap={15}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 11, fill: "#64748b" }}
                  />
                  <Tooltip
                    cursor={{ fill: "#f8fafc" }}
                    formatter={(value: number) => [
                      formatDuration(value * 60),
                      "Usage",
                    ]}
                  />
                  <Bar
                    dataKey="hours"
                    fill="#1d4ed8"
                    radius={[4, 4, 0, 0]}
                    barSize={analyticsView === "Weekly" ? 40 : 12}
                  >
                    {analyticsView === "Weekly" && (
                      <LabelList
                        dataKey="hours"
                        position="top"
                        fill="#64748b"
                        fontSize={11}
                        formatter={(val: number) =>
                          val > 0
                            ? val * 60 < 1
                              ? "<1m"
                              : val < 1
                                ? `${Math.round(val * 60)}m`
                                : `${val.toFixed(1)}h`
                            : "0"
                        }
                      />
                    )}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div className="text-center mt-2 text-[11px] text-slate-500">
                {analyticsView} Period
              </div>
            </div>

            {/* Maintenance Ledger */}
            <div className="mt-8">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-slate-800 uppercase tracking-widest">
                  Maintenance Ledger
                </h3>
                <button
                  onClick={() => setShowLogModal(true)}
                  className="px-4 py-2 bg-blue-600 text-white text-xs font-bold rounded-full hover:bg-blue-700 transition-colors"
                >
                  + Add Entry
                </button>
              </div>
              <div className="bg-slate-50 rounded-2xl border border-slate-100 overflow-x-auto">
                <table className="w-full min-w-[500px] text-left text-sm">
                  <thead className="bg-slate-100/50 text-slate-500 text-[10px] uppercase tracking-widest">
                    <tr>
                      <th className="px-4 py-3 font-medium">Date</th>
                      <th className="px-4 py-3 font-medium">Technician</th>
                      <th className="px-4 py-3 font-medium">Event</th>
                      <th className="px-4 py-3 font-medium">Notes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {logs.length > 0 ? (
                      logs.map((log) => (
                        <tr key={log.id} className="text-slate-700">
                          <td className="px-4 py-3 whitespace-nowrap">
                            {new Date(log.created_at).toLocaleDateString(
                              "en-US",
                              { timeZone: "Asia/Kolkata" }
                            )}
                          </td>
                          <td className="px-4 py-3 font-medium">
                            {log.technician_name}
                          </td>
                          <td className="px-4 py-3">
                            <span className="px-2 py-1 bg-slate-200 text-slate-700 rounded-md text-[10px] font-bold uppercase tracking-wider">
                              {log.event_type}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-slate-500 truncate max-w-[200px]">
                            {log.notes}
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td
                          colSpan={4}
                          className="px-4 py-8 text-center text-slate-400 text-xs italic"
                        >
                          No maintenance logs found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        {/* Footer Controls */}
        <div className="bg-[#f8fafc] border-t border-slate-200 p-6 flex flex-col gap-6">
          <div className="flex items-center justify-between px-4">
            <div className="flex items-center gap-6">
              <span className="text-sm font-medium text-slate-600">
                Access Level
              </span>
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setAccessLevel("Admin")}
                  className={cn(
                    "text-sm font-medium transition-colors",
                    accessLevel === "Admin"
                      ? "text-slate-800"
                      : "text-slate-400 hover:text-slate-600"
                  )}
                >
                  Admin
                </button>
                <button
                  onClick={() => setAccessLevel("Technician")}
                  className={cn(
                    "px-6 py-1.5 rounded-full text-sm font-medium transition-colors border",
                    accessLevel === "Technician"
                      ? "bg-[#e0e7ff] text-blue-700 border-blue-200"
                      : "bg-transparent text-slate-400 border-transparent hover:text-slate-600"
                  )}
                >
                  Technician
                </button>
              </div>
            </div>

            <div className="flex items-center gap-6">
              <span className="text-sm font-medium text-slate-600">
                Analytics
              </span>
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setAnalyticsView("Weekly")}
                  className={cn(
                    "px-6 py-1.5 rounded-full text-sm font-medium transition-colors border",
                    analyticsView === "Weekly"
                      ? "bg-[#e0e7ff] text-blue-700 border-blue-200"
                      : "bg-transparent text-slate-400 border-transparent hover:text-slate-600"
                  )}
                >
                  Weekly
                </button>
                <button
                  onClick={() => setAnalyticsView("Monthly")}
                  className={cn(
                    "text-sm font-medium transition-colors",
                    analyticsView === "Monthly"
                      ? "text-slate-800"
                      : "text-slate-400 hover:text-slate-600"
                  )}
                >
                  Monthly
                </button>
              </div>
            </div>
          </div>

          <button
            onClick={handleResetLifetime}
            disabled={accessLevel !== "Admin"}
            className={cn(
              "w-full py-3 rounded-full font-medium text-sm transition-colors",
              accessLevel === "Admin"
                ? "bg-slate-200 text-slate-700 hover:bg-slate-300"
                : "bg-slate-100 text-slate-400 cursor-not-allowed"
            )}
          >
            Reset Lifetime Counter
          </button>
        </div>

        {/* Settings Modal */}
        <AnimatePresence>
          {showSettingsModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowSettingsModal(false)}
                className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
              />
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="relative w-full max-w-md bg-white rounded-[24px] md:rounded-[32px] p-6 md:p-8 shadow-2xl overflow-y-auto max-h-[85vh] no-scrollbar"
              >
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-xl font-black text-slate-800">
                    System Configuration
                  </h3>
                  <button onClick={() => setShowSettingsModal(false)}>
                    <X className="w-5 h-5 text-slate-400" />
                  </button>
                </div>
                <div className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      Telegram Bot Token
                    </label>
                    <input
                      type="text"
                      value={config.telegram_bot_token || ""}
                      onChange={(e) => {
                        setConfig({
                          ...config,
                          telegram_bot_token: e.target.value,
                        });
                        handleSaveConfig("telegram_bot_token", e.target.value);
                      }}
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      Telegram Chat ID
                    </label>
                    <input
                      type="text"
                      value={config.telegram_chat_id || ""}
                      onChange={(e) => {
                        setConfig({
                          ...config,
                          telegram_chat_id: e.target.value,
                        });
                        handleSaveConfig("telegram_chat_id", e.target.value);
                      }}
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      Watchdog Timeout (Mins)
                    </label>
                    <input
                      type="number"
                      value={config.watchdog_timeout_min || ""}
                      onChange={(e) => {
                        setConfig({
                          ...config,
                          watchdog_timeout_min: e.target.value,
                        });
                        handleSaveConfig(
                          "watchdog_timeout_min",
                          e.target.value
                        );
                      }}
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      Safety Timeout (Mins)
                    </label>
                    <input
                      type="number"
                      value={config.safety_timeout_min || ""}
                      onChange={(e) => {
                        setConfig({
                          ...config,
                          safety_timeout_min: e.target.value,
                        });
                        handleSaveConfig("safety_timeout_min", e.target.value);
                      }}
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                        Shift Start (Hour)
                      </label>
                      <input
                        type="number"
                        value={config.shift_start_hour || ""}
                        onChange={(e) => {
                          setConfig({
                            ...config,
                            shift_start_hour: e.target.value,
                          });
                          handleSaveConfig("shift_start_hour", e.target.value);
                        }}
                        className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                        Shift End (Hour)
                      </label>
                      <input
                        type="number"
                        value={config.shift_end_hour || ""}
                        onChange={(e) => {
                          setConfig({
                            ...config,
                            shift_end_hour: e.target.value,
                          });
                          handleSaveConfig("shift_end_hour", e.target.value);
                        }}
                        className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                      />
                    </div>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Detailed Report Modal */}
        <AnimatePresence>
          {showDetailedReport && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowDetailedReport(false)}
                className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
              />
              <motion.div
                initial={{ scale: 0.9, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.9, opacity: 0, y: 20 }}
                className="relative w-full max-w-2xl bg-white rounded-[24px] md:rounded-[32px] p-6 md:p-8 shadow-2xl overflow-hidden flex flex-col max-h-[85vh] md:max-h-[80vh]"
              >
                <div className="flex items-start justify-between mb-6 shrink-0">
                  <div>
                    <h3 className="text-xl font-black text-slate-800">
                      Detailed Report
                    </h3>
                    <div className="mt-3 flex items-center gap-2">
                      <label className="text-sm text-slate-500 font-medium">
                        Select Date:
                      </label>
                      <input
                        type="date"
                        value={detailedReportDate}
                        onChange={(e) => setDetailedReportDate(e.target.value)}
                        className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-slate-50"
                      />
                    </div>
                  </div>
                  <button
                    onClick={() => setShowDetailedReport(false)}
                    className="p-2 hover:bg-slate-100 rounded-full transition-colors"
                  >
                    <X className="w-5 h-5 text-slate-400" />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto min-h-0 pr-2">
                  {loadingDetails ? (
                    <div className="flex items-center justify-center py-12">
                      <RefreshCw className="w-8 h-8 text-blue-500 animate-spin" />
                    </div>
                  ) : detailedReportData.length === 0 ? (
                    <div className="text-center py-12 text-slate-500">
                      No detailed logs available for this date.
                    </div>
                  ) : (
                    <div className="bg-slate-50 rounded-2xl border border-slate-100 overflow-hidden">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-slate-100/50 text-slate-500 text-[10px] uppercase tracking-widest sticky top-0 backdrop-blur-md">
                          <tr>
                            <th className="px-4 py-3 font-medium">ON Time</th>
                            <th className="px-4 py-3 font-medium">OFF Time</th>
                            <th className="px-4 py-3 font-medium text-right">
                              Working Time
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {detailedReportData.map((log, i) => (
                            <tr
                              key={i}
                              className="hover:bg-slate-50/50 transition-colors"
                            >
                              <td className="px-4 py-3 font-mono text-slate-700">
                                {new Date(log.onTime).toLocaleTimeString(
                                  "en-US",
                                  { hour12: false, timeZone: "Asia/Kolkata" }
                                )}
                              </td>
                              <td className="px-4 py-3 font-mono text-slate-700">
                                {new Date(log.offTime).toLocaleTimeString(
                                  "en-US",
                                  { hour12: false, timeZone: "Asia/Kolkata" }
                                )}
                              </td>
                              <td className="px-4 py-3 font-mono text-slate-900 font-medium text-right">
                                {formatDuration(log.durationMinutes)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="bg-slate-100/50 font-bold text-slate-900 border-t-2 border-slate-200 sticky bottom-0">
                          <tr>
                            <td
                              colSpan={2}
                              className="px-4 py-3 text-right uppercase tracking-widest text-[11px] text-slate-500"
                            >
                              Total
                            </td>
                            <td className="px-4 py-3 font-mono text-right">
                              {formatDuration(
                                detailedReportData.reduce(
                                  (acc, curr) => acc + curr.durationMinutes,
                                  0
                                )
                              )}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Log Modal */}
        <AnimatePresence>
          {showLogModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowLogModal(false)}
                className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
              />
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="relative w-full max-w-md bg-white rounded-[24px] md:rounded-[32px] p-6 md:p-8 shadow-2xl overflow-y-auto max-h-[85vh] no-scrollbar"
              >
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-xl font-black text-slate-800">
                    Add Maintenance Log
                  </h3>
                  <button onClick={() => setShowLogModal(false)}>
                    <X className="w-5 h-5 text-slate-400" />
                  </button>
                </div>
                <form onSubmit={handleAddLog} className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      Technician Name
                    </label>
                    <input
                      required
                      type="text"
                      value={newLog.technician_name}
                      onChange={(e) =>
                        setNewLog({
                          ...newLog,
                          technician_name: e.target.value,
                        })
                      }
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      Event Type
                    </label>
                    <select
                      value={newLog.event_type}
                      onChange={(e) =>
                        setNewLog({ ...newLog, event_type: e.target.value })
                      }
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    >
                      <option>Maintenance</option>
                      <option>Repair</option>
                      <option>Inspection</option>
                      <option>Calibration</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      Notes
                    </label>
                    <textarea
                      required
                      rows={3}
                      value={newLog.notes}
                      onChange={(e) =>
                        setNewLog({ ...newLog, notes: e.target.value })
                      }
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 resize-none"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full py-3 bg-blue-600 text-white rounded-xl font-bold text-sm hover:bg-blue-700 transition-colors mt-2"
                  >
                    Save Log
                  </button>
                </form>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Add Node Modal */}
        <AnimatePresence>
          {showAddNodeModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowAddNodeModal(false)}
                className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
              />
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="relative w-full max-w-md bg-white rounded-[24px] md:rounded-[32px] p-6 md:p-8 shadow-2xl overflow-y-auto max-h-[85vh] no-scrollbar"
              >
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-xl font-black text-slate-800">
                    Add New Node
                  </h3>
                  <button onClick={() => setShowAddNodeModal(false)}>
                    <X className="w-5 h-5 text-slate-400" />
                  </button>
                </div>
                <form onSubmit={handleAddNode} className="space-y-4">
                  {addNodeError && (
                    <div className="p-3 bg-red-50 border border-red-100 rounded-xl text-xs text-red-600">
                      {addNodeError}
                    </div>
                  )}
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      Node ID (Unique)
                    </label>
                    <input
                      required
                      type="text"
                      placeholder="e.g., node_10"
                      value={newNodeId}
                      onChange={(e) => setNewNodeId(e.target.value)}
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      Alias / Name
                    </label>
                    <input
                      type="text"
                      placeholder="e.g., Storage Area 10"
                      value={newNodeAlias}
                      onChange={(e) => setNewNodeAlias(e.target.value)}
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full py-3 bg-blue-600 text-white rounded-xl font-bold text-sm hover:bg-blue-700 transition-colors mt-2"
                  >
                    Create Node
                  </button>
                </form>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Delete Confirmation Modal */}
        <AnimatePresence>
          {nodeToDelete && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setNodeToDelete(null)}
                className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
              />
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="relative w-full max-w-md bg-white rounded-[24px] md:rounded-[32px] p-6 md:p-8 shadow-2xl overflow-y-auto max-h-[85vh] no-scrollbar"
              >
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-xl font-black text-slate-800">
                    Delete Node
                  </h3>
                  <button onClick={() => setNodeToDelete(null)}>
                    <X className="w-5 h-5 text-slate-400" />
                  </button>
                </div>
                <div className="space-y-4">
                  <p className="text-sm text-slate-600">
                    Are you sure you want to delete node{" "}
                    <span className="font-bold text-slate-800">
                      {nodeToDelete}
                    </span>
                    ?
                  </p>
                  <p className="text-xs text-red-500 bg-red-50 p-3 rounded-lg border border-red-100">
                    This action is permanent and will also delete all
                    maintenance logs and notifications associated with this
                    node.
                  </p>
                  <div className="flex gap-3 mt-6">
                    <button
                      onClick={() => setNodeToDelete(null)}
                      className="flex-1 py-3 bg-slate-100 text-slate-700 rounded-xl font-bold text-sm hover:bg-slate-200 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleDeleteNode}
                      className="flex-1 py-3 bg-red-600 text-white rounded-xl font-bold text-sm hover:bg-red-700 transition-colors shadow-lg shadow-red-200"
                    >
                      Delete Permanently
                    </button>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
        {/* Database Viewer Modal */}
        <AnimatePresence>
          {showDbViewer && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowDbViewer(false)}
                className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
              />
              <motion.div
                initial={{ scale: 0.9, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.9, opacity: 0, y: 20 }}
                className="relative w-full max-w-5xl bg-white rounded-[24px] md:rounded-[32px] p-6 md:p-8 shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
              >
                <div className="flex items-start md:items-center justify-between mb-6 shrink-0 gap-4 md:gap-0">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600">
                      <Database className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="text-xl font-black text-slate-800">
                        Raw Database Explorer
                      </h3>
                      <p className="text-xs text-slate-500 font-medium">
                        Read-only view of internal factory.db
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setShowDbViewer(false)}
                    className="p-2 hover:bg-slate-100 rounded-full transition-colors"
                  >
                    <X className="w-5 h-5 text-slate-400" />
                  </button>
                </div>

                <div className="flex gap-2 overflow-x-auto pb-4 shrink-0 no-scrollbar border-b border-slate-100 mb-4">
                  {Object.keys(dbData).map((table) => (
                    <button
                      key={table}
                      onClick={() => setSelectedTable(table)}
                      className={cn(
                        "px-4 py-2 rounded-lg text-sm font-bold uppercase tracking-wider whitespace-nowrap transition-colors",
                        selectedTable === table
                          ? "bg-slate-800 text-white"
                          : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                      )}
                    >
                      {table} ({dbData[table]?.length || 0})
                    </button>
                  ))}
                </div>

                <div className="flex-1 overflow-auto min-h-0 bg-slate-50 rounded-2xl border border-slate-100">
                  {selectedTable && dbData[selectedTable]?.length > 0 ? (
                    <table className="w-full text-left text-sm max-w-full">
                      <thead className="bg-[#e2e8f0] text-slate-600 text-[10px] uppercase tracking-widest sticky top-0 font-bold">
                        <tr>
                          {Object.keys(dbData[selectedTable][0]).map((key) => (
                            <th
                              key={key}
                              className="px-4 py-3 whitespace-nowrap border-b border-slate-200"
                            >
                              {key}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {dbData[selectedTable].map((row, i) => (
                          <tr
                            key={i}
                            className="hover:bg-slate-100/50 transition-colors"
                          >
                            {Object.values(row).map((val: any, j) => (
                              <td
                                key={j}
                                className="px-4 py-2 font-mono text-[11px] text-slate-700 max-w-[250px] truncate"
                                title={String(val)}
                              >
                                {val === null ? (
                                  <span className="text-slate-400 italic">
                                    NULL
                                  </span>
                                ) : (
                                  String(val)
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="flex items-center justify-center h-full text-slate-400 text-sm font-medium">
                      {selectedTable ? "Table is empty" : "Select a table"}
                    </div>
                  )}
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
