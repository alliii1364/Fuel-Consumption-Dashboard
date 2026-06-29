import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LatLng, parseGsRoutePoints } from './geo.util';

export interface RouteStop {
  stopId?: number;
  seq: number;
  name: string | null;
  lat: number;
  lng: number;
  type: string;
  radiusM: number;
}

/** A route's anchored yard (round-trip start & end). Snapshotted on the route. */
export interface RouteDepot {
  depotId: number | null;
  name: string | null;
  lat: number;
  lng: number;
}

export interface RouteRecord {
  routeId: number;
  userId: number;
  name: string;
  source: string;
  gsRouteId: number | null;
  geometry: LatLng[];
  corridorBufferM: number;
  totalDistanceKm: number | null;
  totalDurationS: number | null;
  optimized: boolean;
  notes: string | null;
  active: boolean;
  depot: RouteDepot | null;
  stops: RouteStop[];
}

export interface CreateRouteData {
  name: string;
  source: string;
  gsRouteId?: number | null;
  geometry: LatLng[];
  corridorBufferM: number;
  totalDistanceKm?: number | null;
  totalDurationS?: number | null;
  optimized: boolean;
  notes?: string | null;
  depot?: RouteDepot | null;
  stops: RouteStop[];
}

@Injectable()
export class RouteRepository {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async create(userId: number, data: CreateRouteData): Promise<number> {
    const result = await this.ds.query(
      `INSERT INTO fd_routes
         (user_id, name, source, gs_route_id, geometry, corridor_buffer_m,
          total_distance_km, total_duration_s, optimized, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        data.name,
        data.source,
        data.gsRouteId ?? null,
        JSON.stringify(data.geometry || []),
        data.corridorBufferM,
        data.totalDistanceKm ?? null,
        data.totalDurationS ?? null,
        data.optimized ? 1 : 0,
        data.notes ?? null,
      ],
    );
    const routeId = result.insertId as number;
    await this.replaceStops(routeId, data.stops);
    await this.setDepot(routeId, data.depot ?? null);
    return routeId;
  }

  /** Upsert (or clear) the per-route depot anchor. */
  async setDepot(routeId: number, depot: RouteDepot | null): Promise<void> {
    await this.ds.query(`DELETE FROM fd_route_depots WHERE route_id = ?`, [routeId]);
    if (!depot) return;
    await this.ds.query(
      `INSERT INTO fd_route_depots (route_id, depot_id, name, lat, lng)
       VALUES (?, ?, ?, ?, ?)`,
      [routeId, depot.depotId ?? null, depot.name ?? null, depot.lat, depot.lng],
    );
  }

  async replaceStops(routeId: number, stops: RouteStop[]): Promise<void> {
    await this.ds.query(`DELETE FROM fd_route_stops WHERE route_id = ?`, [routeId]);
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      await this.ds.query(
        `INSERT INTO fd_route_stops (route_id, seq, name, lat, lng, type, radius_m)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [routeId, i + 1, s.name ?? null, s.lat, s.lng, s.type || 'stop', s.radiusM || 100],
      );
    }
  }

  async list(userId: number): Promise<Omit<RouteRecord, 'geometry' | 'stops'>[]> {
    const rows = await this.ds.query(
      `SELECT r.route_id, r.user_id, r.name, r.source, r.gs_route_id,
              r.corridor_buffer_m, r.total_distance_km, r.total_duration_s,
              r.optimized, r.notes, r.active, d.name AS depot_name,
              (SELECT COUNT(*) FROM fd_route_stops s WHERE s.route_id = r.route_id) AS stop_count
       FROM fd_routes r
       LEFT JOIN fd_route_depots d ON d.route_id = r.route_id
       WHERE r.user_id = ? AND r.active = 1
       ORDER BY r.created_at DESC`,
      [userId],
    );
    return rows.map((r: any) => ({
      routeId: r.route_id,
      userId: r.user_id,
      name: r.name,
      source: r.source,
      gsRouteId: r.gs_route_id,
      corridorBufferM: r.corridor_buffer_m,
      totalDistanceKm: r.total_distance_km != null ? Number(r.total_distance_km) : null,
      totalDurationS: r.total_duration_s,
      optimized: r.optimized === 1,
      notes: r.notes,
      active: r.active === 1,
      depotName: r.depot_name ?? null,
      stopCount: Number(r.stop_count),
    })) as any;
  }

  async get(userId: number, routeId: number): Promise<RouteRecord> {
    const rows = await this.ds.query(
      `SELECT * FROM fd_routes WHERE route_id = ? AND user_id = ? LIMIT 1`,
      [routeId, userId],
    );
    if (!rows.length) throw new NotFoundException('Route not found');
    const r = rows[0];
    const stops = await this.ds.query(
      `SELECT stop_id, seq, name, lat, lng, type, radius_m
       FROM fd_route_stops WHERE route_id = ? ORDER BY seq ASC`,
      [routeId],
    );
    const depotRows = await this.ds.query(
      `SELECT depot_id, name, lat, lng FROM fd_route_depots WHERE route_id = ? LIMIT 1`,
      [routeId],
    );
    return {
      routeId: r.route_id,
      userId: r.user_id,
      name: r.name,
      source: r.source,
      gsRouteId: r.gs_route_id,
      geometry: this.parseGeometry(r.geometry),
      corridorBufferM: r.corridor_buffer_m,
      totalDistanceKm: r.total_distance_km != null ? Number(r.total_distance_km) : null,
      totalDurationS: r.total_duration_s,
      optimized: r.optimized === 1,
      notes: r.notes,
      active: r.active === 1,
      depot: depotRows.length
        ? {
            depotId: depotRows[0].depot_id,
            name: depotRows[0].name,
            lat: Number(depotRows[0].lat),
            lng: Number(depotRows[0].lng),
          }
        : null,
      stops: stops.map((s: any) => ({
        stopId: s.stop_id,
        seq: s.seq,
        name: s.name,
        lat: Number(s.lat),
        lng: Number(s.lng),
        type: s.type,
        radiusM: s.radius_m,
      })),
    };
  }

  async update(
    userId: number,
    routeId: number,
    patch: Partial<CreateRouteData>,
  ): Promise<void> {
    await this.get(userId, routeId); // ownership check
    const fields: string[] = [];
    const params: any[] = [];
    if (patch.name !== undefined) (fields.push('name = ?'), params.push(patch.name));
    if (patch.corridorBufferM !== undefined)
      (fields.push('corridor_buffer_m = ?'), params.push(patch.corridorBufferM));
    if (patch.notes !== undefined) (fields.push('notes = ?'), params.push(patch.notes));
    if (patch.geometry !== undefined)
      (fields.push('geometry = ?'), params.push(JSON.stringify(patch.geometry)));
    if (patch.totalDistanceKm !== undefined)
      (fields.push('total_distance_km = ?'), params.push(patch.totalDistanceKm));
    if (patch.totalDurationS !== undefined)
      (fields.push('total_duration_s = ?'), params.push(patch.totalDurationS));
    if (patch.optimized !== undefined)
      (fields.push('optimized = ?'), params.push(patch.optimized ? 1 : 0));
    if (fields.length) {
      params.push(routeId);
      await this.ds.query(
        `UPDATE fd_routes SET ${fields.join(', ')} WHERE route_id = ?`,
        params,
      );
    }
    if (patch.stops) await this.replaceStops(routeId, patch.stops);
    if (patch.depot !== undefined) await this.setDepot(routeId, patch.depot);
  }

  async remove(userId: number, routeId: number): Promise<void> {
    await this.get(userId, routeId); // ownership check
    await this.ds.query(`UPDATE fd_routes SET active = 0 WHERE route_id = ?`, [routeId]);
  }

  /** Existing gs_user_routes available for import. */
  async listImportableGsRoutes(userId: number): Promise<
    Array<{ gsRouteId: number; name: string; deviation: string | null; pointCount: number }>
  > {
    const rows = await this.ds.query(
      `SELECT route_id, route_name, route_deviation, route_points
       FROM gs_user_routes
       WHERE user_id = ? AND route_points IS NOT NULL AND route_points <> ''
       ORDER BY route_name ASC`,
      [userId],
    );
    return rows.map((r: any) => ({
      gsRouteId: r.route_id,
      name: r.route_name,
      deviation: r.route_deviation,
      pointCount: parseGsRoutePoints(r.route_points).length,
    }));
  }

  /** Read a single gs_user_routes row and parse its polyline. */
  async getGsRoute(
    userId: number,
    gsRouteId: number,
  ): Promise<{ name: string; points: LatLng[]; corridorBufferM: number }> {
    const rows = await this.ds.query(
      `SELECT route_name, route_deviation, route_points
       FROM gs_user_routes WHERE user_id = ? AND route_id = ? LIMIT 1`,
      [userId, gsRouteId],
    );
    if (!rows.length) throw new NotFoundException('Source route not found');
    const r = rows[0];
    // route_deviation is expressed in km (e.g. "0.9"); convert to metres.
    const devKm = parseFloat(r.route_deviation);
    const corridorBufferM = Number.isFinite(devKm) ? Math.round(devKm * 1000) : 150;
    return {
      name: r.route_name,
      points: parseGsRoutePoints(r.route_points),
      corridorBufferM,
    };
  }

  private parseGeometry(raw: string | null): LatLng[] {
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
}
