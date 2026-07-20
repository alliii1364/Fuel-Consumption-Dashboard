import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface DriverLocationRecord {
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

/**
 * Raw-SQL store for the driver Android app: FCM device tokens, phone GPS pings,
 * and proof-of-delivery records. Same loose-coupling style as the other
 * dispatch repositories.
 */
@Injectable()
export class DriverAppRepository {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  // ── Devices (FCM) ──────────────────────────────────────────────────────────
  async registerDevice(
    driverId: number,
    fcmToken: string,
    platform = 'android',
    appVersion: string | null = null,
  ): Promise<void> {
    await this.ds.query(
      `INSERT INTO fd_driver_devices (driver_id, fcm_token, platform, app_version)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE driver_id = VALUES(driver_id),
                               platform = VALUES(platform),
                               app_version = VALUES(app_version),
                               updated_at = CURRENT_TIMESTAMP`,
      [driverId, fcmToken, platform, appVersion],
    );
  }

  /** FCM tokens for a driver — used by the push service. */
  async tokensForDriver(driverId: number): Promise<string[]> {
    const rows = await this.ds.query(
      `SELECT fcm_token FROM fd_driver_devices WHERE driver_id = ?`,
      [driverId],
    );
    return rows.map((r: any) => r.fcm_token as string);
  }

  /** Drop device tokens FCM has reported as permanently invalid. */
  async removeTokens(tokens: string[]): Promise<void> {
    if (!tokens.length) return;
    const placeholders = tokens.map(() => '?').join(',');
    await this.ds.query(
      `DELETE FROM fd_driver_devices WHERE fcm_token IN (${placeholders})`,
      tokens,
    );
  }

  // ── Location pings ───────────────────────────────────────────────────────
  async addLocation(p: {
    driverId: number;
    assignmentId: number | null;
    lat: number;
    lng: number;
    speed: number | null;
    accuracyM: number | null;
    recordedAt: Date;
  }): Promise<void> {
    await this.ds.query(
      `INSERT INTO fd_driver_locations
         (driver_id, assignment_id, lat, lng, speed, accuracy_m, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [p.driverId, p.assignmentId, p.lat, p.lng, p.speed, p.accuracyM, p.recordedAt],
    );
  }

  /** Recent phone-GPS trail for an assignment (oldest→newest), capped. */
  async recentLocations(
    assignmentId: number,
    limit = 200,
  ): Promise<DriverLocationRecord[]> {
    const rows = await this.ds.query(
      `SELECT * FROM (
         SELECT id, driver_id, assignment_id, lat, lng, speed, accuracy_m, recorded_at
         FROM fd_driver_locations
         WHERE assignment_id = ?
         ORDER BY recorded_at DESC
         LIMIT ?
       ) t ORDER BY recorded_at ASC`,
      [assignmentId, limit],
    );
    return rows.map((r: any) => this.mapLoc(r));
  }

  // ── Proof of delivery ──────────────────────────────────────────────────────
  async addPod(p: {
    assignmentId: number;
    stopId: number | null;
    driverId: number;
    photoPath: string | null;
    note: string | null;
    lat: number | null;
    lng: number | null;
  }): Promise<number> {
    const res = await this.ds.query(
      `INSERT INTO fd_pod
         (assignment_id, stop_id, driver_id, photo_path, note, lat, lng)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [p.assignmentId, p.stopId, p.driverId, p.photoPath, p.note, p.lat, p.lng],
    );
    return res.insertId as number;
  }

  async listPod(assignmentId: number): Promise<PodRecord[]> {
    const rows = await this.ds.query(
      `SELECT id, assignment_id, stop_id, driver_id, photo_path, note, lat, lng, created_at
       FROM fd_pod WHERE assignment_id = ? ORDER BY created_at ASC`,
      [assignmentId],
    );
    return rows.map((r: any) => this.mapPod(r));
  }

  private mapLoc(r: any): DriverLocationRecord {
    return {
      id: r.id,
      driverId: r.driver_id,
      assignmentId: r.assignment_id,
      lat: Number(r.lat),
      lng: Number(r.lng),
      speed: r.speed != null ? Number(r.speed) : null,
      accuracyM: r.accuracy_m != null ? Number(r.accuracy_m) : null,
      recordedAt: r.recorded_at,
    };
  }

  private mapPod(r: any): PodRecord {
    return {
      id: r.id,
      assignmentId: r.assignment_id,
      stopId: r.stop_id,
      driverId: r.driver_id,
      photoPath: r.photo_path,
      note: r.note,
      lat: r.lat != null ? Number(r.lat) : null,
      lng: r.lng != null ? Number(r.lng) : null,
      createdAt: r.created_at,
    };
  }
}
