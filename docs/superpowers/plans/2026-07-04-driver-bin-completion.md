# Driver Bin Completion + Portal Deviation Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drivers mark each bin complete with a required photo; the server verifies their GPS against the bin location (out-of-range accepted but flagged); the job auto-completes on the last bin; managers get portal-wide toast popups when a driver deviates from the route.

**Architecture:** Backend adds one table (`fd_stop_completions`), a pure range-check util, a repository, an orchestration service, and two endpoints (driver `POST /me/jobs/:id/stops/:stopId/complete`, manager `GET /assignments/alerts`). Frontend adds per-bin Complete UI in the driver job page, completion badges in the manager LiveMonitor, and a global `AlertWatcher` that polls alerts and toasts.

**Tech Stack:** NestJS 10 + TypeORM raw SQL (MySQL), Jest; Next.js dashboard (React, no test runner — verify with `npm run build`), existing toast component.

**Spec:** `docs/superpowers/specs/2026-07-04-driver-bin-completion-design.md`

## Global Constraints

- Work on a feature branch `feature/driver-bin-completion` (not `feature/fuel-preagg-rollup`). Do NOT commit anything under `fuel-backend/dist/` — it is stale build output.
- Migrations: `fd_` prefix, no hard FKs to `gs_*` tables, re-runnable (`IF NOT EXISTS`), file `fuel-backend/migrations/006_stop_completions.sql`.
- Error strings shown verbatim in the driver app (copy exactly): `"A photo is required to complete a bin"`, `"Location is required — enable GPS and try again"`, `"Bin already completed"`, `"Job is not active"`.
- In-range rule: `distance_m <= radius_m + min(accuracyM ?? 0, 50)`. Distance rounded to whole metres.
- Active job statuses for bin completion: `accepted`, `en_route`, `arrived`.
- Backend tests: `cd fuel-backend && npx jest <file> --verbose` (jest is configured in package.json, rootDir `src`).
- Dashboard verification: `cd fuel-dashboard && npm run build` (there is no test runner).
- All backend paths below are relative to `fuel-backend/`, dashboard paths to `fuel-dashboard/`.

---

### Task 1: Migration + in-range rule util

**Files:**
- Create: `fuel-backend/migrations/006_stop_completions.sql`
- Create: `fuel-backend/src/dispatch/services/completion.util.ts`
- Test: `fuel-backend/src/dispatch/services/completion.util.spec.ts`

**Interfaces:**
- Consumes: `LatLng`, `haversineMeters` from `./geo.util` (existing).
- Produces: `checkCompletionRange(driver: LatLng, stop: LatLng, radiusM: number, accuracyM?: number | null): { distanceM: number; inRange: boolean }` and constant `ACCURACY_ALLOWANCE_CAP_M = 50`. Task 3 calls this.

- [ ] **Step 1: Write the migration**

```sql
-- Driver-confirmed bin completions (photo + location-verified), one per
-- assignment+stop. Same conventions as 001: fd_ prefix, no hard FKs to gs_*,
-- safe to re-run (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS fd_stop_completions (
  id            INT           NOT NULL AUTO_INCREMENT,
  assignment_id INT           NOT NULL,   -- fd_assignments.assignment_id
  stop_id       INT           NOT NULL,   -- fd_route_stops.stop_id
  driver_id     INT           NOT NULL,   -- gs_user_object_drivers.driver_id
  lat           DECIMAL(10,7) NOT NULL,   -- driver GPS at tap time
  lng           DECIMAL(10,7) NOT NULL,
  accuracy_m    FLOAT             NULL,   -- device-reported GPS accuracy
  distance_m    INT           NOT NULL,   -- computed driver→bin distance
  in_range      TINYINT(1)    NOT NULL,   -- 1 = within radius_m + accuracy allowance
  photo_path    VARCHAR(512)  NOT NULL,   -- required proof photo (under UPLOADS_DIR)
  note          VARCHAR(1024)     NULL,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fd_completion (assignment_id, stop_id),
  KEY idx_fd_completion_assignment (assignment_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- [ ] **Step 2: Write the failing test**

At the equator, 0.001° of longitude ≈ 111.3 m — the tests exploit that for predictable distances.

```typescript
// src/dispatch/services/completion.util.spec.ts
import { checkCompletionRange, ACCURACY_ALLOWANCE_CAP_M } from './completion.util';

const STOP = { lat: 0, lng: 0 };

describe('checkCompletionRange', () => {
  it('is in range well inside the radius', () => {
    // ~55.7m from the stop, radius 100
    const r = checkCompletionRange({ lat: 0, lng: 0.0005 }, STOP, 100);
    expect(r.inRange).toBe(true);
    expect(r.distanceM).toBeGreaterThan(50);
    expect(r.distanceM).toBeLessThan(60);
  });

  it('is in range exactly at the radius edge (<=)', () => {
    // ~100.2m raw → rounds to 100, radius 100 → still in
    const r = checkCompletionRange({ lat: 0, lng: 0.0009 }, STOP, 100);
    expect(r.distanceM).toBe(100);
    expect(r.inRange).toBe(true);
  });

  it('is out of range beyond radius + allowance', () => {
    // ~222.6m, radius 100, no accuracy
    const r = checkCompletionRange({ lat: 0, lng: 0.002 }, STOP, 100);
    expect(r.distanceM).toBeGreaterThan(200);
    expect(r.inRange).toBe(false);
  });

  it('GPS accuracy extends the radius', () => {
    // ~130m, radius 100, accuracy 40 → 100+40=140 ≥ 130 → in
    const r = checkCompletionRange({ lat: 0, lng: 0.00117 }, STOP, 100, 40);
    expect(r.inRange).toBe(true);
  });

  it('accuracy allowance is capped at 50m', () => {
    // ~160m, radius 100, accuracy 500 → capped to 100+50=150 < 160 → out
    const r = checkCompletionRange({ lat: 0, lng: 0.00144 }, STOP, 100, 500);
    expect(r.inRange).toBe(false);
    expect(ACCURACY_ALLOWANCE_CAP_M).toBe(50);
  });

  it('treats null accuracy as zero allowance', () => {
    const r = checkCompletionRange({ lat: 0, lng: 0.00117 }, STOP, 100, null);
    expect(r.inRange).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd fuel-backend && npx jest src/dispatch/services/completion.util.spec.ts --verbose`
Expected: FAIL — `Cannot find module './completion.util'`

- [ ] **Step 4: Write the implementation**

```typescript
// src/dispatch/services/completion.util.ts
import { LatLng, haversineMeters } from './geo.util';

/** Cap on how much a poor GPS fix may extend the bin radius. */
export const ACCURACY_ALLOWANCE_CAP_M = 50;

export interface CompletionCheck {
  /** Driver → bin distance, whole metres. */
  distanceM: number;
  /** True when within radius_m + min(accuracy, cap). */
  inRange: boolean;
}

/**
 * The bin-completion verification rule: the driver counts as "at the bin"
 * when their distance is within the stop's geofence radius, extended by the
 * device-reported GPS accuracy (capped so a wildly-inaccurate fix can't pass).
 */
export function checkCompletionRange(
  driver: LatLng,
  stop: LatLng,
  radiusM: number,
  accuracyM?: number | null,
): CompletionCheck {
  const distanceM = Math.round(haversineMeters(driver, stop));
  const allowance = Math.min(accuracyM ?? 0, ACCURACY_ALLOWANCE_CAP_M);
  return { distanceM, inRange: distanceM <= radiusM + allowance };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd fuel-backend && npx jest src/dispatch/services/completion.util.spec.ts --verbose`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add fuel-backend/migrations/006_stop_completions.sql fuel-backend/src/dispatch/services/completion.util.ts fuel-backend/src/dispatch/services/completion.util.spec.ts
git commit -m "feat(dispatch): stop-completion schema + location verification rule"
```

---

### Task 2: StopCompletionRepository

**Files:**
- Create: `fuel-backend/src/dispatch/services/stop-completion.repository.ts`

**Interfaces:**
- Consumes: TypeORM `DataSource` (same `@InjectDataSource()` pattern as `assignment.repository.ts`).
- Produces (Tasks 3–4 depend on these exact signatures):
  - `interface StopCompletion { id: number; assignmentId: number; stopId: number; driverId: number; lat: number; lng: number; accuracyM: number | null; distanceM: number; inRange: boolean; photoPath: string; note: string | null; createdAt: Date }`
  - `add(c: Omit<StopCompletion, 'id' | 'createdAt'>): Promise<number>` — returns insert id
  - `listForAssignment(assignmentId: number): Promise<StopCompletion[]>`
  - `getForStop(assignmentId: number, stopId: number): Promise<StopCompletion | null>`

No unit test — thin SQL, consistent with every other repository in this module (the service in Task 3 is tested against a fake of this interface).

- [ ] **Step 1: Write the repository**

```typescript
// src/dispatch/services/stop-completion.repository.ts
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
```

- [ ] **Step 2: Verify it compiles**

Run: `cd fuel-backend && npx tsc --noEmit -p tsconfig.json`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add fuel-backend/src/dispatch/services/stop-completion.repository.ts
git commit -m "feat(dispatch): stop-completion repository"
```

---

### Task 3: StopCompletionService (orchestration, TDD)

**Files:**
- Create: `fuel-backend/src/dispatch/services/stop-completion.service.ts`
- Test: `fuel-backend/src/dispatch/services/stop-completion.service.spec.ts`

**Interfaces:**
- Consumes: `AssignmentRepository.getForDriver / addEvent / setStatus` (existing signatures — see `assignment.repository.ts`), `RouteRepository.get(userId, routeId)` returning `{ stops: RouteStop[] }` where `RouteStop = { stopId?: number; seq; name; lat; lng; type; radiusM }`, `StopCompletionRepository` (Task 2), `checkCompletionRange` (Task 1).
- Produces (Task 4 depends on this exact signature):
  - `complete(driverId: number, assignmentId: number, stopId: number, input: { lat: number; lng: number; accuracyM?: number | null; note?: string | null; photoPath: string }): Promise<{ completion: StopCompletion; jobCompleted: boolean; stopCompletions: StopCompletion[] }>`

- [ ] **Step 1: Write the failing tests**

The service is constructed directly with fakes (same style as `deviation.service.spec.ts` — no Nest testing module).

```typescript
// src/dispatch/services/stop-completion.service.spec.ts
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { StopCompletionService } from './stop-completion.service';
import { StopCompletion } from './stop-completion.repository';

// --- fakes -----------------------------------------------------------------
function makeFakes(opts: {
  status?: string;
  stops?: Array<{ stopId: number; seq: number; name: string; lat: number; lng: number; radiusM: number }>;
  existing?: StopCompletion[];
}) {
  const stops = opts.stops ?? [
    { stopId: 11, seq: 1, name: 'Bin 1', lat: 0, lng: 0, radiusM: 100 },
    { stopId: 12, seq: 2, name: 'Bin 2', lat: 0, lng: 0.01, radiusM: 100 },
  ];
  const store: StopCompletion[] = [...(opts.existing ?? [])];
  const events: any[] = [];
  const statusCalls: any[] = [];

  const assignments = {
    getForDriver: jest.fn(async () => ({
      assignmentId: 5,
      userId: 1,
      routeId: 7,
      driverId: 3,
      status: opts.status ?? 'en_route',
    })),
    addEvent: jest.fn(async (_id: number, e: any) => { events.push(e); }),
    setStatus: jest.fn(async (...args: any[]) => { statusCalls.push(args); }),
  };
  const routes = { get: jest.fn(async () => ({ stops })) };
  let nextId = 100;
  const completions = {
    getForStop: jest.fn(async (_a: number, stopId: number) =>
      store.find((c) => c.stopId === stopId) ?? null),
    add: jest.fn(async (c: any) => {
      store.push({ ...c, id: ++nextId, createdAt: new Date() });
      return nextId;
    }),
    listForAssignment: jest.fn(async () => [...store]),
  };
  const svc = new StopCompletionService(assignments as any, routes as any, completions as any);
  return { svc, assignments, routes, completions, events, statusCalls, store };
}

const AT_BIN_1 = { lat: 0, lng: 0.0001, photoPath: 'completions/x.jpg' }; // ~11m away

describe('StopCompletionService.complete', () => {
  it('records an in-range completion and logs a stop_completed event', async () => {
    const f = makeFakes({});
    const r = await f.svc.complete(3, 5, 11, AT_BIN_1);
    expect(r.completion.inRange).toBe(true);
    expect(r.completion.stopId).toBe(11);
    expect(r.jobCompleted).toBe(false);
    expect(f.events).toHaveLength(1);
    expect(f.events[0].type).toBe('stop_completed');
    expect(f.events[0].actor).toBe('driver');
    expect(f.events[0].note).not.toContain('out of range');
    expect(f.statusCalls).toHaveLength(0); // one bin left
  });

  it('accepts but flags an out-of-range completion', async () => {
    const f = makeFakes({});
    // ~1113m from Bin 1
    const r = await f.svc.complete(3, 5, 11, { lat: 0, lng: 0.01, photoPath: 'completions/x.jpg' });
    expect(r.completion.inRange).toBe(false);
    expect(f.events[0].note).toContain('out of range');
    expect(f.events[0].distanceM).toBeGreaterThan(1000);
  });

  it('rejects when the job is not active', async () => {
    const f = makeFakes({ status: 'assigned' });
    await expect(f.svc.complete(3, 5, 11, AT_BIN_1)).rejects.toThrow(BadRequestException);
  });

  it('rejects a stop that is not on the route', async () => {
    const f = makeFakes({});
    await expect(f.svc.complete(3, 5, 999, AT_BIN_1)).rejects.toThrow(NotFoundException);
  });

  it('rejects a duplicate completion with 409', async () => {
    const f = makeFakes({
      existing: [{
        id: 1, assignmentId: 5, stopId: 11, driverId: 3, lat: 0, lng: 0,
        accuracyM: null, distanceM: 5, inRange: true, photoPath: 'p', note: null,
        createdAt: new Date(),
      }],
    });
    await expect(f.svc.complete(3, 5, 11, AT_BIN_1)).rejects.toThrow(ConflictException);
  });

  it('auto-completes the job when the last bin lands', async () => {
    const f = makeFakes({
      existing: [{
        id: 1, assignmentId: 5, stopId: 11, driverId: 3, lat: 0, lng: 0,
        accuracyM: null, distanceM: 5, inRange: true, photoPath: 'p', note: null,
        createdAt: new Date(),
      }],
    });
    const r = await f.svc.complete(3, 5, 12, { lat: 0, lng: 0.0101, photoPath: 'completions/y.jpg' });
    expect(r.jobCompleted).toBe(true);
    expect(f.statusCalls).toHaveLength(1);
    expect(f.statusCalls[0]).toEqual([5, 'en_route', 'completed', 'system']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd fuel-backend && npx jest src/dispatch/services/stop-completion.service.spec.ts --verbose`
Expected: FAIL — `Cannot find module './stop-completion.service'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/dispatch/services/stop-completion.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AssignmentRepository } from './assignment.repository';
import { RouteRepository } from './route.repository';
import {
  StopCompletion,
  StopCompletionRepository,
} from './stop-completion.repository';
import { checkCompletionRange } from './completion.util';

const ACTIVE_STATUSES = ['accepted', 'en_route', 'arrived'];

export interface CompleteStopResult {
  completion: StopCompletion;
  /** True when this was the last bin and the job flipped to completed. */
  jobCompleted: boolean;
  stopCompletions: StopCompletion[];
}

/**
 * Driver-confirmed bin completion: verifies the driver's GPS against the
 * bin's geofence (out-of-range is accepted but flagged), records the
 * completion + audit event, and auto-completes the job on the last bin.
 */
@Injectable()
export class StopCompletionService {
  constructor(
    private readonly assignments: AssignmentRepository,
    private readonly routes: RouteRepository,
    private readonly completions: StopCompletionRepository,
  ) {}

  async complete(
    driverId: number,
    assignmentId: number,
    stopId: number,
    input: {
      lat: number;
      lng: number;
      accuracyM?: number | null;
      note?: string | null;
      photoPath: string;
    },
  ): Promise<CompleteStopResult> {
    const assignment = await this.assignments.getForDriver(driverId, assignmentId);
    if (!ACTIVE_STATUSES.includes(assignment.status)) {
      throw new BadRequestException('Job is not active');
    }

    const route = await this.routes.get(assignment.userId, assignment.routeId);
    const stop = route.stops.find((s) => s.stopId === stopId);
    if (!stop) throw new NotFoundException('Stop not found on this route');

    const existing = await this.completions.getForStop(assignmentId, stopId);
    if (existing) {
      throw new ConflictException({
        message: 'Bin already completed',
        completion: existing,
      });
    }

    const check = checkCompletionRange(
      { lat: input.lat, lng: input.lng },
      { lat: stop.lat, lng: stop.lng },
      stop.radiusM,
      input.accuracyM,
    );

    await this.completions.add({
      assignmentId,
      stopId,
      driverId,
      lat: input.lat,
      lng: input.lng,
      accuracyM: input.accuracyM ?? null,
      distanceM: check.distanceM,
      inRange: check.inRange,
      photoPath: input.photoPath,
      note: input.note ?? null,
    });

    const label = stop.name || `stop ${stop.seq}`;
    await this.assignments.addEvent(assignmentId, {
      type: 'stop_completed',
      stopId,
      lat: input.lat,
      lng: input.lng,
      distanceM: check.distanceM,
      actor: 'driver',
      note: check.inRange
        ? `Completed ${label}`
        : `Completed ${label} (out of range, ${check.distanceM}m)`,
    });

    const all = await this.completions.listForAssignment(assignmentId);
    const done = new Set(all.map((c) => c.stopId));
    const jobCompleted = route.stops.every(
      (s) => s.stopId != null && done.has(s.stopId),
    );
    if (jobCompleted) {
      await this.assignments.setStatus(
        assignmentId,
        assignment.status,
        'completed',
        'system',
      );
    }

    return {
      completion: all.find((c) => c.stopId === stopId)!,
      jobCompleted,
      stopCompletions: all,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd fuel-backend && npx jest src/dispatch/services/stop-completion.service.spec.ts --verbose`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add fuel-backend/src/dispatch/services/stop-completion.service.ts fuel-backend/src/dispatch/services/stop-completion.service.spec.ts
git commit -m "feat(dispatch): stop-completion service with range check and job auto-complete"
```

---

### Task 4: Driver endpoint + wiring (module, job detail, manager live)

**Files:**
- Modify: `fuel-backend/src/dispatch/driver-portal.controller.ts`
- Modify: `fuel-backend/src/dispatch/assignments.controller.ts` (the `:id/live` endpoint, ~line 125)
- Modify: `fuel-backend/src/dispatch/dispatch.module.ts`

**Interfaces:**
- Consumes: `StopCompletionService.complete(...)` (Task 3), `StopCompletionRepository.listForAssignment(...)` (Task 2).
- Produces (frontend Tasks 6–9 depend on these):
  - `POST /me/jobs/:id/stops/:stopId/complete` — multipart: `photo` file (required), `lat`, `lng` (required), `accuracyM`, `note` (optional). Response `data`: `{ completion, jobCompleted, stopCompletions }`.
  - `GET /me/jobs/:id` response `data` gains `stopCompletions: StopCompletion[]`.
  - `GET /assignments/:id/live` response `data` gains `stopCompletions: StopCompletion[]`.

- [ ] **Step 1: Register providers in the module**

In `dispatch.module.ts`, add imports:

```typescript
import { StopCompletionRepository } from './services/stop-completion.repository';
import { StopCompletionService } from './services/stop-completion.service';
```

and append `StopCompletionRepository, StopCompletionService,` to the `providers` array (after `MonitoringService`).

- [ ] **Step 2: Add the endpoint to the driver portal controller**

In `driver-portal.controller.ts`:

Add `BadRequestException` to the existing `@nestjs/common` import list. Add to the other imports:

```typescript
import { StopCompletionRepository } from './services/stop-completion.repository';
import { StopCompletionService } from './services/stop-completion.service';
```

Extend the constructor:

```typescript
  constructor(
    private readonly assignments: AssignmentRepository,
    private readonly routes: RouteRepository,
    private readonly driverApp: DriverAppRepository,
    private readonly stopCompletions: StopCompletionService,
    private readonly stopCompletionRepo: StopCompletionRepository,
  ) {}
```

In `jobDetail()`, add completions to the response — replace the `return` with:

```typescript
    const stopCompletions = await this.stopCompletionRepo.listForAssignment(
      assignment.assignmentId,
    );
    return {
      success: true,
      message: 'Job fetched',
      data: {
        assignment,
        route: {
          routeId: route.routeId,
          name: route.name,
          geometry: route.geometry,
          stops: route.stops,
          totalDistanceKm: route.totalDistanceKm,
          totalDurationS: route.totalDurationS,
        },
        stopCompletions,
      },
    };
```

Add the new endpoint after the `proof()` method (reuses the same upload pattern):

```typescript
  /**
   * Driver marks a bin complete: requires a photo and a GPS fix; the fix is
   * verified against the bin's geofence (out-of-range accepted but flagged).
   * Completing the last bin auto-completes the job.
   */
  @Post('jobs/:id/stops/:stopId/complete')
  @UseInterceptors(FileInterceptor('photo'))
  async completeStop(
    @Request() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('stopId', ParseIntPipe) stopId: number,
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
    @Body() body: Record<string, string>,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('A photo is required to complete a bin');
    }
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new BadRequestException('Location is required — enable GPS and try again');
    }

    const dir = join(UPLOADS_DIR, 'completions');
    await fs.mkdir(dir, { recursive: true });
    const ext =
      (file.originalname.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
    const name = `bin_${id}_${stopId}_${Date.now()}.${ext}`;
    await fs.writeFile(join(dir, name), file.buffer);

    const accuracyM =
      body.accuracyM != null && body.accuracyM !== '' ? Number(body.accuracyM) : null;
    const data = await this.stopCompletions.complete(req.user.driverId, id, stopId, {
      lat,
      lng,
      accuracyM: Number.isFinite(accuracyM as number) ? accuracyM : null,
      note: body.note || null,
      photoPath: `completions/${name}`,
    });
    return {
      success: true,
      message: data.jobCompleted ? 'Bin completed — job finished' : 'Bin completed',
      data,
    };
  }
```

- [ ] **Step 3: Add completions to the manager live payload**

In `assignments.controller.ts`, import and inject the repository:

```typescript
import { StopCompletionRepository } from './services/stop-completion.repository';
```

Constructor gains `private readonly stopCompletions: StopCompletionRepository,` after `push`.

In the `live()` method, add before `return`:

```typescript
    const stopCompletions = await this.stopCompletions.listForAssignment(id);
```

and add `stopCompletions,` to the returned `data` object (next to `events`).

- [ ] **Step 4: Verify compile + full backend test suite**

Run: `cd fuel-backend && npx tsc --noEmit -p tsconfig.json && npx jest --verbose`
Expected: compile clean, all suites PASS (existing + new)

- [ ] **Step 5: Commit**

```bash
git add fuel-backend/src/dispatch/driver-portal.controller.ts fuel-backend/src/dispatch/assignments.controller.ts fuel-backend/src/dispatch/dispatch.module.ts
git commit -m "feat(dispatch): driver bin-completion endpoint, completions in job/live payloads"
```

---

### Task 5: Deviation alerts endpoint

**Files:**
- Modify: `fuel-backend/src/dispatch/services/assignment.repository.ts` (add two methods before the private `map`)
- Modify: `fuel-backend/src/dispatch/assignments.controller.ts` (new `@Get('alerts')` — MUST be declared before `@Get(':id')`, next to `@Get('monitor')`)
- Test: `fuel-backend/src/dispatch/assignments.controller.alerts.spec.ts` (create)

**Interfaces:**
- Produces (Task 6/8 depend on these):
  - `GET /assignments/alerts` → `data: { cursor: number, alerts: [] }` (bootstrap — no `sinceEventId` param)
  - `GET /assignments/alerts?sinceEventId=N` → `data: { cursor: number, alerts: Array<{ eventId: number; assignmentId: number; driverName: string | null; routeName: string | null; distanceM: number | null; at: Date }> }`
  - Repository: `listDeviationAlertsSince(userId: number, sinceEventId: number, limit?: number)`, `maxEventId(userId: number): Promise<number>`

- [ ] **Step 1: Write the failing controller test**

The controller is constructed directly with a fake repository (only the deps the alerts route touches matter; the rest are `null as any`).

```typescript
// src/dispatch/assignments.controller.alerts.spec.ts
import { AssignmentsController } from './assignments.controller';

function makeController(fake: Partial<Record<string, any>>) {
  return new AssignmentsController(
    fake as any,      // assignments repository
    null as any,      // routes
    null as any,      // monitoring
    null as any,      // driverApp
    null as any,      // push
    null as any,      // stopCompletions
  );
}

const REQ = { user: { id: 42 } };

describe('GET /assignments/alerts', () => {
  it('bootstraps with the max event id and no alerts when sinceEventId is absent', async () => {
    const ctl = makeController({ maxEventId: jest.fn(async () => 900) });
    const res = await ctl.alerts(REQ, undefined);
    expect(res.data).toEqual({ cursor: 900, alerts: [] });
  });

  it('returns alerts newer than the cursor and advances it', async () => {
    const alerts = [
      { eventId: 901, assignmentId: 5, driverName: 'Ahmed', routeName: 'North', distanceM: 480, at: new Date() },
      { eventId: 905, assignmentId: 6, driverName: 'Bilal', routeName: 'South', distanceM: 220, at: new Date() },
    ];
    const list = jest.fn(async () => alerts);
    const ctl = makeController({ listDeviationAlertsSince: list });
    const res = await ctl.alerts(REQ, '900');
    expect(list).toHaveBeenCalledWith(42, 900);
    expect(res.data.cursor).toBe(905);
    expect(res.data.alerts).toHaveLength(2);
  });

  it('keeps the cursor when there are no new alerts', async () => {
    const ctl = makeController({ listDeviationAlertsSince: jest.fn(async () => []) });
    const res = await ctl.alerts(REQ, '900');
    expect(res.data).toEqual({ cursor: 900, alerts: [] });
  });
});
```

Note: after Task 4 the controller has 6 constructor params — if this test is written before Task 4 is merged, adjust the fake list to match the current constructor.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd fuel-backend && npx jest src/dispatch/assignments.controller.alerts.spec.ts --verbose`
Expected: FAIL — `ctl.alerts is not a function`

- [ ] **Step 3: Add the repository methods**

In `assignment.repository.ts`, add after `lastDeviationAt()`:

```typescript
  /** One row per deviation event newer than the cursor, across this manager's assignments. */
  async listDeviationAlertsSince(
    userId: number,
    sinceEventId: number,
    limit = 20,
  ): Promise<
    Array<{
      eventId: number;
      assignmentId: number;
      driverName: string | null;
      routeName: string | null;
      distanceM: number | null;
      at: Date;
    }>
  > {
    const rows = await this.ds.query(
      `SELECT e.event_id, e.assignment_id, e.distance_m, e.created_at,
              d.driver_name, r.name AS route_name
       FROM fd_route_events e
       JOIN fd_assignments a ON a.assignment_id = e.assignment_id
       LEFT JOIN gs_user_object_drivers d ON d.driver_id = a.driver_id
       LEFT JOIN fd_routes r ON r.route_id = a.route_id
       WHERE a.user_id = ? AND e.type = 'deviation' AND e.event_id > ?
       ORDER BY e.event_id ASC
       LIMIT ?`,
      [userId, sinceEventId, limit],
    );
    return rows.map((r: any) => ({
      eventId: r.event_id,
      assignmentId: r.assignment_id,
      driverName: r.driver_name ?? null,
      routeName: r.route_name ?? null,
      distanceM: r.distance_m,
      at: r.created_at,
    }));
  }

  /** Highest event id across this manager's assignments — the alert bootstrap cursor. */
  async maxEventId(userId: number): Promise<number> {
    const rows = await this.ds.query(
      `SELECT MAX(e.event_id) AS max_id
       FROM fd_route_events e
       JOIN fd_assignments a ON a.assignment_id = e.assignment_id
       WHERE a.user_id = ?`,
      [userId],
    );
    return rows[0]?.max_id ?? 0;
  }
```

- [ ] **Step 4: Add the controller endpoint**

In `assignments.controller.ts`, add directly after the `monitor()` method (both are static paths that must precede `@Get(':id')`):

```typescript
  /**
   * Deviation alert feed for the portal-wide popup watcher. Without
   * `sinceEventId` it only returns the current cursor (no toast flood on
   * first load); with it, every deviation event since — the client toasts
   * each and stores the advanced cursor.
   */
  @Get('alerts')
  async alerts(@Request() req: any, @Query('sinceEventId') sinceEventId?: string) {
    const since = sinceEventId != null ? Number(sinceEventId) : NaN;
    if (!Number.isFinite(since)) {
      const cursor = await this.assignments.maxEventId(req.user.id);
      return { success: true, message: 'Alert cursor', data: { cursor, alerts: [] } };
    }
    const alerts = await this.assignments.listDeviationAlertsSince(req.user.id, since);
    const cursor = alerts.length ? alerts[alerts.length - 1].eventId : since;
    return { success: true, message: `${alerts.length} alert(s)`, data: { cursor, alerts } };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd fuel-backend && npx jest src/dispatch --verbose`
Expected: PASS (all dispatch suites)

- [ ] **Step 6: Commit**

```bash
git add fuel-backend/src/dispatch/services/assignment.repository.ts fuel-backend/src/dispatch/assignments.controller.ts fuel-backend/src/dispatch/assignments.controller.alerts.spec.ts
git commit -m "feat(dispatch): deviation alert feed for portal popups"
```

---

### Task 6: Dashboard API lib additions

**Files:**
- Modify: `fuel-dashboard/src/lib/dispatch.ts`

**Interfaces:**
- Consumes: backend endpoints from Tasks 4–5; existing `request()` helper and multipart pattern from `uploadProof` (~line 423).
- Produces (Tasks 7–9 import these):
  - `interface StopCompletion { id; assignmentId; stopId; driverId; lat; lng; accuracyM; distanceM; inRange; photoPath; note; createdAt }`
  - `interface DeviationAlert { eventId; assignmentId; driverName; routeName; distanceM; at }`
  - `completeStop(token, jobId, stopId, data): Promise<{ completion: StopCompletion; jobCompleted: boolean; stopCompletions: StopCompletion[] }>`
  - `getDeviationAlerts(token, sinceEventId?): Promise<{ cursor: number; alerts: DeviationAlert[] }>`
  - `getMyJob` return type gains `stopCompletions: StopCompletion[]`; `LiveStatus` gains `stopCompletions: StopCompletion[]`.

- [ ] **Step 1: Add types and functions**

Add near the other dispatch types:

```typescript
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
  createdAt: string;
}

export interface DeviationAlert {
  eventId: number;
  assignmentId: number;
  driverName: string | null;
  routeName: string | null;
  distanceM: number | null;
  at: string;
}
```

Update `getMyJob` (~line 366) to include completions in its response type:

```typescript
export const getMyJob = (token: string, id: number) =>
  request<{ assignment: Assignment; route: RouteDetail; stopCompletions: StopCompletion[] }>(
    `/me/jobs/${id}`,
    {},
    token,
  );
```

Add `stopCompletions: StopCompletion[];` to the `LiveStatus` interface (~line 160, next to `events: RouteEvent[]`).

Add after `uploadProof`:

```typescript
/** Driver marks a bin complete — photo + GPS required (multipart). */
export async function completeStop(
  token: string,
  jobId: number,
  stopId: number,
  data: { photo: Blob; lat: number; lng: number; accuracyM?: number; note?: string },
): Promise<{ completion: StopCompletion; jobCompleted: boolean; stopCompletions: StopCompletion[] }> {
  const base = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3007"}/api`;
  const form = new FormData();
  form.append("photo", data.photo, "bin.jpg");
  form.append("lat", String(data.lat));
  form.append("lng", String(data.lng));
  if (data.accuracyM != null) form.append("accuracyM", String(data.accuracyM));
  if (data.note) form.append("note", data.note);
  const res = await fetch(`${base}/me/jobs/${jobId}/stops/${stopId}/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.message || `Completion failed (${res.status})`);
  return json.data;
}

/** Deviation alert feed for the portal popup watcher. */
export const getDeviationAlerts = (token: string, sinceEventId?: number) =>
  request<{ cursor: number; alerts: DeviationAlert[] }>(
    `/assignments/alerts${sinceEventId != null ? `?sinceEventId=${sinceEventId}` : ""}`,
    {},
    token,
  );
```

- [ ] **Step 2: Verify the dashboard builds**

Run: `cd fuel-dashboard && npm run build`
Expected: build succeeds (type errors would fail it)

- [ ] **Step 3: Commit**

```bash
git add fuel-dashboard/src/lib/dispatch.ts
git commit -m "feat(dispatch): dashboard API for bin completion + deviation alerts"
```

---

### Task 7: Driver job page — per-bin Complete UI

**Files:**
- Modify: `fuel-dashboard/src/app/driver/job/page.tsx`

**Interfaces:**
- Consumes: `completeStop`, `StopCompletion` from `@/lib/dispatch` (Task 6); existing `capturePhoto` from `@/lib/native/camera` (returns `{ blob: Blob } | null`).
- Produces: driver-facing UI only.

- [ ] **Step 1: Update data type and imports**

```typescript
import { getMyJob, updateMyJobStatus, uploadProof, completeStop, Assignment, RouteDetail, StopCompletion } from "@/lib/dispatch";
```

Change the JobData type:

```typescript
type JobData = { assignment: Assignment; route: RouteDetail; stopCompletions: StopCompletion[] };
```

(`getMyJob` already returns the extra field after Task 6; the offline cache picks it up automatically.)

- [ ] **Step 2: Add completion state + handler**

Inside `DriverJobDetailInner`, add state next to `podBusy`:

```typescript
  const [completingStopId, setCompletingStopId] = useState<number | null>(null);
```

Add the handler after `captureProof()`:

```typescript
  async function completeBin(stopId: number) {
    if (!token) return;
    setCompletingStopId(stopId);
    setError(null);
    try {
      const photo = await capturePhoto();
      if (!photo) { setCompletingStopId(null); return; }
      const pos = await new Promise<GeolocationPosition | null>((resolve) => {
        if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (p) => resolve(p),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 10000 },
        );
      });
      if (!pos) {
        setError("Location is required — enable GPS and try again");
        return;
      }
      await completeStop(token, id, stopId, {
        photo: photo.blob,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracyM: pos.coords.accuracy,
      });
      await load();
    } catch (e: any) {
      // 409 (already completed) just means our view was stale — refresh.
      if (String(e?.message).includes("already completed")) await load();
      else setError(e?.message || "Failed to complete bin");
    } finally {
      setCompletingStopId(null);
    }
  }
```

- [ ] **Step 3: Render per-bin completion state**

Above the `return`, derive:

```typescript
  const completions = data.stopCompletions ?? [];
  const completionByStop = new Map(completions.map((c) => [c.stopId, c]));
  const jobActive = a.status === "accepted" || a.status === "en_route" || a.status === "arrived";
```

Change the stops card header line to show progress:

```tsx
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Bins ({completions.length}/{route.stops.length} done)
          </p>
```

Replace the body of `route.stops.map((s, i) => (...))` with:

```tsx
            {route.stops.map((s, i) => {
              const done = s.stopId != null ? completionByStop.get(s.stopId) : undefined;
              return (
                <div key={s.stopId ?? i} className="flex items-start gap-2.5">
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0 mt-0.5"
                    style={{ background: done ? "#16a34a" : i === route.stops.length - 1 ? "#16a34a" : "var(--color-primary)" }}
                  >
                    {done ? <CheckCircle2 size={13} /> : i === route.stops.length - 1 ? <Flag size={12} /> : i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800">{s.name || `Stop ${i + 1}`}</p>
                    {done ? (
                      <p className="text-xs flex items-center gap-1.5" style={{ color: done.inRange ? "#16a34a" : "#d97706" }}>
                        <CheckCircle2 size={11} />
                        {new Date(done.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        {!done.inRange && ` · out of range · ${done.distanceM}m`}
                      </p>
                    ) : (
                      <a
                        href={`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-blue-600 flex items-center gap-1"
                      >
                        <MapPin size={11} /> Navigate
                      </a>
                    )}
                  </div>
                  {!done && jobActive && s.stopId != null && (
                    <button
                      onClick={() => completeBin(s.stopId!)}
                      disabled={completingStopId != null}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold text-white flex-shrink-0 disabled:opacity-50"
                      style={{ background: "#16a34a" }}
                    >
                      <Camera size={12} />
                      {completingStopId === s.stopId ? "Saving…" : "Complete"}
                    </button>
                  )}
                </div>
              );
            })}
```

- [ ] **Step 4: Verify build**

Run: `cd fuel-dashboard && npm run build`
Expected: build succeeds

- [ ] **Step 5: Commit**

```bash
git add fuel-dashboard/src/app/driver/job/page.tsx
git commit -m "feat(driver): per-bin complete button with photo + GPS verification"
```

---

### Task 8: Toast link support + portal-wide AlertWatcher

**Files:**
- Modify: `fuel-dashboard/src/components/ui/toast.tsx`
- Create: `fuel-dashboard/src/components/AlertWatcher.tsx`
- Modify: `fuel-dashboard/src/app/layout.tsx`

**Interfaces:**
- Consumes: `useAuth` from `@/contexts/AuthContext` (`{ token }`, manager JWT only — driver pages use a separate `driverSession` token so the watcher stays inert there), `useToast` from `@/components/ui`, `getDeviationAlerts` (Task 6).
- Produces: `ToastItem` gains optional `href?: string` (clicking the toast body navigates); `<AlertWatcher />` mounted globally.

- [ ] **Step 1: Add `href` support to the toast**

In `toast.tsx`:

Add to `ToastItem`:

```typescript
  /** When set, clicking the toast body navigates here. */
  href?: string;
```

In `Toaster`, replace the content `<div className="flex-1 min-w-0">…</div>` block with:

```tsx
            <div
              className={`flex-1 min-w-0${t.href ? " cursor-pointer" : ""}`}
              onClick={t.href ? () => { window.location.href = t.href!; onClose(t.id); } : undefined}
            >
              <p className="text-sm font-semibold" style={{ color: "var(--color-text-1)" }}>{t.title}</p>
              {t.description && (
                <p className="text-xs mt-0.5 break-words" style={{ color: "var(--color-text-2)" }}>{t.description}</p>
              )}
            </div>
```

- [ ] **Step 2: Create the AlertWatcher**

```tsx
// src/components/AlertWatcher.tsx
"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui";
import { getDeviationAlerts } from "@/lib/dispatch";

const POLL_MS = 20_000;
const CURSOR_KEY = "fueliq_alert_cursor";

/**
 * Portal-wide deviation popups: polls the alert feed while a manager is
 * signed in and toasts each new off-route event once (cursor persisted in
 * localStorage so a refresh doesn't re-toast). Inert on driver/login pages.
 */
export default function AlertWatcher() {
  const { token } = useAuth();
  const pathname = usePathname();
  const toast = useToast();
  const busy = useRef(false);

  const enabled =
    !!token && !pathname.startsWith("/driver") && !pathname.startsWith("/login");

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    async function poll() {
      if (busy.current || cancelled) return;
      busy.current = true;
      try {
        const raw = localStorage.getItem(CURSOR_KEY);
        const since = raw != null && raw !== "" ? Number(raw) : NaN;
        const { cursor, alerts } = await getDeviationAlerts(
          token!,
          Number.isFinite(since) ? since : undefined,
        );
        localStorage.setItem(CURSOR_KEY, String(cursor));
        if (!cancelled) {
          for (const a of alerts) {
            toast.show({
              tone: "error",
              title: `${a.driverName || "Driver"} is ${a.distanceM != null ? `${a.distanceM}m ` : ""}off route`,
              description: `${a.routeName || "Route"} — tap to open the live monitor`,
              href: "/dispatch/monitor",
              duration: 10_000,
            });
          }
        }
      } catch {
        // Silent — the next poll retries.
      } finally {
        busy.current = false;
      }
    }

    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled, token, toast]);

  return null;
}
```

- [ ] **Step 3: Mount it in the root layout**

In `src/app/layout.tsx`, add the import:

```typescript
import AlertWatcher from "@/components/AlertWatcher";
```

and change the provider nesting to:

```tsx
        <ToastProvider>
          <AuthProvider>
            <AlertWatcher />
            {children}
          </AuthProvider>
        </ToastProvider>
```

- [ ] **Step 4: Verify build**

Run: `cd fuel-dashboard && npm run build`
Expected: build succeeds

- [ ] **Step 5: Commit**

```bash
git add fuel-dashboard/src/components/ui/toast.tsx fuel-dashboard/src/components/AlertWatcher.tsx fuel-dashboard/src/app/layout.tsx
git commit -m "feat(dispatch): portal-wide deviation popup notifications"
```

---

### Task 9: Manager LiveMonitor — completion badges

**Files:**
- Modify: `fuel-dashboard/src/components/dispatch/LiveMonitor.tsx` (stop list, ~lines 204–217)

**Interfaces:**
- Consumes: `LiveStatus.stopCompletions` (Tasks 4 & 6); `StopCompletion` type from `@/lib/dispatch`.

- [ ] **Step 1: Show driver-confirmed completions in the stop list**

Add `StopCompletion` to the existing `@/lib/dispatch` import in `LiveMonitor.tsx`. Inside the component (near `const a = live?.analysis;`), derive:

```typescript
  const completionByStop = new Map(
    (live?.stopCompletions ?? []).map((c: StopCompletion) => [c.stopId, c]),
  );
```

Replace the stop-row map body (currently rendering `StopStatusBadge`) with:

```tsx
                    {live!.route.stops.map((s) => {
                      const st = a.stopStatuses.find((x) => x.seq === s.seq);
                      const done = s.stopId != null ? completionByStop.get(s.stopId) : undefined;
                      return (
                        <div key={s.seq} className="flex items-center gap-2 text-xs bg-gray-50 rounded-lg px-2 py-1.5">
                          <span className="w-5 h-5 rounded-full bg-gray-200 text-gray-600 font-bold flex items-center justify-center flex-shrink-0">
                            {s.seq}
                          </span>
                          <span className="flex-1 min-w-0 truncate text-gray-700">{s.name || `Stop ${s.seq}`}</span>
                          {done && (
                            <span
                              className="px-1.5 py-0.5 rounded-full font-bold text-white flex-shrink-0"
                              style={{ background: done.inRange ? "#16a34a" : "#d97706" }}
                              title={done.inRange ? "Driver confirmed at bin" : `Driver confirmed out of range (${done.distanceM}m)`}
                            >
                              {done.inRange ? "✓ done" : `✓ ${done.distanceM}m off`}
                            </span>
                          )}
                          {st ? <StopStatusBadge status={st.status} dwellS={st.dwellS} /> : null}
                        </div>
                      );
                    })}
```

- [ ] **Step 2: Verify build**

Run: `cd fuel-dashboard && npm run build`
Expected: build succeeds

- [ ] **Step 3: Commit**

```bash
git add fuel-dashboard/src/components/dispatch/LiveMonitor.tsx
git commit -m "feat(dispatch): show driver bin confirmations on the live monitor"
```

---

### Task 10: Full verification

- [ ] **Step 1: Backend — full test suite + build**

Run: `cd fuel-backend && npx jest --verbose && npm run build`
Expected: all suites PASS; nest build clean

- [ ] **Step 2: Dashboard — lint + build**

Run: `cd fuel-dashboard && npm run lint && npm run build`
Expected: clean

- [ ] **Step 3: Apply the migration to the dev database**

Run (uses the credentials in `fuel-backend/.env`):

```bash
mysql -h 192.168.20.170 -u dev -p'dev@iteck123' gs < fuel-backend/migrations/006_stop_completions.sql
```

Verify: `SHOW TABLES LIKE 'fd_stop_completions'` returns the table. (If `mysql` CLI is unavailable locally, run the DDL through any SQL client against the same DB.)

- [ ] **Step 4: End-to-end smoke test (manual, with backend + dashboard running)**

1. Sign in as a driver on `/driver`, open an active job.
2. Tap **Complete** on a bin → camera + GPS prompt → bin turns green with a time.
3. Complete the last bin → job status flips to `completed` without tapping "Complete job".
4. As a manager, open the live monitor → completed bins show "✓ done" (orange "✓ Nm off" for an out-of-range one).
5. Force a deviation event (or insert one: `INSERT INTO fd_route_events (assignment_id, type, distance_m, actor, note) VALUES (<active assignment id>, 'deviation', 480, 'system', 'test');`) → within 20s a red toast pops on any portal page; clicking it opens `/dispatch/monitor`.

- [ ] **Step 5: Use the superpowers:verification-before-completion skill, then finish the branch**

Use the superpowers:finishing-a-development-branch skill to merge/PR `feature/driver-bin-completion`.
