/* eslint-disable */
// Invalidation script — drops all fd_fuel_daily rows for a single vehicle.
// Run after a unit replacement or IMEI reuse so the next query recomputes
// cleanly from raw data.
//
// Usage:
//   node scripts/invalidate-fuel-daily.js <imei>
//
// Writes ONLY to fd_fuel_daily; no gs_* tables touched.

require('dotenv').config();

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { FuelDailyRepository } = require('../dist/fuel/rollup/fuel-daily.repository');

async function main() {
  const imei = process.argv[2];
  if (!imei) {
    console.error('[invalidate] ERROR: imei argument is required');
    console.error('[invalidate] Usage: node scripts/invalidate-fuel-daily.js <imei>');
    process.exit(1);
  }

  console.log(`[invalidate] Removing cached fd_fuel_daily rows for imei=${imei} ...`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const repo = app.get(FuelDailyRepository);
    await repo.deleteVehicle(imei);
    console.log(`[invalidate] Done — all fd_fuel_daily rows for ${imei} removed.`);
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error('[invalidate] FAILED:', e.message || e);
  process.exit(1);
});
