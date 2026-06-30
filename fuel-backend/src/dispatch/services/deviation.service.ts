import { Injectable } from '@nestjs/common';
import {
  LatLng,
  distanceToPolylineMeters,
  haversineMeters,
  progressAlongPolyline,
} from './geo.util';
import { RouteStop } from './route.repository';

export interface TrailPoint {
  ts: Date;
  lat: number;
  lng: number;
  speed: number;
}

/** Which feed the live position is currently being driven by. */
export type PositionSource = 'tracker' | 'phone' | 'none';

export interface DeviationAnalysis {
  currentPosition: LatLng | null;
  lastSeen: Date | null;
  speed: number | null;
  /** Which feed drove the current position (tracker primary, phone fallback). */
  positionSource: PositionSource;
  /** Distance of the latest fix from the planned route corridor (metres). */
  distanceFromRouteM: number | null;
  /** True only when the vehicle has been outside the corridor for a sustained window. */
  offRoute: boolean;
  /** Worst deviation seen across the analysed trail (metres). */
  maxDeviationM: number;
  progressPct: number;
  visitedStopSeqs: number[];
  missedStopSeqs: number[];
}

/**
 * Corridor-based route-adherence analysis. Pure (no I/O): given the planned
 * geometry, stops, tolerance and an actual GPS trail, it reports current
 * position, deviation, progress, and stop visits. Uses hysteresis so a single
 * GPS jitter point never trips an "off-route" alert.
 */
@Injectable()
export class DeviationService {
  /** A deviation must persist at least this long to count as off-route. */
  private readonly SUSTAIN_MS = 90_000;

  /**
   * @param trail       the position trail (tracker primary, phone fallback)
   *                    that drives current position, deviation and progress.
   * @param visitTrail  points used for stop-visit detection — defaults to
   *                    `trail`, but callers can pass the union of all feeds so a
   *                    bin counts as collected if any source reached it.
   * @param positionSource which feed `trail` came from (for display).
   */
  analyze(
    route: { geometry: LatLng[]; stops: RouteStop[]; corridorBufferM: number },
    trail: TrailPoint[],
    visitTrail: TrailPoint[] = trail,
    positionSource: PositionSource = 'tracker',
  ): DeviationAnalysis {
    const visited = (pts: TrailPoint[]): { visitedStopSeqs: number[]; missedStopSeqs: number[] } => {
      const v: number[] = [];
      const m: number[] = [];
      for (const s of route.stops) {
        const hit = pts.some(
          (p) => haversineMeters(p, { lat: s.lat, lng: s.lng }) <= s.radiusM,
        );
        (hit ? v : m).push(s.seq);
      }
      return { visitedStopSeqs: v, missedStopSeqs: m };
    };

    const empty: DeviationAnalysis = {
      currentPosition: null,
      lastSeen: null,
      speed: null,
      positionSource: 'none',
      distanceFromRouteM: null,
      offRoute: false,
      maxDeviationM: 0,
      progressPct: 0,
      // Even with no position trail, a bin may have been visited via another feed.
      ...visited(visitTrail),
    };
    if (trail.length === 0) return empty;

    const geom: LatLng[] =
      route.geometry.length >= 2
        ? route.geometry
        : route.stops.map((s) => ({ lat: s.lat, lng: s.lng }));
    if (geom.length < 2) return { ...empty, currentPosition: trailLast(trail), positionSource };

    const buffer = route.corridorBufferM;
    let maxDeviationM = 0;
    const flags = trail.map((p) => {
      const d = distanceToPolylineMeters(p, geom);
      if (d > maxDeviationM) maxDeviationM = d;
      return { ts: p.ts, off: d > buffer, d };
    });

    const last = trail[trail.length - 1];
    const lastDist = flags[flags.length - 1].d;

    // Hysteresis: off-route only if every fix within the trailing window is off.
    let offRoute = false;
    if (lastDist > buffer) {
      const cutoff = last.ts.getTime() - this.SUSTAIN_MS;
      const recent = flags.filter((f) => f.ts.getTime() >= cutoff);
      const allOff = recent.length > 0 && recent.every((f) => f.off);
      // Require either a sustained window (>=2 fixes) or a gross deviation.
      offRoute = allOff && (recent.length >= 2 || lastDist > buffer * 2);
    }

    const { visitedStopSeqs, missedStopSeqs } = visited(visitTrail);

    return {
      currentPosition: { lat: last.lat, lng: last.lng },
      lastSeen: last.ts,
      speed: last.speed,
      positionSource,
      distanceFromRouteM: Math.round(lastDist),
      offRoute,
      maxDeviationM: Math.round(maxDeviationM),
      progressPct: Math.round(progressAlongPolyline(last, geom) * 100),
      visitedStopSeqs,
      missedStopSeqs,
    };
  }
}

function trailLast(trail: TrailPoint[]): LatLng | null {
  if (!trail.length) return null;
  const p = trail[trail.length - 1];
  return { lat: p.lat, lng: p.lng };
}
