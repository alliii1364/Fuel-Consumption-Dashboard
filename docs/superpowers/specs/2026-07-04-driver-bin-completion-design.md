# Driver Bin Completion + Portal Deviation Alerts — Design

**Date:** 2026-07-04
**Status:** Approved

## Purpose

Two additions to the dispatch/driver-app feature set:

1. **Per-bin completion with location verification.** The driver marks each bin
   (route stop) complete from the driver app. The server verifies the driver's
   GPS position against the bin's location before recording it. Out-of-range
   completions are accepted but flagged for the manager. A photo is required
   with every completion. When the last bin is completed, the job
   auto-completes.
2. **Deviation popup on the manager portal.** When a driver goes off-route
   (already detected by the every-minute monitoring cron), a toast notification
   pops up anywhere in the manager portal with a click-through to the live
   monitor.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Driver taps Complete while outside bin radius | **Accept, but flag** (`in_range = 0`); manager sees it flagged |
| All bins completed | **Job auto-completes** (actor `system`) |
| Proof per bin | **Photo required** on every bin completion |
| Deviation popup scope | **Anywhere in the portal** (global watcher), in-app toast only (no browser push) |

## Part 1 — Per-bin completion

### Schema (`migrations/006_stop_completions.sql`)

Same conventions as existing migrations: `fd_` prefix, no hard FKs to `gs_*`,
re-runnable (`IF NOT EXISTS`).

```sql
CREATE TABLE IF NOT EXISTS fd_stop_completions (
  id            INT           NOT NULL AUTO_INCREMENT,
  assignment_id INT           NOT NULL,   -- fd_assignments.assignment_id
  stop_id       INT           NOT NULL,   -- fd_route_stops.stop_id
  driver_id     INT           NOT NULL,   -- gs_user_object_drivers.driver_id
  lat           DECIMAL(10,7) NOT NULL,   -- driver GPS at tap time
  lng           DECIMAL(10,7) NOT NULL,
  accuracy_m    FLOAT             NULL,   -- device-reported GPS accuracy
  distance_m    INT           NOT NULL,   -- computed driver→bin haversine distance
  in_range      TINYINT(1)    NOT NULL,   -- 1 = within radius_m + accuracy allowance
  photo_path    VARCHAR(512)  NOT NULL,   -- required proof photo (under UPLOADS_DIR)
  note          VARCHAR(1024)     NULL,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fd_completion (assignment_id, stop_id),  -- idempotency guard
  KEY idx_fd_completion_assignment (assignment_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### Endpoint

`POST /me/jobs/:id/stops/:stopId/complete` — driver role, multipart
(`photo` file + `lat`, `lng`, `accuracyM`, optional `note`).

Server-side flow, in order:

1. **Ownership & state.** Assignment must belong to the authenticated driver
   (existing `getForDriver` scoping). Stop must belong to the assignment's
   route. Job status must be active (`accepted|en_route|arrived`); otherwise
   400. If the bin already has a completion row, return 409 with the existing
   completion (idempotent client retry stays safe).
2. **Required inputs.** Missing photo → 400 "A photo is required to complete a
   bin". Missing/invalid `lat`/`lng` → 400 "Location is required — enable GPS
   and try again". These strings are shown verbatim by the driver app.
3. **Verification.** `distance_m = haversine(driver, stop)` (reuse
   `geo.util.ts`). `in_range = distance_m <= stop.radius_m +
   min(accuracyM ?? 0, 50)`. The 50 m cap stops a wildly-inaccurate fix from
   passing the check. Out-of-range still saves, flagged.
4. **Persist.** Photo saved under `uploads/completions/` (same pattern as POD
   uploads). Insert `fd_stop_completions` row. Log a `stop_completed` event to
   `fd_route_events` (`stop_id`, `lat`, `lng`, `distance_m`, actor `driver`;
   note marks out-of-range, e.g. "Completed Bin 3 (out of range, 480m)").
5. **Auto-complete.** If every stop on the route now has a completion row →
   set assignment status to `completed` (actor `system`), stamp
   `completed_at`, log the status-change event. Reuses the existing
   `setStatus` path.
6. **Response.** `{ completion, stopCompletions: [...] }` — the fresh
   per-stop completion list so the app updates without a refetch.

Job detail (`GET /me/jobs/:id`) additionally returns `stopCompletions` so the
app renders completed state on load. The manager's assignment detail (live
monitor endpoint) includes the same list.

### Driver app UI (`fuel-dashboard/src/app/driver/job/page.tsx`)

- Each bin row gets a **Complete** button: opens camera
  (`<input type="file" accept="image/*" capture="environment">`), grabs
  `navigator.geolocation.getCurrentPosition` (high accuracy), uploads
  multipart.
- Completed bins: green check + completion time. Flagged ones: orange
  "out of range · 480m" badge.
- Header shows progress ("4/7 bins").
- Errors from the server (no GPS, already completed, job not active) surface
  as-is in the existing error UI.
- Existing job-level status buttons and job-level POD capture stay unchanged.

### Manager monitor

Stop list in the live monitor job detail shows per-bin completion state;
out-of-range completions render orange with the distance.

## Part 2 — Deviation popup on the portal

No schema change. The monitoring cron (every minute) already writes
`deviation` events to `fd_route_events` with `distance_m`, one event per
deviation episode.

### Backend

`GET /assignments/alerts?sinceEventId=N` — manager role. Returns `deviation`
events newer than `sinceEventId` for **this manager's** assignments (scoped by
`fd_assignments.user_id`), joined with driver name and route name, capped
(e.g. latest 20), newest last:

```json
{ "alerts": [{ "eventId": 123, "assignmentId": 5, "driverName": "Ahmed",
   "routeName": "North Karachi collection", "distanceM": 480,
   "at": "2026-07-04T09:12:00Z" }] }
```

Without `sinceEventId`, returns only the current max event id (bootstrap — no
toast flood on first load).

### Frontend

`AlertWatcher` — a small client component mounted in the manager portal layout
(not the driver layout):

- Polls the alerts endpoint every 20 s while a manager token is present.
- Persists last-seen event id in `localStorage` (survives refresh/navigation).
- Each new event → one toast: "Ahmed is 480m off route on North Karachi
  collection — View", using the existing toast component
  (`components/ui`); "View" navigates to `/dispatch/monitor`.
- One toast per event id, never re-toasted. The backend's
  one-event-per-episode behaviour prevents repeat alerts while a driver stays
  off-route.

## Error handling summary

| Case | Behaviour |
|---|---|
| OSRM/GPS unrelated failures | unchanged |
| Photo missing | 400, message shown verbatim in app |
| GPS missing/invalid | 400, message shown verbatim in app |
| Bin already completed | 409 + existing completion (client treats as done) |
| Job not in active status | 400 |
| Stop not on this route / job not this driver's | 404 (existing scoping) |
| Alerts poll failure | silent; next poll retries |

## Testing

- **Unit — in-range rule:** inside radius; exactly at edge; outside; outside
  but within accuracy allowance; accuracy capped at 50 m.
- **Unit — completion flow:** rejects missing photo/GPS; flags out-of-range;
  idempotency (duplicate → 409); auto-complete fires only when the last bin
  lands; event rows written.
- **Unit — alerts query:** scoped to the manager's own assignments;
  `sinceEventId` cursor; bootstrap mode.
- Patterns follow `deviation.service.spec.ts`.

## Out of scope

- Browser/native push notifications for managers (in-app toast only).
- Undo/reopen of a completed bin (manager tooling can come later).
- Changes to the automatic dwell-based stop detection (kept as-is; it feeds
  the monitor, while completions are the authoritative driver-confirmed
  record).
