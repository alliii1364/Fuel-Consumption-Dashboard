/**
 * Geospatial helpers for dispatch: distance, polyline parsing, and
 * point-to-route (corridor) distance used by deviation detection.
 * Short-distance math uses an equirectangular projection around the
 * query point — accurate to well under a metre at fleet scale.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6371008.8;
const DEG2RAD = Math.PI / 180;

/** Great-circle distance between two points, in metres. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * DEG2RAD;
  const dLng = (b.lng - a.lng) * DEG2RAD;
  const lat1 = a.lat * DEG2RAD;
  const lat2 = b.lat * DEG2RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total length of a polyline in kilometres. */
export function polylineLengthKm(line: LatLng[]): number {
  let m = 0;
  for (let i = 1; i < line.length; i++) m += haversineMeters(line[i - 1], line[i]);
  return m / 1000;
}

/**
 * Parse the legacy gs_user_routes.route_points format: a flat comma-separated
 * "lat,lng,lat,lng,..." string into LatLng points.
 */
export function parseGsRoutePoints(raw: string | null | undefined): LatLng[] {
  if (!raw) return [];
  const nums = raw
    .split(',')
    .map((n) => parseFloat(n.trim()))
    .filter((n) => Number.isFinite(n));
  const out: LatLng[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    out.push({ lat: nums[i], lng: nums[i + 1] });
  }
  return out;
}

/** Project a lat/lng to local metres (x=east, y=north) around an origin. */
function project(p: LatLng, origin: LatLng): { x: number; y: number } {
  const x = (p.lng - origin.lng) * DEG2RAD * Math.cos(origin.lat * DEG2RAD) * EARTH_RADIUS_M;
  const y = (p.lat - origin.lat) * DEG2RAD * EARTH_RADIUS_M;
  return { x, y };
}

/** Perpendicular distance (metres) from a point to a single segment [a,b]. */
function pointToSegmentMeters(p: LatLng, a: LatLng, b: LatLng): number {
  const P = project(p, p);
  const A = project(a, p);
  const B = project(b, p);
  const abx = B.x - A.x;
  const aby = B.y - A.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return Math.hypot(P.x - A.x, P.y - A.y);
  let t = ((P.x - A.x) * abx + (P.y - A.y) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = A.x + t * abx;
  const cy = A.y + t * aby;
  return Math.hypot(P.x - cx, P.y - cy);
}

/**
 * Minimum distance (metres) from a point to a polyline — i.e. how far the
 * point is from the nearest part of the planned route. This is the core of
 * corridor-based deviation detection.
 */
export function distanceToPolylineMeters(p: LatLng, line: LatLng[]): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return haversineMeters(p, line[0]);
  let min = Infinity;
  for (let i = 1; i < line.length; i++) {
    const d = pointToSegmentMeters(p, line[i - 1], line[i]);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Fraction (0..1) of the route the point has progressed along, measured by the
 * nearest vertex. Coarse but adequate for a progress bar.
 */
export function progressAlongPolyline(p: LatLng, line: LatLng[]): number {
  if (line.length < 2) return 0;
  let bestIdx = 0;
  let bestD = Infinity;
  for (let i = 0; i < line.length; i++) {
    const d = haversineMeters(p, line[i]);
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
    }
  }
  return bestIdx / (line.length - 1);
}
