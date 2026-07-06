"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { X, AlertTriangle, CheckCircle2, Navigation, Gauge, Camera, Satellite, Smartphone, CircleSlash, Circle, Clock, Info } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { getAssignmentLive, getAssignmentProof, setEventRemark, LiveStatus, PodRecord, RouteEvent, StopVisitStatus, StopCompletion } from "@/lib/dispatch";

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
  const [showLegend, setShowLegend] = useState(false);
  const [remarks, setRemarks] = useState<Record<number, string>>({});
  // Remember the user's distance-unit preference across sessions. Lazy init is
  // safe here: this modal only mounts client-side (opened on click), so there
  // is no SSR pass to cause a hydration mismatch.
  const [distKm, setDistKm] = useState<boolean>(() => {
    try { return localStorage.getItem("fueliq_dist_unit") === "km"; } catch { return false; }
  });
  function setUnit(km: boolean) {
    setDistKm(km);
    try { localStorage.setItem("fueliq_dist_unit", km ? "km" : "m"); } catch {}
  }
  const fmtDistance = (m: number | null): string =>
    m == null ? "—" : distKm ? `${(m / 1000).toFixed(2)} km` : `${m} m`;

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

  async function saveRemark(ev: RouteEvent) {
    if (!token) return;
    try {
      await setEventRemark(token, assignmentId, ev.eventId, remarks[ev.eventId] ?? ev.remark ?? "");
      await load();
    } catch { /* surfaced on next poll */ }
  }

  const a = live?.analysis;
  const completionByStop = new Map(
    (live?.stopCompletions ?? []).map((c: StopCompletion) => [c.stopId, c]),
  );
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

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-0 flex-1 overflow-hidden">
          <div style={{ minHeight: 380 }}>
            {live && (
              <DispatchMap
                geometry={live.route.geometry}
                depot={live.route.depot ? { lat: live.route.depot.lat, lng: live.route.depot.lng, name: live.route.depot.name } : null}
                stops={live.route.stops.map((s) => ({
                  lat: s.lat,
                  lng: s.lng,
                  name: s.name,
                  seq: s.seq,
                  status: a?.stopStatuses.find((x) => x.seq === s.seq)?.status,
                }))}
                vehicle={pos ? { lat: pos.lat, lng: pos.lng, offRoute: a?.offRoute, label: live.assignment.vehicleName || "" } : null}
              />
            )}
          </div>

          <div className="p-5 overflow-auto border-l" style={{ borderColor: "var(--color-border)" }}>
            {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

            {a && (
              <>
                <div
                  className="rounded-xl px-3.5 py-3 mb-4 flex items-center gap-2"
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
                <div className="flex items-center justify-between py-2 border-b" style={{ borderColor: "#F3F4F6" }}>
                  <span className="text-xs text-gray-500 flex items-center gap-1.5">
                    <Gauge size={14} />
                    Distance from route
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-gray-800 tabular-nums">{fmtDistance(a.distanceFromRouteM)}</span>
                    <span className="inline-flex rounded-md overflow-hidden border" style={{ borderColor: "var(--color-border)" }}>
                      {([["m", false], ["km", true]] as const).map(([lbl, km]) => (
                        <button
                          key={lbl}
                          type="button"
                          onClick={() => setUnit(km)}
                          aria-pressed={distKm === km}
                          className="px-1.5 py-0.5 text-[10px] font-bold transition-colors"
                          style={{
                            background: distKm === km ? "var(--color-primary)" : "transparent",
                            color: distKm === km ? "#fff" : "var(--color-text-3)",
                          }}
                        >
                          {lbl}
                        </button>
                      ))}
                    </span>
                  </div>
                </div>
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
                <div className="flex items-center justify-between py-2 border-b" style={{ borderColor: "#F3F4F6" }}>
                  <span className="text-xs text-gray-500">Stops</span>
                  <span className="flex items-center gap-2.5">
                    {STATUS_ORDER.map((s) => {
                      const { Icon, color, label } = STATUS_UI[s];
                      const count = a.stopStatuses.filter((x) => x.status === s).length;
                      return (
                        <span key={s} title={label} className="flex items-center gap-1 text-sm font-semibold text-gray-800">
                          <Icon size={14} style={{ color }} />
                          {count}
                        </span>
                      );
                    })}
                  </span>
                </div>

                <div className="mt-5">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Stops ({live!.route.stops.length})</p>
                    <button
                      type="button"
                      onClick={() => setShowLegend((v) => !v)}
                      aria-label="Status color legend"
                      aria-expanded={showLegend}
                      title="What do the colors mean?"
                      className="flex items-center gap-1 text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full border transition-colors"
                      style={{
                        borderColor: showLegend ? "var(--color-primary)" : "var(--color-border)",
                        color: showLegend ? "var(--color-primary)" : "var(--color-text-3)",
                        background: showLegend ? "rgba(var(--color-primary-rgb), 0.08)" : "transparent",
                      }}
                    >
                      <Info size={12} />
                      Info
                    </button>
                  </div>

                  {showLegend && (
                    <div className="mb-2 rounded-lg border p-2.5 flex flex-col gap-1.5" style={{ borderColor: "var(--color-border)", background: "#F9FAFB" }}>
                      <p className="text-[10px] font-semibold text-gray-500 uppercase">Marker &amp; stop colors</p>
                      {STATUS_ORDER.map((s) => {
                        const { Icon, color, label, desc } = STATUS_UI[s];
                        return (
                          <div key={s} className="flex items-start gap-2">
                            <Icon size={13} style={{ color }} className="flex-shrink-0 mt-0.5" />
                            <span className="text-xs text-gray-700">
                              <span className="font-semibold">{label}</span> — {desc}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="flex flex-col gap-1.5 max-h-56 overflow-auto">
                    {live!.route.stops.map((s) => {
                      const st = a.stopStatuses.find((x) => x.seq === s.seq);
                      const done = s.stopId != null ? completionByStop.get(s.stopId) : undefined;
                      return (
                        <div key={s.seq} className="flex items-center gap-2 text-xs bg-gray-50 rounded-lg px-2 py-1.5">
                          <span className="w-5 h-5 rounded-full bg-gray-200 text-gray-600 font-bold flex items-center justify-center flex-shrink-0">
                            {s.seq}
                          </span>
                          <span className="flex-1 min-w-0 truncate text-gray-700">{s.name || `Stop ${s.seq}`}</span>
                          {done && (
                            <span
                              className="px-1.5 py-0.5 rounded-full font-bold text-white flex-shrink-0"
                              style={{ background: done.inRange ? "#16a34a" : "#d97706" }}
                              title={done.inRange ? "Driver confirmed at bin" : `Driver confirmed out of range (${done.distanceM}m)`}
                            >
                              {done.inRange ? "✓ done" : `✓ ${done.distanceM}m off`}
                            </span>
                          )}
                          {st ? <StopStatusBadge status={st.status} dwellS={st.dwellS} /> : null}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <Metric label="Status" value={live!.assignment.status} />

                <div className="mt-5">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Event log</p>
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
                        {(ev.type === "deviation" || ev.type === "stop_skipped") && (
                          <div className="mt-1 flex gap-1">
                            <input
                              defaultValue={ev.remark ?? ""}
                              onChange={(e) => setRemarks((m) => ({ ...m, [ev.eventId]: e.target.value }))}
                              placeholder="Add reason…"
                              className="flex-1 min-w-0 px-1.5 py-0.5 border rounded text-[11px]"
                              style={{ borderColor: "#E5E7EB" }}
                            />
                            <button onClick={() => saveRemark(ev)} className="px-2 py-0.5 rounded text-[11px] font-semibold text-white" style={{ background: "var(--color-primary)" }}>
                              Save
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {pod.length > 0 && (
                  <div className="mt-5">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                      <Camera size={13} /> Proof of delivery ({pod.length})
                    </p>
                    <div className="flex flex-col gap-2">
                      {pod.map((p) => (
                        <div key={p.id} className="flex gap-2 bg-gray-50 rounded-lg p-2">
                          {p.photoPath && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={`${API_BASE}/api/uploads/${p.photoPath}`}
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
    <div className="flex items-center justify-between py-2 border-b" style={{ borderColor: "#F3F4F6" }}>
      <span className="text-xs text-gray-500 flex items-center gap-1.5">
        {icon}
        {label}
      </span>
      <span className="text-sm font-semibold text-gray-800 tabular-nums">{value}</span>
    </div>
  );
}

const STATUS_UI: Record<StopVisitStatus, { label: string; color: string; Icon: LucideIcon; desc: string }> = {
  stopped: { label: "Stopped", color: "#16a34a", Icon: CheckCircle2, desc: "Stopped at the bin (≤5 km/h for ≥2 min) — collected." },
  skipped: { label: "Skipped", color: "#f59e0b", Icon: CircleSlash, desc: "Entered the bin's radius but didn't stop — drove through." },
  not_reached: { label: "Not reached", color: "#9CA3AF", Icon: Circle, desc: "Never entered the radius and has moved past it (or job ended)." },
  pending: { label: "Pending", color: "#2563eb", Icon: Clock, desc: "Not reached yet — job still in progress." },
};

const STATUS_ORDER: StopVisitStatus[] = ["stopped", "skipped", "not_reached", "pending"];

// Human-readable dwell duration. Uses "s" / "min" / "h" (never a bare "m",
// which collides with the metres shown elsewhere in the panel).
function formatDwell(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function StopStatusBadge({ status, dwellS }: { status: StopVisitStatus; dwellS?: number }) {
  const ui = STATUS_UI[status];
  const Icon = ui.Icon;
  return (
    <span
      className="text-[10px] font-bold px-2 py-0.5 rounded-full text-white flex-shrink-0 inline-flex items-center gap-1"
      style={{ background: ui.color }}
    >
      <Icon size={11} />
      {ui.label}
      {status === "stopped" && dwellS != null ? ` · ${formatDwell(dwellS)}` : ""}
    </span>
  );
}
