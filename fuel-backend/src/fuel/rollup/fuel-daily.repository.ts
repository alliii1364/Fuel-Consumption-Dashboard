import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DailyMetrics } from './reconstruct.util';

export function rowToDaily(r: any): DailyMetrics {
  let refuels = [];
  if (r.refuel_events) {
    try { refuels = typeof r.refuel_events === 'string' ? JSON.parse(r.refuel_events) : r.refuel_events; } catch { refuels = []; }
  }
  return {
    day: typeof r.day === 'string' ? r.day : new Date(r.day).toISOString().slice(0, 10),
    consumed: Number(r.consumed) || 0,
    refueled: Number(r.refueled) || 0,
    netDrop: r.net_drop === null ? null : Number(r.net_drop),
    firstFuel: r.first_fuel === null ? null : Number(r.first_fuel),
    lastFuel: r.last_fuel === null ? null : Number(r.last_fuel),
    cost: r.cost === null ? null : Number(r.cost),
    refuels,
  };
}

@Injectable()
export class FuelDailyRepository {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async upsertDay(
    imei: string, sensorId: number,
    m: DailyMetrics & { firstTs: Date | null; lastTs: Date | null; samples: number },
  ): Promise<void> {
    await this.ds.query(
      `INSERT INTO fd_fuel_daily
         (imei, sensor_id, day, consumed, refueled, net_drop, first_fuel, last_fuel,
          first_ts, last_ts, cost, refuel_events, samples)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         consumed=VALUES(consumed), refueled=VALUES(refueled), net_drop=VALUES(net_drop),
         first_fuel=VALUES(first_fuel), last_fuel=VALUES(last_fuel),
         first_ts=VALUES(first_ts), last_ts=VALUES(last_ts), cost=VALUES(cost),
         refuel_events=VALUES(refuel_events), samples=VALUES(samples)`,
      [imei, sensorId, m.day, m.consumed, m.refueled, m.netDrop, m.firstFuel, m.lastFuel,
       m.firstTs, m.lastTs, m.cost, JSON.stringify(m.refuels), m.samples],
    );
  }

  async getDays(imei: string, sensorId: number, dayStrs: string[]): Promise<DailyMetrics[]> {
    if (!dayStrs.length) return [];
    const placeholders = dayStrs.map(() => '?').join(',');
    const rows: any[] = await this.ds.query(
      `SELECT day, consumed, refueled, net_drop, first_fuel, last_fuel, cost, refuel_events
       FROM fd_fuel_daily WHERE imei=? AND sensor_id=? AND day IN (${placeholders})
       ORDER BY day ASC`,
      [imei, sensorId, ...dayStrs],
    );
    return rows.map(rowToDaily);
  }

  async hasDay(imei: string, sensorId: number, day: string): Promise<boolean> {
    const r: any[] = await this.ds.query(
      `SELECT 1 FROM fd_fuel_daily WHERE imei=? AND sensor_id=? AND day=? LIMIT 1`,
      [imei, sensorId, day],
    );
    return r.length > 0;
  }

  /** Invalidation — drop all cached rows for a vehicle (run after a unit
   *  replacement / IMEI reuse so the next query recomputes cleanly). */
  async deleteVehicle(imei: string): Promise<void> {
    await this.ds.query(`DELETE FROM fd_fuel_daily WHERE imei=?`, [imei]);
  }

  /** Orphan cleanup — cached rows whose imei no longer exists in gs_objects. */
  async deleteOrphans(): Promise<number> {
    const r: any = await this.ds.query(
      `DELETE fd FROM fd_fuel_daily fd
       LEFT JOIN gs_objects o ON o.imei = fd.imei
       WHERE o.imei IS NULL`,
    );
    return r?.affectedRows ?? 0;
  }
}
