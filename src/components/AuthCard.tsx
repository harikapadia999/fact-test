import React from "react";
import { Lock } from "lucide-react";

interface AuthProps {
  currentView: "login" | "signup";
  authError: string;
  authUsername: string;
  setAuthUsername: (v: string) => void;
  authPassword: string;
  setAuthPassword: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  switchView: (view: "login" | "signup") => void;
}

export function AuthCard({
  currentView,
  authError,
  authUsername,
  setAuthUsername,
  authPassword,
  setAuthPassword,
  onSubmit,
  switchView,
}: AuthProps) {
  return (
    <div className="min-h-screen bg-[#f4f4f5] flex items-center justify-center p-4 md:p-8 font-sans">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl overflow-hidden flex flex-col border border-slate-200 p-8">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 bg-[#e0e7ff] text-blue-600 rounded-full flex items-center justify-center mb-4">
            <Lock className="w-6 h-6" />
          </div>
          <h1 className="text-2xl font-black text-slate-800 tracking-tight">
            Factory Portal
          </h1>
          <p className="text-sm font-medium text-slate-500 uppercase tracking-widest mt-1">
            {currentView === "login" ? "Authentication" : "Registration"}
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          {authError && (
            <div className="p-3 bg-red-50 text-red-600 rounded-xl text-xs font-bold text-center border border-red-100">
              {authError}
            </div>
          )}
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              Username
            </label>
            <input
              required
              type="text"
              value={authUsername}
              onChange={(e) => setAuthUsername(e.target.value)}
              className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              Password
            </label>
            <input
              required
              type="password"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <button
            type="submit"
            className="w-full py-3 bg-blue-600 text-white rounded-xl font-bold text-sm tracking-wide mt-2 hover:bg-blue-700 transition-colors"
          >
            Authenticate Session
          </button>
        </form>

        <div className="mt-6 text-center text-xs text-slate-500">
          <p>Sign-ups are restricted.</p>
          <p>Please contact an Administrator to gain access.</p>
        </div>
      </div>
    </div>
  );
}
