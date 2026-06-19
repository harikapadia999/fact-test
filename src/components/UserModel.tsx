import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { X, Trash2, UserPlus, Users } from "lucide-react";
import { fetchJson } from "../api";

interface UsersModalProps {
  show: boolean;
  onClose: () => void;
  accessLevel: string;
}

export function UsersModal({ show, onClose, accessLevel }: UsersModalProps) {
  const [users, setUsers] = useState<any[]>([]);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState("Technician");
  const [error, setError] = useState<string | null>(null);

  const fetchUsers = async () => {
    try {
      const data = await fetchJson("/api/users", {
        headers: {
          "x-access-level": accessLevel,
        },
      });
      setUsers(data || []);
    } catch (e) {}
  };

  useEffect(() => {
    if (show && accessLevel === "Admin") {
      fetchUsers();
    }
  }, [show, accessLevel]);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await fetchJson("/api/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-access-level": accessLevel,
        },
        body: JSON.stringify({
          username: newUsername,
          password: newPassword,
          role: newRole,
        }),
      });
      setNewUsername("");
      setNewPassword("");
      fetchUsers();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDeleteUser = async (id: number) => {
    try {
      await fetchJson(`/api/users/${id}`, {
        method: "DELETE",
        headers: {
          "x-access-level": accessLevel,
        },
      });
      fetchUsers();
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
      />
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="relative w-full max-w-2xl bg-white rounded-[32px] p-8 shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
      >
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#e0e7ff] text-blue-600 rounded-full flex items-center justify-center">
              <Users className="w-5 h-5" />
            </div>
            <h3 className="text-xl font-black text-slate-800">
              User Management
            </h3>
          </div>
          <button onClick={onClose}>
            <X className="w-5 h-5 text-slate-400 hover:text-slate-600 transition" />
          </button>
        </div>

        <div className="flex gap-6 flex-1 min-h-0">
          {/* Create User Form */}
          <div className="w-1/3 border-r border-slate-100 pr-6 flex flex-col">
            <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">
              Add User
            </h4>
            <form onSubmit={handleCreateUser} className="space-y-4 flex-1">
              {error && (
                <div className="p-2 bg-red-50 text-red-600 rounded text-xs font-bold w-full truncate">
                  {error}
                </div>
              )}
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                  Username
                </label>
                <input
                  required
                  type="text"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                  Password
                </label>
                <input
                  required
                  type="text"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                  Role
                </label>
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                >
                  <option value="Technician">Technician</option>
                  <option value="Admin">Admin</option>
                </select>
              </div>
              <button
                type="submit"
                className="w-full py-2.5 bg-blue-600 text-white flex items-center justify-center gap-2 rounded-lg font-bold text-sm tracking-wide mt-2 hover:bg-blue-700 transition"
              >
                <UserPlus className="w-4 h-4" />
                CREATE USER
              </button>
            </form>
          </div>

          {/* User List */}
          <div className="w-2/3 flex flex-col overflow-hidden">
            <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">
              Authorized Personnel
            </h4>
            <div className="flex-1 overflow-y-auto pr-2 space-y-2">
              {users.map((user: any) => (
                <div
                  key={user.id}
                  className="p-4 rounded-xl border border-slate-100 bg-slate-50 flex items-center justify-between"
                >
                  <div>
                    <p className="font-bold text-slate-800 tracking-tight text-sm">
                      {user.username}
                    </p>
                    <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-0.5">
                      {user.role}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDeleteUser(user.id)}
                    className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition"
                    title="Delete User"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
              {users.length === 0 && (
                <p className="text-xs text-slate-400 font-medium italic">
                  No users found.
                </p>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
