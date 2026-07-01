"use client";

import { useEffect } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  Popup,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { LatLng, StopVisitStatus } from "@/lib/dispatch";

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
  /** Live vehicle position. */
  vehicle?: { lat: number; lng: number; offRoute?: boolean; label?: string } | null;
  /** Click handler — enables "click to add stop" build mode. */
  onMapClick?: (lat: number, lng: number) => void;
  center?: [number, number];
  height?: number | string;
}

const KARACHI: [number, number] = [24.8607, 67.0011];

const STOP_STATUS_COLOR: Record<StopVisitStatus, string> = {
  stopped: "#16a34a",
  skipped: "#f59e0b",
  not_reached: "#9CA3AF",
  pending: "#2563eb",
};

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
          icon={numberPin(s.seq ?? i + 1, s.status ? STOP_STATUS_COLOR[s.status] : "#E84040")}
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
    </MapContainer>
  );
}
