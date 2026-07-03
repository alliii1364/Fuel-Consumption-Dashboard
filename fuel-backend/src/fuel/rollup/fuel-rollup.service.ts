import { Injectable } from '@nestjs/common';
import { FuelConsumptionService } from '../services/fuel-consumption.service';
import { FuelSensor } from '../services/fuel-sensor-resolver.service';
import { FuelDailyRepository } from './fuel-daily.repository';
import { dayUtcRange, karachiDayStrs, isDayAligned } from './karachi-day.util';
import { reconstructRange, DailyMetrics, RangeMetrics } from './reconstruct.util';

@Injectable()
export class FuelRollupService {
  constructor(
    private readonly consumption: FuelConsumptionService,
    private readonly daily: FuelDailyRepository,
  ) {}

  /** Compute one Karachi-day via the existing analysis and upsert its row. */
  async computeAndStoreDay(imei: string, sensor: FuelSensor, day: string, fcr: string): Promise<void> {
    const { start, end } = dayUtcRange(day);
    const r = await this.consumption.getConsumption(imei, start, end, sensor, fcr).catch(() => null);
    if (!r) {
      // No data that day → store a zero row so we don't recompute it forever.
      await this.daily.upsertDay(imei, sensor.sensorId, {
        day, consumed: 0, refueled: 0, netDrop: null, firstFuel: null, lastFuel: null,
        cost: null, refuels: [], firstTs: null, lastTs: null, samples: 0,
      });
      return;
    }
    await this.daily.upsertDay(imei, sensor.sensorId, {
      day,
      consumed: r.netDrop !== null ? Math.max(0, r.netDrop + r.refueled) : r.consumed,
      refueled: r.refueled, netDrop: r.netDrop, firstFuel: r.firstFuel, lastFuel: r.lastFuel,
      cost: r.estimatedCost, refuels: r.refuels,
      firstTs: r.refuels[0] ? new Date(r.refuels[0].at) : null, // ts fields best-effort
      lastTs: null, samples: r.samples,
    });
  }

  /** Range metrics from cached rollup rows + compute-on-miss for absent full
   *  days + edge-day recompute. fd_fuel_daily is a CACHE: any full day not
   *  present is recomputed from raw and stored (never assumed 0). This is what
   *  makes the read path correct across backfill gaps AND IMEI renames — after
   *  a rename the new imei simply misses and recomputes from its (renamed) raw
   *  table, which holds the full history. */
  async getConsumptionViaRollup(imei: string, from: Date, to: Date, sensor: FuelSensor, fcr: string): Promise<RangeMetrics> {
    const fullDays = karachiDayStrs(from, to);
    const dailyRows = await this.daily.getDays(imei, sensor.sensorId, fullDays);
    const have = new Set(dailyRows.map((d) => d.day));

    // Compute-on-miss: any full day not in the cache is computed from raw now
    // (and stored for next time). Never drop/zero a missing day.
    for (const day of fullDays) {
      if (!have.has(day)) {
        await this.computeAndStoreDay(imei, sensor, day, fcr);
      }
    }
    const rows = have.size === fullDays.length
      ? dailyRows
      : await this.daily.getDays(imei, sensor.sensorId, fullDays);

    const parts: DailyMetrics[] = [...rows];
    // Leading partial day (range starts mid-day)
    if (!isDayAligned(from)) {
      const firstFullStart = fullDays.length ? dayUtcRange(fullDays[0]).start : to;
      if (from < firstFullStart) parts.unshift(await this.edge(imei, sensor, fcr, from, firstFullStart));
    }
    // Trailing partial day (range ends mid-day)
    if (!isDayAligned(to)) {
      const lastFullEnd = fullDays.length ? dayUtcRange(fullDays[fullDays.length - 1]).end : from;
      if (to > lastFullEnd) parts.push(await this.edge(imei, sensor, fcr, lastFullEnd, to));
    }
    return reconstructRange(parts);
  }

  private async edge(imei: string, sensor: FuelSensor, fcr: string, from: Date, to: Date): Promise<DailyMetrics> {
    const r = await this.consumption.getConsumption(imei, from, to, sensor, fcr).catch(() => null);
    if (!r) return { day: 'edge', consumed: 0, refueled: 0, netDrop: null, firstFuel: null, lastFuel: null, cost: null, refuels: [] };
    return {
      day: 'edge',
      consumed: r.netDrop !== null ? Math.max(0, r.netDrop + r.refueled) : r.consumed,
      refueled: r.refueled, netDrop: r.netDrop, firstFuel: r.firstFuel, lastFuel: r.lastFuel,
      cost: r.estimatedCost, refuels: r.refuels,
    };
  }
}
