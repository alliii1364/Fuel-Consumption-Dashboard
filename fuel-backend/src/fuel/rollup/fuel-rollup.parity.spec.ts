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
 * HOW TO RUN (all config via env — no file edits needed):
 *   Run from fuel-backend/, with the .env pointing at the real DB, and the
 *   fd_fuel_daily table already created (migration 005). Then:
 *
 *     FUEL_ROLLUP_PARITY_DB=1 \
 *     PARITY_IMEI=<real_imei> \
 *     PARITY_FCR='<gs_objects.fcr for that vehicle>' \
 *     PARITY_FROM='2026-05-31T19:00:00.000Z' \
 *     PARITY_TO='2026-06-04T19:00:00.000Z' \
 *     npx jest fuel-rollup.parity
 *
 *   - PARITY_IMEI is required (a real vehicle with fuel data in the window).
 *   - PARITY_FCR defaults to '{}'; set it to the vehicle's real fcr for a
 *     production-accurate check (both raw and rollup use the same FCR, so
 *     parity holds either way — but real fcr gives realistic numbers).
 *   - PARITY_FROM/PARITY_TO default to the range below; both MUST be Karachi
 *     day-aligned (19:00:00Z). Pick a window where the vehicle actually reports.
 *   Repeat for 2-3 vehicles before enabling FUEL_ROLLUP=1.
 *
 * The test validates the literal-edge boundary semantic: the day-by-day rollup sum
 * must equal the whole-range getConsumption result within tolerance (0.5 L).
 * This MUST pass before enabling FUEL_ROLLUP=1 in production.
 *
 * When FUEL_ROLLUP_PARITY_DB is unset the entire suite is skipped — 0 tests run,
 * no DB connection is opened.
 */

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AppModule } from '../../app.module';
import { FuelConsumptionService } from '../services/fuel-consumption.service';
import { FuelSensor, FuelSensorResolverService } from '../services/fuel-sensor-resolver.service';
import { FuelDailyRepository } from './fuel-daily.repository';
import { FuelRollupService } from './fuel-rollup.service';
import { karachiDayStrs } from './karachi-day.util';

const SKIP = !process.env.FUEL_ROLLUP_PARITY_DB;

// ---------------------------------------------------------------------------
// OPERATOR-EDIT CONSTANTS — set before running manually:
// ---------------------------------------------------------------------------
/** Real vehicle IMEI. Override via env: PARITY_IMEI=<imei> or edit here. */
const IMEI = process.env.PARITY_IMEI ?? 'REPLACE_WITH_REAL_IMEI';
/** Fuel-config-rules JSON for the vehicle. Set PARITY_FCR to the vehicle's real
 *  gs_objects.fcr for a production-accurate check (defaults to '{}'). */
const FCR = process.env.PARITY_FCR ?? '{}';
/** Karachi-day-aligned UTC range (19:00:00Z boundaries). Override via
 *  PARITY_FROM / PARITY_TO to target a window where the vehicle has fuel data. */
const FROM_ISO = process.env.PARITY_FROM ?? '2026-05-31T19:00:00.000Z';
const TO_ISO = process.env.PARITY_TO ?? '2026-06-04T19:00:00.000Z';
// ---------------------------------------------------------------------------

(SKIP ? describe.skip : describe)('FuelRollupService parity (skip unless FUEL_ROLLUP_PARITY_DB=1)', () => {
  let app: INestApplication;
  let rollup: FuelRollupService;
  let consumptionService: FuelConsumptionService;
  let sensor: FuelSensor;

  beforeAll(async () => {
    if (SKIP) return;
    // Bootstrap the full NestJS application so all providers (TypeORM DataSource,
    // FuelConsumptionService, FuelDailyRepository, etc.) are properly wired.
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    consumptionService = app.get(FuelConsumptionService);
    const dataSource = app.get<DataSource>(getDataSourceToken());
    const dailyRepo = new FuelDailyRepository(dataSource as any);
    rollup = new FuelRollupService(consumptionService, dailyRepo);

    // Resolve the primary fuel sensor for the vehicle under test.
    const resolver = app.get(FuelSensorResolverService);
    sensor = await resolver.resolveFuelSensor(IMEI);
  });

  afterAll(async () => {
    if (!SKIP) await app?.close();
  });

  it('rollup-reconstructed metrics equal whole-range getConsumption (tolerance 0.5 L)', async () => {
    if (SKIP) return;
    const from = new Date(FROM_ISO);
    const to   = new Date(TO_ISO);
    // eslint-disable-next-line no-console
    console.log(`[parity] imei=${IMEI} range=${FROM_ISO}..${TO_ISO} fcr=${FCR}`);
    const raw = await consumptionService.getConsumption(IMEI, from, to, sensor, FCR);
    // roll up each day, then reconstruct
    for (const d of karachiDayStrs(from, to)) await rollup.computeAndStoreDay(IMEI, sensor, d, FCR);
    const agg = await rollup.getConsumptionViaRollup(IMEI, from, to, sensor, FCR);
    expect(Math.abs(agg.consumed - (raw.netDrop !== null ? Math.max(0, raw.netDrop + raw.refueled) : raw.consumed))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(agg.refueled - raw.refueled)).toBeLessThanOrEqual(0.5);
  });
});
