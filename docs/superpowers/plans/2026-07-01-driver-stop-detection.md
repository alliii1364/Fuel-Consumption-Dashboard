# Driver Stop Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, per route stop in the live monitor, whether the driver actually stopped (dwelled), passed through without stopping (skipped), never reached it (not reached), or hasn't gotten there yet (pending).

**Architecture:** Add a pure per-stop classifier to the existing `DeviationService` (backend, no I/O) that reads the assembled GPS trail and a dwell rule (speed + time). It returns a new `stopStatuses[]` field on `DeviationAnalysis`, carried through the existing `/assignments/:id/live` payload untouched. The frontend Live Monitor renders a per-stop status list and colors the map's stop markers by status. Existing proximity-based `visitedStopSeqs`/arrival/auto-advance behavior is left unchanged.

**Tech Stack:** NestJS + TypeScript (backend, Jest + ts-jest for unit tests), Next.js 16 + React + Leaflet (frontend, no unit-test runner — verified by typecheck/build/manual).

## Global Constraints

- Backend unit tests: Jest, files `*.spec.ts` under `fuel-backend/src`, run with `npm test` (cwd `fuel-backend`).
- `DeviationService.analyze` must stay **pure** (no I/O) and **backward compatible**: existing params keep working; new behavior gated behind an optional param defaulting to current behavior.
- Do **not** change `visitedStopSeqs` / `missedStopSeqs` semantics (proximity-based) — arrival events and final-stop auto-advance depend on them.
- Dwell thresholds are named constants (tunable): `STOP_MAX_SPEED_KMH = 5`, `STOP_STILL_SPEED_KMH = 2`, `MIN_DWELL_MS = 120_000`.
- Status color palette (frontend): stopped `#16a34a`, skipped `#f59e0b`, not_reached `#9CA3AF`, pending `#2563eb`.

---

### Task 1: Backend — per-stop classifier in `DeviationService`

**Files:**
- Modify: `fuel-backend/src/dispatch/services/deviation.service.ts`
- Modify: `fuel-backend/src/dispatch/services/monitoring.service.ts` (pass `jobEnded`)
- Test: `fuel-backend/src/dispatch/services/deviation.service.spec.ts` (create)

**Interfaces:**
- Consumes: `haversineMeters`, `progressAlongPolyline`, `LatLng` (from `./geo.util`); `RouteStop` (from `./route.repository`); `TrailPoint`, `DeviationAnalysis` (existing, this file).
- Produces:
  - `export type StopVisitStatus = 'stopped' | 'skipped' | 'not_reached' | 'pending';`
  - `export interface StopStatus { seq: number; status: StopVisitStatus; dwellS?: number; arrivedAt?: string; }`
  - `DeviationAnalysis.stopStatuses: StopStatus[]` (new field)
  - `DeviationService.analyze(route, trail, visitTrail?, positionSource?, jobEnded?: boolean)` — new optional 5th param `jobEnded` (default `false`).

- [ ] **Step 1: Add types + new field + a stub so the spec compiles**

In `deviation.service.ts`, above `DeviationAnalysis`, add:

```ts
export type StopVisitStatus = 'stopped' | 'skipped' | 'not_reached' | 'pending';

export interface StopStatus {
  /** Matches RouteStop.seq. */
  seq: number;
  status: StopVisitStatus;
  /** Seconds spent at rest within the stop radius (only when 'stopped'). */
  dwellS?: number;
  /** ISO time of the first in-radius fix ('stopped' or 'skipped'). */
  arrivedAt?: string;
}
```

Add the field to the `DeviationAnalysis` interface (after `missedStopSeqs: number[];`):

```ts
  /** Per-stop dwell-based status for the live monitor (display only). */
  stopStatuses: StopStatus[];
```

Add the tunable constants inside the class (next to `SUSTAIN_MS`):

```ts
  /** At/under this speed (km/h) within a stop radius counts as "at rest". */
  private readonly STOP_MAX_SPEED_KMH = 5;
  /** A single in-radius fix at/under this speed (km/h) counts as parked (sparse data). */
  private readonly STOP_STILL_SPEED_KMH = 2;
  /** Minimum time at rest within the radius to count as a real stop. */
  private readonly MIN_DWELL_MS = 120_000;
```

Then, so the spec file compiles before the real logic exists, add `stopStatuses: []` to **every** object `analyze` returns (the `empty` object, the `geom.length < 2` early return, and the final return). This is a temporary stub — Step 4 replaces it with real values.

- [ ] **Step 2: Write the failing tests**

Create `fuel-backend/src/dispatch/services/deviation.service.spec.ts`:

```ts
import { DeviationService } from './deviation.service';
import { RouteStop } from './route.repository';
import { TrailPoint } from './deviation.service';
import { LatLng } from './geo.util';

// A 4-vertex straight line heading east; stop fractions differ along it.
const GEOM: LatLng[] = [
  { lat: 0, lng: 0 },
  { lat: 0, lng: 0.01 },
  { lat: 0, lng: 0.02 },
  { lat: 0, lng: 0.03 },
];

function stop(seq: number, lat: number, lng: number, radiusM = 50): RouteStop {
  return { seq, name: `Stop ${seq}`, lat, lng, type: 'bin', radiusM };
}

function pt(ms: number, lat: number, lng: number, speed: number): TrailPoint {
  return { ts: new Date(ms), lat, lng, speed };
}

const svc = new DeviationService();
const route = (stops: RouteStop[]) => ({ geometry: GEOM, stops, corridorBufferM: 100 });
const statusOf = (a: ReturnType<DeviationService['analyze']>, seq: number) =>
  a.stopStatuses.find((s) => s.seq === seq)?.status;

describe('DeviationService stop classification', () => {
  it('marks a stop STOPPED when dwelled slow and long within radius', () => {
    const s = stop(1, 0, 0.01);
    // 3 min at the bin, speed ~0
    const trail = [
      pt(0, 0, 0.01, 0),
      pt(90_000, 0, 0.01, 1),
      pt(180_000, 0, 0.01, 0),
    ];
    const a = svc.analyze(route([s]), trail, trail, 'tracker');
    expect(statusOf(a, 1)).toBe('stopped');
    const ss = a.stopStatuses.find((x) => x.seq === 1)!;
    expect(ss.dwellS).toBe(180);
    expect(ss.arrivedAt).toBe(new Date(0).toISOString());
  });

  it('marks a stop SKIPPED when it drove through the radius without stopping', () => {
    const s = stop(1, 0, 0.01);
    // two quick fixes, both moving fast, short span
    const trail = [pt(0, 0, 0.0099, 30), pt(20_000, 0, 0.0101, 32)];
    const a = svc.analyze(route([s]), trail, trail, 'tracker');
    expect(statusOf(a, 1)).toBe('skipped');
  });

  it('marks a stop NOT_REACHED when never in radius and progress is past it', () => {
    const s = stop(1, 0, 0.01); // early stop (fraction ~0.33)
    // driver is near the END of the route, never went to the bin
    const trail = [pt(0, 0, 0.03, 40)];
    const a = svc.analyze(route([s]), trail, trail, 'tracker');
    expect(statusOf(a, 1)).toBe('not_reached');
  });

  it('marks a stop PENDING when never in radius and still ahead on an active job', () => {
    const s = stop(1, 0, 0.03); // late stop (fraction ~1.0)
    // driver near the START, hasn't reached the far bin yet
    const trail = [pt(0, 0, 0.0, 40)];
    const a = svc.analyze(route([s]), trail, trail, 'tracker');
    expect(statusOf(a, 1)).toBe('pending');
  });

  it('sparse fallback: a single near-zero-speed in-radius fix counts as STOPPED', () => {
    const s = stop(1, 0, 0.01);
    const trail = [pt(0, 0, 0.01, 1)]; // one fix, ~parked
    const a = svc.analyze(route([s]), trail, trail, 'tracker');
    expect(statusOf(a, 1)).toBe('stopped');
  });

  it('a single fast in-radius fix is SKIPPED, not stopped', () => {
    const s = stop(1, 0, 0.01);
    const trail = [pt(0, 0, 0.01, 30)];
    const a = svc.analyze(route([s]), trail, trail, 'tracker');
    expect(statusOf(a, 1)).toBe('skipped');
  });

  it('when the job has ended, a never-reached stop is NOT_REACHED (not pending)', () => {
    const s = stop(1, 0, 0.03); // far ahead by progress
    const trail = [pt(0, 0, 0.0, 0)];
    const a = svc.analyze(route([s]), trail, trail, 'tracker', true);
    expect(statusOf(a, 1)).toBe('not_reached');
  });

  it('still derives visitedStopSeqs/missedStopSeqs by proximity (unchanged)', () => {
    const visited = stop(1, 0, 0.01);
    const missed = stop(2, 0, 0.03);
    const trail = [pt(0, 0, 0.01, 30)]; // in radius of stop 1 only, moving
    const a = svc.analyze(route([visited, missed]), trail, trail, 'tracker');
    // proximity => stop 1 visited even though it was only "skipped" by dwell
    expect(a.visitedStopSeqs).toContain(1);
    expect(a.missedStopSeqs).toContain(2);
    expect(statusOf(a, 1)).toBe('skipped');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd fuel-backend && npm test -- deviation.service`
Expected: FAIL — assertions on `stopStatuses` fail (stub returns `[]`, so `statusOf` is `undefined`).

- [ ] **Step 4: Implement the classifier and wire it into `analyze`**

In `deviation.service.ts`, add this private method to the class:

```ts
  /**
   * Per-stop dwell classification (display only; does not affect
   * visited/missed proximity semantics). A stop is:
   *  - stopped: an in-radius fix was at/under STOP_MAX_SPEED_KMH and the
   *    in-radius fixes span >= MIN_DWELL_MS; or (sparse data) a lone in-radius
   *    fix at/under STOP_STILL_SPEED_KMH.
   *  - skipped: entered the radius but did not meet the stop rule.
   *  - not_reached: never entered the radius and the driver has moved past it
   *    (by route progress) or the job has ended.
   *  - pending: never entered the radius and the stop is still ahead.
   */
  private computeStopStatuses(
    stops: RouteStop[],
    visitTrail: TrailPoint[],
    geom: LatLng[],
    currentFraction: number,
    jobEnded: boolean,
  ): StopStatus[] {
    return stops.map((s) => {
      const inRadius = visitTrail
        .filter(
          (p) => haversineMeters(p, { lat: s.lat, lng: s.lng }) <= s.radiusM,
        )
        .sort((a, b) => a.ts.getTime() - b.ts.getTime());

      if (inRadius.length > 0) {
        const minSpeed = Math.min(...inRadius.map((p) => p.speed));
        const spanMs =
          inRadius[inRadius.length - 1].ts.getTime() - inRadius[0].ts.getTime();
        const dwelled =
          (minSpeed <= this.STOP_MAX_SPEED_KMH && spanMs >= this.MIN_DWELL_MS) ||
          (inRadius.length === 1 && minSpeed <= this.STOP_STILL_SPEED_KMH);
        return {
          seq: s.seq,
          status: dwelled ? 'stopped' : 'skipped',
          ...(dwelled ? { dwellS: Math.round(spanMs / 1000) } : {}),
          arrivedAt: inRadius[0].ts.toISOString(),
        };
      }

      const stopFraction =
        geom.length >= 2
          ? progressAlongPolyline({ lat: s.lat, lng: s.lng }, geom)
          : 0;
      const passed = jobEnded || stopFraction < currentFraction;
      return { seq: s.seq, status: passed ? 'not_reached' : 'pending' };
    });
  }
```

Update the `analyze` signature and body. Change the signature to:

```ts
  analyze(
    route: { geometry: LatLng[]; stops: RouteStop[]; corridorBufferM: number },
    trail: TrailPoint[],
    visitTrail: TrailPoint[] = trail,
    positionSource: PositionSource = 'tracker',
    jobEnded = false,
  ): DeviationAnalysis {
```

Compute `geom` **once at the top** of `analyze` (before the empty-trail return) and reuse it:

```ts
    const geom: LatLng[] =
      route.geometry.length >= 2
        ? route.geometry
        : route.stops.map((s) => ({ lat: s.lat, lng: s.lng }));
```

Replace the three `stopStatuses: []` stubs with real values:

- In the `empty` object (no trail): `currentFraction` is 0.
  ```ts
      stopStatuses: this.computeStopStatuses(route.stops, visitTrail, geom, 0, jobEnded),
  ```
- In the `geom.length < 2` early return: also fraction 0.
  ```ts
      stopStatuses: this.computeStopStatuses(route.stops, visitTrail, geom, 0, jobEnded),
  ```
  (Note: since `geom` is now computed at the top, delete the second local `geom` declaration that previously lived lower in the method.)
- In the final return, compute the current fraction from the last fix:
  ```ts
      const currentFraction = progressAlongPolyline(last, geom);
      // ...
      stopStatuses: this.computeStopStatuses(route.stops, visitTrail, geom, currentFraction, jobEnded),
  ```
  Place the `currentFraction` line next to the existing `progressPct` computation and reuse it: `progressPct: Math.round(currentFraction * 100)`.

- [ ] **Step 5: Pass `jobEnded` from the monitoring service**

In `monitoring.service.ts`, update the `this.deviation.analyze(...)` call (currently ends with `positionSource,`) to pass whether the job is terminal:

```ts
    const analysis = this.deviation.analyze(
      {
        geometry: route.geometry,
        stops: route.stops,
        corridorBufferM: route.corridorBufferM,
      },
      positionTrail,
      visitTrail,
      positionSource,
      assignment.status === 'completed' || assignment.status === 'cancelled',
    );
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd fuel-backend && npm test -- deviation.service`
Expected: PASS (8 passing).

- [ ] **Step 7: Typecheck the backend build**

Run: `cd fuel-backend && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add fuel-backend/src/dispatch/services/deviation.service.ts \
        fuel-backend/src/dispatch/services/monitoring.service.ts \
        fuel-backend/src/dispatch/services/deviation.service.spec.ts
git commit -m "feat(dispatch): per-stop dwell-based stop/skip detection"
```

---

### Task 2: Frontend — types for `stopStatuses`

**Files:**
- Modify: `fuel-dashboard/src/lib/dispatch.ts:135-146` (the `DeviationAnalysis` interface)

**Interfaces:**
- Consumes: nothing new.
- Produces: `StopVisitStatus`, `StopStatus`, and `DeviationAnalysis.stopStatuses: StopStatus[]` on the frontend — mirrors the backend shape returned by `/assignments/:id/live`. Tasks 3 and 4 rely on these.

- [ ] **Step 1: Add the types**

In `dispatch.ts`, immediately before `export interface DeviationAnalysis {`, add:

```ts
export type StopVisitStatus = "stopped" | "skipped" | "not_reached" | "pending";

export interface StopStatus {
  seq: number;
  status: StopVisitStatus;
  dwellS?: number;
  arrivedAt?: string;
}
```

Inside `DeviationAnalysis`, after `missedStopSeqs: number[];`, add:

```ts
  stopStatuses: StopStatus[];
```

- [ ] **Step 2: Typecheck**

Run: `cd fuel-dashboard && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add fuel-dashboard/src/lib/dispatch.ts
git commit -m "feat(dispatch): frontend types for per-stop statuses"
```

---

### Task 3: Frontend — per-stop status list in Live Monitor

**Files:**
- Modify: `fuel-dashboard/src/components/dispatch/LiveMonitor.tsx`

**Interfaces:**
- Consumes: `StopStatus` / `StopVisitStatus` from `@/lib/dispatch` (Task 2); `live.analysis.stopStatuses`, `live.route.stops`.
- Produces: nothing consumed by later tasks (Task 4 is independent).

- [ ] **Step 1: Add a status-display helper**

At the bottom of `LiveMonitor.tsx` (near the `Metric` component), add a small config + badge helper:

```tsx
const STATUS_UI: Record<StopVisitStatus, { label: string; color: string }> = {
  stopped: { label: "Stopped", color: "#16a34a" },
  skipped: { label: "Skipped", color: "#f59e0b" },
  not_reached: { label: "Not reached", color: "#9CA3AF" },
  pending: { label: "Pending", color: "#2563eb" },
};

function StopStatusBadge({ status, dwellS }: { status: StopVisitStatus; dwellS?: number }) {
  const ui = STATUS_UI[status];
  const mins = dwellS != null ? Math.round(dwellS / 60) : null;
  return (
    <span
      className="text-[10px] font-bold px-2 py-0.5 rounded-full text-white flex-shrink-0"
      style={{ background: ui.color }}
    >
      {ui.label}
      {status === "stopped" && mins != null ? ` · ${mins}m` : ""}
    </span>
  );
}
```

Add the import at the top:

```tsx
import { getAssignmentLive, getAssignmentProof, LiveStatus, PodRecord, StopVisitStatus } from "@/lib/dispatch";
```

- [ ] **Step 2: Replace the "Pickups collected" metric with a summary + list**

Find this line in the panel:

```tsx
                <Metric label="Pickups collected" value={`${a.visitedStopSeqs.length}/${a.visitedStopSeqs.length + a.missedStopSeqs.length}`} />
```

Replace it with a summary metric that counts by status plus a per-stop list. Insert the following (using `a.stopStatuses` keyed by `seq`, iterating the ordered `live!.route.stops`):

```tsx
                <Metric
                  label="Stops"
                  value={
                    `🟢 ${a.stopStatuses.filter((s) => s.status === "stopped").length}` +
                    ` · 🟡 ${a.stopStatuses.filter((s) => s.status === "skipped").length}` +
                    ` · ⚪ ${a.stopStatuses.filter((s) => s.status === "not_reached").length}`
                  }
                />

                <div className="mt-3">
                  <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Stops ({live!.route.stops.length})</p>
                  <div className="flex flex-col gap-1.5 max-h-56 overflow-auto">
                    {live!.route.stops.map((s) => {
                      const st = a.stopStatuses.find((x) => x.seq === s.seq);
                      return (
                        <div key={s.seq} className="flex items-center gap-2 text-xs bg-gray-50 rounded-lg px-2 py-1.5">
                          <span className="w-5 h-5 rounded-full bg-gray-200 text-gray-600 font-bold flex items-center justify-center flex-shrink-0">
                            {s.seq}
                          </span>
                          <span className="flex-1 min-w-0 truncate text-gray-700">{s.name || `Stop ${s.seq}`}</span>
                          {st ? <StopStatusBadge status={st.status} dwellS={st.dwellS} /> : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
```

- [ ] **Step 3: Typecheck + lint**

Run: `cd fuel-dashboard && npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 4: Manual check**

Run the dev server (`cd fuel-dashboard && npm run dev`), open a live monitor for an in-progress assignment, and confirm the per-stop list renders with colored badges and the summary counts. (Requires a backend with the Task 1 changes running.)

- [ ] **Step 5: Commit**

```bash
git add fuel-dashboard/src/components/dispatch/LiveMonitor.tsx
git commit -m "feat(dispatch): per-stop status list in live monitor"
```

---

### Task 4: Frontend — color stop markers by status on the map

**Files:**
- Modify: `fuel-dashboard/src/components/dispatch/DispatchMap.tsx`
- Modify: `fuel-dashboard/src/components/dispatch/LiveMonitor.tsx` (pass status into `stops`)

**Interfaces:**
- Consumes: `StopVisitStatus` from `@/lib/dispatch`; `a.stopStatuses` in `LiveMonitor`.
- Produces: `DispatchMap` `StopMarker` gains an optional `status?: StopVisitStatus`.

- [ ] **Step 1: Teach `DispatchMap` to color stop pins by status**

In `DispatchMap.tsx`, import the type and extend `StopMarker`:

```tsx
import { LatLng, StopVisitStatus } from "@/lib/dispatch";
```

```tsx
interface StopMarker {
  lat: number;
  lng: number;
  name?: string | null;
  seq?: number;
  status?: StopVisitStatus;
}
```

Add a color map near `KARACHI`:

```tsx
const STOP_STATUS_COLOR: Record<StopVisitStatus, string> = {
  stopped: "#16a34a",
  skipped: "#f59e0b",
  not_reached: "#9CA3AF",
  pending: "#2563eb",
};
```

In the stops `.map(...)`, replace the hardcoded pin color with the status color (falling back to the current red when no status is provided, e.g. in the route builder):

```tsx
          icon={numberPin(s.seq ?? i + 1, s.status ? STOP_STATUS_COLOR[s.status] : "#E84040")}
```

- [ ] **Step 2: Pass status from `LiveMonitor` into the map**

In `LiveMonitor.tsx`, find the `<DispatchMap ... stops={...} />` call and merge each stop's status from `a.stopStatuses`:

```tsx
                stops={live.route.stops.map((s) => ({
                  lat: s.lat,
                  lng: s.lng,
                  name: s.name,
                  seq: s.seq,
                  status: a?.stopStatuses.find((x) => x.seq === s.seq)?.status,
                }))}
```

- [ ] **Step 3: Typecheck + lint**

Run: `cd fuel-dashboard && npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 4: Manual check**

With the dev server running and a live monitor open, confirm stop pins are green/amber/grey/blue by status, and the route builder's pins are still red (unaffected).

- [ ] **Step 5: Commit**

```bash
git add fuel-dashboard/src/components/dispatch/DispatchMap.tsx \
        fuel-dashboard/src/components/dispatch/LiveMonitor.tsx
git commit -m "feat(dispatch): color live-monitor map pins by stop status"
```

---

## Self-Review

**Spec coverage:**
- Dwell rule (speed + time) + sparse fallback → Task 1 (`computeStopStatuses`, constants, tests 1/2/5/6).
- 4 states (stopped/skipped/not_reached/pending) → Task 1 (tests 1–4, 7).
- `stopStatuses` data shape, `visited/missed` unchanged → Task 1 (test 8) + Task 2 (types).
- Scope guard (no change to arrival events / auto-advance) → Task 1 keeps proximity `visited()`; only adds a separate field.
- Live Monitor per-stop list → Task 3. Colored map markers → Task 4.
- Thresholds tunable, color palette → Global Constraints + Tasks 1/3/4.
- Testing (8 cases on pure service) → Task 1 Step 2.

**Placeholder scan:** No TBD/TODO; all code shown in full.

**Type consistency:** `StopVisitStatus`/`StopStatus`/`stopStatuses` identical across backend (Task 1) and frontend (Task 2), consumed unchanged in Tasks 3/4. `computeStopStatuses` signature matches its call sites. `analyze`'s new `jobEnded` param is optional and its only new caller (monitoring.service) is updated in Task 1 Step 5.
