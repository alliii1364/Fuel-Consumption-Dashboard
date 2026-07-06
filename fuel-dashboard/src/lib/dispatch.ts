// Dispatch & route-monitoring API layer + types. Reuses the shared request()
// wrapper from api.ts (JWT injection, envelope unwrap, retry, ApiError).
import { request } from "./api";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LatLng {
  lat: number;
  lng: number;
}

export interface DriverRecord {
  driverId: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  assignId: string | null;
  address: string | null;
  desc: string | null;
  hasLogin: boolean;
  loginActive: boolean;
}

export interface DriverInput {
  name: string;
  phone?: string;
  email?: string;
  assignId?: string;
  address?: string;
  desc?: string;
}

export interface RouteStop {
  stopId?: number;
  seq: number;
  name: string | null;
  lat: number;
  lng: number;
  type: string;
  radiusM: number;
}

export interface Depot {
  depotId: number;
  name: string;
  lat: number;
  lng: number;
  isDefault: boolean;
}

/** A route's anchored yard (round-trip start & end). */
export interface RouteDepot {
  depotId: number | null;
  name: string | null;
  lat: number;
  lng: number;
}

export interface RouteSummary {
  routeId: number;
  name: string;
  source: string;
  gsRouteId: number | null;
  corridorBufferM: number;
  totalDistanceKm: number | null;
  totalDurationS: number | null;
  optimized: boolean;
  active: boolean;
  depotName: string | null;
  stopCount: number;
}

export interface RouteDetail extends Omit<RouteSummary, "stopCount" | "depotName"> {
  userId: number;
  geometry: LatLng[];
  notes: string | null;
  depot: RouteDepot | null;
  stops: RouteStop[];
  /** True when OSRM was unreachable and the route was saved with straight-line geometry. */
  degraded?: boolean;
}

export interface ImportableRoute {
  gsRouteId: number;
  name: string;
  deviation: string | null;
  pointCount: number;
}

export type AssignmentStatus =
  | "assigned"
  | "accepted"
  | "en_route"
  | "arrived"
  | "completed"
  | "cancelled";

export interface Assignment {
  assignmentId: number;
  userId: number;
  routeId: number;
  routeName: string | null;
  driverId: number;
  driverName: string | null;
  imei: string;
  vehicleName: string | null;
  status: AssignmentStatus;
  priority: string;
  scheduledStart: string | null;
  notes: string | null;
  lastLat: number | null;
  lastLng: number | null;
  lastSeen: string | null;
  progressPct: number | null;
  offRoute: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RouteEvent {
  eventId: number;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  stopId: number | null;
  lat: number | null;
  lng: number | null;
  distanceM: number | null;
  actor: string;
  note: string | null;
  createdAt: string;
}

/** A driver-confirmed bin completion (photo + location-verified). */
export interface StopCompletion {
  id: number;
  assignmentId: number;
  stopId: number;
  driverId: number;
  lat: number;
  lng: number;
  accuracyM: number | null;
  distanceM: number;
  inRange: boolean;
  photoPath: string;
  note: string | null;
  createdAt: string;
}

export interface DeviationAlert {
  eventId: number;
  assignmentId: number;
  driverName: string | null;
  routeName: string | null;
  distanceM: number | null;
  at: string;
}

export type PositionSource = "tracker" | "phone" | "none";

export type StopVisitStatus = "stopped" | "skipped" | "not_reached" | "pending";

export interface StopStatus {
  seq: number;
  status: StopVisitStatus;
  dwellS?: number;
  arrivedAt?: string;
}

export interface DeviationAnalysis {
  currentPosition: LatLng | null;
  lastSeen: string | null;
  speed: number | null;
  positionSource: PositionSource;
  distanceFromRouteM: number | null;
  offRoute: boolean;
  maxDeviationM: number;
  progressPct: number;
  visitedStopSeqs: number[];
  missedStopSeqs: number[];
  stopStatuses: StopStatus[];
}

export interface LiveStatus {
  assignment: Assignment;
  analysis: DeviationAnalysis;
  route: {
    routeId: number;
    name: string;
    geometry: LatLng[];
    stops: RouteStop[];
    depot: RouteDepot | null;
    corridorBufferM: number;
    totalDistanceKm: number | null;
  };
  events: RouteEvent[];
  stopCompletions: StopCompletion[];
}

export interface StopInput {
  name?: string;
  lat: number;
  lng: number;
  type?: string;
  radiusM?: number;
}

// ─── Manager: drivers ──────────────────────────────────────────────────────────

export const getDrivers = (token: string) =>
  request<DriverRecord[]>("/drivers", {}, token);

export const createDriver = (token: string, body: DriverInput) =>
  request<DriverRecord>("/drivers", { method: "POST", body: JSON.stringify(body) }, token);

export const updateDriver = (token: string, driverId: number, body: Partial<DriverInput>) =>
  request<DriverRecord>(`/drivers/${driverId}`, { method: "PATCH", body: JSON.stringify(body) }, token);

export const deleteDriver = (token: string, driverId: number) =>
  request<{ driverId: number }>(`/drivers/${driverId}`, { method: "DELETE" }, token);

/** Set/reset a driver's login PIN (driver logs in with their driver ID + PIN). */
export const setDriverPin = (token: string, driverId: number, pin: string) =>
  request<{ driverId: number }>(
    `/drivers/${driverId}/pin`,
    { method: "POST", body: JSON.stringify({ pin }) },
    token,
  );

/** Disable a driver's PWA login (revoke access without deleting credentials). */
export const disableDriverLogin = (token: string, driverId: number) =>
  request<{ driverId: number }>(
    `/drivers/${driverId}/login/disable`,
    { method: "PATCH" },
    token,
  );

// ─── Manager: depots (yards) ─────────────────────────────────────────────────

export const getDepots = (token: string) =>
  request<Depot[]>("/depots", {}, token);

export const createDepot = (
  token: string,
  body: { name: string; lat: number; lng: number; isDefault?: boolean },
) => request<Depot>("/depots", { method: "POST", body: JSON.stringify(body) }, token);

export const setDefaultDepot = (token: string, depotId: number) =>
  request<{ depotId: number }>(`/depots/${depotId}/default`, { method: "PATCH" }, token);

export const deleteDepot = (token: string, depotId: number) =>
  request<{ depotId: number }>(`/depots/${depotId}`, { method: "DELETE" }, token);

// ─── Manager: routes ───────────────────────────────────────────────────────────

export const getRoutes = (token: string) =>
  request<RouteSummary[]>("/routes", {}, token);

export const getRoute = (token: string, routeId: number) =>
  request<RouteDetail>(`/routes/${routeId}`, {}, token);

export const getImportableRoutes = (token: string) =>
  request<ImportableRoute[]>("/routes/importable", {}, token);

export const createRoute = (
  token: string,
  body: {
    name: string;
    depotId?: number;
    stops: StopInput[];
    optimize?: boolean;
    corridorBufferM?: number;
    notes?: string;
  },
) => request<RouteDetail>("/routes", { method: "POST", body: JSON.stringify(body) }, token);

export const updateRoute = (
  token: string,
  routeId: number,
  body: {
    name?: string;
    depotId?: number;
    stops?: StopInput[];
    optimize?: boolean;
    corridorBufferM?: number;
    notes?: string;
  },
) =>
  request<RouteDetail>(
    `/routes/${routeId}`,
    { method: "PATCH", body: JSON.stringify(body) },
    token,
  );

export const importRoute = (token: string, gsRouteId: number, optimize = false) =>
  request<RouteDetail>(
    "/routes/import",
    { method: "POST", body: JSON.stringify({ gsRouteId, optimize }) },
    token,
  );

export const deleteRoute = (token: string, routeId: number) =>
  request<{ routeId: number }>(`/routes/${routeId}`, { method: "DELETE" }, token);

/** KML upload uses multipart, so it bypasses the JSON request() helper. */
export async function uploadKmlRoute(
  token: string,
  file: File,
  opts: { name?: string; corridorBufferM?: number; optimize?: boolean } = {},
): Promise<RouteDetail> {
  const base = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3007"}/api`;
  const qs = new URLSearchParams();
  if (opts.name) qs.set("name", opts.name);
  if (opts.corridorBufferM) qs.set("corridorBufferM", String(opts.corridorBufferM));
  if (opts.optimize) qs.set("optimize", "true");
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${base}/routes/upload-kml?${qs}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.message || `Upload failed (${res.status})`);
  return json.data as RouteDetail;
}

// ─── Manager: assignments ──────────────────────────────────────────────────────

export const getAssignments = (token: string, status?: string) =>
  request<Assignment[]>(`/assignments${status ? `?status=${status}` : ""}`, {}, token);

export const createAssignment = (
  token: string,
  body: {
    routeId: number;
    driverId: number;
    imei: string;
    priority?: string;
    scheduledStart?: string;
    notes?: string;
  },
) => request<Assignment>("/assignments", { method: "POST", body: JSON.stringify(body) }, token);

export const getAssignmentLive = (token: string, id: number) =>
  request<LiveStatus>(`/assignments/${id}/live`, {}, token);

/** One in-flight assignment + its planned route, for the fleet monitor screen. */
export interface MonitorEntry {
  assignment: Assignment;
  route: {
    routeId: number;
    name: string;
    geometry: LatLng[];
    stops: RouteStop[];
    depot: RouteDepot | null;
    corridorBufferM: number;
  } | null;
}

/** All active assignments + their routes in one call, for the live monitor. */
export const getMonitor = (token: string) =>
  request<MonitorEntry[]>("/assignments/monitor", {}, token);

export const setAssignmentStatus = (token: string, id: number, status: string) =>
  request<Assignment>(
    `/assignments/${id}/status`,
    { method: "PATCH", body: JSON.stringify({ status }) },
    token,
  );

export const cancelAssignment = (token: string, id: number) =>
  request<Assignment>(`/assignments/${id}/cancel`, { method: "PATCH" }, token);

// ─── Driver PWA ────────────────────────────────────────────────────────────────

export interface DriverLoginResponse {
  token: string;
  expiresIn: string;
  driver: { driverId: number; name: string | null };
}

export const driverLogin = (driverId: number, pin: string) =>
  request<DriverLoginResponse>("/auth/driver/login", {
    method: "POST",
    body: JSON.stringify({ driverId, pin }),
  });

export const getMyJobs = (token: string) =>
  request<Assignment[]>("/me/jobs", {}, token);

export const getMyJob = (token: string, id: number) =>
  request<{ assignment: Assignment; route: RouteDetail; stopCompletions: StopCompletion[] }>(`/me/jobs/${id}`, {}, token);

export const updateMyJobStatus = (token: string, id: number, status: string) =>
  request<Assignment>(
    `/me/jobs/${id}/status`,
    { method: "PATCH", body: JSON.stringify({ status }) },
    token,
  );

// ─── Driver Android app: devices, location, proof of delivery ────────────────

export interface LocationPing {
  lat: number;
  lng: number;
  speed?: number;
  accuracyM?: number;
  recordedAt?: string;
  assignmentId?: number;
}

export interface DriverLocation {
  id: number;
  driverId: number;
  assignmentId: number | null;
  lat: number;
  lng: number;
  speed: number | null;
  accuracyM: number | null;
  recordedAt: string;
}

export interface PodRecord {
  id: number;
  assignmentId: number;
  stopId: number | null;
  driverId: number;
  photoPath: string | null;
  note: string | null;
  lat: number | null;
  lng: number | null;
  createdAt: string;
}

export const registerDevice = (token: string, fcmToken: string, appVersion?: string) =>
  request<{ ok: boolean }>(
    "/me/devices",
    { method: "POST", body: JSON.stringify({ fcmToken, platform: "android", appVersion }) },
    token,
  );

export const reportLocation = (token: string, pings: LocationPing[]) =>
  request<{ ok: boolean }>(
    "/me/location",
    { method: "POST", body: JSON.stringify({ pings }) },
    token,
  );

/** Multipart upload — bypasses the JSON request() helper. */
export async function uploadProof(
  token: string,
  jobId: number,
  data: { photo?: Blob; note?: string; stopId?: number; lat?: number; lng?: number },
): Promise<{ podId: number; photoPath: string | null }> {
  const base = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3007"}/api`;
  const form = new FormData();
  if (data.photo) form.append("photo", data.photo, "pod.jpg");
  if (data.note) form.append("note", data.note);
  if (data.stopId != null) form.append("stopId", String(data.stopId));
  if (data.lat != null) form.append("lat", String(data.lat));
  if (data.lng != null) form.append("lng", String(data.lng));
  const res = await fetch(`${base}/me/jobs/${jobId}/proof`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.message || `Upload failed (${res.status})`);
  return json.data;
}

/** Driver marks a bin complete — photo + GPS required (multipart). */
export async function completeStop(
  token: string,
  jobId: number,
  stopId: number,
  data: { photo: Blob; lat: number; lng: number; accuracyM?: number; note?: string },
): Promise<{ completion: StopCompletion; jobCompleted: boolean; stopCompletions: StopCompletion[] }> {
  const base = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3007"}/api`;
  const form = new FormData();
  form.append("photo", data.photo, "bin.jpg");
  form.append("lat", String(data.lat));
  form.append("lng", String(data.lng));
  if (data.accuracyM != null) form.append("accuracyM", String(data.accuracyM));
  if (data.note) form.append("note", data.note);
  const res = await fetch(`${base}/me/jobs/${jobId}/stops/${stopId}/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.message || `Completion failed (${res.status})`);
  return json.data;
}

/** Deviation alert feed for the portal popup watcher. */
export const getDeviationAlerts = (token: string, sinceEventId?: number) =>
  request<{ cursor: number; alerts: DeviationAlert[] }>(
    `/assignments/alerts${sinceEventId != null ? `?sinceEventId=${sinceEventId}` : ""}`,
    {},
    token,
  );

// Manager-side views of driver-reported data.
export const getAssignmentProof = (token: string, id: number) =>
  request<PodRecord[]>(`/assignments/${id}/proof`, {}, token);

export const getAssignmentTrack = (token: string, id: number) =>
  request<DriverLocation[]>(`/assignments/${id}/track`, {}, token);
