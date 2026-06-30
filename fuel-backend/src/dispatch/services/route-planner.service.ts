import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { OsrmClientService } from './osrm-client.service';
import { RouteStop } from './route.repository';
import { LatLng, polylineLengthKm } from './geo.util';

export interface PlannedRoute {
  stops: RouteStop[];
  geometry: LatLng[];
  distanceKm: number | null;
  durationS: number | null;
  optimized: boolean;
  /** True when OSRM was unreachable and we fell back to straight-line geometry. */
  degraded: boolean;
}

/**
 * Turns a set of stops into a drivable plan: optionally reorders them
 * optimally (OSRM /trip), then snaps to the road network for geometry + ETA.
 *
 * OSRM is an optional dependency: when it is unreachable, planning degrades
 * gracefully to straight-line geometry (stop order preserved, no optimization,
 * distance estimated as the great-circle path) so route creation never fails
 * outright. Fewer than 2 stops never needs OSRM.
 */
@Injectable()
export class RoutePlannerService {
  private readonly logger = new Logger(RoutePlannerService.name);

  constructor(private readonly osrm: OsrmClientService) {}

  async plan(stops: RouteStop[], optimize: boolean): Promise<PlannedRoute> {
    const normalized = stops.map((s, i) => ({
      ...s,
      seq: i + 1,
      type: s.type || 'stop',
      radiusM: s.radiusM || 100,
    }));

    if (normalized.length < 2) {
      return this.straightLine(normalized, false);
    }

    const points: LatLng[] = normalized.map((s) => ({ lat: s.lat, lng: s.lng }));

    try {
      if (optimize) {
        const trip = await this.osrm.optimizeTrip(points);
        const orderedStops = trip.orderedInputIndices.map((idx, i) => ({
          ...normalized[idx],
          seq: i + 1,
        }));
        return {
          stops: orderedStops,
          geometry: trip.geometry,
          distanceKm: trip.distanceKm,
          durationS: trip.durationS,
          optimized: true,
          degraded: false,
        };
      }

      const r = await this.osrm.route(points);
      return {
        stops: normalized,
        geometry: r.geometry,
        distanceKm: r.distanceKm,
        durationS: r.durationS,
        optimized: false,
        degraded: false,
      };
    } catch (err) {
      if (err instanceof ServiceUnavailableException) {
        this.logger.warn(
          `OSRM unavailable — saving route with straight-line geometry (${normalized.length} stops, optimize=${optimize}).`,
        );
        return this.straightLine(normalized, false);
      }
      throw err;
    }
  }

  /**
   * Plan a round trip: yard → bins → yard. The depot is the fixed start & end;
   * only the bins in between are (optionally) reordered. Geometry always closes
   * back to the depot. Degrades to a straight-line loop when OSRM is down.
   */
  async planRoundTrip(
    depot: LatLng,
    bins: RouteStop[],
    optimize: boolean,
  ): Promise<PlannedRoute> {
    const normalized = bins.map((s, i) => ({
      ...s,
      seq: i + 1,
      type: s.type || 'pickup',
      radiusM: s.radiusM || 100,
    }));

    // No bins yet — a trivial loop that sits at the yard.
    if (normalized.length === 0) {
      return {
        stops: [],
        geometry: [depot],
        distanceKm: 0,
        durationS: null,
        optimized: false,
        degraded: false,
      };
    }

    const binPts: LatLng[] = normalized.map((s) => ({ lat: s.lat, lng: s.lng }));
    try {
      if (optimize && normalized.length >= 2) {
        const trip = await this.osrm.optimizeRoundTrip(depot, binPts);
        const orderedBins = trip.orderedBinIndices.map((idx, i) => ({
          ...normalized[idx],
          seq: i + 1,
        }));
        return {
          stops: orderedBins,
          geometry: trip.geometry,
          distanceKm: trip.distanceKm,
          durationS: trip.durationS,
          optimized: true,
          degraded: false,
        };
      }

      // Fixed order: depot → bins (as given) → depot.
      const r = await this.osrm.route([depot, ...binPts, depot]);
      return {
        stops: normalized,
        geometry: r.geometry,
        distanceKm: r.distanceKm,
        durationS: r.durationS,
        optimized: false,
        degraded: false,
      };
    } catch (err) {
      if (err instanceof ServiceUnavailableException) {
        this.logger.warn(
          `OSRM unavailable — round-trip saved with straight-line geometry (${normalized.length} bins, optimize=${optimize}).`,
        );
        const geometry = [depot, ...binPts, depot];
        return {
          stops: normalized,
          geometry,
          distanceKm: polylineLengthKm(geometry),
          durationS: null,
          optimized: false,
          degraded: true,
        };
      }
      throw err;
    }
  }

  /** Build a plan from stop coordinates alone, no road network. */
  private straightLine(stops: RouteStop[], optimized: boolean): PlannedRoute {
    const geometry = stops.map((s) => ({ lat: s.lat, lng: s.lng }));
    return {
      stops,
      geometry,
      distanceKm: geometry.length >= 2 ? polylineLengthKm(geometry) : 0,
      durationS: null,
      optimized,
      degraded: geometry.length >= 2,
    };
  }
}
