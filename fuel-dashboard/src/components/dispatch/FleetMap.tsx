"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  Circle,
  Popup,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { LatLng, StopVisitStatus, STOP_STATUS_COLORS } from "@/lib/dispatch";

export interface FleetEntry {
  assignmentId: number;
  label: string;
  status: string;
  offRoute: boolean;
  /** Cron-persisted position (updated ~once/minute) — used only as a fallback. */
  position: { lat: number; lng: number } | null;
  /** Raw latest fix straight from the tracker table — no route/fallback blending, fetched on-demand for the selected entry. */
  latestFix?: { lat: number; lng: number; ageLabel?: string; timeLabel?: string } | null;
  geometry: LatLng[];
  stops: { lat: number; lng: number; name?: string | null; seq?: number; status?: StopVisitStatus }[];
  depot: { lat: number; lng: number; name?: string | null } | null;
}

interface Props {
  entries: FleetEntry[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

const KARACHI: [number, number] = [24.8607, 67.0011];
const LATEST_FIX_COLOR = "#9333ea";

function numberPin(seq: number, color: string) {
  return L.divIcon({
    className: "",
    html: `<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;
      background:${color};border:2px solid white;transform:rotate(-45deg);
      box-shadow:0 2px 5px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;">
      <span style="transform:rotate(45deg);color:white;font-size:10px;font-weight:800;">${seq}</span></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 22],
  });
}

function depotIcon() {
  return L.divIcon({
    className: "",
    html: `<div style="width:26px;height:26px;border-radius:8px;background:#0f172a;
      border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.35);display:flex;
      align-items:center;justify-content:center;">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white"
        stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 9.5 12 3l9 6.5"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>
      </svg></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function truckIcon(offRoute: boolean, selected: boolean) {
  const color = offRoute ? "#ef4444" : "#2563eb";
  const size = selected ? 26 : 20;
  return L.divIcon({
    className: "",
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};
      border:3px solid white;box-shadow:0 0 0 ${selected ? 5 : 3}px ${color}40;"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// Solid center dot for the raw tracker fix — visually distinct from
// truckIcon (blue/red) so it never reads as "the" vehicle marker. The
// live/animated read comes from the PingRadius rings drawn around it.
function latestFixIcon(color: string) {
  return L.divIcon({
    className: "",
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};
      border:2px solid white;box-shadow:0 0 6px rgba(0,0,0,0.4);"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

/**
 * A geo-anchored ring that continuously expands and fades — a "sonar ping"
 * reprojected correctly by Leaflet on every pan/zoom. Sized in *screen*
 * pixels (converted to metres each frame from the current zoom) rather than
 * a fixed metre radius, so it reads as a visible pulse whether the map is
 * zoomed to one bin or fit to a many-stop route. `phase` (0–1) offsets this
 * ring's position in the shared cycle so several instances layered together
 * read as one continuous ripple instead of a single lonely pulse.
 */
function PingRadius({
  center, color, phase = 0, minPx = 16, maxPx = 90, periodMs = 2200,
}: {
  center: [number, number];
  color: string;
  phase?: number;
  minPx?: number;
  maxPx?: number;
  periodMs?: number;
}) {
  const map = useMap();
  const [t, setT] = useState(phase);
  const rafRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let start: number | null = null;
    function step(ts: number) {
      if (start == null) start = ts - phase * periodMs;
      const elapsed = (ts - start) % periodMs;
      setT(elapsed / periodMs);
      rafRef.current = requestAnimationFrame(step);
    }
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodMs]);

  const metersPerPixel = (156543.03392 * Math.cos((center[0] * Math.PI) / 180)) / Math.pow(2, map.getZoom());
  const pxRadius = minPx + (maxPx - minPx) * t;
  const radius = pxRadius * metersPerPixel;
  const fade = 1 - t;

  return (
    <Circle
      center={center}
      radius={radius}
      pathOptions={{
        color,
        weight: 2,
        opacity: fade * 0.9,
        fillColor: color,
        fillOpacity: fade * 0.25,
      }}
      interactive={false}
    />
  );
}

/** Fit the map to the selected entry, or to the whole fleet when nothing is selected. */
function FitFleet({ entries, selectedId }: { entries: FleetEntry[]; selectedId: number | null }) {
  const map = useMap();
  useEffect(() => {
    map.invalidateSize();
    const sel = entries.find((e) => e.assignmentId === selectedId);
    const pts: [number, number][] = [];
    if (sel) {
      sel.geometry.forEach((p) => pts.push([p.lat, p.lng]));
      sel.stops.forEach((s) => pts.push([s.lat, s.lng]));
      if (sel.depot) pts.push([sel.depot.lat, sel.depot.lng]);
      if (sel.position) pts.push([sel.position.lat, sel.position.lng]);
    } else {
      entries.forEach((e) => {
        if (e.position) pts.push([e.position.lat, e.position.lng]);
      });
      // Fall back to route geometry when no vehicle has reported yet.
      if (pts.length === 0) entries.forEach((e) => e.geometry.forEach((p) => pts.push([p.lat, p.lng])));
    }
    if (pts.length === 1) map.setView(pts[0], 14);
    else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [60, 60] });
  }, [entries, selectedId, map]);
  return null;
}

export default function FleetMap({ entries, selectedId, onSelect }: Props) {
  return (
    <MapContainer center={KARACHI} zoom={12} style={{ width: "100%", height: "100%" }} zoomControl>
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="&copy; OpenStreetMap"
        maxZoom={19}
      />
      <FitFleet entries={entries} selectedId={selectedId} />

      {/* Overview mode (nothing selected): faint polyline for every route so the
          whole fleet's paths are visible. Once a route is selected, every other
          route's line/markers are hidden entirely — only its bold line renders below. */}
      {selectedId == null &&
        entries.map((e) =>
          e.geometry.length >= 2 ? (
            <Polyline
              key={`faint-${e.assignmentId}`}
              positions={e.geometry.map((p) => [p.lat, p.lng] as [number, number])}
              pathOptions={{ color: "#9CA3AF", weight: 2, opacity: 0.5 }}
            />
          ) : null,
        )}

      {/* Selected route — bold line, numbered stops, depot. */}
      {entries
        .filter((e) => e.assignmentId === selectedId)
        .map((e) => (
          <FeatureGroup key={`sel-${e.assignmentId}`} entry={e} />
        ))}

      {/* Vehicle markers — every entry when nothing is selected, otherwise only the selected one. */}
      {entries.map((e) =>
        e.position && (selectedId == null || e.assignmentId === selectedId) ? (
          <Marker
            key={`veh-${e.assignmentId}`}
            position={[e.position.lat, e.position.lng]}
            icon={truckIcon(e.offRoute, e.assignmentId === selectedId)}
            eventHandlers={{ click: () => onSelect(e.assignmentId) }}
          >
            <Popup>
              <b>{e.label}</b>
              <br />
              {e.status}{e.offRoute ? " · OFF ROUTE" : ""}
            </Popup>
          </Marker>
        ) : null,
      )}

      {/* Raw latest tracker fix for the selected entry — fetched on-demand, no route/fallback blending. */}
      {entries
        .filter((e) => e.assignmentId === selectedId && e.latestFix)
        .map((e) => (
          <Fragment key={`fix-${e.assignmentId}`}>
            {[0, 1 / 3, 2 / 3].map((phase) => (
              <PingRadius key={phase} center={[e.latestFix!.lat, e.latestFix!.lng]} color={LATEST_FIX_COLOR} phase={phase} />
            ))}
            <Marker position={[e.latestFix!.lat, e.latestFix!.lng]} icon={latestFixIcon(LATEST_FIX_COLOR)}>
              <Popup>
                <b>Latest tracker fix</b>
                {e.latestFix!.ageLabel ? <><br />{e.latestFix!.ageLabel}</> : null}
                <br />
                {e.latestFix!.lat.toFixed(5)}, {e.latestFix!.lng.toFixed(5)}
                {e.latestFix!.timeLabel ? <><br />{e.latestFix!.timeLabel}</> : null}
              </Popup>
            </Marker>
          </Fragment>
        ))}
    </MapContainer>
  );
}

/** The selected route's prominent geometry + stops + depot. */
function FeatureGroup({ entry }: { entry: FleetEntry }) {
  return (
    <>
      {entry.geometry.length >= 2 && (
        <Polyline
          positions={entry.geometry.map((p) => [p.lat, p.lng] as [number, number])}
          pathOptions={{ color: "#2563eb", weight: 4, opacity: 0.85 }}
        />
      )}
      {entry.depot && (
        <Marker position={[entry.depot.lat, entry.depot.lng]} icon={depotIcon()}>
          <Popup><b>{entry.depot.name || "Yard"}</b> (start &amp; end)</Popup>
        </Marker>
      )}
      {entry.stops.map((s, i) => (
        <Marker
          key={`stop-${i}`}
          position={[s.lat, s.lng]}
          icon={numberPin(s.seq ?? i + 1, s.status ? STOP_STATUS_COLORS[s.status] : "#E84040")}
        >
          <Popup>{s.name || `Bin ${s.seq ?? i + 1}`}</Popup>
        </Marker>
      ))}
    </>
  );
}
