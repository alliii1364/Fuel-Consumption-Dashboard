"use client";

import { memo, useMemo, useState, useRef, useEffect } from "react";
import { EnhancedChart, RankingTable, Heatmap } from "@/components/reports";
import { MapPin, Clock, Route, Fuel, Navigation, ChevronDown, ChevronRight, AlertTriangle, Droplets } from "lucide-react";
import { fmtDateTime } from "@/lib/dateUtils";
import { MapContainer, TileLayer, Marker, Popup, Tooltip, Polyline, ScaleControl, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { TheftLocationsReportData, TripRoutePoint } from "@/lib/types";
import { getTripRoute } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

interface SpecialReportViewsProps {
  activeReport: string;
  loading: boolean;
  dailyTrendData?: any;
  refuelData?: any;
  engineHoursData?: any;
  vehicleStatusData?: any;
  idleWasteData?: any;
  tripsData?: any;
  theftLocationData?: TheftLocationsReportData | null;
  vehicles: any[];
}

// ── Theft location helpers ───────────────────────────────────────────────────

interface TheftPin {
  lat: number | null;
  lng: number | null;
  vehicleName: string;
  plateNumber: string;
  at: string;
  fuelBefore: number;
  fuelAfter: number;
  consumed: number;
  imei: string;
}

const THEFT_COLOR          = "#dc2626";
const THEFT_COLOR_SELECTED = "#7c3aed";

// Teardrop pin marker — scales slightly with consumed amount, pulses when selected
function makeTheftIcon(isSelected: boolean, consumed: number): L.DivIcon {
  const base  = Math.min(46, Math.max(34, 30 + consumed * 0.35));
  const size  = isSelected ? base + 8 : base;
  const color = isSelected ? THEFT_COLOR_SELECTED : THEFT_COLOR;
  const cx    = size / 2;
  const cy    = size * 0.42;
  const r     = size * 0.37;
  const tail  = size * 1.28;

  const pulse = isSelected ? `
    <circle cx="${cx}" cy="${cy}" r="${r + 5}" fill="none" stroke="${color}" stroke-width="2" opacity="0.6">
      <animate attributeName="r"       values="${r + 5};${r + 16}" dur="1.4s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0.6;0"              dur="1.4s" repeatCount="indefinite"/>
    </circle>` : "";

  const svg = `
    <svg width="${size}" height="${tail}" viewBox="0 0 ${size} ${tail}" xmlns="http://www.w3.org/2000/svg">
      ${pulse}
      <filter id="sh"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-opacity="0.35"/></filter>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" stroke="white" stroke-width="2.5" filter="url(#sh)"/>
      <polygon points="${cx - 5},${cy + r - 3} ${cx},${tail - 2} ${cx + 5},${cy + r - 3}"
        fill="${color}" filter="url(#sh)"/>
      <circle cx="${cx}" cy="${cy}" r="${r * 0.52}" fill="white" opacity="0.2"/>
      <text x="${cx}" y="${cy + r * 0.22}" text-anchor="middle"
        font-size="${Math.round(r * 0.72)}" fill="white" font-weight="900" font-family="sans-serif">!</text>
    </svg>`;

  return L.divIcon({
    html: svg,
    className: "",
    iconSize:    [size, tail],
    iconAnchor:  [cx,   tail - 2],
    popupAnchor: [0,    -(tail + 4)],
    tooltipAnchor: [size * 0.6, -cy],
  });
}

// Fits all markers into view on first load; flies to selected marker on click
function MapController({ pins, selectedIdx }: { pins: TheftPin[]; selectedIdx: number | null }) {
  const map = useMap();
  const mappable = pins.filter((p) => p.lat !== null && p.lng !== null) as Array<TheftPin & { lat: number; lng: number }>;

  useEffect(() => {
    if (mappable.length === 0) return;
    if (mappable.length === 1) { map.setView([mappable[0].lat, mappable[0].lng], 15); return; }
    const bounds = L.latLngBounds(mappable.map((p) => [p.lat, p.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mappable.length]);

  useEffect(() => {
    if (selectedIdx === null) return;
    const p = pins[selectedIdx];
    if (!p || p.lat === null || p.lng === null) return;
    map.flyTo([p.lat, p.lng], 15, { duration: 0.8 });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdx]);

  return null;
}

// ── Trip route helpers ───────────────────────────────────────────────────────

const VEHICLE_PALETTE = ["#3b82f6","#8b5cf6","#ec4899","#14b8a6","#f59e0b","#6366f1","#10b981","#f97316"];

function vehicleColor(idx: number) { return VEHICLE_PALETTE[idx % VEHICLE_PALETTE.length]; }

function speedColor(speed: number): string {
  if (speed < 20) return "#3b82f6";
  if (speed < 50) return "#22c55e";
  if (speed < 80) return "#f59e0b";
  return "#ef4444";
}

function buildSpeedSegments(points: TripRoutePoint[]): Array<{ coords: [number,number][]; color: string }> {
  if (points.length < 2) return [];
  const segs: Array<{ coords: [number,number][]; color: string }> = [];
  let cur = speedColor(points[0].speed);
  let seg: [number,number][] = [[points[0].lat, points[0].lng]];

  for (let i = 1; i < points.length; i++) {
    const c = speedColor(points[i].speed);
    seg.push([points[i].lat, points[i].lng]);
    if (c !== cur || i === points.length - 1) {
      segs.push({ coords: seg, color: cur });
      cur = c;
      seg = [[points[i].lat, points[i].lng]];
    }
  }
  return segs;
}

function makeStartEndIcon(type: "start" | "end"): L.DivIcon {
  const bg    = type === "start" ? "#22c55e" : "#ef4444";
  const label = type === "start" ? "S" : "E";
  const shadow = type === "start" ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)";
  return L.divIcon({
    html: `<div style="width:30px;height:30px;border-radius:50%;background:${bg};
      border:3px solid white;box-shadow:0 2px 8px ${shadow};display:flex;
      align-items:center;justify-content:center;color:white;font-size:13px;font-weight:900;">${label}</div>`,
    className: "",
    iconSize:    [30, 30],
    iconAnchor:  [15, 15],
    popupAnchor: [0, -18],
  });
}

function RouteBoundsController({ coords }: { coords: [number,number][] }) {
  const map = useMap();
  useEffect(() => {
    if (coords.length < 2) return;
    map.fitBounds(L.latLngBounds(coords), { padding: [40, 40], maxZoom: 16 });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coords.length]);
  return null;
}

// ── TripRouteView ─────────────────────────────────────────────────────────────

interface FlatTrip {
  imei: string;
  vehicleName: string;
  plateNumber: string;
  vehicleIdx: number;
  tripId: string;
  startTime: string;
  endTime: string | null;
  durationMinutes: number;
  distanceKm: number;
  fuelConsumed: number;
  maxSpeed: number;
}

function TripRouteView({ tripsData, loading }: { tripsData: any; loading: boolean }) {
  const { token } = useAuth();
  const [selectedKey, setSelectedKey]     = useState<string | null>(null);
  const [routePoints, setRoutePoints]     = useState<TripRoutePoint[]>([]);
  const [routeLoading, setRouteLoading]   = useState(false);

  // Flatten all trips across all vehicles into a single chronological list
  const allTrips: FlatTrip[] = useMemo(() => {
    if (!tripsData?.vehicles) return [];
    return tripsData.vehicles
      .flatMap((v: any, vi: number) =>
        (v.trips ?? []).map((t: any) => ({
          imei:            v.imei,
          vehicleName:     v.name,
          plateNumber:     v.plateNumber,
          vehicleIdx:      vi,
          tripId:          t.tripId,
          startTime:       t.startTime,
          endTime:         t.endTime ?? null,
          durationMinutes: t.durationMinutes ?? 0,
          distanceKm:      t.distanceKm ?? 0,
          fuelConsumed:    Math.max(0, t.fuelConsumed ?? (t.fuelAtStart ?? 0) - (t.fuelAtEnd ?? 0)),
          maxSpeed:        t.maxSpeed ?? 0,
        }))
      )
      .sort((a: FlatTrip, b: FlatTrip) =>
        new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
      );
  }, [tripsData]);

  const tripKey = (t: FlatTrip) => `${t.imei}-${t.startTime}`;

  const selectedTrip = useMemo(
    () => allTrips.find((t) => tripKey(t) === selectedKey) ?? null,
    [allTrips, selectedKey],
  );

  const loadRoute = async (trip: FlatTrip) => {
    if (!token || !trip.endTime) return;
    setRouteLoading(true);
    setRoutePoints([]);
    try {
      const data = await getTripRoute(token, trip.imei, trip.startTime, trip.endTime);
      setRoutePoints(data.points);
    } catch {
      setRoutePoints([]);
    } finally {
      setRouteLoading(false);
    }
  };

  const handleSelectTrip = (trip: FlatTrip) => {
    const key = tripKey(trip);
    if (key === selectedKey) { setSelectedKey(null); setRoutePoints([]); return; }
    setSelectedKey(key);
    loadRoute(trip);
  };

  const formatDur = (min: number) => {
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const speedSegs  = useMemo(() => buildSpeedSegments(routePoints), [routePoints]);
  const allCoords  = useMemo<[number,number][]>(
    () => routePoints.map((p) => [p.lat, p.lng]),
    [routePoints],
  );
  const mapCenter: [number,number] = allCoords.length > 0
    ? allCoords[0]
    : [24.8607, 67.0011];

  const fleetTrips    = tripsData?.fleetTotals?.totalTrips ?? allTrips.length;
  const fleetDistance = tripsData?.fleetTotals?.totalDistanceKm ?? 0;

  if (loading) {
    return (
      <div className="flex-1 rounded-xl flex items-center justify-center"
        style={{ background: "rgba(255,255,255,0.95)", border: "1px solid rgba(255,255,255,0.8)" }}>
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-full border-4 border-blue-200 border-t-blue-600 animate-spin" />
          <p className="text-sm font-medium" style={{ color: "#6B7280" }}>Loading trips…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 rounded-xl overflow-hidden flex flex-col"
      style={{ background: "rgba(255,255,255,0.95)", backdropFilter: "blur(20px)",
        border: "1px solid rgba(255,255,255,0.8)", boxShadow: "0 2px 12px rgba(0,0,0,0.03)", minHeight: 0 }}>

      {/* Header */}
      <div className="flex-shrink-0 p-4 border-b flex items-center justify-between"
        style={{ borderColor: "rgba(240,239,239,0.8)" }}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "#3b82f615" }}>
            <Route size={20} style={{ color: "#3b82f6" }} />
          </div>
          <div>
            <h3 className="font-semibold text-lg" style={{ color: "#1A1A2E" }}>Trip Routes</h3>
            <p className="text-sm" style={{ color: "#9CA3AF" }}>
              {selectedTrip ? `${selectedTrip.vehicleName} · ${fmtDateTime(selectedTrip.startTime)}` : "Select a trip to view its route"}
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <div className="text-center px-4 py-2 rounded-xl" style={{ background: "#3b82f615", border: "1px solid #3b82f630" }}>
            <p className="text-xs" style={{ color: "#9CA3AF" }}>Total Trips</p>
            <p className="font-bold text-lg" style={{ color: "#3b82f6" }}>{fleetTrips}</p>
          </div>
          <div className="text-center px-4 py-2 rounded-xl" style={{ background: "#22c55e15", border: "1px solid #22c55e30" }}>
            <p className="text-xs" style={{ color: "#9CA3AF" }}>Distance</p>
            <p className="font-bold text-lg" style={{ color: "#22c55e" }}>{formatNumber(fleetDistance)} km</p>
          </div>
        </div>
      </div>

      {/* Speed legend */}
      {selectedTrip && routePoints.length > 0 && (
        <div className="flex-shrink-0 px-4 py-2 border-b flex items-center gap-4"
          style={{ borderColor: "rgba(240,239,239,0.6)", background: "rgba(248,250,252,0.6)" }}>
          <span className="text-xs font-medium" style={{ color: "#6B7280" }}>Speed:</span>
          {[["#3b82f6","< 20 km/h"],["#22c55e","20–50"],["#f59e0b","50–80"],["#ef4444","> 80"]].map(([c,l]) => (
            <div key={l} className="flex items-center gap-1">
              <div className="w-6 h-2 rounded-full" style={{ background: c }} />
              <span className="text-xs" style={{ color: "#6B7280" }}>{l}</span>
            </div>
          ))}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 flex min-h-0">
        {/* Left: trip list */}
        <div className="w-[38%] flex-shrink-0 border-r overflow-y-auto"
          style={{ borderColor: "rgba(240,239,239,0.8)" }}>
          {allTrips.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-16 px-6">
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ background: "#F3F4F6" }}>
                <Route size={28} style={{ color: "#9CA3AF" }} />
              </div>
              <h3 className="text-base font-semibold mb-1" style={{ color: "#1A1A2E" }}>No Trips Found</h3>
              <p className="text-sm text-center" style={{ color: "#9CA3AF" }}>No trips detected in the selected period.</p>
            </div>
          ) : allTrips.map((trip, idx) => {
            const isActive = tripKey(trip) === selectedKey;
            const color    = vehicleColor(trip.vehicleIdx);
            return (
              <button
                key={tripKey(trip)}
                onClick={() => handleSelectTrip(trip)}
                className="w-full text-left p-3 border-b flex items-start gap-3 transition-all hover:bg-gray-50"
                style={{
                  borderColor: "rgba(240,239,239,0.6)",
                  background:  isActive ? `${color}08` : "transparent",
                  borderLeft:  isActive ? `3px solid ${color}` : "3px solid transparent",
                }}
              >
                {/* Number badge */}
                <div className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold mt-0.5"
                  style={{ background: `${color}15`, color }}>
                  {idx + 1}
                </div>
                <div className="flex-1 min-w-0">
                  {/* Vehicle name */}
                  <div className="flex items-center gap-2 mb-0.5">
                    <p className="font-semibold text-sm truncate" style={{ color: "#1A1A2E" }}>{trip.vehicleName}</p>
                    <span className="flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ background: `${color}15`, color }}>
                      {trip.plateNumber}
                    </span>
                  </div>
                  {/* Times */}
                  <p className="text-xs mb-1" style={{ color: "#9CA3AF" }}>
                    <span style={{ color: "#22c55e", fontWeight: 600 }}>{fmtDateTime(trip.startTime)}</span>
                    {trip.endTime && (
                      <> → <span style={{ color: "#ef4444", fontWeight: 600 }}>{fmtDateTime(trip.endTime)}</span></>
                    )}
                  </p>
                  {/* Stats */}
                  <div className="flex items-center gap-3 text-xs" style={{ color: "#6B7280" }}>
                    <span>{formatDur(trip.durationMinutes)}</span>
                    <span style={{ color: "#3b82f6", fontWeight: 600 }}>{formatNumber(trip.distanceKm)} km</span>
                    {trip.fuelConsumed > 0 && (
                      <span style={{ color: "#E84040", fontWeight: 600 }}>{formatNumber(trip.fuelConsumed)} L</span>
                    )}
                    {trip.maxSpeed > 0 && (
                      <span>{formatNumber(trip.maxSpeed, 0)} km/h max</span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Right: map */}
        <div className="flex-1 min-w-0 relative">
          {!selectedTrip ? (
            <div className="h-full flex flex-col items-center justify-center" style={{ background: "#F8FAFC" }}>
              <Route size={56} style={{ color: "#D1D5DB" }} className="mb-3" />
              <p className="text-base font-semibold" style={{ color: "#9CA3AF" }}>Select a trip to see its route</p>
              <p className="text-sm mt-1" style={{ color: "#C4C4C4" }}>{allTrips.length} trips available</p>
            </div>
          ) : (
            <>
              {/* Route loading overlay */}
              {routeLoading && (
                <div className="absolute inset-0 z-[1000] flex items-center justify-center"
                  style={{ background: "rgba(255,255,255,0.7)", backdropFilter: "blur(4px)" }}>
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-10 h-10 rounded-full border-4 border-blue-200 border-t-blue-600 animate-spin" />
                    <p className="text-sm font-medium" style={{ color: "#3b82f6" }}>Loading route…</p>
                  </div>
                </div>
              )}
              <MapContainer
                center={mapCenter}
                zoom={13}
                style={{ height: "100%", width: "100%" }}
                scrollWheelZoom
                zoomControl
              >
                <TileLayer
                  attribution='&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
                  url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
                  subdomains="abcd"
                  maxZoom={19}
                />
                <ScaleControl position="bottomright" imperial={false} />

                {allCoords.length > 1 && <RouteBoundsController coords={allCoords} />}

                {/* Speed-coloured route segments */}
                {speedSegs.map((seg, i) => (
                  <Polyline
                    key={i}
                    positions={seg.coords}
                    color={seg.color}
                    weight={4}
                    opacity={0.85}
                    smoothFactor={1.5}
                  />
                ))}

                {/* Start marker */}
                {allCoords.length > 0 && (
                  <Marker position={allCoords[0]} icon={makeStartEndIcon("start")}>
                    <Popup>
                      <div style={{ fontFamily: "inherit", minWidth: 160 }}>
                        <p style={{ fontWeight: 700, color: "#22c55e", marginBottom: 4 }}>▶ Trip Start</p>
                        <p style={{ fontSize: 12, color: "#1A1A2E", fontWeight: 600 }}>{selectedTrip.vehicleName}</p>
                        <p style={{ fontSize: 11, color: "#6B7280" }}>{fmtDateTime(selectedTrip.startTime)}</p>
                      </div>
                    </Popup>
                    <Tooltip direction="top" offset={[0, -18]} opacity={1} permanent={false}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#22c55e" }}>Start</span>
                    </Tooltip>
                  </Marker>
                )}

                {/* End marker */}
                {allCoords.length > 1 && selectedTrip.endTime && (
                  <Marker position={allCoords[allCoords.length - 1]} icon={makeStartEndIcon("end")}>
                    <Popup>
                      <div style={{ fontFamily: "inherit", minWidth: 160 }}>
                        <p style={{ fontWeight: 700, color: "#ef4444", marginBottom: 4 }}>■ Trip End</p>
                        <p style={{ fontSize: 12, color: "#1A1A2E", fontWeight: 600 }}>{selectedTrip.vehicleName}</p>
                        <p style={{ fontSize: 11, color: "#6B7280" }}>{fmtDateTime(selectedTrip.endTime)}</p>
                        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                          <div>
                            <p style={{ fontSize: 10, color: "#9CA3AF" }}>Distance</p>
                            <p style={{ fontSize: 13, fontWeight: 700, color: "#3b82f6" }}>{formatNumber(selectedTrip.distanceKm)} km</p>
                          </div>
                          <div>
                            <p style={{ fontSize: 10, color: "#9CA3AF" }}>Duration</p>
                            <p style={{ fontSize: 13, fontWeight: 700, color: "#1A1A2E" }}>{formatDur(selectedTrip.durationMinutes)}</p>
                          </div>
                          {selectedTrip.fuelConsumed > 0 && (
                            <div>
                              <p style={{ fontSize: 10, color: "#9CA3AF" }}>Fuel</p>
                              <p style={{ fontSize: 13, fontWeight: 700, color: "#E84040" }}>{formatNumber(selectedTrip.fuelConsumed)} L</p>
                            </div>
                          )}
                        </div>
                      </div>
                    </Popup>
                    <Tooltip direction="top" offset={[0, -18]} opacity={1} permanent={false}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#ef4444" }}>End</span>
                    </Tooltip>
                  </Marker>
                )}
              </MapContainer>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const formatNumber = (num: number, decimals = 1): string => {
  if (num === null || num === undefined || isNaN(num)) return "—";
  return num.toFixed(decimals);
};

// ── TheftLocationView ────────────────────────────────────────────────────────

function TheftLocationView({ data, loading }: { data: TheftLocationsReportData | null; loading: boolean }) {
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  const pins: TheftPin[] = useMemo(() => {
    if (!data?.events) return [];
    return data.events.map((e) => ({
      lat: e.lat,
      lng: e.lng,
      vehicleName: e.name,
      plateNumber: e.plateNumber,
      at: e.at,
      fuelBefore: e.fuelBefore,
      fuelAfter: e.fuelAfter,
      consumed: e.consumed,
      imei: e.imei,
    }));
  }, [data]);

  const firstMappable = pins.find((p) => p.lat !== null && p.lng !== null) as (TheftPin & { lat: number; lng: number }) | undefined;
  const mapCenter: [number, number] = firstMappable
    ? [firstMappable.lat, firstMappable.lng]
    : [24.8607, 67.0011]; // Karachi fallback

  const fleetTotalLost = useMemo(
    () => pins.reduce((sum, p) => sum + p.consumed, 0),
    [pins],
  );

  if (loading) {
    return (
      <div className="flex-1 rounded-xl flex items-center justify-center" style={{ background: "rgba(255,255,255,0.95)", border: "1px solid rgba(255,255,255,0.8)" }}>
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-full border-4 border-purple-200 border-t-purple-600 animate-spin" />
          <p className="text-sm font-medium" style={{ color: "#6B7280" }}>Loading theft locations…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 rounded-xl overflow-hidden flex flex-col" style={{ background: "rgba(255,255,255,0.95)", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.8)", boxShadow: "0 2px 12px rgba(0,0,0,0.03)", minHeight: 0 }}>
      {/* Header */}
      <div className="flex-shrink-0 p-4 border-b flex items-center justify-between" style={{ borderColor: "rgba(240,239,239,0.8)" }}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "#7c3aed15" }}>
            <MapPin size={20} style={{ color: "#7c3aed" }} />
          </div>
          <div>
            <h3 className="font-semibold text-lg" style={{ color: "#1A1A2E" }}>Theft Locations</h3>
            <p className="text-sm" style={{ color: "#9CA3AF" }}>Confirmed fuel theft events</p>
          </div>
        </div>
        <div className="flex gap-3">
          <div className="text-center px-4 py-2 rounded-xl" style={{ background: "#7c3aed15", border: "1px solid #7c3aed30" }}>
            <p className="text-xs" style={{ color: "#9CA3AF" }}>Events</p>
            <p className="font-bold text-lg" style={{ color: "#7c3aed" }}>{data?.totalEvents ?? pins.length}</p>
          </div>
          <div className="text-center px-4 py-2 rounded-xl" style={{ background: "#dc262615", border: "1px solid #dc262630" }}>
            <p className="text-xs" style={{ color: "#9CA3AF" }}>Fuel Lost</p>
            <p className="font-bold text-lg" style={{ color: "#dc2626" }}>{formatNumber(fleetTotalLost)} L</p>
          </div>
        </div>
      </div>

      {/* Body: list + map */}
      <div className="flex-1 flex min-h-0">
        {/* Left: event list */}
        <div className="w-[38%] flex-shrink-0 border-r overflow-y-auto" style={{ borderColor: "rgba(240,239,239,0.8)" }}>
          {pins.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-16 px-6">
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ background: "#F3F4F6" }}>
                <AlertTriangle size={28} style={{ color: "#9CA3AF" }} />
              </div>
              <h3 className="text-base font-semibold mb-1" style={{ color: "#1A1A2E" }}>No Confirmed Thefts</h3>
              <p className="text-sm text-center" style={{ color: "#9CA3AF" }}>No fuel theft events detected in the selected period.</p>
            </div>
          ) : (
            pins.map((pin, idx) => {
              const isActive = selectedIdx === idx;
              const color = isActive ? THEFT_COLOR_SELECTED : THEFT_COLOR;
              return (
                <button
                  key={`${pin.imei}-${pin.at}-${idx}`}
                  onClick={() => setSelectedIdx(isActive ? null : idx)}
                  className="w-full text-left p-4 border-b flex items-start gap-3 transition-all"
                  style={{
                    borderColor: "rgba(240,239,239,0.6)",
                    background: isActive ? `${color}08` : "transparent",
                    borderLeft: isActive ? `3px solid ${color}` : "3px solid transparent",
                  }}
                >
                  <div className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center mt-0.5" style={{ background: `${color}15` }}>
                    <Droplets size={14} style={{ color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm truncate mb-0.5" style={{ color: "#1A1A2E" }}>{pin.vehicleName}</p>
                    <p className="text-xs mb-1" style={{ color: "#9CA3AF" }}>{pin.plateNumber} · {fmtDateTime(pin.at)}</p>
                    <div className="flex items-center gap-3 mb-1">
                      <span className="text-xs font-semibold" style={{ color: THEFT_COLOR }}>−{formatNumber(pin.consumed)} L</span>
                      <span className="text-xs" style={{ color: "#9CA3AF" }}>{formatNumber(pin.fuelBefore)} → {formatNumber(pin.fuelAfter)} L</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Navigation size={9} style={{ color: "#9CA3AF", flexShrink: 0 }} />
                      <span className="text-[10px] font-mono" style={{ color: "#9CA3AF" }}>
                        {pin.lat !== null && pin.lng !== null
                          ? `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`
                          : "Location unknown"}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Right: map */}
        <div className="flex-1 min-w-0 relative">
          {pins.length === 0 ? (
            <div className="h-full flex items-center justify-center" style={{ background: "#F8FAFC" }}>
              <div className="text-center">
                <MapPin size={48} style={{ color: "#D1D5DB" }} className="mx-auto mb-3" />
                <p className="text-sm" style={{ color: "#9CA3AF" }}>No locations to display</p>
              </div>
            </div>
          ) : (
            <MapContainer
              center={mapCenter}
              zoom={pins.length === 1 ? 15 : 12}
              style={{ height: "100%", width: "100%" }}
              scrollWheelZoom
              zoomControl
            >
              {/* CartoDB Positron — clean light base that makes red pins pop */}
              <TileLayer
                attribution='&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
                url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
                subdomains="abcd"
                maxZoom={19}
              />

              <ScaleControl position="bottomright" imperial={false} />
              <MapController pins={pins} selectedIdx={selectedIdx} />

              {pins.map((pin, idx) => {
                if (pin.lat === null || pin.lng === null) return null;
                const isSelected = selectedIdx === idx;
                return (
                  <Marker
                    key={`${pin.imei}-${pin.at}-${idx}`}
                    position={[pin.lat, pin.lng]}
                    icon={makeTheftIcon(isSelected, pin.consumed)}
                    zIndexOffset={isSelected ? 1000 : 0}
                    eventHandlers={{
                      click: () => setSelectedIdx(isSelected ? null : idx),
                    }}
                  >
                    {/* Hover tooltip */}
                    <Tooltip direction="top" offset={[0, -8]} opacity={1}>
                      <div style={{ fontFamily: "inherit", minWidth: 140 }}>
                        <p style={{ fontWeight: 700, fontSize: 12, color: "#1A1A2E", marginBottom: 2 }}>
                          {pin.vehicleName}
                        </p>
                        <p style={{ fontSize: 11, color: THEFT_COLOR, fontWeight: 600 }}>
                          −{formatNumber(pin.consumed)} L stolen
                        </p>
                        <p style={{ fontSize: 10, color: "#9CA3AF", marginTop: 2 }}>
                          {fmtDateTime(pin.at)}
                        </p>
                      </div>
                    </Tooltip>

                    {/* Click popup */}
                    <Popup minWidth={220} maxWidth={260}>
                      <div style={{ fontFamily: "inherit" }}>
                        {/* Popup header bar */}
                        <div style={{
                          margin: "-14px -16px 12px",
                          padding: "10px 16px",
                          background: isSelected
                            ? "linear-gradient(135deg, #7c3aed, #6d28d9)"
                            : "linear-gradient(135deg, #dc2626, #b91c1c)",
                          borderRadius: "14px 14px 0 0",
                        }}>
                          <p style={{ color: "white", fontWeight: 700, fontSize: 11, opacity: 0.8, marginBottom: 2, letterSpacing: "0.05em" }}>
                            ⚠ FUEL THEFT DETECTED
                          </p>
                          <p style={{ color: "white", fontWeight: 700, fontSize: 14 }}>{pin.vehicleName}</p>
                          <p style={{ color: "rgba(255,255,255,0.75)", fontSize: 11 }}>{pin.plateNumber}</p>
                        </div>

                        {/* Time */}
                        <p style={{ fontSize: 11, color: "#6B7280", marginBottom: 10 }}>
                          🕐 {fmtDateTime(pin.at)}
                        </p>

                        {/* Fuel metrics */}
                        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                          <div style={{ flex: 1, textAlign: "center", padding: "8px 4px", borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca" }}>
                            <p style={{ fontSize: 10, color: "#9CA3AF", marginBottom: 2 }}>Stolen</p>
                            <p style={{ fontSize: 15, fontWeight: 800, color: THEFT_COLOR }}>−{formatNumber(pin.consumed)} L</p>
                          </div>
                          <div style={{ flex: 1, textAlign: "center", padding: "8px 4px", borderRadius: 8, background: "#f9fafb", border: "1px solid #e5e7eb" }}>
                            <p style={{ fontSize: 10, color: "#9CA3AF", marginBottom: 2 }}>Before</p>
                            <p style={{ fontSize: 13, fontWeight: 700, color: "#1A1A2E" }}>{formatNumber(pin.fuelBefore)} L</p>
                          </div>
                          <div style={{ flex: 1, textAlign: "center", padding: "8px 4px", borderRadius: 8, background: "#f9fafb", border: "1px solid #e5e7eb" }}>
                            <p style={{ fontSize: 10, color: "#9CA3AF", marginBottom: 2 }}>After</p>
                            <p style={{ fontSize: 13, fontWeight: 700, color: "#1A1A2E" }}>{formatNumber(pin.fuelAfter)} L</p>
                          </div>
                        </div>

                        {/* Location */}
                        <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 8px", borderRadius: 8, background: "#f9fafb", border: "1px solid #e5e7eb" }}>
                          <MapPin size={11} style={{ color: "#9CA3AF", flexShrink: 0 }} />
                          <span style={{ fontSize: 10, fontFamily: "monospace", color: "#6B7280" }}>
                            {pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}
                          </span>
                        </div>
                      </div>
                    </Popup>
                  </Marker>
                );
              })}
            </MapContainer>
          )}
        </div>
      </div>
    </div>
  );
}

const formatDateTime = (iso: string): string => fmtDateTime(iso);

// Fix Leaflet default icon (broken in Next.js / Webpack)
if (typeof window !== "undefined") {
  // @ts-ignore
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
    iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
    shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  });
}

function SpecialReportViewsComponent({
  activeReport,
  loading,
  dailyTrendData,
  refuelData,
  engineHoursData,
  vehicleStatusData,
  idleWasteData,
  tripsData,
  theftLocationData,
  vehicles,
}: SpecialReportViewsProps) {
  const [expandedVehicles, setExpandedVehicles] = useState<Set<string>>(new Set());

  const toggleVehicle = (imei: string) => {
    setExpandedVehicles((prev) => {
      const next = new Set(prev);
      if (next.has(imei)) {
        next.delete(imei);
      } else {
        next.add(imei);
      }
      return next;
    });
  };

  const formatDuration = (minutes: number): string => {
    if (minutes < 60) {
      return `${Math.round(minutes)} min`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  };

  const content = useMemo(() => {
    // Full width daily trends chart layout
    if (activeReport === "daily-trend" && dailyTrendData?.fleetDailyTrend?.length) {
      return (
        <div className="flex-1 rounded-xl overflow-hidden flex flex-col" style={{ background: "rgba(255, 255, 255, 0.95)", backdropFilter: "blur(20px)", border: "1px solid rgba(255, 255, 255, 0.8)", boxShadow: "0 2px 12px rgba(0, 0, 0, 0.03)", minHeight: 0 }}>
          <div className="p-5 border-b flex items-center justify-between" style={{ borderColor: "rgba(240, 239, 239, 0.8)" }}>
            <div>
              <h3 className="font-semibold text-xl" style={{ color: "#1A1A2E" }}>Daily Fuel Consumption Trends</h3>
              <p className="text-sm mt-1" style={{ color: "#9CA3AF" }}>Fleet consumption vs Distance over time</p>
            </div>
            <div className="flex gap-4">
              <div className="text-right">
                <p className="text-xs" style={{ color: "#9CA3AF" }}>Total Consumed</p>
                <p className="font-bold text-lg" style={{ color: "#E84040" }}>
                  {formatNumber(dailyTrendData.fleetDailyTrend.reduce((a: number, d: any) => a + (d.consumed || 0), 0))} L
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs" style={{ color: "#9CA3AF" }}>Total Distance</p>
                <p className="font-bold text-lg" style={{ color: "#3b82f6" }}>
                  {formatNumber(dailyTrendData.fleetDailyTrend.reduce((a: number, d: any) => a + (d.distanceKm || 0), 0))} km
                </p>
              </div>
            </div>
          </div>
          <div className="flex-1 p-4 min-h-0">
            <EnhancedChart
              type="area"
              data={dailyTrendData.fleetDailyTrend}
              dataKeys={[
                { key: "consumed", name: "Fleet Consumed (L)", color: "#E84040" },
                { key: "distanceKm", name: "Distance (km)", color: "#3b82f6" },
              ]}
              xAxisKey="date"
              height={500}
              showLegend
              gradient
            />
          </div>
        </div>
      );
    }

    // Full width refueling events layout
    if (activeReport === "refuels" && refuelData?.events) {
      return (
        <div className="flex-1 rounded-xl overflow-hidden" style={{ background: "rgba(255, 255, 255, 0.95)", backdropFilter: "blur(20px)", border: "1px solid rgba(255, 255, 255, 0.8)", boxShadow: "0 2px 12px rgba(0, 0, 0, 0.03)", minHeight: 0 }}>
          <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: "rgba(240, 239, 239, 0.8)" }}>
            <h3 className="font-semibold text-lg" style={{ color: "#1A1A2E" }}>Recent Refueling Events</h3>
            <span className="text-sm px-3 py-1 rounded-full" style={{ background: "#E8404015", color: "#E84040" }}>
              {refuelData.events.length} Total Events
            </span>
          </div>
          <div className="overflow-auto h-full" style={{ maxHeight: "calc(100% - 60px)" }}>
            {refuelData.events.map((event: any, idx: number) => (
              <div key={idx} className="p-4 flex items-center justify-between border-b hover:bg-gray-50 transition-colors" style={{ borderColor: "rgba(240, 239, 239, 0.5)" }}>
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: "#E8404015" }}>
                    <span className="text-sm font-bold" style={{ color: "#E84040" }}>{idx + 1}</span>
                  </div>
                  <div>
                    <p className="font-semibold text-base" style={{ color: "#1A1A2E" }}>{event.name}</p>
                    <p className="text-sm" style={{ color: "#9CA3AF" }}>{formatDateTime(event.at)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-8 text-right">
                  <div>
                    <p className="text-sm" style={{ color: "#9CA3AF" }}>Added</p>
                    <p className="font-bold text-lg" style={{ color: "#22c55e" }}>+{formatNumber(event.added)} L</p>
                  </div>
                  <div>
                    <p className="text-sm" style={{ color: "#9CA3AF" }}>Fuel Level</p>
                    <p className="font-medium text-sm" style={{ color: "#1A1A2E" }}>
                      {formatNumber(event.fuelBefore)} → <span className="font-bold">{formatNumber(event.fuelAfter)} L</span>
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    // Full width Engine Hours Ranking
    if (activeReport === "engine-hours" && engineHoursData) {
      return (
        <div className="flex-1 rounded-xl overflow-hidden flex flex-col" style={{ background: "rgba(255, 255, 255, 0.95)", backdropFilter: "blur(20px)", border: "1px solid rgba(255, 255, 255, 0.8)", boxShadow: "0 2px 12px rgba(0, 0, 0, 0.03)", minHeight: 0 }}>
          <div className="p-5 border-b flex items-center justify-between" style={{ borderColor: "rgba(240, 239, 239, 0.8)" }}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "#14b8a615" }}>
                <Clock size={20} style={{ color: "#14b8a6" }} />
              </div>
              <div>
                <h3 className="font-semibold text-lg" style={{ color: "#1A1A2E" }}>Engine Hours Ranking</h3>
                <p className="text-sm" style={{ color: "#9CA3AF" }}>By total runtime</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs" style={{ color: "#9CA3AF" }}>Fleet Total</p>
              <p className="font-bold text-lg" style={{ color: "#14b8a6" }}>{formatNumber(engineHoursData.fleetTotalEngineHours || 0)} hrs</p>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-4">
            <div className="space-y-3">
              {[...engineHoursData.vehicles]
                .sort((a: any, b: any) => (b.engineOnHours || 0) - (a.engineOnHours || 0))
                .map((v: any, i: number) => {
                  const rankColors = ["#FFD700", "#C0C0C0", "#CD7F32"];
                  const score = Math.min(100, Math.round(((v.engineOnHours || 0) / 120) * 100));
                  const scoreColor = score >= 80 ? "#22c55e" : score >= 60 ? "#3b82f6" : score >= 40 ? "#f59e0b" : "#ef4444";
                  return (
                    <div
                      key={v.imei}
                      className="p-4 rounded-xl flex items-center justify-between transition-all hover:shadow-md"
                      style={{
                        background: "rgba(255, 255, 255, 0.8)",
                        border: "1px solid rgba(229, 231, 235, 0.5)",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                      }}
                    >
                      <div className="flex items-center gap-4">
                        <div
                          className="w-10 h-10 rounded-xl flex items-center justify-center font-bold text-sm"
                          style={{
                            background: i < 3 ? `${rankColors[i]}20` : "#F3F4F6",
                            color: i < 3 ? rankColors[i] : "#6B7280",
                            border: i < 3 ? `2px solid ${rankColors[i]}40` : "none",
                          }}
                        >
                          {i + 1}
                        </div>
                        <div>
                          <p className="font-semibold text-base" style={{ color: "#1A1A2E" }}>{v.name}</p>
                          <p className="text-sm" style={{ color: "#9CA3AF" }}>{v.plateNumber}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-8">
                        <div className="text-center">
                          <p className="text-xs" style={{ color: "#9CA3AF" }}>Hours</p>
                          <p className="font-bold text-lg" style={{ color: "#1A1A2E" }}>{formatNumber(v.engineOnHours || 0)}</p>
                        </div>
                        <div className="text-center">
                          <p className="text-xs" style={{ color: "#9CA3AF" }}>Avg/Day</p>
                          <p className="font-bold text-lg" style={{ color: "#1A1A2E" }}>{formatNumber(v.avgHoursPerDay || 0)}</p>
                        </div>
                        <div
                          className="px-4 py-2 rounded-xl text-center min-w-[70px]"
                          style={{ background: `${scoreColor}15`, border: `1px solid ${scoreColor}30` }}
                        >
                          <p className="text-xs" style={{ color: "#9CA3AF" }}>SCORE</p>
                          <p className="font-bold text-xl" style={{ color: scoreColor }}>{score}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      );
    }

    // Full width Vehicle Status
    if (activeReport === "vehicle-status" && vehicleStatusData) {
      return (
        <div className="flex-1 rounded-xl overflow-hidden flex flex-col" style={{ background: "rgba(255, 255, 255, 0.95)", backdropFilter: "blur(20px)", border: "1px solid rgba(255, 255, 255, 0.8)", boxShadow: "0 2px 12px rgba(0, 0, 0, 0.03)", minHeight: 0 }}>
          <div className="p-5 border-b flex items-center justify-between" style={{ borderColor: "rgba(240, 239, 239, 0.8)" }}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "#6366f115" }}>
                <MapPin size={20} style={{ color: "#6366f1" }} />
              </div>
              <div>
                <h3 className="font-semibold text-lg" style={{ color: "#1A1A2E" }}>Fleet Status</h3>
                <p className="text-sm" style={{ color: "#9CA3AF" }}>Real-time vehicle snapshot</p>
              </div>
            </div>
            <div className="flex gap-4">
              <div className="text-center px-4 py-2 rounded-xl" style={{ background: "#22c55e15", border: "1px solid #22c55e30" }}>
                <p className="text-xs" style={{ color: "#22c55e" }}>Online</p>
                <p className="font-bold text-lg" style={{ color: "#22c55e" }}>{vehicleStatusData.online}</p>
              </div>
              <div className="text-center px-4 py-2 rounded-xl" style={{ background: "#ef444415", border: "1px solid #ef444430" }}>
                <p className="text-xs" style={{ color: "#ef4444" }}>Offline</p>
                <p className="font-bold text-lg" style={{ color: "#ef4444" }}>{vehicleStatusData.offline}</p>
              </div>
              <div className="text-center px-4 py-2 rounded-xl" style={{ background: "#3b82f615", border: "1px solid #3b82f630" }}>
                <p className="text-xs" style={{ color: "#3b82f6" }}>Total</p>
                <p className="font-bold text-lg" style={{ color: "#3b82f6" }}>{vehicleStatusData.totalVehicles}</p>
              </div>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {vehicleStatusData.vehicles.map((v: any) => (
                <div
                  key={v.imei}
                  className="p-4 rounded-xl flex items-center justify-between transition-all hover:shadow-md"
                  style={{
                    background: "rgba(255, 255, 255, 0.8)",
                    border: "1px solid rgba(229, 231, 235, 0.5)",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                  }}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ background: v.status === "online" ? "#22c55e" : "#ef4444" }}
                    />
                    <div>
                      <p className="font-semibold text-sm" style={{ color: "#1A1A2E" }}>{v.name}</p>
                      <p className="text-xs" style={{ color: "#9CA3AF" }}>{v.plateNumber}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-medium" style={{ color: v.status === "online" ? "#22c55e" : "#ef4444" }}>
                      {v.status === "online" ? "Online" : "Offline"}
                    </p>
                    {v.lastSeen && (
                      <p className="text-xs" style={{ color: "#9CA3AF" }}>
                        {formatDateTime(v.lastSeen)}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }

    // Trips — side-by-side route map
    if (activeReport === "trips") {
      return <TripRouteView tripsData={tripsData} loading={loading} />;
    }

    // Full width Trips Report (legacy — kept for reference, no longer rendered)
    if (activeReport === "trips-legacy" && tripsData) {
      const hasVehicles = tripsData.vehicles && tripsData.vehicles.length > 0;
      const getTripFuelUsed = (trip: any): number => {
        const reported =
          typeof trip?.fuelConsumed === "number" && Number.isFinite(trip.fuelConsumed)
            ? Math.max(0, trip.fuelConsumed)
            : null;
        const hasBoundaries =
          typeof trip?.fuelAtStart === "number" &&
          Number.isFinite(trip.fuelAtStart) &&
          typeof trip?.fuelAtEnd === "number" &&
          Number.isFinite(trip.fuelAtEnd);
        const boundary = hasBoundaries ? Math.max(0, trip.fuelAtStart - trip.fuelAtEnd) : null;
        // Use backend-calculated trip fuel as source of truth.
        // Fallback to boundary delta only when backend value is missing.
        if (reported != null) return reported;
        if (boundary != null) return boundary;
        return 0;
      };
      const getTripEfficiency = (trip: any): number | null => {
        if (typeof trip?.kmPerLiter === "number" && Number.isFinite(trip.kmPerLiter) && trip.kmPerLiter > 0) {
          return trip.kmPerLiter;
        }
        const fuelUsed = getTripFuelUsed(trip);
        const distanceKm = Number.isFinite(trip?.distanceKm) ? Math.max(0, trip.distanceKm) : 0;
        if (fuelUsed <= 0 || distanceKm <= 0) return null;
        return distanceKm / fuelUsed;
      };
      const getVehicleTripFuel = (vehicle: any): number => {
        if (typeof vehicle?.tripFuelConsumed === "number" && Number.isFinite(vehicle.tripFuelConsumed)) {
          return Math.max(0, vehicle.tripFuelConsumed);
        }
        // Never fall back to period fuel here; derive strictly from trip records.
        return (vehicle?.trips ?? []).reduce(
          (sum: number, trip: any) => sum + getTripFuelUsed(trip),
          0
        );
      };
      const getVehiclePeriodFuel = (vehicle: any): number => {
        if (typeof vehicle?.totalFuelConsumed === "number" && Number.isFinite(vehicle.totalFuelConsumed)) {
          return Math.max(0, vehicle.totalFuelConsumed);
        }
        return getVehicleTripFuel(vehicle);
      };
      const getVehicleUnassignedFuel = (vehicle: any): number => {
        if (
          typeof vehicle?.unassignedFuelConsumed === "number" &&
          Number.isFinite(vehicle.unassignedFuelConsumed)
        ) {
          return Math.max(0, vehicle.unassignedFuelConsumed);
        }
        return Math.max(0, getVehiclePeriodFuel(vehicle) - getVehicleTripFuel(vehicle));
      };
      const getVehicleTripEfficiency = (vehicle: any): number | null => {
        if (
          typeof vehicle?.avgKmPerLiter === "number" &&
          Number.isFinite(vehicle.avgKmPerLiter) &&
          vehicle.avgKmPerLiter > 0
        ) {
          return vehicle.avgKmPerLiter;
        }
        const tripFuel = getVehicleTripFuel(vehicle);
        const distanceKm = Number.isFinite(vehicle?.totalDistanceKm) ? Math.max(0, vehicle.totalDistanceKm) : 0;
        if (tripFuel <= 0 || distanceKm <= 0) return null;
        return distanceKm / tripFuel;
      };
      const fleetTripFuelFromVehicles = hasVehicles
        ? tripsData.vehicles.reduce((sum: number, vehicle: any) => sum + getVehicleTripFuel(vehicle), 0)
        : 0;
      const fleetPeriodFuelFromVehicles = hasVehicles
        ? tripsData.vehicles.reduce((sum: number, vehicle: any) => sum + getVehiclePeriodFuel(vehicle), 0)
        : 0;
      const fleetTripFuel = Number.isFinite(tripsData.fleetTotals?.tripFuelConsumed)
        ? Math.max(0, tripsData.fleetTotals.tripFuelConsumed)
        : fleetTripFuelFromVehicles;
      const fleetPeriodFuel = fleetPeriodFuelFromVehicles > 0
        ? fleetPeriodFuelFromVehicles
        : Math.max(0, tripsData.fleetTotals?.totalFuelConsumed || 0);
      const allTrips = hasVehicles
        ? tripsData.vehicles.flatMap((v: any) =>
            v.trips.map((t: any) => ({ ...t, vehicleName: v.name, vehiclePlate: v.plateNumber }))
          )
        : [];

      return (
        <div className="flex-1 rounded-xl overflow-hidden flex flex-col" style={{ background: "rgba(255, 255, 255, 0.95)", backdropFilter: "blur(20px)", border: "1px solid rgba(255, 255, 255, 0.8)", boxShadow: "0 2px 12px rgba(0, 0, 0, 0.03)", minHeight: 0 }}>
          <div className="p-5 border-b flex items-center justify-between" style={{ borderColor: "rgba(240, 239, 239, 0.8)" }}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "#3b82f615" }}>
                <Route size={20} style={{ color: "#3b82f6" }} />
              </div>
              <div>
                <h3 className="font-semibold text-lg" style={{ color: "#1A1A2E" }}>Trip Analysis</h3>
                <p className="text-sm" style={{ color: "#9CA3AF" }}>Individual trips from ignition on to off</p>
              </div>
            </div>
            <div className="flex gap-4">
              <div className="text-center px-4 py-2 rounded-xl" style={{ background: "#3b82f615", border: "1px solid #3b82f630" }}>
                <p className="text-xs" style={{ color: "#9CA3AF" }}>Total Trips</p>
                <p className="font-bold text-lg" style={{ color: "#3b82f6" }}>{tripsData.fleetTotals?.totalTrips || 0}</p>
              </div>
              <div className="text-center px-4 py-2 rounded-xl" style={{ background: "#22c55e15", border: "1px solid #22c55e30" }}>
                <p className="text-xs" style={{ color: "#9CA3AF" }}>Distance</p>
                <p className="font-bold text-lg" style={{ color: "#22c55e" }}>{formatNumber(tripsData.fleetTotals?.totalDistanceKm || 0)} km</p>
              </div>
              <div className="text-center px-4 py-2 rounded-xl" style={{ background: "#E8404015", border: "1px solid #E8404030" }}>
                <p className="text-xs" style={{ color: "#9CA3AF" }}>Fuel (Period)</p>
                <p className="font-bold text-lg" style={{ color: "#E84040" }}>{formatNumber(fleetPeriodFuel)} L</p>
              </div>
              <div className="text-center px-4 py-2 rounded-xl" style={{ background: "#f59e0b15", border: "1px solid #f59e0b30" }}>
                <p className="text-xs" style={{ color: "#9CA3AF" }}>Fuel (Trips)</p>
                <p className="font-bold text-lg" style={{ color: "#f59e0b" }}>{formatNumber(fleetTripFuel)} L</p>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-auto p-4">
            {!hasVehicles ? (
              <div className="flex flex-col items-center justify-center py-12">
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ background: "#F3F4F6" }}>
                  <Route size={32} style={{ color: "#9CA3AF" }} />
                </div>
                <h3 className="text-lg font-semibold mb-2" style={{ color: "#1A1A2E" }}>No Trips Found</h3>
                <p className="text-sm" style={{ color: "#9CA3AF" }}>No trips detected in the selected date range</p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* All Trips Table */}
                {allTrips.length > 0 && (
                  <div className="rounded-xl overflow-hidden" style={{ background: "rgba(255, 255, 255, 0.8)", border: "1px solid rgba(229, 231, 235, 0.5)" }}>
                    <div className="p-4 border-b" style={{ borderColor: "rgba(229, 231, 235, 0.5)" }}>
                      <h4 className="font-semibold text-sm" style={{ color: "#1A1A2E" }}>All Trips</h4>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left" style={{ background: "rgba(248, 250, 252, 0.8)" }}>
                            <th className="px-4 py-3 font-medium" style={{ color: "#6B7280" }}>#</th>
                            <th className="px-4 py-3 font-medium" style={{ color: "#6B7280" }}>Vehicle</th>
                            <th className="px-4 py-3 font-medium" style={{ color: "#22c55e" }}>Ign. ON</th>
                            <th className="px-4 py-3 font-medium" style={{ color: "#ef4444" }}>Ign. OFF</th>
                            <th className="px-4 py-3 font-medium" style={{ color: "#6B7280" }}>Duration</th>
                            <th className="px-4 py-3 font-medium" style={{ color: "#6B7280" }}>Distance</th>
                            <th className="px-4 py-3 font-medium" style={{ color: "#6B7280" }}>Fuel Used</th>
                            <th className="px-4 py-3 font-medium" style={{ color: "#6B7280" }}>Max Speed</th>
                          </tr>
                        </thead>
                        <tbody>
                          {allTrips.slice(0, 100).map((trip: any, idx: number) => (
                            <tr key={`${trip.tripId}-${idx}`} className="border-b hover:bg-gray-50 transition-colors" style={{ borderColor: "rgba(229, 231, 235, 0.3)" }}>
                              <td className="px-4 py-3">
                                <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-xs font-semibold" style={{ background: "#0ea5e915", color: "#0ea5e9" }}>
                                  {idx + 1}
                                </span>
                              </td>
                              <td className="px-4 py-3">
                                <p className="font-medium" style={{ color: "#1A1A2E" }}>{trip.vehicleName}</p>
                                <p className="text-xs" style={{ color: "#9CA3AF" }}>{trip.vehiclePlate}</p>
                              </td>
                              <td className="px-4 py-3">
                                <span style={{ color: "#22c55e", fontWeight: 500 }}>{formatDateTime(trip.startTime)}</span>
                              </td>
                              <td className="px-4 py-3">
                                <span style={{ color: "#ef4444", fontWeight: 500 }}>{trip.endTime ? formatDateTime(trip.endTime) : "—"}</span>
                              </td>
                              <td className="px-4 py-3" style={{ color: "#6B7280" }}>
                                {formatDuration(trip.durationMinutes)}
                                {trip.idleDurationMinutes > 5 && (
                                  <span className="block text-xs" style={{ color: "#f59e0b" }}>
                                    {formatDuration(trip.idleDurationMinutes)} idle
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                <span className="font-medium" style={{ color: "#3b82f6" }}>{formatNumber(trip.distanceKm)} km</span>
                              </td>
                              <td className="px-4 py-3">
                                <span className="font-medium" style={{ color: "#E84040" }}>{formatNumber(getTripFuelUsed(trip))} L</span>
                              </td>
                              <td className="px-4 py-3" style={{ color: "#6B7280" }}>
                                {formatNumber(trip.maxSpeed)} km/h
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {allTrips.length > 100 && (
                        <div className="p-4 text-center text-sm" style={{ color: "#9CA3AF" }}>
                          Showing first 100 of {allTrips.length} trips
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Per-Vehicle Summary */}
                <div className="rounded-xl overflow-hidden" style={{ background: "rgba(255, 255, 255, 0.8)", border: "1px solid rgba(229, 231, 235, 0.5)" }}>
                  <div className="p-4 border-b" style={{ borderColor: "rgba(229, 231, 235, 0.5)" }}>
                    <h4 className="font-semibold text-sm" style={{ color: "#1A1A2E" }}>Vehicle Trip Summaries</h4>
                  </div>
                  <div className="space-y-2 p-4">
                    {tripsData.vehicles.map((vehicle: any) => (
                      <div key={vehicle.imei} className="rounded-lg overflow-hidden" style={{ border: "1px solid rgba(229, 231, 235, 0.5)" }}>
                        <button
                          onClick={() => toggleVehicle(vehicle.imei)}
                          className="w-full p-4 flex items-center justify-between hover:bg-gray-50 transition-colors"
                          style={{ background: "rgba(248, 250, 252, 0.5)" }}
                        >
                          <div className="flex items-center gap-3">
                            {expandedVehicles.has(vehicle.imei) ? (
                              <ChevronDown size={18} style={{ color: "#6B7280" }} />
                            ) : (
                              <ChevronRight size={18} style={{ color: "#6B7280" }} />
                            )}
                            <div>
                              <p className="font-semibold" style={{ color: "#1A1A2E" }}>{vehicle.name}</p>
                              <p className="text-xs" style={{ color: "#9CA3AF" }}>{vehicle.plateNumber}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-6 text-sm">
                            <div className="text-center">
                              <p className="text-xs" style={{ color: "#9CA3AF" }}>Trips</p>
                              <p className="font-semibold" style={{ color: "#3b82f6" }}>{vehicle.totalTrips}</p>
                            </div>
                            <div className="text-center">
                              <p className="text-xs" style={{ color: "#9CA3AF" }}>Distance</p>
                              <p className="font-semibold" style={{ color: "#22c55e" }}>{formatNumber(vehicle.totalDistanceKm)} km</p>
                            </div>
                            <div className="text-center">
                              <p className="text-xs" style={{ color: "#9CA3AF" }}>Period Fuel</p>
                              <p className="font-semibold" style={{ color: "#E84040" }}>
                                {formatNumber(getVehiclePeriodFuel(vehicle))} L
                              </p>
                            </div>
                            <div className="text-center">
                              <p className="text-xs" style={{ color: "#9CA3AF" }}>Trip Fuel</p>
                              <p className="font-semibold" style={{ color: "#f59e0b" }}>
                                {formatNumber(getVehicleTripFuel(vehicle))} L
                              </p>
                            </div>
                            <div className="text-center">
                              <p className="text-xs" style={{ color: "#9CA3AF" }}>Unassigned</p>
                              <p className="font-semibold" style={{ color: "#6B7280" }}>
                                {formatNumber(getVehicleUnassignedFuel(vehicle))} L
                              </p>
                            </div>
                            <div className="text-center">
                              <p className="text-xs" style={{ color: "#9CA3AF" }}>Efficiency</p>
                              <p className="font-semibold" style={{ color: (getVehicleTripEfficiency(vehicle) ?? 0) >= 8 ? "#22c55e" : (getVehicleTripEfficiency(vehicle) ?? 0) >= 5 ? "#f59e0b" : "#ef4444" }}>
                                {getVehicleTripEfficiency(vehicle) ? `${formatNumber(getVehicleTripEfficiency(vehicle) ?? 0)} km/L` : "—"}
                              </p>
                            </div>
                          </div>
                        </button>

                        {expandedVehicles.has(vehicle.imei) && vehicle.trips.length > 0 && (
                          <div className="p-4 border-t" style={{ borderColor: "rgba(229, 231, 235, 0.3)" }}>
                            <div className="overflow-x-auto">
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="text-left" style={{ background: "rgba(248, 250, 252, 0.5)" }}>
                                    <th className="px-3 py-2 font-medium text-xs" style={{ color: "#6B7280" }}>#</th>
                                    <th className="px-3 py-2 font-medium text-xs" style={{ color: "#22c55e" }}>Ign. ON</th>
                                    <th className="px-3 py-2 font-medium text-xs" style={{ color: "#ef4444" }}>Ign. OFF</th>
                                    <th className="px-3 py-2 font-medium text-xs" style={{ color: "#6B7280" }}>Duration</th>
                                    <th className="px-3 py-2 font-medium text-xs" style={{ color: "#6B7280" }}>Distance</th>
                                    <th className="px-3 py-2 font-medium text-xs" style={{ color: "#6B7280" }}>Fuel Used</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {vehicle.trips.map((trip: any, tripIdx: number) => (
                                    <tr key={trip.tripId} className="border-b hover:bg-gray-50 transition-colors" style={{ borderColor: "rgba(229, 231, 235, 0.2)" }}>
                                      <td className="px-3 py-2">
                                        <span className="text-xs font-semibold" style={{ color: "#0ea5e9" }}>{tripIdx + 1}</span>
                                      </td>
                                      <td className="px-3 py-2 text-xs font-medium" style={{ color: "#22c55e" }}>
                                        {formatDateTime(trip.startTime)}
                                      </td>
                                      <td className="px-3 py-2 text-xs font-medium" style={{ color: "#ef4444" }}>
                                        {trip.endTime ? formatDateTime(trip.endTime) : "—"}
                                      </td>
                                      <td className="px-3 py-2 text-xs" style={{ color: "#6B7280" }}>
                                        {formatDuration(trip.durationMinutes)}
                                        {trip.idleDurationMinutes > 5 && (
                                          <span className="block text-xs" style={{ color: "#f59e0b" }}>
                                            {formatDuration(trip.idleDurationMinutes)} idle
                                          </span>
                                        )}
                                      </td>
                                      <td className="px-3 py-2 text-xs font-medium" style={{ color: "#3b82f6" }}>
                                        {formatNumber(trip.distanceKm)} km
                                      </td>
                                      <td className="px-3 py-2 text-xs font-medium" style={{ color: "#E84040" }}>
                                        {formatNumber(getTripFuelUsed(trip))} L
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      );
    }

    // ── Theft Location Map ──────────────────────────────────────────────────
    if (activeReport === "theft-location") {
      return <TheftLocationView data={theftLocationData ?? null} loading={loading} />;
    }

    return null;
  }, [activeReport, loading, dailyTrendData, refuelData, engineHoursData, vehicleStatusData, tripsData, theftLocationData, expandedVehicles]);

  return content;
}

export const SpecialReportViews = memo(SpecialReportViewsComponent);
