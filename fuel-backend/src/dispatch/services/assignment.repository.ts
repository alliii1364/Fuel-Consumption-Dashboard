import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export type AssignmentStatus =
  | 'assigned'
  | 'accepted'
  | 'en_route'
  | 'arrived'
  | 'completed'
  | 'cancelled';

export interface AssignmentRecord {
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
  scheduledStart: Date | null;
  notes: string | null;
  lastLat: number | null;
  lastLng: number | null;
  lastSeen: Date | null;
  progressPct: number | null;
  offRoute: boolean;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
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
  createdAt: Date;
}

const SELECT_FULL = `
  SELECT a.*, r.name AS route_name, d.driver_name, o.name AS vehicle_name
  FROM fd_assignments a
  LEFT JOIN fd_routes r ON r.route_id = a.route_id
  LEFT JOIN gs_user_object_drivers d ON d.driver_id = a.driver_id
  LEFT JOIN gs_objects o ON o.imei = a.imei`;

@Injectable()
export class AssignmentRepository {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async create(
    userId: number,
    data: {
      routeId: number;
      driverId: number;
      imei: string;
      priority?: string;
      scheduledStart?: string | null;
      notes?: string | null;
    },
  ): Promise<number> {
    await this.assertOwnership(userId, data.routeId, data.driverId, data.imei);
    const result = await this.ds.query(
      `INSERT INTO fd_assignments
         (user_id, route_id, driver_id, imei, status, priority, scheduled_start, notes, assigned_at)
       VALUES (?, ?, ?, ?, 'assigned', ?, ?, ?, NOW())`,
      [
        userId,
        data.routeId,
        data.driverId,
        data.imei,
        data.priority || 'normal',
        data.scheduledStart ? new Date(data.scheduledStart) : null,
        data.notes ?? null,
      ],
    );
    const id = result.insertId as number;
    await this.addEvent(id, {
      type: 'status_change',
      toStatus: 'assigned',
      actor: 'manager',
    });
    return id;
  }

  private async assertOwnership(
    userId: number,
    routeId: number,
    driverId: number,
    imei: string,
  ): Promise<void> {
    const [route] = await this.ds.query(
      `SELECT 1 FROM fd_routes WHERE route_id = ? AND user_id = ? AND active = 1 LIMIT 1`,
      [routeId, userId],
    );
    if (!route) throw new BadRequestException('Route not found or not owned');

    const [driver] = await this.ds.query(
      `SELECT 1 FROM gs_user_object_drivers WHERE driver_id = ? AND user_id = ? LIMIT 1`,
      [driverId, userId],
    );
    if (!driver) throw new BadRequestException('Driver not found or not owned');

    const [veh] = await this.ds.query(
      `SELECT 1 FROM gs_user_objects WHERE imei = ? AND user_id = ? LIMIT 1`,
      [imei, userId],
    );
    if (!veh) throw new BadRequestException('Vehicle not found or not owned');
  }

  async list(
    userId: number,
    opts: { status?: string } = {},
  ): Promise<AssignmentRecord[]> {
    const params: any[] = [userId];
    let where = `a.user_id = ?`;
    if (opts.status) {
      where += ` AND a.status = ?`;
      params.push(opts.status);
    }
    const rows = await this.ds.query(
      `${SELECT_FULL} WHERE ${where} ORDER BY a.created_at DESC`,
      params,
    );
    return rows.map((r: any) => this.map(r));
  }

  async get(userId: number, assignmentId: number): Promise<AssignmentRecord> {
    const rows = await this.ds.query(
      `${SELECT_FULL} WHERE a.assignment_id = ? AND a.user_id = ? LIMIT 1`,
      [assignmentId, userId],
    );
    if (!rows.length) throw new NotFoundException('Assignment not found');
    return this.map(rows[0]);
  }

  async listForDriver(driverId: number): Promise<AssignmentRecord[]> {
    const rows = await this.ds.query(
      `${SELECT_FULL} WHERE a.driver_id = ?
         AND a.status NOT IN ('completed','cancelled')
       ORDER BY a.scheduled_start IS NULL, a.scheduled_start ASC, a.created_at DESC`,
      [driverId],
    );
    return rows.map((r: any) => this.map(r));
  }

  async getForDriver(driverId: number, assignmentId: number): Promise<AssignmentRecord> {
    const rows = await this.ds.query(
      `${SELECT_FULL} WHERE a.assignment_id = ? AND a.driver_id = ? LIMIT 1`,
      [assignmentId, driverId],
    );
    if (!rows.length) throw new NotFoundException('Assignment not found');
    return this.map(rows[0]);
  }

  /** All assignments currently being executed — used by the monitoring cron. */
  async listActiveForMonitoring(): Promise<AssignmentRecord[]> {
    const rows = await this.ds.query(
      `${SELECT_FULL} WHERE a.status IN ('accepted','en_route','arrived')`,
    );
    return rows.map((r: any) => this.map(r));
  }

  async setStatus(
    assignmentId: number,
    fromStatus: AssignmentStatus,
    toStatus: AssignmentStatus,
    actor: 'manager' | 'driver' | 'system',
  ): Promise<void> {
    const extra: string[] = [];
    if (toStatus === 'en_route') extra.push('started_at = COALESCE(started_at, NOW())');
    if (toStatus === 'completed' || toStatus === 'cancelled')
      extra.push('completed_at = NOW()');
    await this.ds.query(
      `UPDATE fd_assignments SET status = ?${extra.length ? ', ' + extra.join(', ') : ''}
       WHERE assignment_id = ?`,
      [toStatus, assignmentId],
    );
    await this.addEvent(assignmentId, {
      type: 'status_change',
      fromStatus,
      toStatus,
      actor,
    });
  }

  async updateProgress(
    assignmentId: number,
    p: {
      lat: number | null;
      lng: number | null;
      lastSeen: Date | null;
      progressPct: number | null;
      offRoute: boolean;
    },
  ): Promise<void> {
    await this.ds.query(
      `UPDATE fd_assignments
       SET last_lat = ?, last_lng = ?, last_seen = ?, progress_pct = ?, off_route = ?
       WHERE assignment_id = ?`,
      [p.lat, p.lng, p.lastSeen, p.progressPct, p.offRoute ? 1 : 0, assignmentId],
    );
  }

  async addEvent(
    assignmentId: number,
    e: {
      type: string;
      fromStatus?: string | null;
      toStatus?: string | null;
      stopId?: number | null;
      lat?: number | null;
      lng?: number | null;
      distanceM?: number | null;
      actor?: string;
      note?: string | null;
    },
  ): Promise<void> {
    await this.ds.query(
      `INSERT INTO fd_route_events
         (assignment_id, type, from_status, to_status, stop_id, lat, lng, distance_m, actor, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        assignmentId,
        e.type,
        e.fromStatus ?? null,
        e.toStatus ?? null,
        e.stopId ?? null,
        e.lat ?? null,
        e.lng ?? null,
        e.distanceM ?? null,
        e.actor || 'system',
        e.note ?? null,
      ],
    );
  }

  async listEvents(assignmentId: number, limit = 200): Promise<RouteEvent[]> {
    const rows = await this.ds.query(
      `SELECT event_id, type, from_status, to_status, stop_id, lat, lng,
              distance_m, actor, note, created_at
       FROM fd_route_events WHERE assignment_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      [assignmentId, limit],
    );
    return rows.map((r: any) => ({
      eventId: r.event_id,
      type: r.type,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      stopId: r.stop_id,
      lat: r.lat != null ? Number(r.lat) : null,
      lng: r.lng != null ? Number(r.lng) : null,
      distanceM: r.distance_m,
      actor: r.actor,
      note: r.note,
      createdAt: r.created_at,
    }));
  }

  /** Stop ids already recorded as arrived — so monitoring emits each once. */
  async listArrivedStopIds(assignmentId: number): Promise<number[]> {
    const rows = await this.ds.query(
      `SELECT DISTINCT stop_id FROM fd_route_events
       WHERE assignment_id = ? AND type = 'arrived_stop' AND stop_id IS NOT NULL`,
      [assignmentId],
    );
    return rows.map((r: any) => r.stop_id as number);
  }

  /** Most recent deviation event timestamp — used to throttle repeat alerts. */
  async lastDeviationAt(assignmentId: number): Promise<Date | null> {
    const rows = await this.ds.query(
      `SELECT created_at FROM fd_route_events
       WHERE assignment_id = ? AND type = 'deviation'
       ORDER BY created_at DESC LIMIT 1`,
      [assignmentId],
    );
    return rows.length ? rows[0].created_at : null;
  }

  /** One row per deviation event newer than the cursor, across this manager's assignments. */
  async listDeviationAlertsSince(
    userId: number,
    sinceEventId: number,
    limit = 20,
  ): Promise<
    Array<{
      eventId: number;
      assignmentId: number;
      driverName: string | null;
      routeName: string | null;
      distanceM: number | null;
      at: Date;
    }>
  > {
    const rows = await this.ds.query(
      `SELECT e.event_id, e.assignment_id, e.distance_m, e.created_at,
              d.driver_name, r.name AS route_name
       FROM fd_route_events e
       JOIN fd_assignments a ON a.assignment_id = e.assignment_id
       LEFT JOIN gs_user_object_drivers d ON d.driver_id = a.driver_id
       LEFT JOIN fd_routes r ON r.route_id = a.route_id
       WHERE a.user_id = ? AND e.type = 'deviation' AND e.event_id > ?
       ORDER BY e.event_id ASC
       LIMIT ?`,
      [userId, sinceEventId, limit],
    );
    return rows.map((r: any) => ({
      eventId: r.event_id,
      assignmentId: r.assignment_id,
      driverName: r.driver_name ?? null,
      routeName: r.route_name ?? null,
      distanceM: r.distance_m,
      at: r.created_at,
    }));
  }

  /** Highest event id across this manager's assignments — the alert bootstrap cursor. */
  async maxEventId(userId: number): Promise<number> {
    const rows = await this.ds.query(
      `SELECT MAX(e.event_id) AS max_id
       FROM fd_route_events e
       JOIN fd_assignments a ON a.assignment_id = e.assignment_id
       WHERE a.user_id = ?`,
      [userId],
    );
    return rows[0]?.max_id ?? 0;
  }

  private map(r: any): AssignmentRecord {
    return {
      assignmentId: r.assignment_id,
      userId: r.user_id,
      routeId: r.route_id,
      routeName: r.route_name ?? null,
      driverId: r.driver_id,
      driverName: r.driver_name ?? null,
      imei: r.imei,
      vehicleName: r.vehicle_name ?? null,
      status: r.status,
      priority: r.priority,
      scheduledStart: r.scheduled_start,
      notes: r.notes,
      lastLat: r.last_lat != null ? Number(r.last_lat) : null,
      lastLng: r.last_lng != null ? Number(r.last_lng) : null,
      lastSeen: r.last_seen,
      progressPct: r.progress_pct != null ? Number(r.progress_pct) : null,
      offRoute: r.off_route === 1,
      createdAt: r.created_at,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    };
  }
}
