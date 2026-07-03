# Fuel Pre-Aggregation — Daily Rollup Table

**Date:** 2026-07-03
**Status:** Approved (design), pending implementation plan
**Area:** fuel-backend — dashboard/summary + per-vehicle consumption/refuels

## Problem

Every fuel dashboard request recomputes from raw telemetry: it fetches
100k–500k rows from a per-vehicle `gs_object_data_<imei>` table and runs heavy
synchronous analysis (transform + calibration, median filter, spike/refuel
detection). This is slow (seconds per vehicle) and — because `dashboard/summary`
loops over **every** vehicle — blocks the single Node thread, freezing all
other endpoints and occasionally OOM-restarting the process.

## Goal

Precompute each vehicle's **per-day** fuel metrics once (in a background job,
using the existing analysis code) into a small rollup table, so dashboard
requests read ~30 daily rows instead of 100k+ raw rows.

Measured basis → estimated result:
- Raw path today: ~2.15 s fetch + multi-second analysis per vehicle.
- Rollup path: read ~30 daily rows (**~10–30 ms per vehicle** for day-aligned
  ranges; the app's ranges are Asia/Karachi-midnight aligned). Summary for a
  fleet → sub-second. Wide ranges (6 months ≈ 180 rows) stay fast. No
  event-loop freeze / OOM, because per-request work is tiny.

## 🔒 Safety constraints (HARD — the source data is sensitive & shared)

The `gs` database is shared and its telemetry tables are business-critical.
This feature must be **strictly additive and read-only** toward everything that
already exists:

1. **Create exactly ONE new table**: `fd_fuel_daily` (the `fd_` prefix matches
   this app's existing dispatch tables: `fd_routes`, `fd_pod`, …).
2. **Never ALTER, DROP, or add columns/indexes/triggers to any existing table**
   — especially `gs_objects`, `gs_object_sensors`, and the `gs_object_data_*`
   raw tables. The rollup job only **SELECTs** from them (as the app already
   does). No `CREATE TRIGGER` anywhere (a trigger on the raw tables would touch
   the hot write path — forbidden).
3. **Backfill must be gentle**: process vehicle-by-vehicle, day-by-day, with a
   small delay between vehicles and a bounded query window, so the shared DB
   and other apps are not impacted. It is a one-time, resumable, off-peak job.
4. **Feature-flagged** (`FUEL_ROLLUP=0` default until validated): flag off →
   endpoints use today's raw computation unchanged. Instant rollback, no
   redeploy.
5. Writes go only to `fd_fuel_daily`. If the job or table is dropped, nothing
   else is affected.

## Design

### Table `fd_fuel_daily`
One row per (vehicle, sensor, Asia/Karachi calendar day):
```
imei         VARCHAR      -- vehicle
sensor_id    INT          -- fuel sensor
day          DATE         -- Asia/Karachi calendar day
consumed     DOUBLE       -- drop-sum for the day (L)
refueled     DOUBLE       -- refuel total for the day (L)
net_drop     DOUBLE       -- firstFuel - lastFuel for the day
first_fuel   DOUBLE       -- fuel level at day start
last_fuel    DOUBLE       -- fuel level at day end
first_ts     DATETIME     -- first reading ts that day
last_ts      DATETIME     -- last reading ts that day
cost         DOUBLE       -- estimated cost for the day (nullable)
refuel_events JSON        -- [{at, amount}, ...] for the refuels endpoint
computed_at  DATETIME     -- when this row was rolled up
PRIMARY KEY (imei, sensor_id, day)
```

### Day definition (timezone)
A "day" is an **Asia/Karachi** calendar day. Day `D` spans
`[D-1 19:00 UTC, D 19:00 UTC)` (Karachi is UTC+5). This matches the app's
range boundaries (the dashboard already sends `19:00:00Z` from/to), so a normal
range covers whole rollup days.

### Rollup job (background, reuses existing logic)
For a (imei, sensor, day): call the **existing** `FuelConsumptionService`
computation for `from = day start UTC`, `to = day end UTC` (its 2 h warmup
window gives the median filter proper boundary context), then store the day's
`consumed / refueled / net_drop / first_fuel / last_fuel / first_ts / last_ts /
cost / refuel_events`. No new fuel math — same code path.

- **Incremental cron** (e.g. hourly/daily): roll up the last ~2 days
  (`computed_at` re-stamped) for vehicles that reported recently; historical
  days are immutable and computed once.
- **Backfill** (one-time, throttled): walk each vehicle's data range day by day,
  skipping days already present, with a short pause between vehicles. Resumable
  (idempotent upsert on the PK).

### Query path (range `[from, to]`)
- **Full Karachi-days inside the range** → read from `fd_fuel_daily` (fast).
- **Partial edge days** (range not day-aligned) → recompute only those 1–2 days
  from raw via the existing service (small).
- **Reconstruct range metrics** (identical to today's summary math):
  - `refueled = Σ daily refueled` (+ edge days)
  - `rangeNetDrop = firstDay.first_fuel − lastDay.last_fuel`
  - `consumed = max(0, rangeNetDrop + rangeRefueled)` (mass-balance; matches
    the current summary/routes formula)
  - `refuels list = concat(daily refuel_events)` (+ edge)
  - `cost = Σ daily cost`

### Endpoints served (Phase 1)
`dashboard/summary`, `fuel/consumption`, `fuel/refuels`. **Not** in this phase:
`fuel/history` (arbitrary-interval time-series — needs a separate downsampled
series) and `fuel/stats` (min/max/avg — needs different daily aggregates).
Those keep today's raw path and are a Phase 2.

## Accuracy — the main technical risk

Computing day-by-day and summing may differ slightly from analysing the whole
range at once (median-filter / spike detection behaves differently at day
boundaries). **This must be validated, not assumed:**

- **Parity test**: for several real vehicles + ranges, assert the
  rollup-reconstructed `consumed / refueled / netDrop / refuels` **equals** the
  current whole-range `getConsumption` result within a tight tolerance.
- If boundaries diverge beyond tolerance, mitigate (the per-day 2 h warmup
  already helps; if needed, store finer data or use overlapping windows) — and
  re-validate. We do **not** ship until parity holds.

## Rollback / safety

- `FUEL_ROLLUP=0` → all endpoints use the current raw computation. Default off
  until parity + measurement pass in prod.
- Dropping `fd_fuel_daily` or disabling the cron affects nothing else.

## Testing

1. **Rollup unit test**: a day's rollup row equals the service's single-day
   result.
2. **Reconstruction unit test**: range metrics from daily rows == whole-range
   values on synthetic data (full days and partial edge days).
3. **Parity test** (accuracy gate): rollup-path vs raw-path on real-ish data,
   within tolerance.
4. **Query-path integration**: endpoints return the same shape; `FUEL_ROLLUP=0`
   falls back to raw.
5. Existing fuel tests keep passing.

## Rollout steps (guided)
1. **Migration**: `CREATE TABLE fd_fuel_daily` only (via the app's migration
   runner). No changes to existing tables.
2. **Deploy** backend (job + query integration) with `FUEL_ROLLUP=0`.
3. **Backfill** (throttled, off-peak) — populate historical days.
4. Run the **parity check** against raw for a few vehicles/ranges.
5. `FUEL_ROLLUP=1` → measure. Cron keeps it current.

## Files touched

- Create: `fuel-backend/migrations/005_fuel_daily_rollup.sql` (CREATE TABLE only)
- Create: `fuel-backend/src/fuel/rollup/fuel-daily.repository.ts` (read/upsert `fd_fuel_daily`)
- Create: `fuel-backend/src/fuel/rollup/fuel-rollup.service.ts` (compute + store a day; range reconstruction)
- Create: `fuel-backend/src/fuel/rollup/fuel-rollup.cron.ts` (incremental schedule)
- Create: `fuel-backend/scripts/backfill-fuel-daily.js` (one-time, throttled, resumable)
- Create: `fuel-backend/src/fuel/rollup/fuel-rollup.parity.spec.ts` + reconstruction unit tests
- Modify: `fuel-backend/src/fuel/fuel.module.ts` (register rollup providers)
- Modify: `fuel-backend/src/fuel/fuel.controller.ts` (consumption/refuels via rollup when `FUEL_ROLLUP=1`)
- Modify: `fuel-backend/src/dashboard/dashboard.service.ts` (summary via rollup when `FUEL_ROLLUP=1`)
- Modify: `fuel-backend/.env.example` (document `FUEL_ROLLUP`)
- No changes to any `gs_*` table.
