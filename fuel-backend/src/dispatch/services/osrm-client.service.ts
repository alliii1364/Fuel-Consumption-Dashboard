import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LatLng } from './geo.util';

export interface OptimizedTrip {
  /** Input stop indices in the optimal visiting order. */
  orderedInputIndices: number[];
  /** Full road geometry of the optimized trip. */
  geometry: LatLng[];
  distanceKm: number;
  durationS: number;
}

export interface RouteResult {
  geometry: LatLng[];
  distanceKm: number;
  durationS: number;
}

/**
 * Thin client for a self-hosted OSRM instance (configurable via OSRM_URL).
 * Uses the /trip service for stop-order optimization (a TSP solver) and
 * /route for fixed-order road geometry + ETA.
 */
@Injectable()
export class OsrmClientService {
  private readonly logger = new Logger(OsrmClientService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs = 15000;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = (
      this.config.get<string>('OSRM_URL') || 'http://localhost:5000'
    ).replace(/\/+$/, '');
  }

  private toCoordString(points: LatLng[]): string {
    // OSRM expects lng,lat;lng,lat
    return points.map((p) => `${p.lng},${p.lat}`).join(';');
  }

  private async fetchJson(url: string): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      const json = await res.json();
      if (!res.ok || json.code !== 'Ok') {
        throw new ServiceUnavailableException(
          `OSRM error: ${json.code || res.status} ${json.message || ''}`.trim(),
        );
      }
      return json;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.error(`OSRM request failed (${this.baseUrl}): ${String(err)}`);
      throw new ServiceUnavailableException(
        `Routing engine unreachable at ${this.baseUrl}. Is OSRM running?`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Optimize the order of >=2 stops and return the road geometry + ETA. */
  async optimizeTrip(points: LatLng[]): Promise<OptimizedTrip> {
    if (points.length < 2) {
      throw new ServiceUnavailableException(
        'At least 2 stops are required to optimize a route',
      );
    }
    const url =
      `${this.baseUrl}/trip/v1/driving/${this.toCoordString(points)}` +
      `?roundtrip=false&source=first&destination=last&geometries=geojson&overview=full`;
    const json = await this.fetchJson(url);
    const trip = json.trips[0];

    // waypoints[i].waypoint_index = position of input i within the optimized trip.
    const ordered = json.waypoints
      .map((w: any, i: number) => ({ i, pos: w.waypoint_index }))
      .sort((a: any, b: any) => a.pos - b.pos)
      .map((w: any) => w.i);

    return {
      orderedInputIndices: ordered,
      geometry: this.decodeGeoJson(trip.geometry),
      distanceKm: trip.distance / 1000,
      durationS: Math.round(trip.duration),
    };
  }

  /**
   * Optimize a round trip that departs from and returns to `depot`, visiting all
   * `bins` in the optimal order. The depot is pinned as the first waypoint
   * (source=first) and the trip is closed back to it (roundtrip=true), so the
   * returned geometry already includes the return leg to the yard.
   */
  async optimizeRoundTrip(
    depot: LatLng,
    bins: LatLng[],
  ): Promise<{
    orderedBinIndices: number[];
    geometry: LatLng[];
    distanceKm: number;
    durationS: number;
  }> {
    const points = [depot, ...bins];
    if (points.length < 2) {
      throw new ServiceUnavailableException(
        'At least 1 bin is required to plan a round trip',
      );
    }
    const url =
      `${this.baseUrl}/trip/v1/driving/${this.toCoordString(points)}` +
      `?roundtrip=true&source=first&geometries=geojson&overview=full`;
    const json = await this.fetchJson(url);
    const trip = json.trips[0];

    // waypoints[i].waypoint_index = position of input i within the optimized
    // trip. Drop the depot (input 0) and re-base the rest into bin indices.
    const orderedBinIndices = json.waypoints
      .map((w: any, i: number) => ({ i, pos: w.waypoint_index }))
      .sort((a: any, b: any) => a.pos - b.pos)
      .map((w: any) => w.i)
      .filter((i: number) => i !== 0)
      .map((i: number) => i - 1);

    return {
      orderedBinIndices,
      geometry: this.decodeGeoJson(trip.geometry),
      distanceKm: trip.distance / 1000,
      durationS: Math.round(trip.duration),
    };
  }

  /** Road geometry + ETA for stops in the given (fixed) order. */
  async route(points: LatLng[]): Promise<RouteResult> {
    if (points.length < 2) {
      throw new ServiceUnavailableException(
        'At least 2 points are required to build a route',
      );
    }
    const url =
      `${this.baseUrl}/route/v1/driving/${this.toCoordString(points)}` +
      `?geometries=geojson&overview=full`;
    const json = await this.fetchJson(url);
    const route = json.routes[0];
    return {
      geometry: this.decodeGeoJson(route.geometry),
      distanceKm: route.distance / 1000,
      durationS: Math.round(route.duration),
    };
  }

  private decodeGeoJson(geometry: { coordinates: [number, number][] }): LatLng[] {
    return (geometry.coordinates || []).map(([lng, lat]) => ({ lat, lng }));
  }
}
