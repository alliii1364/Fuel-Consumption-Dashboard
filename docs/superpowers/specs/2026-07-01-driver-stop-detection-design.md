# Driver Stop Detection — per-stop "Stopped / Skipped / Not reached"

**Date:** 2026-07-01
**Status:** Approved (design), pending implementation plan
**Area:** Dispatch → live monitoring

## Problem

The live monitor currently marks a route stop (bin) as "visited" if *any* GPS
fix ever fell within the stop's radius. It never checks whether the driver
**actually stopped** there. A driver who drives *through* a bin's radius without
halting is counted as a pickup, so a manager cannot tell a real collection from
a drive-by.

We want each stop to show whether the driver genuinely stopped, merely passed
through without stopping, or never reached it at all.

## Goal

For each route stop, classify and display one of:

| Status | Meaning |
|--------|---------|
| 🟢 **Stopped** | Driver halted at the bin and (presumably) collected. |
| 🟡 **Skipped** | Driver entered the bin's radius but did not stop — drove through. |
| ⚪ **Not reached** | Driver never entered the radius and has already moved past it (or the job ended). |
| ⏳ **Pending** | Not yet reached; the job is still in progress and the driver hasn't gotten there. |

Display live in the **Live Monitor**: a per-stop list with status badges, and
colored stop markers on the map.

## Non-goals (YAGNI)

- **No post-trip report / history screen.** Live display only.
- **No change** to existing `arrived_stop` events or the final-stop
  **auto-advance** (`en_route`/`accepted` → `arrived`) logic. Those stay on
  proximity to avoid regressions. Stop *status* is computed purely for display.
- No new DB tables or columns. Computed on the fly from the existing GPS trails.

## Detection algorithm (backend, pure)

Implemented in `fuel-backend/src/dispatch/services/deviation.service.ts`
(`DeviationService.analyze`), which is already pure (no I/O) and receives the
planned route + the actual GPS `visitTrail` (union of vehicle tracker + driver
phone pings, already assembled by `MonitoringService`).

For each stop `s` (with its own `s.radiusM`):

1. Collect `inRadius` = trail points where `haversineMeters(p, s) <= s.radiusM`,
   sorted by time.
2. Classify:
   - **Stopped** if `inRadius` is non-empty **and**
     - `min(speed of inRadius points) <= STOP_MAX_SPEED_KMH`, **and**
     - `(last.ts - first.ts) >= MIN_DWELL_MS` (dwell span), **or** the
       **sparse-data fallback**: exactly one `inRadius` fix with
       `speed <= STOP_STILL_SPEED_KMH` (~2 km/h) counts as stopped (the tracker
       reports ~1 fix/min, so a single near-zero-speed fix means it sat there
       between fixes).
   - **Skipped** if `inRadius` is non-empty but the Stopped rule is not met
     (drove through).
   - **Not reached** if `inRadius` is empty **and** the driver has moved past
     the stop: `stopProgressFraction < currentProgressFraction`
     (via existing `progressAlongPolyline`), or the assignment status is
     terminal (`completed` / `cancelled`).
   - **Pending** if `inRadius` is empty and the stop is still ahead
     (`stopProgressFraction >= currentProgressFraction`) on an active job.

### Thresholds (named constants in `DeviationService`, tunable)

- `STOP_MAX_SPEED_KMH = 5` — at/under this counts as "at rest" within the radius.
- `STOP_STILL_SPEED_KMH = 2` — single-fix sparse-data "parked" threshold.
- `MIN_DWELL_MS = 120_000` — minimum dwell (2 min) to count as a real stop.

## Data shape

Extend `DeviationAnalysis` with a per-stop array; keep `visitedStopSeqs` /
`missedStopSeqs` for backward compatibility (derive them from the new field):

```ts
export type StopVisitStatus = 'stopped' | 'skipped' | 'not_reached' | 'pending';

export interface StopStatus {
  seq: number;
  status: StopVisitStatus;
  dwellS?: number;      // seconds at rest within radius (when stopped)
  arrivedAt?: string;   // ISO time of first in-radius fix (stopped/skipped)
}

// added to DeviationAnalysis:
stopStatuses: StopStatus[];
```

`MonitoringService.evaluate` already builds `visitTrail` and calls
`deviation.analyze` — no change needed there beyond the analysis carrying the
new field through to the `/assignments/:id/live` payload.

## Frontend

- **`fuel-dashboard/src/lib/dispatch.ts`** — add `StopStatus` / `stopStatuses`
  to the `LiveStatus.analysis` type.
- **`fuel-dashboard/src/components/dispatch/LiveMonitor.tsx`** — replace the
  single "Pickups collected: X/Y" metric with:
  - a summary line: `🟢 stopped · 🟡 skipped · ⚪ not reached`, and
  - a per-stop list: stop name + status badge (+ dwell time when stopped).
- **`fuel-dashboard/src/components/dispatch/DispatchMap.tsx`** — color each stop
  marker by status (green / amber / grey / blue-pending). The component receives
  a per-stop status map alongside the existing stop coordinates.

Color key (reuse existing palette used elsewhere in the app):
- stopped `#16a34a`, skipped `#f59e0b`, not_reached `#9CA3AF`, pending `#2563eb`.

## Error / edge handling

- **No trail at all** → every stop `pending` on an active job, `not_reached`
  once terminal.
- **Sparse tracker data** → single near-zero-speed in-radius fix ⇒ stopped
  (fallback above); prevents false "skipped".
- **Overlapping radii** (two bins close together) → each classified
  independently against its own radius; a fix can satisfy both.
- **GPS jitter** → speed and dwell thresholds absorb single noisy fixes; no
  extra hysteresis needed for stop classification (unlike off-route, which keeps
  its existing `SUSTAIN_MS` hysteresis).

## Testing

`DeviationService` is pure → unit tests with synthetic trails:

1. Dwelled long + slow within radius → **stopped** (dwellS reported).
2. Multiple fast fixes through radius, no low speed / short span → **skipped**.
3. No fix in radius, progress past the stop → **not_reached**.
4. No fix in radius, stop still ahead, active job → **pending**.
5. Single in-radius fix at ~0 km/h (sparse) → **stopped** (fallback).
6. Single in-radius fix at 30 km/h → **skipped**.
7. Terminal job, stop never reached → **not_reached** (not pending).
8. `visitedStopSeqs` / `missedStopSeqs` still derived correctly for compat.

## Files touched

- `fuel-backend/src/dispatch/services/deviation.service.ts` (algorithm + types)
- `fuel-backend/src/dispatch/services/deviation.service.spec.ts` (new tests)
- `fuel-dashboard/src/lib/dispatch.ts` (types)
- `fuel-dashboard/src/components/dispatch/LiveMonitor.tsx` (per-stop list)
- `fuel-dashboard/src/components/dispatch/DispatchMap.tsx` (colored markers)
