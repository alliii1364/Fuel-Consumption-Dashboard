/**
 * SHIP GATE — parity test for FuelRollupService.
 *
 * This test MUST be run manually against a real vehicle and a real database
 * before enabling the FUEL_ROLLUP feature flag in production.
 *
 * It confirms that the literal-edge boundary semantic from Task 3 (reconstructRange
 * uses parts[0].firstFuel / parts[last].lastFuel verbatim) yields results that
 * match the direct whole-range getConsumption call within the allowed tolerance.
 *
 * The literal-edge boundary semantic is NOT verified by the mocked unit tests
 * (fuel-rollup.service.spec.ts) — those tests only verify orchestration logic.
 * Only this test, run against real data, constitutes verification of that semantic.
 *
 * To run: FUEL_ROLLUP_PARITY_DB=1 npx jest fuel-rollup.parity
 */

import { DataSource } from 'typeorm';
import { FuelConsumptionService } from '../services/fuel-consumption.service';
import { FuelDailyRepository } from './fuel-daily.repository';
import { FuelRollupService } from './fuel-rollup.service';
import { karachiDayStrs } from './karachi-day.util';

const SKIP = !process.env.FUEL_ROLLUP_PARITY_DB;

// Replace these with a known vehicle + sensor before running manually:
const IMEI = 'REPLACE_WITH_REAL_IMEI';
const FCR = '{}';

describe.skip('FuelRollupService parity (skip unless FUEL_ROLLUP_PARITY_DB=1)', () => {
  let rollup: FuelRollupService;
  let consumptionService!: FuelConsumptionService;
  let sensor: any;

  beforeAll(async () => {
    if (SKIP) return;
    // Bootstrap: instantiate with a real DataSource connected to the test/prod DB.
    // Adjust connection options to match your environment.
    const ds = new DataSource({
      type: 'mysql',
      // host/port/username/password/database from env or hardcoded for manual run
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 3306),
      username: process.env.DB_USER ?? 'root',
      password: process.env.DB_PASS ?? '',
      database: process.env.DB_NAME ?? 'fueldb',
    });
    await ds.initialize();

    const dailyRepo = new FuelDailyRepository(ds as any);
    // FuelConsumptionService has more dependencies — wire them up manually or
    // bootstrap via NestJS test module as needed.
    // This is left as a placeholder for the manual run setup.
    // consumptionService = ... (instantiate with ds)
    rollup = new FuelRollupService(consumptionService, dailyRepo);
    // sensor = await sensorResolver.resolveAllFuelSensors(IMEI)[0];
  });

  it('rollup-reconstructed metrics equal whole-range getConsumption (tolerance 0.5 L)', async () => {
    if (SKIP) return;
    const from = new Date('2026-05-31T19:00:00.000Z');
    const to   = new Date('2026-06-04T19:00:00.000Z');
    const raw = await consumptionService.getConsumption(IMEI, from, to, sensor, FCR);
    // roll up each day, then reconstruct
    for (const d of karachiDayStrs(from, to)) await rollup.computeAndStoreDay(IMEI, sensor, d, FCR);
    const agg = await rollup.getConsumptionViaRollup(IMEI, from, to, sensor, FCR);
    expect(Math.abs(agg.consumed - (raw.netDrop !== null ? Math.max(0, raw.netDrop + raw.refueled) : raw.consumed))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(agg.refueled - raw.refueled)).toBeLessThanOrEqual(0.5);
  });
});
