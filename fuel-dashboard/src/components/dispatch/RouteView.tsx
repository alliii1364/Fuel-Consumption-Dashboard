"use client";

import dynamic from "next/dynamic";
import { MapPin, Ruler, Clock, Pencil, X, Warehouse } from "lucide-react";
import { RouteDetail } from "@/lib/dispatch";

const DispatchMap = dynamic(() => import("./DispatchMap"), { ssr: false });

interface Props {
  route: RouteDetail;
  onClose: () => void;
  /** Hand the loaded route up to the builder for editing. */
  onEdit?: (route: RouteDetail) => void;
}

/**
 * Read-only inline view of a saved route, rendered in the same spot as the
 * builder (not a modal) so the route is shown on the main map.
 */
export default function RouteView({ route, onClose, onEdit }: Props) {
  const fmtDuration = (s: number | null) =>
    s == null ? "—" : s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-4">
      <div className="rounded-xl overflow-hidden border" style={{ borderColor: "var(--color-border)", height: 460 }}>
        <DispatchMap
          geometry={route.geometry}
          depot={route.depot ? { lat: route.depot.lat, lng: route.depot.lng, name: route.depot.name } : null}
          stops={route.stops.map((s) => ({ lat: s.lat, lng: s.lng, name: s.name, seq: s.seq }))}
        />
      </div>

      <div className="flex flex-col gap-3">
        <div className="rounded-xl p-4 border" style={{ borderColor: "var(--color-border)", background: "#fff" }}>
          <div className="flex items-start justify-between mb-3">
            <div className="min-w-0">
              <p className="font-bold text-gray-800 truncate">{route.name}</p>
              <p className="text-xs text-gray-500 uppercase">
                {route.source}{route.optimized ? " · optimized" : ""} · corridor {route.corridorBufferM} m
              </p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-700 flex-shrink-0" title="Close view">
              <X size={16} />
            </button>
          </div>

          {route.depot && (
            <div className="flex items-center gap-1.5 text-xs text-gray-600 mb-2">
              <Warehouse size={13} className="text-gray-700" />
              <span className="font-semibold">Yard:</span> {route.depot.name || "—"}
              <span className="text-gray-400">· round trip</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 mb-3">
            <Stat icon={<Ruler size={13} />} label="Distance" value={route.totalDistanceKm != null ? `${route.totalDistanceKm.toFixed(1)} km` : "—"} />
            <Stat icon={<Clock size={13} />} label="Duration" value={fmtDuration(route.totalDurationS)} />
          </div>

          {onEdit && (
            <button
              onClick={() => onEdit(route)}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-bold text-white"
              style={{ background: "var(--color-primary)" }}
            >
              <Pencil size={14} /> Edit route
            </button>
          )}
        </div>

        <div className="rounded-xl p-4 border flex-1" style={{ borderColor: "var(--color-border)", background: "#fff" }}>
          <p className="text-xs font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1.5">
            <MapPin size={13} /> Pickup bins ({route.stops.length})
          </p>
          <div className="flex flex-col gap-1.5 max-h-72 overflow-auto">
            {route.stops.map((s) => (
              <div key={s.seq} className="flex items-center gap-2 text-sm bg-gray-50 rounded-lg px-2 py-1.5">
                <span className="text-xs font-bold text-primary">{s.seq}.</span>
                <span className="flex-1 min-w-0 truncate text-gray-700">{s.name || `Stop ${s.seq}`}</span>
                <span className="text-[10px] text-gray-400">{s.radiusM} m</span>
              </div>
            ))}
          </div>

          {route.notes && (
            <div className="mt-3">
              <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Notes</p>
              <p className="text-sm text-gray-600">{route.notes}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg p-2.5" style={{ background: "var(--color-surface-2)" }}>
      <div className="flex items-center gap-1 text-gray-500 text-[10px] font-semibold uppercase mb-0.5">{icon}{label}</div>
      <p className="text-sm font-bold text-gray-800">{value}</p>
    </div>
  );
}
