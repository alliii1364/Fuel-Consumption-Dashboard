"use client";

import { useEffect, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  Circle,
  Popup,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { LatLng, StopVisitStatus, STOP_STATUS_COLORS } from "@/lib/dispatch";

interface StopMarker {
  lat: number;
  lng: number;
  name?: string | null;
  seq?: number;
  status?: StopVisitStatus;
}

interface Props {
  /** Ordered stops to render as numbered pins. */
  stops?: StopMarker[];
  /** Road geometry polyline (e.g. from OSRM). */
  geometry?: LatLng[];
  /** The yard/depot — round-trip start & end, drawn as a distinct home marker. */
  depot?: { lat: number; lng: number; name?: string | null } | null;
  /** Live vehicle position (route-analysis derived: tracker, falls back to phone GPS). */
  vehicle?: { lat: number; lng: number; offRoute?: boolean; label?: string } | null;
  /** Raw latest fix straight from the tracker table — no route/fallback blending. */
  latestFix?: { lat: number; lng: number; ageLabel?: string; timeLabel?: string } | null;
  /** Click handler — enables "click to add stop" build mode. */
  onMapClick?: (lat: number, lng: number) => void;
  center?: [number, number];
  height?: number | string;
}

const KARACHI: [number, number] = [24.8607, 67.0011];
const LATEST_FIX_COLOR = "#9333ea";

function numberPin(seq: number, color: string) {
  return L.divIcon({
    className: "",
    html: `<div style="width:24px;height:24px;border-radius:50% 50% 50% 0;
      background:${color};border:2px solid white;transform:rotate(-45deg);
      box-shadow:0 2px 6px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;">
      <span style="transform:rotate(45deg);color:white;font-size:11px;font-weight:800;">${seq}</span></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 24],
  });
}

function depotIcon() {
  return L.divIcon({
    className: "",
    html: `<div style="width:28px;height:28px;border-radius:8px;background:#0f172a;
      border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.35);display:flex;
      align-items:center;justify-content:center;">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white"
        stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 9.5 12 3l9 6.5"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>
      </svg></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function vehicleIcon(offRoute: boolean) {
  const color = offRoute ? "#ef4444" : "#2563eb";
  return L.divIcon({
    className: "",
    html: `<div style="width:20px;height:20px;border-radius:50%;background:${color};
      border:3px solid white;box-shadow:0 0 0 4px ${color}40;"></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

// Solid center dot for the raw tracker fix — visually distinct from
// vehicleIcon (which is blue/red) so it never reads as "the" vehicle marker.
// The live/animated read comes from the PingRadius rings drawn around it.
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
 * zoomed to one bin or fit to a 37-stop route — a fixed metre radius all but
 * disappears at city-wide zoom. `phase` (0–1) offsets this ring's position in
 * the shared cycle so several instances layered together read as one
 * continuous ripple instead of a single lonely pulse.
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

  // Web Mercator metres-per-pixel at this latitude/zoom (read live each
  // animation frame, so it stays correct across zoom/pan without a listener).
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

function ClickCapture({ onClick }: { onClick?: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      if (onClick) onClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function FitData({ pts }: { pts: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    // Recompute the map's pixel size first — guards against the container
    // not having its final dimensions when the map initialised (e.g. a panel
    // that mounts/expands after the map), which otherwise leaves overlays
    // mispositioned and the fitBounds below computed against a stale size.
    map.invalidateSize();
    if (pts.length === 0) return;
    if (pts.length === 1) {
      map.setView(pts[0], 14);
      return;
    }
    map.fitBounds(L.latLngBounds(pts), { padding: [50, 50] });
  }, [pts, map]);
  return null;
}

export default function DispatchMap({
  stops = [],
  geometry = [],
  depot = null,
  vehicle = null,
  latestFix = null,
  onMapClick,
  center,
  height = "100%",
}: Props) {
  const allPts: [number, number][] = [
    ...geometry.map((p) => [p.lat, p.lng] as [number, number]),
    ...stops.map((s) => [s.lat, s.lng] as [number, number]),
  ];
  if (depot) allPts.push([depot.lat, depot.lng]);
  if (vehicle) allPts.push([vehicle.lat, vehicle.lng]);
  if (latestFix) allPts.push([latestFix.lat, latestFix.lng]);

  const start = center ?? (allPts[0] || KARACHI);

  return (
    <MapContainer center={start} zoom={12} style={{ width: "100%", height }} zoomControl>
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; OpenStreetMap'
        maxZoom={19}
      />
      <ClickCapture onClick={onMapClick} />
      <FitData pts={allPts} />

      {geometry.length >= 2 && (
        <Polyline
          positions={geometry.map((p) => [p.lat, p.lng] as [number, number])}
          pathOptions={{ color: "#2563eb", weight: 4, opacity: 0.8 }}
        />
      )}

      {/* When there's no road geometry, connect stops with a dashed line. */}
      {geometry.length < 2 && stops.length >= 2 && (
        <Polyline
          positions={stops.map((s) => [s.lat, s.lng] as [number, number])}
          pathOptions={{ color: "#9CA3AF", weight: 2, dashArray: "6 6" }}
        />
      )}

      {stops.map((s, i) => (
        <Marker
          key={`stop-${i}`}
          position={[s.lat, s.lng]}
          icon={numberPin(s.seq ?? i + 1, s.status ? STOP_STATUS_COLORS[s.status] : "#E84040")}
        >
          <Popup>
            <b>{s.name || `Stop ${s.seq ?? i + 1}`}</b>
            <br />
            {s.lat.toFixed(5)}, {s.lng.toFixed(5)}
          </Popup>
        </Marker>
      ))}

      {depot && (
        <Marker position={[depot.lat, depot.lng]} icon={depotIcon()}>
          <Popup>
            <b>{depot.name || "Yard"}</b> (start &amp; end)
            <br />
            {depot.lat.toFixed(5)}, {depot.lng.toFixed(5)}
          </Popup>
        </Marker>
      )}

      {vehicle && (
        <Marker position={[vehicle.lat, vehicle.lng]} icon={vehicleIcon(!!vehicle.offRoute)}>
          <Popup>{vehicle.label || "Vehicle"}{vehicle.offRoute ? " — OFF ROUTE" : ""}</Popup>
        </Marker>
      )}

      {latestFix && (
        <>
          {/* Three staggered rings sharing one 2.2s cycle — always one
              mid-expansion, so it reads as a continuous ripple rather than a
              single pulse-then-pause. */}
          {[0, 1 / 3, 2 / 3].map((phase) => (
            <PingRadius key={phase} center={[latestFix.lat, latestFix.lng]} color={LATEST_FIX_COLOR} phase={phase} />
          ))}
          <Marker position={[latestFix.lat, latestFix.lng]} icon={latestFixIcon(LATEST_FIX_COLOR)}>
            <Popup>
              <b>Latest tracker fix</b>
              {latestFix.ageLabel ? <><br />{latestFix.ageLabel}</> : null}
              <br />
              {latestFix.lat.toFixed(5)}, {latestFix.lng.toFixed(5)}
              {latestFix.timeLabel ? <><br />{latestFix.timeLabel}</> : null}
            </Popup>
          </Marker>
        </>
      )}
    </MapContainer>
  );
}
