/* eslint-disable */
// One-time throttled backfill for fd_fuel_daily.
// Reads config from fuel-backend/.env (dotenv), bootstraps a Nest standalone
// context from the compiled dist/, loops every vehicle in gs_objects, and for
// each vehicle computes + stores any missing Karachi-day rows.  Idempotent /
// resumable: days already present in fd_fuel_daily are skipped via hasDay().
//
// Usage:
//   node scripts/backfill-fuel-daily.js [--days=120] [--sleep=300]
//
// DO NOT run against production without ops sign-off.  READ-only on gs_*;
// writes only fd_fuel_daily.

require('dotenv').config();

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { FuelRollupService } = require('../dist/fuel/rollup/fuel-rollup.service');
const { FuelSensorResolverService } = require('../dist/fuel/services/fuel-sensor-resolver.service');
const { FuelDailyRepository } = require('../dist/fuel/rollup/fuel-daily.repository');
const { karachiDayStrs } = require('../dist/fuel/rollup/karachi-day.util');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function parseArg(name, defaultVal) {
  const flag = `--${name}=`;
  const found = process.argv.slice(2).find((a) => a.startsWith(flag));
  return found ? parseInt(found.slice(flag.length), 10) : defaultVal;
}

const DAYS  = parseArg('days', 120);
const SLEEP = parseArg('sleep', 300);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`[backfill] Starting: days=${DAYS}, sleep=${SLEEP}ms`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  const rollup   = app.get(FuelRollupService);
  const sensors  = app.get(FuelSensorResolverService);
  const repo     = app.get(FuelDailyRepository);

  // Raw DataSource is needed only to list vehicles — borrow it from the repo.
  // FuelDailyRepository uses @InjectDataSource(), so access its ds via the
  // TypeORM DataSource token registered in the module.
  const { DataSource } = require('typeorm');
  const ds = app.get(DataSource);

  // List all vehicles that have reported recently (or all, for a full backfill)
  const vehicles = await ds.query('SELECT imei, fcr FROM gs_objects');
  const total = vehicles.length;
  console.log(`[backfill] Found ${total} vehicles`);

  // Compute the date window once — last DAYS Karachi days up to now
  const to   = new Date();
  const from = new Date(to.getTime() - DAYS * 24 * 60 * 60 * 1000);
  const allDays = karachiDayStrs(from, to);
  console.log(`[backfill] Window: ${allDays[0]} → ${allDays[allDays.length - 1]} (${allDays.length} days)`);

  for (let i = 0; i < total; i++) {
    const { imei, fcr } = vehicles[i];

    let sensor;
    try {
      sensor = await sensors.resolveFuelSensor(imei);
    } catch (e) {
      console.log(`[backfill] [${i + 1}/${total}] ${imei}: no fuel sensor, skipping`);
      await sleep(SLEEP);
      continue;
    }

    let newDays = 0;
    for (const day of allDays) {
      const already = await repo.hasDay(imei, sensor.sensorId, day);
      if (!already) {
        await rollup.computeAndStoreDay(imei, sensor, day, fcr ?? '');
        newDays++;
      }
    }

    console.log(`[backfill] [${i + 1}/${total}] ${imei}: ${newDays} new day(s) stored`);
    await sleep(SLEEP);
  }

  console.log('[backfill] Done.');
  await app.close();
}

main().catch((e) => {
  console.error('[backfill] FAILED:', e.message || e);
  process.exit(1);
});
