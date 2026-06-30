"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import {
  Loader2, ArrowLeft, RefreshCw, AlertTriangle, Inbox, MapPin,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { getMonitor, MonitorEntry } from "@/lib/dispatch";
import { ApiError } from "@/lib/types";
import type { FleetEntry } from "@/components/dispatch/FleetMap";

const FleetMap = dynamic(() => import("@/components/dispatch/FleetMap"), { ssr: false });

const STATUS_COLORS: Record<string, string> = {
  assigned: "#6B7280", accepted: "#2563eb", en_route: "#f59e0b",
  arrived: "#16a34a", completed: "#16a34a", cancelled: "#9CA3AF",
};

const REFRESH_MS = 20_000;

function relTime(iso: string | null): string {
  if (!iso) return "no fix";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export default function FleetMonitorPage() {
  const { token, isLoading: authLoading, logout } = useAuth();
  const router = useRouter();

  const [entries, setEntries] = useState<MonitorEntry[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    if (!authLoading && !token) router.replace("/login");
  }, [authLoading, token, router]);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const data = await getMonitor(token);
      setEntries(data);
      setLastUpdated(new Date());
      setError(null);
    } catch (e: any) {
      if (e instanceof ApiError && e.statusCode === 401) { logout(); router.replace("/login"); return; }
      setError(e instanceof ApiError ? e.userMessage : e?.message || "Failed to load fleet");
    } finally {
      setLoading(false);
    }
  }, [token, logout, router]);

  useEffect(() => {
    if (!token) return;
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [token, load]);

  const fleet: FleetEntry[] = useMemo(
    () =>
      entries.map((m) => ({
        assignmentId: m.assignment.assignmentId,
        label: m.assignment.routeName || m.assignment.vehicleName || `#${m.assignment.assignmentId}`,
        status: m.assignment.status,
        offRoute: m.assignment.offRoute,
        position:
          m.assignment.lastLat != null && m.assignment.lastLng != null
            ? { lat: m.assignment.lastLat, lng: m.assignment.lastLng }
            : null,
        geometry: m.route?.geometry ?? [],
        stops: (m.route?.stops ?? []).map((s) => ({ lat: s.lat, lng: s.lng, name: s.name, seq: s.seq })),
        depot: m.route?.depot ? { lat: m.route.depot.lat, lng: m.route.depot.lng, name: m.route.depot.name } : null,
      })),
    [entries],
  );

  const offRouteCount = fleet.filter((e) => e.offRoute).length;

  if (authLoading || !token) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-gray-50">
      {/* Header */}
      <header className="flex-shrink-0 flex items-center gap-3 px-4 h-12 border-b bg-white" style={{ borderColor: "var(--color-border)" }}>
        <button onClick={() => router.push("/dispatch")} className="flex items-center gap-1.5 text-sm font-semibold text-gray-600 hover:text-gray-900">
          <ArrowLeft size={16} /> Dispatch
        </button>
        <div className="w-px h-5 bg-gray-200 flex-shrink-0" />
        <h1 className="font-bold text-gray-800 truncate min-w-0"><span className="hidden sm:inline">Live </span>Fleet Monitor</h1>
        <span className="text-xs text-gray-500 flex-shrink-0">{fleet.length} active</span>
        {offRouteCount > 0 && (
          <span className="flex items-center gap-1 text-xs font-bold text-red-600">
            <AlertTriangle size={13} /> {offRouteCount} off route
          </span>
        )}
        <div className="ml-auto flex items-center gap-3 flex-shrink-0">
          <span className="hidden md:inline text-xs text-gray-400">
            {lastUpdated ? `Updated ${relTime(lastUpdated.toISOString())}` : ""}
          </span>
          <button onClick={load} className="text-gray-400 hover:text-gray-700" title="Refresh now">
            <RefreshCw size={15} />
          </button>
        </div>
      </header>

      <div className="flex-1 flex flex-col sm:flex-row min-h-0">
        {/* Active-assignment list */}
        <aside className="w-full sm:w-72 sm:flex-shrink-0 max-h-[45%] sm:max-h-none border-b sm:border-b-0 sm:border-r bg-white overflow-auto" style={{ borderColor: "var(--color-border)" }}>
          {loading && (
            <div className="flex items-center justify-center py-10"><Loader2 className="animate-spin text-primary" /></div>
          )}
          {error && <p className="text-xs text-red-600 p-4">{error}</p>}
          {!loading && fleet.length === 0 && !error && (
            <div className="flex flex-col items-center text-center text-gray-400 px-4 py-12 gap-2">
              <Inbox size={28} />
              <p className="text-sm font-semibold text-gray-500">No active routes</p>
              <p className="text-xs">Dispatched jobs in progress will appear here.</p>
            </div>
          )}
          <div className="flex flex-col">
            {fleet.map((e) => {
              const m = entries.find((x) => x.assignment.assignmentId === e.assignmentId)!.assignment;
              const isSel = e.assignmentId === selectedId;
              return (
                <button
                  key={e.assignmentId}
                  onClick={() => setSelectedId(isSel ? null : e.assignmentId)}
                  className="text-left px-3 py-2.5 border-b hover:bg-gray-50"
                  style={{ borderColor: "#F3F4F6", background: isSel ? "rgba(var(--color-primary-rgb),0.06)" : undefined }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-gray-800 text-sm truncate">{e.label}</p>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full text-white flex-shrink-0" style={{ background: STATUS_COLORS[e.status] ?? "#6B7280" }}>
                      {e.status}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 truncate">{m.driverName || "—"} · {m.vehicleName || m.imei}</p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <div className="flex-1 h-1.5 bg-gray-100 rounded overflow-hidden">
                      <div className="h-full" style={{ width: `${m.progressPct ?? 0}%`, background: e.offRoute ? "#ef4444" : "var(--color-primary)" }} />
                    </div>
                    <span className="text-[10px] text-gray-400 flex-shrink-0">{m.progressPct ?? 0}%</span>
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    {e.offRoute
                      ? <span className="flex items-center gap-1 text-[10px] font-bold text-red-600"><AlertTriangle size={11} /> Off route</span>
                      : <span className="flex items-center gap-1 text-[10px] text-gray-400"><MapPin size={11} /> On route</span>}
                    <span className="text-[10px] text-gray-400">{relTime(m.lastSeen)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Map */}
        <main className="flex-1 min-w-0">
          <FleetMap entries={fleet} selectedId={selectedId} onSelect={(id) => setSelectedId(id)} />
        </main>
      </div>
    </div>
  );
}
