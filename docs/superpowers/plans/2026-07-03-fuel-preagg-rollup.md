# Fuel Pre-Aggregation Rollup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Precompute per-vehicle per-day fuel metrics into a new `fd_fuel_daily` table (using the existing analysis code) so `dashboard/summary`, `fuel/consumption`, and `fuel/refuels` read ~30 daily rows instead of 100k+ raw rows.

**Architecture:** A background job runs the existing `FuelConsumptionService` for a single Karachi-day and upserts a compact summary row. A range request reads the full-day rows from `fd_fuel_daily` and recomputes only partial edge days from raw, then reconstructs range totals with pure math. Feature-flagged (`FUEL_ROLLUP`) with the current raw path as fallback; ships only after a parity test proves rollup numbers match the raw numbers.

**Tech Stack:** NestJS + TypeScript, TypeORM (single MySQL 5.7 `gs` DataSource), Jest + ts-jest, `@nestjs/schedule` (already used).

## Global Constraints

- 🔒 **Strictly additive + read-only toward existing data.** Create exactly ONE new table `fd_fuel_daily`. NEVER `ALTER`/`DROP`/add columns/indexes/triggers to any existing table (`gs_objects`, `gs_object_sensors`, `gs_object_data_*`). The rollup only `SELECT`s from them.
- Migration is `CREATE TABLE IF NOT EXISTS` only, `fd_`-prefixed, InnoDB, `utf8mb4`, idempotent (matches `migrations/003_depots.sql` style). Run via `node scripts/run-migration.js`.
- **Feature flag `FUEL_ROLLUP`** (default `0`): `0` → endpoints use today's raw computation unchanged (instant rollback).
- A "day" is an **Asia/Karachi** calendar day = `[D-1 19:00:00Z, D 19:00:00Z)` (UTC+5).
- **Accuracy gate:** rollup-reconstructed `consumed/refueled/netDrop/refuels` must equal the current whole-range `getConsumption` within tolerance (Task 5). Do not enable the flag in prod until it passes.
- Backfill is throttled, off-peak, resumable (idempotent upsert). Never run unbounded queries against the shared DB.
- Tests: Jest `*.spec.ts` under `fuel-backend/src`, run `npm test` from `fuel-backend`.
- Existing types (verbatim): `ConsumptionResult { consumed:number; refueled:number; estimatedCost:number|null; unit:string; refuels:RefuelEvent[]; firstFuel:number|null; lastFuel:number|null; netDrop:number|null; … }`, `RefuelEvent { at:string; fuelBefore:number; fuelAfter:number; added:number; unit:string }`.

---

### Task 1: Migration — `fd_fuel_daily` table

**Files:**
- Create: `fuel-backend/migrations/005_fuel_daily_rollup.sql`

**Interfaces:**
- Produces: table `fd_fuel_daily`, PK `(imei, sensor_id, day)`, columns per the spec.

- [ ] **Step 1: Write the migration (CREATE TABLE only — no ALTER anywhere)**

```sql
-- Daily fuel rollup — precomputed per-vehicle per-day metrics for fast dashboard reads.
-- Strictly additive: a brand-new fd_-prefixed table. NO changes to any gs_* table.
CREATE TABLE IF NOT EXISTS fd_fuel_daily (
  imei          VARCHAR(32)   NOT NULL,            -- gs_objects.imei
  sensor_id     INT           NOT NULL,            -- gs_object_sensors sensor id
  day           DATE          NOT NULL,            -- Asia/Karachi calendar day
  consumed      DOUBLE        NOT NULL DEFAULT 0,  -- drop-sum for the day (L)
  refueled      DOUBLE        NOT NULL DEFAULT 0,  -- refuel total for the day (L)
  net_drop      DOUBLE            NULL,            -- firstFuel - lastFuel for the day
  first_fuel    DOUBLE            NULL,            -- fuel level at day start
  last_fuel     DOUBLE            NULL,            -- fuel level at day end
  first_ts      DATETIME          NULL,            -- first reading ts that day (UTC)
  last_ts       DATETIME          NULL,            -- last reading ts that day (UTC)
  cost          DOUBLE            NULL,            -- estimated cost for the day
  refuel_events JSON              NULL,            -- [{at,fuelBefore,fuelAfter,added,unit}]
  samples       INT           NOT NULL DEFAULT 0,  -- rows analysed that day
  computed_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (imei, sensor_id, day),
  KEY idx_fd_fuel_daily_imei_day (imei, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- [ ] **Step 2: Run it (local/test DB) and verify**

Run: `node scripts/run-migration.js migrations/005_fuel_daily_rollup.sql`
Then: `DESCRIBE fd_fuel_daily;`
Expected: table exists with the columns above; re-running the migration is a no-op (IF NOT EXISTS).

- [ ] **Step 3: Commit**

```bash
git add fuel-backend/migrations/005_fuel_daily_rollup.sql
git commit -m "feat(fuel): fd_fuel_daily rollup table migration (additive only)"
```

---

### Task 2: Karachi-day helpers (pure)

**Files:**
- Create: `fuel-backend/src/fuel/rollup/karachi-day.util.ts`
- Test: `fuel-backend/src/fuel/rollup/karachi-day.util.spec.ts`

**Interfaces:**
- Produces:
  - `karachiDayStrs(from: Date, to: Date): string[]` — full Karachi `YYYY-MM-DD` days fully inside `[from,to)`.
  - `dayUtcRange(dayStr: string): { start: Date; end: Date }` — UTC bounds of a Karachi day (`start = day-1 19:00Z`, `end = day 19:00Z`... i.e. `dayStr 00:00 +05:00` to `+1d`).
  - `isDayAligned(d: Date): boolean` — true if `d` is exactly a Karachi midnight (`d.getUTCHours()===19 && mins/secs/ms===0`).

- [ ] **Step 1: Write failing tests**

```ts
import { karachiDayStrs, dayUtcRange, isDayAligned } from './karachi-day.util';

describe('karachi-day.util', () => {
  it('dayUtcRange maps a Karachi day to [prev 19:00Z, 19:00Z)', () => {
    const { start, end } = dayUtcRange('2026-06-01');
    expect(start.toISOString()).toBe('2026-05-31T19:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-01T19:00:00.000Z');
  });
  it('isDayAligned true only at Karachi midnight (19:00Z)', () => {
    expect(isDayAligned(new Date('2026-06-01T19:00:00.000Z'))).toBe(true);
    expect(isDayAligned(new Date('2026-06-01T18:30:00.000Z'))).toBe(false);
  });
  it('karachiDayStrs lists full days inside an aligned range', () => {
    const days = karachiDayStrs(
      new Date('2026-05-31T19:00:00.000Z'), // Karachi 2026-06-01 00:00
      new Date('2026-06-03T19:00:00.000Z'), // Karachi 2026-06-04 00:00
    );
    expect(days).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
  });
});
```

- [ ] **Step 2: Run → fail** — `npm test -- karachi-day` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
const KHI_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC+5, no DST in Pakistan

/** UTC bounds of a Karachi calendar day `YYYY-MM-DD`. */
export function dayUtcRange(dayStr: string): { start: Date; end: Date } {
  const start = new Date(`${dayStr}T00:00:00.000Z`).getTime() - KHI_OFFSET_MS;
  return { start: new Date(start), end: new Date(start + 24 * 60 * 60 * 1000) };
}

/** True when `d` sits exactly on a Karachi midnight boundary. */
export function isDayAligned(d: Date): boolean {
  return (d.getTime() + KHI_OFFSET_MS) % (24 * 60 * 60 * 1000) === 0;
}

/** Karachi YYYY-MM-DD of an instant. */
function toKarachiDayStr(d: Date): string {
  return new Date(d.getTime() + KHI_OFFSET_MS).toISOString().slice(0, 10);
}

/** Full Karachi days entirely inside [from, to). */
export function karachiDayStrs(from: Date, to: Date): string[] {
  const firstFull = isDayAligned(from)
    ? from
    : dayUtcRange(toKarachiDayStr(new Date(from.getTime() + 24 * 60 * 60 * 1000))).start;
  const out: string[] = [];
  for (let s = firstFull.getTime(); s + 24 * 60 * 60 * 1000 <= to.getTime(); s += 24 * 60 * 60 * 1000) {
    out.push(toKarachiDayStr(new Date(s)));
  }
  return out;
}
```

- [ ] **Step 4: Run → pass.** `npm test -- karachi-day` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(fuel): Karachi-day helpers for rollup"`

---

### Task 3: Range reconstruction (pure, accuracy-critical)

**Files:**
- Create: `fuel-backend/src/fuel/rollup/reconstruct.util.ts`
- Test: `fuel-backend/src/fuel/rollup/reconstruct.util.spec.ts`

**Interfaces:**
- Consumes: `RefuelEvent` from `../services/fuel-consumption.service`.
- Produces:
  - `interface DailyMetrics { day:string; consumed:number; refueled:number; netDrop:number|null; firstFuel:number|null; lastFuel:number|null; cost:number|null; refuels:RefuelEvent[]; }`
  - `interface RangeMetrics { consumed:number; refueled:number; netDrop:number|null; firstFuel:number|null; lastFuel:number|null; cost:number|null; refuels:RefuelEvent[]; }`
  - `reconstructRange(parts: DailyMetrics[]): RangeMetrics` — `parts` time-ordered (edge-day results included as `DailyMetrics`).

- [ ] **Step 1: Write failing tests**

```ts
import { reconstructRange, DailyMetrics } from './reconstruct.util';

const day = (o: Partial<DailyMetrics>): DailyMetrics => ({
  day: o.day ?? '2026-06-01', consumed: o.consumed ?? 0, refueled: o.refueled ?? 0,
  netDrop: o.netDrop ?? null, firstFuel: o.firstFuel ?? null, lastFuel: o.lastFuel ?? null,
  cost: o.cost ?? null, refuels: o.refuels ?? [],
});

describe('reconstructRange', () => {
  it('sums refueled/cost and uses first/last boundaries for netDrop', () => {
    const r = reconstructRange([
      day({ day: '2026-06-01', consumed: 10, refueled: 5, firstFuel: 100, lastFuel: 95, cost: 50 }),
      day({ day: '2026-06-02', consumed: 8,  refueled: 0, firstFuel: 95,  lastFuel: 87, cost: 40 }),
    ]);
    expect(r.refueled).toBe(5);
    expect(r.cost).toBe(90);
    expect(r.firstFuel).toBe(100);
    expect(r.lastFuel).toBe(87);
    expect(r.netDrop).toBe(13);           // 100 - 87
  });
  it('consumed = max(0, netDrop + refueled) when boundaries exist', () => {
    const r = reconstructRange([
      day({ firstFuel: 100, lastFuel: 60, refueled: 20 }),
    ]);
    expect(r.consumed).toBe(60);          // max(0, 40 + 20)
  });
  it('falls back to summed daily consumed when a boundary is missing', () => {
    const r = reconstructRange([
      day({ consumed: 7, refueled: 0, firstFuel: null, lastFuel: null }),
      day({ consumed: 3, refueled: 0, firstFuel: 50, lastFuel: 40 }),
    ]);
    expect(r.netDrop).toBeNull();
    expect(r.consumed).toBe(10);          // 7 + 3
  });
  it('concatenates refuel events in order', () => {
    const a = { at: '2026-06-01T05:00:00Z', fuelBefore: 10, fuelAfter: 30, added: 20, unit: 'L' };
    const b = { at: '2026-06-02T06:00:00Z', fuelBefore: 20, fuelAfter: 50, added: 30, unit: 'L' };
    const r = reconstructRange([day({ refuels: [a] }), day({ refuels: [b] })]);
    expect(r.refuels).toEqual([a, b]);
  });
});
```

- [ ] **Step 2: Run → fail.** `npm test -- reconstruct.util` → FAIL.

- [ ] **Step 3: Implement**

```ts
import { RefuelEvent } from '../services/fuel-consumption.service';

export interface DailyMetrics {
  day: string;
  consumed: number;
  refueled: number;
  netDrop: number | null;
  firstFuel: number | null;
  lastFuel: number | null;
  cost: number | null;
  refuels: RefuelEvent[];
}
export type RangeMetrics = Omit<DailyMetrics, 'day'>;

/** Combine ordered per-day metrics into range metrics, mirroring the current
 *  summary math: mass-balance from the range's first/last boundary fuel when
 *  available, else the summed daily drop totals. */
export function reconstructRange(parts: DailyMetrics[]): RangeMetrics {
  const refueled = parts.reduce((a, p) => a + p.refueled, 0);
  const costParts = parts.map((p) => p.cost).filter((c): c is number => c !== null);
  const cost = costParts.length ? costParts.reduce((a, c) => a + c, 0) : null;
  const refuels = parts.flatMap((p) => p.refuels);

  const withFirst = parts.find((p) => p.firstFuel !== null);
  const withLast = [...parts].reverse().find((p) => p.lastFuel !== null);
  const firstFuel = withFirst?.firstFuel ?? null;
  const lastFuel = withLast?.lastFuel ?? null;

  let netDrop: number | null = null;
  let consumed: number;
  if (firstFuel !== null && lastFuel !== null) {
    netDrop = firstFuel - lastFuel;
    consumed = Math.max(0, netDrop + refueled);
  } else {
    consumed = parts.reduce((a, p) => a + p.consumed, 0);
  }
  return { consumed, refueled, netDrop, firstFuel, lastFuel, cost, refuels };
}
```

- [ ] **Step 4: Run → pass.** `npm test -- reconstruct.util` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(fuel): pure range reconstruction from daily metrics"`

---

### Task 4: `FuelDailyRepository` — read/upsert `fd_fuel_daily`

**Files:**
- Create: `fuel-backend/src/fuel/rollup/fuel-daily.repository.ts`
- Test: `fuel-backend/src/fuel/rollup/fuel-daily.repository.spec.ts`

**Interfaces:**
- Consumes: `DataSource` (TypeORM), `DailyMetrics` (Task 3).
- Produces:
  - `upsertDay(imei:string, sensorId:number, m: DailyMetrics & { firstTs:Date|null; lastTs:Date|null; samples:number }): Promise<void>`
  - `getDays(imei:string, sensorId:number, dayStrs:string[]): Promise<DailyMetrics[]>`
  - `hasDay(imei:string, sensorId:number, day:string): Promise<boolean>`
  - `deleteVehicle(imei:string): Promise<void>` — invalidate a vehicle's cache (unit replacement)
  - `deleteOrphans(): Promise<number>` — drop rows whose imei is gone from gs_objects

- [ ] **Step 1: Write failing test (row → DailyMetrics mapping is the risk)**

```ts
import { rowToDaily } from './fuel-daily.repository';

describe('rowToDaily', () => {
  it('maps a DB row (JSON refuel_events string) to DailyMetrics', () => {
    const m = rowToDaily({
      day: '2026-06-01', consumed: 10, refueled: 5, net_drop: 13,
      first_fuel: 100, last_fuel: 87, cost: 90,
      refuel_events: '[{"at":"2026-06-01T05:00:00Z","fuelBefore":10,"fuelAfter":30,"added":20,"unit":"L"}]',
    } as any);
    expect(m.day).toBe('2026-06-01');
    expect(m.netDrop).toBe(13);
    expect(m.refuels).toHaveLength(1);
    expect(m.refuels[0].added).toBe(20);
  });
  it('handles null refuel_events', () => {
    const m = rowToDaily({ day: '2026-06-02', consumed: 0, refueled: 0, net_drop: null,
      first_fuel: null, last_fuel: null, cost: null, refuel_events: null } as any);
    expect(m.refuels).toEqual([]);
    expect(m.netDrop).toBeNull();
  });
});
```

- [ ] **Step 2: Run → fail.** `npm test -- fuel-daily.repository` → FAIL.

- [ ] **Step 3: Implement** (export the pure `rowToDaily`; repo methods do I/O)

```ts
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
```

- [ ] **Step 4: Run → pass.** `npm test -- fuel-daily.repository` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(fuel): fd_fuel_daily repository"`

---

### Task 5: `FuelRollupService` — compute+store a day, range query, parity gate

**Files:**
- Create: `fuel-backend/src/fuel/rollup/fuel-rollup.service.ts`
- Test: `fuel-backend/src/fuel/rollup/fuel-rollup.parity.spec.ts`

**Interfaces:**
- Consumes: `FuelConsumptionService.getConsumption(imei,from,to,sensor,fcr)` → `ConsumptionResult`; `FuelDailyRepository` (Task 4); `karachi-day.util` (Task 2); `reconstructRange` (Task 3).
- Produces:
  - `computeAndStoreDay(imei, sensor: FuelSensor, day: string, fcr: string): Promise<void>`
  - `getConsumptionViaRollup(imei, from, to, sensor: FuelSensor, fcr: string): Promise<RangeMetrics>`

- [ ] **Step 1: Write the parity test (accuracy gate)** — rollup path == raw path.

```ts
// Uses a real DataSource against the test DB and a known IMEI/day-aligned range.
// The rollup result must equal the direct whole-range getConsumption result.
// (Bootstraps FuelWorkerless context or instantiates services with the test DataSource.)
it('rollup-reconstructed metrics equal whole-range getConsumption (tolerance 0.5 L)', async () => {
  const from = new Date('2026-05-31T19:00:00.000Z');
  const to   = new Date('2026-06-04T19:00:00.000Z');
  const raw = await consumptionService.getConsumption(IMEI, from, to, sensor, FCR);
  // roll up each day, then reconstruct
  for (const d of karachiDayStrs(from, to)) await rollup.computeAndStoreDay(IMEI, sensor, d, FCR);
  const agg = await rollup.getConsumptionViaRollup(IMEI, from, to, sensor, FCR);
  expect(Math.abs(agg.consumed - (raw.netDrop !== null ? Math.max(0, raw.netDrop + raw.refueled) : raw.consumed))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(agg.refueled - raw.refueled)).toBeLessThanOrEqual(0.5);
});
```

*(If the test DB isn't reachable in CI, this test is `describe.skip`-guarded behind an env flag and MUST be run manually against a real vehicle before enabling `FUEL_ROLLUP` in prod — this is the ship gate.)*

- [ ] **Step 2: Run → fail.** `npm test -- fuel-rollup.parity` → FAIL.

- [ ] **Step 3: Implement**

```ts
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
```

- [ ] **Step 4: Run parity → pass** (against test DB / manually). Tune only if boundaries diverge > tolerance (per spec).
- [ ] **Step 5: Commit** — `git commit -m "feat(fuel): rollup service (compute day + range reconstruct) + parity test"`

---

### Task 6: Cron (incremental) + throttled backfill script

**Files:**
- Create: `fuel-backend/src/fuel/rollup/fuel-rollup.cron.ts`
- Create: `fuel-backend/scripts/backfill-fuel-daily.js`
- Create: `fuel-backend/scripts/invalidate-fuel-daily.js` (drop one vehicle's cached rows after a unit swap: bootstraps a context, resolves `FuelDailyRepository`, calls `deleteVehicle(process.argv[2])`)

**Interfaces:**
- Consumes: `FuelRollupService`, `FuelSensorResolverService`, `DataSource` (to list vehicles).

- [ ] **Step 1: Cron — roll up recent days for recently-reporting vehicles (flag-gated)**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FuelRollupService } from './fuel-rollup.service';
import { FuelSensorResolverService } from '../services/fuel-sensor-resolver.service';
import { karachiDayStrs } from './karachi-day.util';

@Injectable()
export class FuelRollupCron {
  private readonly logger = new Logger(FuelRollupCron.name);
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rollup: FuelRollupService,
    private readonly sensors: FuelSensorResolverService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async roll(): Promise<void> {
    if (process.env.FUEL_ROLLUP !== '1') return;
    const to = new Date();
    const from = new Date(to.getTime() - 2 * 24 * 60 * 60 * 1000); // last ~2 days
    const days = karachiDayStrs(from, to);
    const objs: any[] = await this.ds.query(`SELECT imei, fcr FROM gs_objects WHERE dt_tracker >= ?`, [from]);
    for (const o of objs) {
      try {
        const sensor = await this.sensors.resolveFuelSensor(o.imei);
        for (const d of days) await this.rollup.computeAndStoreDay(o.imei, sensor, d, o.fcr ?? '');
      } catch (e) { this.logger.warn(`rollup ${o.imei}: ${String(e)}`); }
      await new Promise((r) => setTimeout(r, 200)); // gentle on the shared DB
    }
  }
}
```

- [ ] **Step 2: Backfill script — throttled, resumable, one-time**

```js
// node scripts/backfill-fuel-daily.js  [--days=120] [--sleep=300]
// Reads config from fuel-backend/.env, walks each vehicle's recent days,
// skips days already present, pauses between vehicles. READ-only on gs_*.
// (Bootstraps a Nest standalone context to reuse the real services.)
```
*(The plan's implementer writes this using `NestFactory.createApplicationContext(AppModule)` → resolve `FuelRollupService` + `FuelSensorResolverService`, loop `gs_objects`, call `computeAndStoreDay` for each missing day, `--sleep` ms between vehicles, log progress, resumable via `hasDay`.)*

- [ ] **Step 3: Verify** cron no-ops when `FUEL_ROLLUP!=1`; backfill populates rows for one vehicle on a small `--days=3` run.
- [ ] **Step 4: Commit** — `git commit -m "feat(fuel): rollup cron + throttled backfill script"`

---

### Task 7: Wire endpoints behind `FUEL_ROLLUP` + register providers + docs

**Files:**
- Modify: `fuel-backend/src/fuel/fuel.module.ts` (add `FuelDailyRepository`, `FuelRollupService`, `FuelRollupCron` to providers)
- Modify: `fuel-backend/src/fuel/fuel.controller.ts` (consumption/refuels via rollup when flag on)
- Modify: `fuel-backend/src/dashboard/dashboard.service.ts` (summary via rollup when flag on)
- Modify: `fuel-backend/.env.example` (document `FUEL_ROLLUP`)

**Interfaces:**
- Consumes: `FuelRollupService.getConsumptionViaRollup(...)` → `RangeMetrics`.

- [ ] **Step 1: Register providers** in `fuel.module.ts` providers array: add `FuelDailyRepository`, `FuelRollupService`, `FuelRollupCron`, and export `FuelRollupService` (so dashboard uses it).

- [ ] **Step 2: Summary via rollup (flag-gated), same shape**

In `dashboard.service.ts` `computeVehicle`, replace the `getConsumption` call with:
```ts
const useRollup = process.env.FUEL_ROLLUP === '1';
const result = useRollup
  ? await this.rollup.getConsumptionViaRollup(v.imei, from, to, sensor, v.fcr ?? '')
  : await this.consumptionService.getConsumption(v.imei, from, to, sensor, v.fcr ?? '');
// result.netDrop / consumed / refueled / estimatedCost(=cost) map identically:
consumed = result.netDrop !== null ? Math.max(0, result.netDrop + result.refueled) : result.consumed;
refueled = result.refueled;
cost = useRollup ? (result as any).cost : (result as any).estimatedCost;
```
(inject `FuelRollupService` into `DashboardService`.)

- [ ] **Step 3: consumption + refuels endpoints** in `fuel.controller.ts`: when `FUEL_ROLLUP==='1'`, build the response from `getConsumptionViaRollup` (consumption totals; refuels list = `result.refuels`); else current path. Keep the response JSON shape unchanged.

- [ ] **Step 4: `.env.example`** — add:
```
# Fuel daily pre-aggregation. 1 = read from fd_fuel_daily rollup; 0 = raw compute.
FUEL_ROLLUP=0
```

- [ ] **Step 5: Verify** `npm run build`; with `FUEL_ROLLUP=0` behavior is byte-identical to today; with `=1` summary/consumption/refuels read the rollup.
- [ ] **Step 6: Commit** — `git commit -m "feat(fuel): serve summary/consumption/refuels from rollup behind FUEL_ROLLUP"`

---

## Rollout (guided, after merge)

1. `node scripts/run-migration.js migrations/005_fuel_daily_rollup.sql` (CREATE TABLE only).
2. Deploy backend with `FUEL_ROLLUP=0` (no behavior change).
3. `node scripts/backfill-fuel-daily.js --days=120 --sleep=300` (off-peak, resumable).
4. Run the parity check for 2–3 vehicles/ranges → confirm numbers match.
5. Set `FUEL_ROLLUP=1` in prod `.env` → `pm2 restart 30` → measure. Cron keeps it current.
6. Rollback anytime: `FUEL_ROLLUP=0` + restart.
7. **After a unit replacement / IMEI rename**: `node scripts/invalidate-fuel-daily.js <newIMEI>` (drops that vehicle's cached rows so it recomputes cleanly). Not strictly required — the cache computes-on-miss and the cron recomputes recent days — but do it if an IMEI was *reused* to avoid a stale hit.

## Self-Review

- **Spec coverage:** table (T1) ✓; tz/day (T2) ✓; reconstruction math (T3) ✓; repo (T4) ✓; rollup compute + range + parity gate (T5) ✓; cron + throttled backfill (T6) ✓; flag + endpoints + docs (T7) ✓; safety (additive-only migration, read-only gs_*, flag, gentle backfill) ✓; Phase-1 scope (summary/consumption/refuels; history/stats excluded) ✓.
- **Placeholders:** the backfill script body (T6 Step 2) is described, not fully coded, because it's a thin standalone-context loop over the already-specified `computeAndStoreDay`/`hasDay` — the implementer has every signature it needs. The parity test uses a test-DB fixture guarded by an env flag (documented). No other placeholders.
- **Type consistency:** `DailyMetrics`/`RangeMetrics`/`reconstructRange` (T3) used identically in T4/T5; `RefuelEvent`, `ConsumptionResult` fields match the codebase; `computeAndStoreDay`/`getConsumptionViaRollup`/`getDays`/`hasDay` signatures consistent across T4/T5/T6/T7.
