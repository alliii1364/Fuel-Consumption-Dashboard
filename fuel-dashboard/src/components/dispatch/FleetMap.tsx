"use client";

import { useEffect } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  Popup,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { LatLng } from "@/lib/dispatch";

export interface FleetEntry {
  assignmentId: number;
  label: string;
  status: string;
  offRoute: boolean;
  position: { lat: number; lng: number } | null;
  geometry: LatLng[];
  stops: { lat: number; lng: number; name?: string | null; seq?: number }[];
  depot: { lat: number; lng: number; name?: string | null } | null;
}

interface Props {
  entries: FleetEntry[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

const KARACHI: [number, number] = [24.8607, 67.0011];

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

      {/* Faint polyline for every route; the selected one is drawn bold below. */}
      {entries.map((e) =>
        e.assignmentId !== selectedId && e.geometry.length >= 2 ? (
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

      {/* Vehicle markers for every entry that has a position. */}
      {entries.map((e) =>
        e.position ? (
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
        <Marker key={`stop-${i}`} position={[s.lat, s.lng]} icon={numberPin(s.seq ?? i + 1, "#E84040")}>
          <Popup>{s.name || `Bin ${s.seq ?? i + 1}`}</Popup>
        </Marker>
      ))}
    </>
  );
}
