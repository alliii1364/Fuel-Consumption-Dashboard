"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { X, AlertTriangle, CheckCircle2, Navigation, Gauge, Camera, Satellite, Smartphone } from "lucide-react";
import { getAssignmentLive, getAssignmentProof, LiveStatus, PodRecord, StopVisitStatus } from "@/lib/dispatch";

const DispatchMap = dynamic(() => import("./DispatchMap"), { ssr: false });

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3007";

interface Props {
  token: string;
  assignmentId: number;
  onClose: () => void;
}

export default function LiveMonitor({ token, assignmentId, onClose }: Props) {
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [pod, setPod] = useState<PodRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, p] = await Promise.all([
        getAssignmentLive(token, assignmentId),
        getAssignmentProof(token, assignmentId).catch(() => [] as PodRecord[]),
      ]);
      setLive(l);
      setPod(p);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Failed to load live status");
    }
  }, [token, assignmentId]);

  useEffect(() => {
    load();
    const id = setInterval(load, 15_000); // poll every 15s
    return () => clearInterval(id);
  }, [load]);

  const a = live?.analysis;
  const pos = a?.currentPosition ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: "var(--color-border)" }}>
          <div>
            <h2 className="font-bold text-gray-800">
              {live?.assignment.routeName || "Live monitor"}
            </h2>
            <p className="text-xs text-gray-500">
              {live?.assignment.driverName} · {live?.assignment.vehicleName || live?.assignment.imei}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
            <X size={20} />
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-0 flex-1 overflow-hidden">
          <div style={{ minHeight: 380 }}>
            {live && (
              <DispatchMap
                geometry={live.route.geometry}
                depot={live.route.depot ? { lat: live.route.depot.lat, lng: live.route.depot.lng, name: live.route.depot.name } : null}
                stops={live.route.stops.map((s) => ({ lat: s.lat, lng: s.lng, name: s.name, seq: s.seq }))}
                vehicle={pos ? { lat: pos.lat, lng: pos.lng, offRoute: a?.offRoute, label: live.assignment.vehicleName || "" } : null}
              />
            )}
          </div>

          <div className="p-4 overflow-auto border-l" style={{ borderColor: "var(--color-border)" }}>
            {error && <p className="text-xs text-red-600 mb-2">{error}</p>}

            {a && (
              <>
                <div
                  className="rounded-xl p-3 mb-3 flex items-center gap-2"
                  style={{ background: a.offRoute ? "rgba(239,68,68,0.08)" : "rgba(34,197,94,0.08)" }}
                >
                  {a.offRoute ? (
                    <AlertTriangle size={18} className="text-red-500" />
                  ) : (
                    <CheckCircle2 size={18} className="text-green-600" />
                  )}
                  <span className="text-sm font-bold" style={{ color: a.offRoute ? "#dc2626" : "#16a34a" }}>
                    {a.offRoute ? "OFF ROUTE" : "On route"}
                  </span>
                </div>

                <Metric icon={<Navigation size={14} />} label="Progress" value={`${a.progressPct}%`} />
                <Metric
                  icon={<Gauge size={14} />}
                  label="Distance from route"
                  value={a.distanceFromRouteM != null ? `${a.distanceFromRouteM} m` : "—"}
                />
                <Metric label="Speed" value={a.speed != null ? `${a.speed} km/h` : "—"} />
                <Metric
                  icon={a.positionSource === "phone" ? <Smartphone size={14} /> : <Satellite size={14} />}
                  label="Position source"
                  value={
                    a.positionSource === "tracker" ? "Tracker"
                      : a.positionSource === "phone" ? "Phone (fallback)"
                      : "No signal"
                  }
                />
                <Metric
                  label="Stops"
                  value={
                    `🟢 ${a.stopStatuses.filter((s) => s.status === "stopped").length}` +
                    ` · 🟡 ${a.stopStatuses.filter((s) => s.status === "skipped").length}` +
                    ` · ⚪ ${a.stopStatuses.filter((s) => s.status === "not_reached").length}`
                  }
                />

                <div className="mt-3">
                  <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Stops ({live!.route.stops.length})</p>
                  <div className="flex flex-col gap-1.5 max-h-56 overflow-auto">
                    {live!.route.stops.map((s) => {
                      const st = a.stopStatuses.find((x) => x.seq === s.seq);
                      return (
                        <div key={s.seq} className="flex items-center gap-2 text-xs bg-gray-50 rounded-lg px-2 py-1.5">
                          <span className="w-5 h-5 rounded-full bg-gray-200 text-gray-600 font-bold flex items-center justify-center flex-shrink-0">
                            {s.seq}
                          </span>
                          <span className="flex-1 min-w-0 truncate text-gray-700">{s.name || `Stop ${s.seq}`}</span>
                          {st ? <StopStatusBadge status={st.status} dwellS={st.dwellS} /> : null}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <Metric label="Status" value={live!.assignment.status} />

                <div className="mt-4">
                  <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Event log</p>
                  <div className="flex flex-col gap-1.5 max-h-48 overflow-auto">
                    {live!.events.length === 0 && <p className="text-xs text-gray-400">No events yet.</p>}
                    {live!.events.map((ev) => (
                      <div key={ev.eventId} className="text-xs bg-gray-50 rounded-lg px-2 py-1.5">
                        <span
                          className="font-bold"
                          style={{ color: ev.type === "deviation" ? "#dc2626" : "#374151" }}
                        >
                          {ev.type}
                        </span>{" "}
                        <span className="text-gray-500">{ev.note || ev.toStatus || ""}</span>
                        <div className="text-gray-400">{new Date(ev.createdAt).toLocaleString()}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {pod.length > 0 && (
                  <div className="mt-4">
                    <p className="text-xs font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1.5">
                      <Camera size={13} /> Proof of delivery ({pod.length})
                    </p>
                    <div className="flex flex-col gap-2">
                      {pod.map((p) => (
                        <div key={p.id} className="flex gap-2 bg-gray-50 rounded-lg p-2">
                          {p.photoPath && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={`${API_BASE}/uploads/${p.photoPath}`}
                              alt="Proof of delivery"
                              className="w-14 h-14 rounded object-cover flex-shrink-0"
                            />
                          )}
                          <div className="min-w-0">
                            <p className="text-xs text-gray-700">{p.note || "Captured"}</p>
                            <p className="text-[10px] text-gray-400">{new Date(p.createdAt).toLocaleString()}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Metric({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b" style={{ borderColor: "#F3F4F6" }}>
      <span className="text-xs text-gray-500 flex items-center gap-1.5">
        {icon}
        {label}
      </span>
      <span className="text-sm font-semibold text-gray-800">{value}</span>
    </div>
  );
}

const STATUS_UI: Record<StopVisitStatus, { label: string; color: string }> = {
  stopped: { label: "Stopped", color: "#16a34a" },
  skipped: { label: "Skipped", color: "#f59e0b" },
  not_reached: { label: "Not reached", color: "#9CA3AF" },
  pending: { label: "Pending", color: "#2563eb" },
};

function StopStatusBadge({ status, dwellS }: { status: StopVisitStatus; dwellS?: number }) {
  const ui = STATUS_UI[status];
  const mins = dwellS != null ? Math.round(dwellS / 60) : null;
  return (
    <span
      className="text-[10px] font-bold px-2 py-0.5 rounded-full text-white flex-shrink-0"
      style={{ background: ui.color }}
    >
      {ui.label}
      {status === "stopped" && mins != null ? ` · ${mins}m` : ""}
    </span>
  );
}
