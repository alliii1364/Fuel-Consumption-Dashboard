# Route-Optimization Enhancements — Design

**Date:** 2026-07-06
**Status:** Approved
**Branch:** feature/route-optimization-enhancements (from main @ 6f4d1bac)

## Purpose

Five enhancements from the route-optimization meeting, building on the
merged driver bin-completion + deviation-alert feature:

- **A. Deviation alert with remarks + skip detection** — manager records a
  reason on each deviation; skipping a stop (not only leaving the route)
  also raises an alert.
- **B. Photo-proof toggle** — keep a single completion photo, but let the
  manager (the system's "admin" role) enable/disable the photo requirement
  for drivers.
- **C. Road routes (OSRM) + APK** — surface the straight-line degradation so
  it stops happening silently; provide a debug-APK build script.
- **D. Persistent route assignment** — a route stays assigned to a
  driver/vehicle until changed; the job resets for a new run instead of
  being recreated daily.
- **E. In-app map + auto-advance** — replace the external Google Maps link
  with an embedded map in the driver app; after "Done", auto-advance to the
  next bin without leaving the app. No timer.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Deviation remarks owner | **Manager**, on the live monitor event log |
| Skip detection | Skipped/missed stops **also** raise an alert (not only off-route) |
| Proof photos | **Single photo + manager on/off toggle** (no before/after split) |
| Container workflow | **In-app embedded map + auto-advance** to next bin |
| Route assignment | **Persistent** (stays assigned; resets for a new run) |
| APK | **Debug build script** provided; release signing/keystore is the user's |

## Global conventions

- Migrations: `fd_` prefix, no hard FKs to `gs_*`, re-runnable (`IF NOT
  EXISTS`), next file numbers continue from `006`.
- Roles: only `manager` and `driver` exist; "admin" == manager.
- Backend: NestJS raw-SQL repositories, Jest unit tests (`cd fuel-backend &&
  npx jest`). Dashboard/driver: Next.js, verified with `npm run build` (no
  test runner).
- Never commit `fuel-backend/dist/` or `node_modules/`.

---

## A. Deviation alert with remarks + skip detection

### Backend

- **Skip events.** `monitoring.service.ts` currently emits `deviation`
  (off-corridor) and `arrived_stop`. Add emission of a new `stop_skipped`
  event for each stop the deviation analysis marks `skipped` (or in
  `missedStopSeqs`), deduped once per stop like `arrived_stop`
  (`listSkippedStopIds` guard, mirroring `listArrivedStopIds`). The event
  carries `stop_id`, the stop's lat/lng, and a note (`Skipped {stop name}`).
- **Alert feed.** `listDeviationAlertsSince` broadens its filter to
  `type IN ('deviation','stop_skipped')` and returns an `alertType` field
  plus the stop name (LEFT JOIN `fd_route_stops`) so the client can word the
  toast ("… skipped Bin 6" vs "… 480m off route"). `maxEventId` bootstrap
  unchanged.
- **Remarks.** New nullable `remark VARCHAR(512)` column on
  `fd_route_events` (migration `007`), distinct from the system `note`. New
  endpoint `PATCH /assignments/:id/events/:eventId/remark` (manager,
  ownership-scoped) sets it; response returns the updated event. Repository
  method `setEventRemark(userId, assignmentId, eventId, remark)` verifies the
  event belongs to one of the manager's assignments before updating.

### Frontend

- Live monitor (`LiveMonitor.tsx`) event log: deviation/skip rows get an
  inline editable remark field (text input + Save) that calls the new
  endpoint and reflects the saved remark. The AlertWatcher toast keeps its
  click-through to `/dispatch/monitor`; the remark is entered there.
- `getDeviationAlerts`/`DeviationAlert` gain `alertType` and `stopName`; the
  toast title reflects skip vs off-route.

---

## B. Photo-proof toggle

### Backend

- **Settings table** (migration `007`, same file as the remark column):
  ```sql
  CREATE TABLE IF NOT EXISTS fd_manager_settings (
    user_id           INT        NOT NULL,   -- gs_users.id (manager)
    require_bin_photo  TINYINT(1) NOT NULL DEFAULT 1,
    updated_at         DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP
                          ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  ```
  Repository `getSettings(userId)` returns defaults (require photo = true)
  when no row exists; `upsertSettings(userId, { requireBinPhoto })` writes.
- **Endpoints** (manager): `GET /settings` and `PATCH /settings`.
- **Enforcement.** `StopCompletionService.complete` accepts a
  `requirePhoto` flag resolved from the owning manager's settings
  (`assignment.userId`). The driver controller passes it through; when
  photo is required and none was uploaded, keep the current 400 (`"A photo
  is required to complete a bin"`); when not required, accept a
  completion with `photoPath = null`. Migration `006`'s `photo_path` is
  relaxed to `NULL`-able via an `ALTER` in `007` (guarded so re-runs are
  safe).

### Frontend

- Dispatch page: a "Require completion photo" toggle (manager) reading/
  writing `/settings`.
- Driver job payload includes `requirePhoto`; `completeBin` skips the
  mandatory-photo path when it's false (photo becomes an optional attach).

---

## C. Road routes (OSRM) + APK

### OSRM straight-line surfacing (code)

- `RoutePlannerService` already computes a `degraded` flag when OSRM is
  unreachable. Thread it through: `RouteRepository.create`/`update` persist
  nothing new, but the controller returns `degraded` in the create/update
  response `data`. `RouteBuilder.tsx` shows a warning toast ("Route saved
  without optimization — routing engine unreachable") when `degraded` is
  true, so a misconfigured/unreachable OSRM never fails silently again.
- The root fix remains operational: set `OSRM_URL` on the deployed backend
  and restart. Documented in the plan's ops notes, not code.

### APK build

- Add `fuel-driver-app/scripts/build-debug-apk.sh` (and a `.ps1` twin)
  running `npm run build` in `fuel-dashboard`, `npx cap sync android`, then
  `./gradlew assembleDebug`, printing the output APK path. Release signing
  (keystore, `assembleRelease`) is documented but left to the user.

---

## D. Persistent route assignment

### Backend

- Migration `007`: `ALTER TABLE fd_assignments ADD COLUMN persistent
  TINYINT(1) NOT NULL DEFAULT 0` (guarded).
- **Create/flag.** `CreateAssignmentDto` gains optional `persistent`;
  managers can also toggle it via `PATCH /assignments/:id` (new small patch
  path or extend status endpoint — a dedicated `PATCH
  /assignments/:id/persistent` keeps concerns clean).
- **Reset for a new run.** New endpoint `POST /assignments/:id/reset`
  (manager) and automatic behavior: when a **persistent** assignment's last
  bin completes, instead of terminating, the service resets it — delete its
  `fd_stop_completions` rows, set status back to `assigned`, clear
  `completed_at`, and log a `run_reset` event. A non-persistent assignment
  keeps today's terminal `completed` behavior. `listForDriver` already
  excludes `completed`, so a reset persistent job stays visible; a completed
  one drops off — matching "stays assigned until changed."
- Repository: `resetAssignment(assignmentId)` (transactional: delete
  completions + update row + event).

### Frontend

- Assignment creation UI: a "Persistent (stays assigned, resets each run)"
  checkbox. Assignment row/detail: a "Start new run" button (calls
  `/reset`) and a persistent badge.

---

## E. In-app map + auto-advance (largest)

### Driver app (`fuel-dashboard/src/app/driver/job/page.tsx` + new map component)

- Replace the per-stop external Google Maps `<a>` link with an **embedded
  Leaflet map** (reuse the existing `react-leaflet` setup from
  `DispatchMap.tsx`; create a driver-focused `DriverNavMap.tsx`). The map
  shows the route geometry, all bins (color-coded by completion), the
  driver's live position, and highlights the **active bin** (first
  not-yet-completed stop in sequence).
- A prominent **"Done / Attempted"** button on the map screen completes the
  active bin via `completeStop` (respecting the photo toggle from B — photo
  captured inline when required, skipped when not). On success:
  - the bin's color flips to done (green / out-of-range orange),
  - the app **auto-selects the next incomplete bin**, re-centres and
    re-routes the map to it,
  - when no bins remain, the job completes (or resets, if persistent per D).
- **Navigation itself:** the embedded map draws the OSRM road route to the
  active bin (reusing the stored geometry / a lightweight leg fetch); we do
  not embed turn-by-turn voice nav. An optional "Open in Google Maps" link
  remains for drivers who want external turn-by-turn, but the completion
  flow no longer depends on leaving the app. **No timer** anywhere.
- Offline tolerance preserved (`stopCompletions ?? []`, cached job).

### Why embedded (constraint)

External Google Maps cannot be programmatically closed or made to call back
into our app, so "auto-close and return, then auto-advance" is only
achievable in-app. The embedded map keeps the driver in one screen for the
whole route.

---

## Implementation order

Smallest / lowest-risk first, largest last:

1. **C-code** — degraded-route surfacing (tiny) + APK script.
2. **B** — photo-proof toggle (settings table, endpoint, enforcement, UI).
3. **A** — remarks column + skip events + alert broadening + monitor UI.
4. **D** — persistent flag + reset flow + UI.
5. **E** — in-app map + auto-advance (driver app restructure).

Migrations A, B, D share one file (`007_route_optimization.sql`); C-code and
E add no schema.

## Testing

- Backend unit (TDD where logic is non-trivial): `stop_skipped` emission +
  dedup; alert-feed type broadening; `setEventRemark` ownership scoping;
  settings default/upsert; `complete` photo-required gate both ways;
  persistent reset (completions cleared, status/`completed_at` reset, event
  logged) vs non-persistent terminal completion.
- Dashboard/driver: `npm run build` gate; manual smoke of the monitor remark
  input, the photo toggle end-to-end, and the driver map auto-advance.
- APK: script runs `assembleDebug` and reports the artifact path.

## Out of scope

- Before/after photo split (explicitly dropped in favor of the toggle).
- Release APK signing / Play Store distribution (user-owned).
- Turn-by-turn voice navigation inside the app.
- Auto-generated recurring daily jobs (persistent-reset chosen instead).
- OSRM server provisioning (operational; `OSRM_URL` config + restart).
