import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

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
  createdAt: Date;
}

@Injectable()
export class StopCompletionRepository {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async add(c: Omit<StopCompletion, 'id' | 'createdAt'>): Promise<number> {
    const result = await this.ds.query(
      `INSERT INTO fd_stop_completions
         (assignment_id, stop_id, driver_id, lat, lng, accuracy_m, distance_m, in_range, photo_path, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        c.assignmentId,
        c.stopId,
        c.driverId,
        c.lat,
        c.lng,
        c.accuracyM,
        c.distanceM,
        c.inRange ? 1 : 0,
        c.photoPath,
        c.note,
      ],
    );
    return result.insertId as number;
  }

  async listForAssignment(assignmentId: number): Promise<StopCompletion[]> {
    const rows = await this.ds.query(
      `SELECT * FROM fd_stop_completions WHERE assignment_id = ? ORDER BY created_at ASC`,
      [assignmentId],
    );
    return rows.map((r: any) => this.map(r));
  }

  async getForStop(assignmentId: number, stopId: number): Promise<StopCompletion | null> {
    const rows = await this.ds.query(
      `SELECT * FROM fd_stop_completions WHERE assignment_id = ? AND stop_id = ? LIMIT 1`,
      [assignmentId, stopId],
    );
    return rows.length ? this.map(rows[0]) : null;
  }

  private map(r: any): StopCompletion {
    return {
      id: r.id,
      assignmentId: r.assignment_id,
      stopId: r.stop_id,
      driverId: r.driver_id,
      lat: Number(r.lat),
      lng: Number(r.lng),
      accuracyM: r.accuracy_m != null ? Number(r.accuracy_m) : null,
      distanceM: r.distance_m,
      inRange: r.in_range === 1,
      photoPath: r.photo_path,
      note: r.note,
      createdAt: r.created_at,
    };
  }
}
