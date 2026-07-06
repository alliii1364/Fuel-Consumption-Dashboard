"use client";

import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect } from "react";
import { LatLng } from "@/lib/dispatch";

// Leaflet's default icon URLs break under bundlers — pin them (same as DispatchMap).
const icon = (color: string) =>
  L.divIcon({
    className: "",
    html: `<div style="background:${color};width:16px;height:16px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 3px rgba(0,0,0,.5)"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });

function Recenter({ center }: { center: LatLng | null }) {
  const map = useMap();
  useEffect(() => { if (center) map.setView([center.lat, center.lng], map.getZoom() < 14 ? 15 : map.getZoom()); }, [center, map]);
  return null;
}

export interface NavStop { seq: number; name: string | null; lat: number; lng: number; done: boolean; active: boolean }

export default function DriverNavMap({
  geometry, stops, driver, active,
}: {
  geometry: LatLng[];
  stops: NavStop[];
  driver: LatLng | null;
  active: LatLng | null;
}) {
  const first = active ?? driver ?? stops[0] ?? geometry[0] ?? { lat: 24.86, lng: 67.0 };
  return (
    <MapContainer center={[first.lat, first.lng]} zoom={14} style={{ height: "100%", width: "100%" }}>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
      {geometry.length >= 2 && <Polyline positions={geometry.map((p) => [p.lat, p.lng])} pathOptions={{ color: "#2563eb", weight: 4, opacity: 0.7 }} />}
      {stops.map((s) => (
        <Marker key={s.seq} position={[s.lat, s.lng]} icon={icon(s.done ? "#16a34a" : s.active ? "#dc2626" : "#6b7280")}>
          <Popup>{s.name || `Stop ${s.seq}`}{s.active ? " (current)" : s.done ? " (done)" : ""}</Popup>
        </Marker>
      ))}
      {driver && <Marker position={[driver.lat, driver.lng]} icon={icon("#7c3aed")}><Popup>You</Popup></Marker>}
      <Recenter center={active} />
    </MapContainer>
  );
}
