import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface Depot {
  depotId: number;
  userId: number;
  name: string;
  lat: number;
  lng: number;
  isDefault: boolean;
}

/** Manager yards/depots — the fixed start & end of round-trip routes. */
@Injectable()
export class DepotRepository {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async list(userId: number): Promise<Depot[]> {
    const rows = await this.ds.query(
      `SELECT depot_id, user_id, name, lat, lng, is_default
       FROM fd_depots WHERE user_id = ? AND active = 1
       ORDER BY is_default DESC, name ASC`,
      [userId],
    );
    return rows.map(this.map);
  }

  async get(userId: number, depotId: number): Promise<Depot> {
    const rows = await this.ds.query(
      `SELECT depot_id, user_id, name, lat, lng, is_default
       FROM fd_depots WHERE depot_id = ? AND user_id = ? AND active = 1 LIMIT 1`,
      [depotId, userId],
    );
    if (!rows.length) throw new NotFoundException('Depot not found');
    return this.map(rows[0]);
  }

  async create(
    userId: number,
    data: { name: string; lat: number; lng: number; isDefault?: boolean },
  ): Promise<number> {
    // The first depot a user creates becomes their default automatically.
    const existing = await this.ds.query(
      `SELECT COUNT(*) AS c FROM fd_depots WHERE user_id = ? AND active = 1`,
      [userId],
    );
    const makeDefault = !!data.isDefault || Number(existing[0].c) === 0;
    if (makeDefault) await this.clearDefault(userId);
    const res = await this.ds.query(
      `INSERT INTO fd_depots (user_id, name, lat, lng, is_default) VALUES (?, ?, ?, ?, ?)`,
      [userId, data.name, data.lat, data.lng, makeDefault ? 1 : 0],
    );
    return res.insertId as number;
  }

  async setDefault(userId: number, depotId: number): Promise<void> {
    await this.get(userId, depotId); // ownership check
    await this.clearDefault(userId);
    await this.ds.query(
      `UPDATE fd_depots SET is_default = 1 WHERE depot_id = ? AND user_id = ?`,
      [depotId, userId],
    );
  }

  async remove(userId: number, depotId: number): Promise<void> {
    await this.get(userId, depotId); // ownership check
    await this.ds.query(
      `UPDATE fd_depots SET active = 0, is_default = 0 WHERE depot_id = ? AND user_id = ?`,
      [depotId, userId],
    );
  }

  private async clearDefault(userId: number): Promise<void> {
    await this.ds.query(`UPDATE fd_depots SET is_default = 0 WHERE user_id = ?`, [userId]);
  }

  private map = (r: any): Depot => ({
    depotId: r.depot_id,
    userId: r.user_id,
    name: r.name,
    lat: Number(r.lat),
    lng: Number(r.lng),
    isDefault: r.is_default === 1,
  });
}
