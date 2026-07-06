# Route-Optimization Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five enhancements on top of the merged bin-completion feature: surface OSRM straight-line degradation, a manager photo-proof toggle, deviation remarks + skip-stop alerts, persistent route assignments, and an in-app map with auto-advance to the next bin.

**Architecture:** One shared additive migration (`007`) adds a settings table plus columns to existing tables; backend changes are raw-SQL repository methods + NestJS endpoints with Jest unit tests; frontend changes are Next.js/React (verified with `npm run build`). The driver app gains an embedded Leaflet map reusing the existing `react-leaflet` setup.

**Tech Stack:** NestJS 10 + TypeORM raw SQL (MySQL/MariaDB), Jest; Next.js + React + react-leaflet; Capacitor (Android APK).

**Spec:** `docs/superpowers/specs/2026-07-06-route-optimization-enhancements-design.md`

## Global Constraints

- Branch `feature/route-optimization-enhancements` (worktree at `d:/Github/Fuel-Consumption-Dashboard-routeopt`). Never commit `fuel-backend/dist/` or `node_modules/` — `git status` is noisy with tracked `node_modules` churn; always `git add` the exact files a task names.
- Migrations: `fd_` prefix, no hard FKs to `gs_*`. `CREATE TABLE IF NOT EXISTS`; `ALTER` statements guarded so re-runs are safe (the DB may be MySQL 8 which lacks `ADD COLUMN IF NOT EXISTS` — use the information_schema guard shown in Task 3).
- Roles: only `manager` and `driver`. "Admin" == manager.
- Error strings shown verbatim in the driver app: keep `"A photo is required to complete a bin"`, `"Location is required — enable GPS and try again"`, `"Bin already completed"`, `"Job is not active"`.
- Backend tests: `cd fuel-backend && npx jest <file> --verbose`. Dashboard/driver: `cd fuel-dashboard && npm run build`.
- No timer anywhere in the driver workflow (explicit requirement).
- All backend paths are relative to `fuel-backend/`, dashboard paths to `fuel-dashboard/`.

---

### Task 1: Surface OSRM straight-line degradation (Feature C, code)

**Files:**
- Modify: `fuel-backend/src/dispatch/routes.controller.ts` (create ~line 88-89 and 104-105; update ~line 241-243)
- Modify: `fuel-dashboard/src/lib/dispatch.ts` (`RouteDetail` interface ~line 73; `createRoute`/`updateRoute` return types)
- Modify: `fuel-dashboard/src/components/dispatch/RouteBuilder.tsx` (`save()` ~line 149-159)

**Interfaces:**
- Consumes: `RoutePlannerService.plan()`/`planRoundTrip()` already return `{ ..., degraded: boolean }` (see `route-planner.service.ts:12-13`). The controller already has the `planned` object in scope.
- Produces: create/update response `data` gains `degraded: boolean`; `RouteDetail` gains `degraded?: boolean`.

- [ ] **Step 1: Attach `degraded` to the create responses**

In `routes.controller.ts`, both `create()` return sites currently do:
```typescript
      const data = await this.routes.get(req.user.id, routeId);
      return { success: true, message: 'Route created', data };
```
Change both (the depot branch ~line 88 and the legacy branch ~line 104) to:
```typescript
      const data = await this.routes.get(req.user.id, routeId);
      return { success: true, message: 'Route created', data: { ...data, degraded: planned.degraded } };
```

- [ ] **Step 2: Attach `degraded` to the update response**

In `update()` (~line 241-243), after `patch` is built the code has `planned` in scope only inside the `if (dto.stops)` block. Change the tail to carry it out:
```typescript
    let degraded = false;
    if (dto.stops) {
      // ...existing block that computes `planned` and sets patch.*...
      degraded = planned.degraded;
    }
    await this.routes.update(req.user.id, routeId, patch);
    const data = await this.routes.get(req.user.id, routeId);
    return { success: true, message: 'Route updated', data: { ...data, degraded } };
```
(Declare `let degraded = false;` before the `if (dto.stops)` block and set it inside.)

- [ ] **Step 3: Type the frontend field**

In `dispatch.ts`, add to the `RouteDetail` interface:
```typescript
  /** True when OSRM was unreachable and the route was saved with straight-line geometry. */
  degraded?: boolean;
```

- [ ] **Step 4: Warn in the RouteBuilder on degraded save**

In `RouteBuilder.tsx` `save()`, the create/update calls currently ignore the result. Capture it and warn:
```typescript
      if (isEdit && editRoute) {
        const saved = await updateRoute(token, editRoute.routeId, payload);
        if (saved?.degraded) notify?.error("Saved without optimization", "Routing engine unreachable — straight-line route used. Check OSRM.");
        else notify?.success("Route updated", name.trim());
        onCancelEdit?.();
      } else {
        const saved = await createRoute(token, payload);
        if (saved?.degraded) notify?.error("Saved without optimization", "Routing engine unreachable — straight-line route used. Check OSRM.");
        else notify?.success("Route created", name.trim());
        resetForm();
      }
      onSaved();
```
(`createRoute`/`updateRoute` already return the `data` object via `request()`, so `saved.degraded` is present.)

- [ ] **Step 5: Verify build**

Run: `cd fuel-backend && npx tsc --noEmit -p tsconfig.json` → clean
Run: `cd fuel-dashboard && npm run build` → succeeds

- [ ] **Step 6: Commit**

```bash
git add fuel-backend/src/dispatch/routes.controller.ts fuel-dashboard/src/lib/dispatch.ts fuel-dashboard/src/components/dispatch/RouteBuilder.tsx
git commit -m "feat(dispatch): surface OSRM straight-line degradation on route save"
```

---

### Task 2: Debug-APK build script (Feature C, ops)

**Files:**
- Create: `fuel-driver-app/scripts/build-debug-apk.sh`
- Create: `fuel-driver-app/scripts/build-debug-apk.ps1`
- Modify: `fuel-driver-app/README.md` (append a "Building the APK" section)

**Interfaces:** none (build tooling only).

- [ ] **Step 1: Inspect the existing build wiring**

Read `fuel-driver-app/capacitor.config.ts` and `fuel-driver-app/package.json` scripts to confirm the web build directory and any existing `cap` scripts. The driver PWA is built from `fuel-dashboard`; the Capacitor Android project lives under `fuel-driver-app/android`.

- [ ] **Step 2: Write the bash script**

`fuel-driver-app/scripts/build-debug-apk.sh`:
```bash
#!/usr/bin/env bash
# Build an unsigned debug APK for driver testing.
# Release signing (keystore, assembleRelease) is intentionally NOT here — that
# is owned by the release manager.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DASH="$ROOT/../fuel-dashboard"

echo "==> Building web assets (fuel-dashboard)"
( cd "$DASH" && npm run build )

echo "==> Syncing Capacitor Android project"
( cd "$ROOT" && npx cap sync android )

echo "==> Assembling debug APK"
( cd "$ROOT/android" && ./gradlew assembleDebug )

APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
echo "==> Done. APK at: $APK"
```

- [ ] **Step 3: Write the PowerShell twin**

`fuel-driver-app/scripts/build-debug-apk.ps1`:
```powershell
# Build an unsigned debug APK for driver testing. Release signing is out of scope.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dash = Join-Path $root "..\fuel-dashboard"

Write-Host "==> Building web assets (fuel-dashboard)"
Push-Location $dash; npm run build; Pop-Location

Write-Host "==> Syncing Capacitor Android project"
Push-Location $root; npx cap sync android; Pop-Location

Write-Host "==> Assembling debug APK"
Push-Location (Join-Path $root "android"); .\gradlew.bat assembleDebug; Pop-Location

$apk = Join-Path $root "android\app\build\outputs\apk\debug\app-debug.apk"
Write-Host "==> Done. APK at: $apk"
```

- [ ] **Step 4: Document in README**

Append to `fuel-driver-app/README.md`:
```markdown
## Building the APK

Debug build (for driver testing):

    bash scripts/build-debug-apk.sh      # macOS/Linux/Git Bash
    pwsh scripts/build-debug-apk.ps1     # Windows

The unsigned debug APK is written to
`android/app/build/outputs/apk/debug/app-debug.apk`.

Release builds (signed, for distribution) are produced with your own keystore
via `./gradlew assembleRelease` and are intentionally not scripted here.
```

- [ ] **Step 5: Syntax-check the scripts**

Run: `bash -n fuel-driver-app/scripts/build-debug-apk.sh` → no output (valid)
(The `.ps1` cannot be executed headlessly; a visual read is sufficient.)

- [ ] **Step 6: Commit**

```bash
git add fuel-driver-app/scripts/build-debug-apk.sh fuel-driver-app/scripts/build-debug-apk.ps1 fuel-driver-app/README.md
git commit -m "chore(driver-app): add debug-APK build scripts"
```

---

### Task 3: Migration 007 + manager settings repository/endpoints (Feature B, part 1)

**Files:**
- Create: `fuel-backend/migrations/007_route_optimization.sql`
- Create: `fuel-backend/src/dispatch/services/manager-settings.repository.ts`
- Modify: `fuel-backend/src/dispatch/dispatch.module.ts` (register provider)
- Modify: `fuel-backend/src/dispatch/assignments.controller.ts` (add `GET`/`PATCH /settings`)
- Create: `fuel-backend/src/dispatch/services/manager-settings.repository.spec.ts` (pure default-logic test)

**Interfaces:**
- Produces (later tasks depend on these):
  - `interface ManagerSettings { requireBinPhoto: boolean }`
  - `ManagerSettingsRepository.getSettings(userId: number): Promise<ManagerSettings>` (returns `{ requireBinPhoto: true }` when no row)
  - `ManagerSettingsRepository.upsertSettings(userId: number, s: { requireBinPhoto: boolean }): Promise<void>`
  - `GET /settings` → `data: { requireBinPhoto }`; `PATCH /settings` body `{ requireBinPhoto: boolean }` → `data: { requireBinPhoto }`
  - Migration 007 also adds: `fd_route_events.remark` (Task 6), `fd_stop_completions.photo_path` nullable (Task 4), `fd_assignments.persistent` (Task 8).

- [ ] **Step 1: Write migration 007 (all shared schema)**

`fuel-backend/migrations/007_route_optimization.sql`:
```sql
-- Route-optimization enhancements: manager settings, deviation remarks,
-- nullable completion photo, persistent assignments. Additive; fd_ prefix;
-- ALTERs guarded for MySQL 8 (no ADD COLUMN IF NOT EXISTS) via a helper proc.

-- 1) Per-manager settings (photo-proof toggle).
CREATE TABLE IF NOT EXISTS fd_manager_settings (
  user_id           INT        NOT NULL,             -- gs_users.id (manager)
  require_bin_photo TINYINT(1) NOT NULL DEFAULT 1,   -- 1 = photo required to complete a bin
  updated_at        DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Idempotent ADD COLUMN helper (works on MySQL 8 and MariaDB).
DROP PROCEDURE IF EXISTS fd_add_col;
DELIMITER $$
CREATE PROCEDURE fd_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE ', tbl, ' ADD COLUMN ', ddl);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END $$
DELIMITER ;

-- 2) Deviation remarks (operator-entered, distinct from system note).
CALL fd_add_col('fd_route_events', 'remark', 'remark VARCHAR(512) NULL');

-- 3) Persistent assignments.
CALL fd_add_col('fd_assignments', 'persistent', 'persistent TINYINT(1) NOT NULL DEFAULT 0');

-- 4) Completion photo becomes optional (manager may disable the requirement).
--    MODIFY is naturally idempotent — re-running just re-asserts NULL-able.
ALTER TABLE fd_stop_completions MODIFY COLUMN photo_path VARCHAR(512) NULL;

DROP PROCEDURE IF EXISTS fd_add_col;
```

- [ ] **Step 2: Write the failing default-logic test**

The repository's only non-SQL logic is the "no row → default true" mapping. Test it against a fake DataSource.

`fuel-backend/src/dispatch/services/manager-settings.repository.spec.ts`:
```typescript
import { ManagerSettingsRepository } from './manager-settings.repository';

function repo(rows: any[]) {
  const ds = { query: jest.fn().mockResolvedValue(rows) };
  return { r: new ManagerSettingsRepository(ds as any), ds };
}

describe('ManagerSettingsRepository.getSettings', () => {
  it('defaults requireBinPhoto to true when no row exists', async () => {
    const { r } = repo([]);
    expect(await r.getSettings(1)).toEqual({ requireBinPhoto: true });
  });

  it('maps require_bin_photo=0 to false', async () => {
    const { r } = repo([{ require_bin_photo: 0 }]);
    expect(await r.getSettings(1)).toEqual({ requireBinPhoto: false });
  });

  it('maps require_bin_photo=1 to true', async () => {
    const { r } = repo([{ require_bin_photo: 1 }]);
    expect(await r.getSettings(1)).toEqual({ requireBinPhoto: true });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd fuel-backend && npx jest src/dispatch/services/manager-settings.repository.spec.ts --verbose`
Expected: FAIL — `Cannot find module './manager-settings.repository'`

- [ ] **Step 4: Write the repository**

`fuel-backend/src/dispatch/services/manager-settings.repository.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface ManagerSettings {
  requireBinPhoto: boolean;
}

@Injectable()
export class ManagerSettingsRepository {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async getSettings(userId: number): Promise<ManagerSettings> {
    const rows = await this.ds.query(
      `SELECT require_bin_photo FROM fd_manager_settings WHERE user_id = ? LIMIT 1`,
      [userId],
    );
    if (!rows.length) return { requireBinPhoto: true };
    return { requireBinPhoto: rows[0].require_bin_photo === 1 };
  }

  async upsertSettings(userId: number, s: { requireBinPhoto: boolean }): Promise<void> {
    await this.ds.query(
      `INSERT INTO fd_manager_settings (user_id, require_bin_photo)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE require_bin_photo = VALUES(require_bin_photo)`,
      [userId, s.requireBinPhoto ? 1 : 0],
    );
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd fuel-backend && npx jest src/dispatch/services/manager-settings.repository.spec.ts --verbose`
Expected: PASS (3 tests)

- [ ] **Step 6: Register provider + add endpoints**

In `dispatch.module.ts`: import `ManagerSettingsRepository` and add it to `providers`.

In `assignments.controller.ts`: import and inject `private readonly settings: ManagerSettingsRepository` in the constructor (append after the existing deps). Add a DTO near the other DTOs in `dispatch.dto.ts`:
```typescript
export class UpdateSettingsDto {
  @IsBoolean()
  requireBinPhoto: boolean;
}
```
(add `IsBoolean` to the existing `class-validator` import if not present). Then add these routes to `AssignmentsController` (place `settings` before `@Get(':id')`, next to `monitor`/`alerts`):
```typescript
  @Get('settings')
  async getSettings(@Request() req: any) {
    const data = await this.settings.getSettings(req.user.id);
    return { success: true, message: 'Settings', data };
  }

  @Patch('settings')
  async updateSettings(@Request() req: any, @Body() dto: UpdateSettingsDto) {
    await this.settings.upsertSettings(req.user.id, { requireBinPhoto: dto.requireBinPhoto });
    const data = await this.settings.getSettings(req.user.id);
    return { success: true, message: 'Settings updated', data };
  }
```
(`@Patch` and `UpdateSettingsDto` must be added to the imports.)

- [ ] **Step 7: Verify compile + focused tests**

Run: `cd fuel-backend && npx tsc --noEmit -p tsconfig.json` → clean
Run: `cd fuel-backend && npx jest src/dispatch --verbose` → all pass

- [ ] **Step 8: Commit**

```bash
git add fuel-backend/migrations/007_route_optimization.sql fuel-backend/src/dispatch/services/manager-settings.repository.ts fuel-backend/src/dispatch/services/manager-settings.repository.spec.ts fuel-backend/src/dispatch/dispatch.module.ts fuel-backend/src/dispatch/assignments.controller.ts fuel-backend/src/dispatch/dto/dispatch.dto.ts
git commit -m "feat(dispatch): manager settings (photo-proof toggle) + migration 007"
```

---

### Task 4: Enforce photo-proof toggle in completion (Feature B, part 2 — backend)

**Files:**
- Modify: `fuel-backend/src/dispatch/services/stop-completion.service.ts`
- Modify: `fuel-backend/src/dispatch/driver-portal.controller.ts` (`completeStop` + `jobDetail`)
- Modify: `fuel-backend/src/dispatch/services/stop-completion.service.spec.ts`

**Interfaces:**
- Consumes: `ManagerSettingsRepository.getSettings(userId)` (Task 3).
- Produces: `complete(...)` gains a `requirePhoto: boolean` argument; `photoPath` becomes `string | null`. `GET /me/jobs/:id` `data` gains `requirePhoto: boolean`.

- [ ] **Step 1: Update the failing tests**

In `stop-completion.service.spec.ts`, the `makeFakes` helper builds the service. Add a `settings` fake and pass it, and add a photo-gate test. Update the constructor call in `makeFakes` to:
```typescript
  const settings = { getSettings: jest.fn(async () => ({ requireBinPhoto: true })) };
  const svc = new StopCompletionService(assignments as any, routes as any, completions as any, settings as any);
  return { svc, assignments, routes, completions, settings, events, statusCalls, store };
```
The existing `complete(...)` calls in tests pass `input` without `requirePhoto`; change the service signature so `requirePhoto` is a separate 5th arg (see Step 3) and update each call to pass `true` (photo present) — e.g. `f.svc.complete(3, 5, 11, AT_BIN_1, true)`. Add:
```typescript
  it('rejects a photoless completion when a photo is required', async () => {
    const f = makeFakes({});
    await expect(
      f.svc.complete(3, 5, 11, { lat: 0, lng: 0.0001, photoPath: null }, true),
    ).rejects.toThrow('A photo is required to complete a bin');
  });

  it('accepts a photoless completion when photo is not required', async () => {
    const f = makeFakes({});
    const r = await f.svc.complete(3, 5, 11, { lat: 0, lng: 0.0001, photoPath: null }, false);
    expect(r.completion.stopId).toBe(11);
  });
```
(`AT_BIN_1` already has `photoPath: 'completions/x.jpg'`; leave the other tests passing `true`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd fuel-backend && npx jest src/dispatch/services/stop-completion.service.spec.ts --verbose`
Expected: FAIL (arity/assertion mismatch — new arg + photoless behavior not implemented)

- [ ] **Step 3: Update the service**

In `stop-completion.service.ts`: import nothing new. Change `photoPath` type and add the `requirePhoto` param + gate:
```typescript
  async complete(
    driverId: number,
    assignmentId: number,
    stopId: number,
    input: {
      lat: number;
      lng: number;
      accuracyM?: number | null;
      note?: string | null;
      photoPath: string | null;
    },
    requirePhoto: boolean,
  ): Promise<CompleteStopResult> {
    const assignment = await this.assignments.getForDriver(driverId, assignmentId);
    if (!ACTIVE_STATUSES.includes(assignment.status)) {
      throw new BadRequestException('Job is not active');
    }
    if (requirePhoto && !input.photoPath) {
      throw new BadRequestException('A photo is required to complete a bin');
    }
    // ...rest unchanged, but the `add({...})` call now passes photoPath: input.photoPath (may be null)...
```
The constructor stays as-is for the service's own deps — `ManagerSettingsRepository` is resolved in the controller (Step 4), not injected here, so the service remains a pure orchestration unit that is *told* whether a photo is required. (Do not inject settings into the service — keep the decision at the controller boundary.)

- [ ] **Step 4: Update the driver controller**

In `driver-portal.controller.ts`:
- Import and inject `ManagerSettingsRepository` (`private readonly settings: ManagerSettingsRepository`).
- In `completeStop`, replace the hard photo check with a settings-driven one. The endpoint currently rejects a missing photo unconditionally; instead resolve the flag and let the service enforce it. Load the assignment's owning manager first:
```typescript
    const assignment = await this.assignments.getForDriver(req.user.driverId, id);
    const { requireBinPhoto } = await this.settings.getSettings(assignment.userId);

    let photoPath: string | null = null;
    if (file?.buffer?.length) {
      const dir = join(UPLOADS_DIR, 'completions');
      await fs.mkdir(dir, { recursive: true });
      const ext = (file.originalname.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
      const name = `bin_${id}_${stopId}_${Date.now()}.${ext}`;
      await fs.writeFile(join(dir, name), file.buffer);
      photoPath = `completions/${name}`;
    }

    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      if (photoPath) await fs.unlink(join(UPLOADS_DIR, photoPath)).catch(() => {});
      throw new BadRequestException('Location is required — enable GPS and try again');
    }

    const accuracyM = body.accuracyM != null && body.accuracyM !== '' ? Number(body.accuracyM) : null;
    let data;
    try {
      data = await this.stopCompletions.complete(
        req.user.driverId, id, stopId,
        {
          lat, lng,
          accuracyM: Number.isFinite(accuracyM as number) ? accuracyM : null,
          note: body.note || null,
          photoPath,
        },
        requireBinPhoto,
      );
    } catch (err) {
      if (photoPath) await fs.unlink(join(UPLOADS_DIR, photoPath)).catch(() => {});
      throw err;
    }
    return {
      success: true,
      message: data.jobCompleted ? 'Bin completed — job finished' : 'Bin completed',
      data,
    };
```
(The photo is now optional at the controller; the service raises the exact `"A photo is required…"` error when `requireBinPhoto` is true and none was sent. Note the unlink path uses `join(UPLOADS_DIR, photoPath)` since `photoPath` already includes the `completions/` prefix.)

- In `jobDetail()`, add the flag to the response so the driver app knows whether to force a photo:
```typescript
    const { requireBinPhoto } = await this.settings.getSettings(assignment.userId);
    // ...existing stopCompletions fetch...
    return {
      success: true,
      message: 'Job fetched',
      data: { assignment, route: { /* ...unchanged... */ }, stopCompletions, requirePhoto: requireBinPhoto },
    };
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd fuel-backend && npx jest src/dispatch --verbose` → all pass (incl. 2 new)
Run: `cd fuel-backend && npx tsc --noEmit -p tsconfig.json` → clean

- [ ] **Step 6: Commit**

```bash
git add fuel-backend/src/dispatch/services/stop-completion.service.ts fuel-backend/src/dispatch/services/stop-completion.service.spec.ts fuel-backend/src/dispatch/driver-portal.controller.ts
git commit -m "feat(dispatch): honor manager photo-proof toggle on bin completion"
```

---

### Task 5: Photo-toggle UI + driver enforcement (Feature B, part 3 — frontend)

**Files:**
- Modify: `fuel-dashboard/src/lib/dispatch.ts` (add `getSettings`/`updateSettings`; `getMyJob` return gains `requirePhoto`)
- Modify: `fuel-dashboard/src/app/dispatch/page.tsx` (a settings toggle)
- Modify: `fuel-dashboard/src/app/driver/job/page.tsx` (`completeBin` respects `requirePhoto`)

**Interfaces:**
- Consumes: `GET/PATCH /settings` (Task 3), `requirePhoto` in job payload (Task 4).

- [ ] **Step 1: Add API functions + type**

In `dispatch.ts`:
```typescript
export interface ManagerSettings { requireBinPhoto: boolean }

export const getSettings = (token: string) =>
  request<ManagerSettings>("/assignments/settings", {}, token);

export const updateSettings = (token: string, requireBinPhoto: boolean) =>
  request<ManagerSettings>(
    "/assignments/settings",
    { method: "PATCH", body: JSON.stringify({ requireBinPhoto }) },
    token,
  );
```
Update `getMyJob`'s return type to include `requirePhoto: boolean`:
```typescript
export const getMyJob = (token: string, id: number) =>
  request<{ assignment: Assignment; route: RouteDetail; stopCompletions: StopCompletion[]; requirePhoto: boolean }>(
    `/me/jobs/${id}`, {}, token,
  );
```

- [ ] **Step 2: Add the toggle to the dispatch page**

In `dispatch/page.tsx`, add state and load it alongside the existing loads, then render a small toggle in the header/toolbar area. Minimal, matching existing controls:
```typescript
  const [requirePhoto, setRequirePhoto] = useState(true);
  // in the existing load effect's Promise.all, add getSettings(token) and setRequirePhoto(s.requireBinPhoto)
  async function togglePhoto() {
    if (!token) return;
    const next = !requirePhoto;
    setRequirePhoto(next);
    try { await updateSettings(token, next); } catch { setRequirePhoto(!next); }
  }
```
Render (near the tab bar):
```tsx
  <label className="flex items-center gap-2 text-xs text-gray-600">
    <input type="checkbox" checked={requirePhoto} onChange={togglePhoto} />
    Require completion photo from drivers
  </label>
```
(Import `getSettings, updateSettings` from `@/lib/dispatch`.)

- [ ] **Step 3: Driver respects the flag**

In `driver/job/page.tsx` `completeBin`, the photo is currently always captured. Make it conditional on `data.requirePhoto`:
```typescript
  async function completeBin(stopId: number) {
    if (!token) return;
    setCompletingStopId(stopId);
    setError(null);
    try {
      let photo: { blob: Blob } | null = null;
      if (data?.requirePhoto) {
        photo = await capturePhoto();
        if (!photo) { setCompletingStopId(null); return; }
      }
      const pos = await new Promise<GeolocationPosition | null>((resolve) => {
        if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition((p) => resolve(p), () => resolve(null), { enableHighAccuracy: true, timeout: 10000 });
      });
      if (!pos) { setError("Location is required — enable GPS and try again"); return; }
      await completeStop(token, id, stopId, {
        photo: photo?.blob,
        lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy,
      });
      await load();
    } catch (e: any) {
      if (String(e?.message).includes("already completed")) await load();
      else setError(e?.message || "Failed to complete bin");
    } finally {
      setCompletingStopId(null);
    }
  }
```
Change `completeStop`'s signature in `dispatch.ts` so `photo` is optional (`photo?: Blob`) and only appended to the form when present:
```typescript
export async function completeStop(
  token: string, jobId: number, stopId: number,
  data: { photo?: Blob; lat: number; lng: number; accuracyM?: number; note?: string },
): Promise<{ completion: StopCompletion; jobCompleted: boolean; stopCompletions: StopCompletion[] }> {
  const base = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3007"}/api`;
  const form = new FormData();
  if (data.photo) form.append("photo", data.photo, "bin.jpg");
  form.append("lat", String(data.lat));
  form.append("lng", String(data.lng));
  if (data.accuracyM != null) form.append("accuracyM", String(data.accuracyM));
  if (data.note) form.append("note", data.note);
  const res = await fetch(`${base}/me/jobs/${jobId}/stops/${stopId}/complete`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.message || `Completion failed (${res.status})`);
  return json.data;
}
```

- [ ] **Step 4: Verify build**

Run: `cd fuel-dashboard && npm run build` → succeeds

- [ ] **Step 5: Commit**

```bash
git add fuel-dashboard/src/lib/dispatch.ts fuel-dashboard/src/app/dispatch/page.tsx fuel-dashboard/src/app/driver/job/page.tsx
git commit -m "feat(dispatch): photo-proof toggle UI + driver honors it"
```

---

### Task 6: Skip-stop alerts + deviation remarks (Feature A — backend)

**Files:**
- Modify: `fuel-backend/src/dispatch/services/monitoring.service.ts` (`persistFindings`)
- Modify: `fuel-backend/src/dispatch/services/assignment.repository.ts` (`listSkippedStopIds`, broaden `listDeviationAlertsSince`, `setEventRemark`)
- Modify: `fuel-backend/src/dispatch/assignments.controller.ts` (remark endpoint)
- Modify: `fuel-backend/src/dispatch/assignments.controller.alerts.spec.ts` (extend fakes for new shape)
- Create: `fuel-backend/src/dispatch/services/assignment.repository.remark.spec.ts`

**Interfaces:**
- Consumes: `DeviationAnalysis.missedStopSeqs` (already computed, see `deviation.service.ts:46`), `addEvent`, `listArrivedStopIds` pattern.
- Produces:
  - New event `type: 'stop_skipped'` (deduped per stop).
  - `listDeviationAlertsSince` returns items with added `alertType: 'deviation' | 'stop_skipped'` and `stopName: string | null`.
  - `setEventRemark(userId, assignmentId, eventId, remark): Promise<boolean>` (false if the event isn't the manager's).
  - `PATCH /assignments/:id/events/:eventId/remark` body `{ remark: string }`.

- [ ] **Step 1: Emit skip events (dedup like arrivals)**

In `assignment.repository.ts`, add next to `listArrivedStopIds`:
```typescript
  /** Stop ids already flagged as skipped — so monitoring emits each once. */
  async listSkippedStopIds(assignmentId: number): Promise<number[]> {
    const rows = await this.ds.query(
      `SELECT DISTINCT stop_id FROM fd_route_events
       WHERE assignment_id = ? AND type = 'stop_skipped' AND stop_id IS NOT NULL`,
      [assignmentId],
    );
    return rows.map((r: any) => r.stop_id as number);
  }
```
In `monitoring.service.ts` `persistFindings`, after the arrivals loop (before the geofence auto-advance block), add:
```typescript
    // Skip alerts — emit each missed stop once.
    const skipped = new Set(
      await this.assignments.listSkippedStopIds(assignment.assignmentId),
    );
    for (const seq of analysis.missedStopSeqs) {
      const stop: any = stopsBySeq.get(seq);
      if (!stop || skipped.has(stop.stopId)) continue;
      await this.assignments.addEvent(assignment.assignmentId, {
        type: 'stop_skipped',
        stopId: stop.stopId,
        lat: stop.lat,
        lng: stop.lng,
        actor: 'system',
        note: `Skipped ${stop.name || 'stop ' + seq}`,
      });
    }
```

- [ ] **Step 2: Broaden the alert feed + add remark writer (write failing tests first)**

Create `fuel-backend/src/dispatch/services/assignment.repository.remark.spec.ts` — a focused test that `setEventRemark` scopes by manager and returns false when the event isn't theirs, using a fake DataSource:
```typescript
import { AssignmentRepository } from './assignment.repository';

function repo(updateResult: any) {
  const ds = { query: jest.fn().mockResolvedValue(updateResult) };
  return { r: new AssignmentRepository(ds as any), ds };
}

describe('AssignmentRepository.setEventRemark', () => {
  it('returns true when a row was updated (event belongs to the manager)', async () => {
    const { r, ds } = repo({ affectedRows: 1 });
    const ok = await r.setEventRemark(42, 5, 900, 'traffic jam');
    expect(ok).toBe(true);
    // scoped by user_id + assignment_id + event_id
    expect(ds.query).toHaveBeenCalledWith(expect.stringContaining('a.user_id = ?'), expect.arrayContaining([42, 5, 900]));
  });

  it('returns false when no row matched (not the managers event)', async () => {
    const { r } = repo({ affectedRows: 0 });
    expect(await r.setEventRemark(42, 5, 900, 'x')).toBe(false);
  });
});
```
Run: `cd fuel-backend && npx jest src/dispatch/services/assignment.repository.remark.spec.ts --verbose` → FAIL (`setEventRemark` not a function).

- [ ] **Step 3: Implement `setEventRemark` + broaden `listDeviationAlertsSince`**

In `assignment.repository.ts`, add:
```typescript
  /** Set the operator remark on one deviation/skip event, scoped to the manager. */
  async setEventRemark(
    userId: number,
    assignmentId: number,
    eventId: number,
    remark: string,
  ): Promise<boolean> {
    const res = await this.ds.query(
      `UPDATE fd_route_events e
       JOIN fd_assignments a ON a.assignment_id = e.assignment_id
       SET e.remark = ?
       WHERE e.event_id = ? AND e.assignment_id = ? AND a.user_id = ?`,
      [remark, eventId, assignmentId, userId],
    );
    return (res?.affectedRows ?? 0) > 0;
  }
```
Broaden `listDeviationAlertsSince` to include skip events, the alert type, and the stop name:
```typescript
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
      alertType: string;
      stopName: string | null;
      at: Date;
    }>
  > {
    const rows = await this.ds.query(
      `SELECT e.event_id, e.assignment_id, e.distance_m, e.type AS alert_type,
              e.created_at, d.driver_name, r.name AS route_name, s.name AS stop_name
       FROM fd_route_events e
       JOIN fd_assignments a ON a.assignment_id = e.assignment_id
       LEFT JOIN gs_user_object_drivers d ON d.driver_id = a.driver_id
       LEFT JOIN fd_routes r ON r.route_id = a.route_id
       LEFT JOIN fd_route_stops s ON s.stop_id = e.stop_id
       WHERE a.user_id = ? AND e.type IN ('deviation','stop_skipped') AND e.event_id > ?
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
      alertType: r.alert_type,
      stopName: r.stop_name ?? null,
      at: r.created_at,
    }));
  }
```

- [ ] **Step 4: Add the remark endpoint**

In `assignments.controller.ts`, add a DTO to `dispatch.dto.ts`:
```typescript
export class SetRemarkDto {
  @IsString()
  @MaxLength(512)
  remark: string;
}
```
(add `MaxLength` to the `class-validator` import if missing). Add the route (after `:id/events`):
```typescript
  @Patch(':id/events/:eventId/remark')
  async setRemark(
    @Request() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() dto: SetRemarkDto,
  ) {
    const ok = await this.assignments.setEventRemark(req.user.id, id, eventId, dto.remark);
    if (!ok) throw new NotFoundException('Event not found');
    return { success: true, message: 'Remark saved', data: { eventId, remark: dto.remark } };
  }
```
(`NotFoundException` and `MaxLength`/`SetRemarkDto` must be imported.)

- [ ] **Step 5: Fix the existing alerts spec for the new shape**

`assignments.controller.alerts.spec.ts` builds alert objects; add `alertType` and `stopName` to the two sample alerts in the "returns alerts" test so the assertion still reflects the real shape (the controller passes them through unchanged, so only the fake data needs the fields):
```typescript
      { eventId: 901, assignmentId: 5, driverName: 'Ahmed', routeName: 'North', distanceM: 480, alertType: 'deviation', stopName: null, at: new Date() },
      { eventId: 905, assignmentId: 6, driverName: 'Bilal', routeName: 'South', distanceM: null, alertType: 'stop_skipped', stopName: 'Bin 6', at: new Date() },
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd fuel-backend && npx jest src/dispatch --verbose` → all pass (incl. new remark spec)
Run: `cd fuel-backend && npx tsc --noEmit -p tsconfig.json` → clean

- [ ] **Step 7: Commit**

```bash
git add fuel-backend/src/dispatch/services/monitoring.service.ts fuel-backend/src/dispatch/services/assignment.repository.ts fuel-backend/src/dispatch/services/assignment.repository.remark.spec.ts fuel-backend/src/dispatch/assignments.controller.ts fuel-backend/src/dispatch/assignments.controller.alerts.spec.ts fuel-backend/src/dispatch/dto/dispatch.dto.ts
git commit -m "feat(dispatch): skip-stop alerts + operator remarks on deviations"
```

---

### Task 7: Skip-alert wording + remarks UI (Feature A — frontend)

**Files:**
- Modify: `fuel-dashboard/src/lib/dispatch.ts` (`DeviationAlert` gains `alertType`/`stopName`; add `setEventRemark`)
- Modify: `fuel-dashboard/src/components/AlertWatcher.tsx` (toast wording)
- Modify: `fuel-dashboard/src/components/dispatch/LiveMonitor.tsx` (remark input on deviation/skip events)

**Interfaces:**
- Consumes: alerts feed + `PATCH .../remark` (Task 6). `RouteEvent` in `LiveStatus.events` already carries `eventId`, `type`, `note`; it now also has `remark` (add to the type).

- [ ] **Step 1: Types + API function**

In `dispatch.ts`, extend `DeviationAlert`:
```typescript
export interface DeviationAlert {
  eventId: number;
  assignmentId: number;
  driverName: string | null;
  routeName: string | null;
  distanceM: number | null;
  alertType: string;
  stopName: string | null;
  at: string;
}
```
Add `remark?: string | null` to the `RouteEvent` interface. Add:
```typescript
export const setEventRemark = (token: string, assignmentId: number, eventId: number, remark: string) =>
  request<{ eventId: number; remark: string }>(
    `/assignments/${assignmentId}/events/${eventId}/remark`,
    { method: "PATCH", body: JSON.stringify({ remark }) },
    token,
  );
```

- [ ] **Step 2: Toast wording for skip vs off-route**

In `AlertWatcher.tsx`, replace the toast title/description construction with:
```typescript
            const isSkip = a.alertType === "stop_skipped";
            toast.show({
              tone: "error",
              title: isSkip
                ? `${a.driverName || "Driver"} skipped ${a.stopName || "a stop"}`
                : `${a.driverName || "Driver"} is ${a.distanceM != null ? `${a.distanceM}m ` : ""}off route`,
              description: `${a.routeName || "Route"} — tap to open the live monitor`,
              href: "/dispatch/monitor",
              duration: 10_000,
            });
```

- [ ] **Step 3: Remark input on the monitor event log**

In `LiveMonitor.tsx`, the event log maps `live!.events`. For rows where `ev.type === "deviation" || ev.type === "stop_skipped"`, render an inline remark editor. Add local state `const [remarks, setRemarks] = useState<Record<number, string>>({})` and a saver:
```typescript
  async function saveRemark(ev: RouteEvent) {
    if (!token) return;
    try {
      await setEventRemark(token, assignmentId, ev.eventId, remarks[ev.eventId] ?? "");
      await load();
    } catch { /* surfaced on next poll */ }
  }
```
In the event row JSX, after the existing note line, for deviation/skip types:
```tsx
                {(ev.type === "deviation" || ev.type === "stop_skipped") && (
                  <div className="mt-1 flex gap-1">
                    <input
                      defaultValue={ev.remark ?? ""}
                      onChange={(e) => setRemarks((m) => ({ ...m, [ev.eventId]: e.target.value }))}
                      placeholder="Add reason…"
                      className="flex-1 min-w-0 px-1.5 py-0.5 border rounded text-[11px]"
                      style={{ borderColor: "#E5E7EB" }}
                    />
                    <button onClick={() => saveRemark(ev)} className="px-2 py-0.5 rounded text-[11px] font-semibold text-white" style={{ background: "var(--color-primary)" }}>
                      Save
                    </button>
                  </div>
                )}
```
(Import `setEventRemark`, `RouteEvent` from `@/lib/dispatch`.)

- [ ] **Step 4: Verify build**

Run: `cd fuel-dashboard && npm run build` → succeeds

- [ ] **Step 5: Commit**

```bash
git add fuel-dashboard/src/lib/dispatch.ts fuel-dashboard/src/components/AlertWatcher.tsx fuel-dashboard/src/components/dispatch/LiveMonitor.tsx
git commit -m "feat(dispatch): skip-alert wording + deviation remark input on monitor"
```

---

### Task 8: Persistent assignment + reset flow (Feature D — backend)

**Files:**
- Modify: `fuel-backend/src/dispatch/dto/dispatch.dto.ts` (`CreateAssignmentDto.persistent`)
- Modify: `fuel-backend/src/dispatch/services/assignment.repository.ts` (`create` persists flag; `resetAssignment`; `setPersistent`; map `persistent`)
- Modify: `fuel-backend/src/dispatch/services/stop-completion.service.ts` (reset instead of complete when persistent)
- Modify: `fuel-backend/src/dispatch/assignments.controller.ts` (reset + persistent endpoints)
- Modify: `fuel-backend/src/dispatch/services/stop-completion.service.spec.ts` (persistent-reset test)

**Interfaces:**
- Consumes: `AssignmentRecord` (gains `persistent: boolean`), `StopCompletionRepository`.
- Produces:
  - `AssignmentRecord.persistent: boolean`.
  - `AssignmentRepository.resetAssignment(assignmentId): Promise<void>` (delete completions + status→`assigned` + clear `completed_at` + `run_reset` event).
  - `AssignmentRepository.setPersistent(userId, assignmentId, persistent): Promise<void>`.
  - `POST /assignments/:id/reset`, `PATCH /assignments/:id/persistent`.
  - When the last bin of a **persistent** assignment completes, `complete(...)` resets instead of setting `completed`; `CompleteStopResult.jobCompleted` stays the "all bins done" signal, and a new `jobReset: boolean` tells the caller a reset happened.

- [ ] **Step 1: DTO + record mapping + repo methods**

In `dispatch.dto.ts` `CreateAssignmentDto`, add:
```typescript
  @IsOptional()
  @IsBoolean()
  persistent?: boolean;
```
In `assignment.repository.ts`:
- Add `persistent: boolean;` to `AssignmentRecord`.
- In `map()`, add `persistent: r.persistent === 1,`.
- In `create()`, extend the INSERT column list + values to include `persistent` (default 0): add `persistent` to the columns and `?` bind `data.persistent ? 1 : 0`, and add `persistent?: boolean` to the `create` `data` param type.
- Add:
```typescript
  async setPersistent(userId: number, assignmentId: number, persistent: boolean): Promise<void> {
    await this.ds.query(
      `UPDATE fd_assignments SET persistent = ? WHERE assignment_id = ? AND user_id = ?`,
      [persistent ? 1 : 0, assignmentId, userId],
    );
  }

  /** Reset a (persistent) assignment for a fresh run: clear completions, reopen. */
  async resetAssignment(assignmentId: number): Promise<void> {
    await this.ds.query(`DELETE FROM fd_stop_completions WHERE assignment_id = ?`, [assignmentId]);
    await this.ds.query(
      `UPDATE fd_assignments SET status = 'assigned', completed_at = NULL, progress_pct = NULL, off_route = 0
       WHERE assignment_id = ?`,
      [assignmentId],
    );
    await this.addEvent(assignmentId, { type: 'run_reset', actor: 'system', note: 'Assignment reset for a new run' });
  }
```

- [ ] **Step 2: Persistent-reset test (write failing first)**

In `stop-completion.service.spec.ts`, add a fake `resetAssignment` to the assignments fake (`resetAssignment: jest.fn(async () => {})`) and a persistent flag to `getForDriver`'s return via an option. Extend `makeFakes` to accept `persistent?: boolean` and have `getForDriver` return `persistent: opts.persistent ?? false`. Add:
```typescript
  it('resets a persistent job instead of completing it on the last bin', async () => {
    const f = makeFakes({
      persistent: true,
      existing: [{ id: 1, assignmentId: 5, stopId: 11, driverId: 3, lat: 0, lng: 0, accuracyM: null, distanceM: 5, inRange: true, photoPath: 'p', note: null, createdAt: new Date() }],
    });
    const r = await f.svc.complete(3, 5, 12, { lat: 0, lng: 0.0101, photoPath: 'p' }, true);
    expect(r.jobReset).toBe(true);
    expect(f.assignments.resetAssignment).toHaveBeenCalledWith(5);
    expect(f.statusCalls).toHaveLength(0); // did NOT setStatus('completed')
  });
```
Run: `cd fuel-backend && npx jest src/dispatch/services/stop-completion.service.spec.ts --verbose` → FAIL.

- [ ] **Step 3: Branch complete() on persistent**

In `stop-completion.service.ts`, extend the result type and the tail:
```typescript
export interface CompleteStopResult {
  completion: StopCompletion;
  jobCompleted: boolean;
  jobReset: boolean;
  stopCompletions: StopCompletion[];
}
```
Replace the auto-complete block:
```typescript
    const all = await this.completions.listForAssignment(assignmentId);
    const done = new Set(all.map((c) => c.stopId));
    const allDone = route.stops.every((s) => s.stopId != null && done.has(s.stopId));
    let jobReset = false;
    if (allDone) {
      if ((assignment as any).persistent) {
        await this.assignments.resetAssignment(assignmentId);
        jobReset = true;
      } else {
        await this.assignments.setStatus(assignmentId, assignment.status, 'completed', 'system');
      }
    }

    return {
      completion: all.find((c) => c.stopId === stopId)!,
      jobCompleted: allDone && !jobReset,
      jobReset,
      stopCompletions: all,
    };
```

- [ ] **Step 4: Wire create + endpoints**

In `assignments.controller.ts` `create()`, pass `persistent: dto.persistent` into `assignments.create(...)`. Add routes (before `@Get(':id')` where static, but these are param routes so place near the other `:id` mutations):
```typescript
  @Patch(':id/persistent')
  async setPersistent(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() dto: { persistent: boolean }) {
    await this.assignments.get(req.user.id, id); // ownership
    await this.assignments.setPersistent(req.user.id, id, !!dto.persistent);
    const data = await this.assignments.get(req.user.id, id);
    return { success: true, message: 'Updated', data };
  }

  @Post(':id/reset')
  async reset(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.assignments.get(req.user.id, id); // ownership
    await this.assignments.resetAssignment(id);
    const data = await this.assignments.get(req.user.id, id);
    return { success: true, message: 'Assignment reset for a new run', data };
  }
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd fuel-backend && npx jest src/dispatch --verbose` → all pass
Run: `cd fuel-backend && npx tsc --noEmit -p tsconfig.json` → clean

- [ ] **Step 6: Commit**

```bash
git add fuel-backend/src/dispatch/dto/dispatch.dto.ts fuel-backend/src/dispatch/services/assignment.repository.ts fuel-backend/src/dispatch/services/stop-completion.service.ts fuel-backend/src/dispatch/services/stop-completion.service.spec.ts fuel-backend/src/dispatch/assignments.controller.ts
git commit -m "feat(dispatch): persistent assignments that reset for a new run"
```

---

### Task 9: Persistent assignment UI (Feature D — frontend)

**Files:**
- Modify: `fuel-dashboard/src/lib/dispatch.ts` (`Assignment` gains `persistent`; add `resetAssignment`, `setPersistent`; `createAssignment` body gains `persistent`)
- Modify: `fuel-dashboard/src/app/dispatch/page.tsx` (persistent checkbox on create; "New run" button + badge on assignment rows)

**Interfaces:**
- Consumes: `POST /assignments/:id/reset`, `PATCH /assignments/:id/persistent` (Task 8).

- [ ] **Step 1: Types + API functions**

In `dispatch.ts`: add `persistent: boolean` to the `Assignment` interface. Add `persistent?: boolean` to the `createAssignment` body type. Add:
```typescript
export const resetAssignment = (token: string, id: number) =>
  request<Assignment>(`/assignments/${id}/reset`, { method: "POST" }, token);

export const setAssignmentPersistent = (token: string, id: number, persistent: boolean) =>
  request<Assignment>(`/assignments/${id}/persistent`, { method: "PATCH", body: JSON.stringify({ persistent }) }, token);
```

- [ ] **Step 2: Create-form checkbox + row controls**

In `dispatch/page.tsx` assignment-creation UI, add a `persistent` checkbox bound to a `useState` and include it in the create payload. On each assignment row, add a persistent badge when `a.persistent` and a "New run" button:
```tsx
  {a.persistent && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-semibold">persistent</span>}
  <button onClick={async () => { await resetAssignment(token!, a.assignmentId); run(); }} className="text-xs text-indigo-600 font-semibold">New run</button>
```
(`run` is the existing reload; import `resetAssignment`, `setAssignmentPersistent`.)

- [ ] **Step 3: Verify build**

Run: `cd fuel-dashboard && npm run build` → succeeds

- [ ] **Step 4: Commit**

```bash
git add fuel-dashboard/src/lib/dispatch.ts fuel-dashboard/src/app/dispatch/page.tsx
git commit -m "feat(dispatch): persistent-assignment UI (badge, new-run, create toggle)"
```

---

### Task 10: In-app map + auto-advance (Feature E — driver app)

**Files:**
- Create: `fuel-dashboard/src/components/dispatch/DriverNavMap.tsx`
- Modify: `fuel-dashboard/src/app/driver/job/page.tsx` (map-centric flow + auto-advance)

**Interfaces:**
- Consumes: `react-leaflet` (already a dependency; pattern in `DispatchMap.tsx`), `completeStop` (Task 5), `data.requirePhoto`, `stopCompletions`, `data.jobReset`/`jobCompleted` from `completeStop`'s return.
- Produces: driver-facing UI only.

- [ ] **Step 1: Read the existing map component to reuse its setup**

Read `fuel-dashboard/src/components/dispatch/DispatchMap.tsx` in full — copy its Leaflet icon fix, `MapContainer`/`TileLayer` setup, and `LatLng` usage. `DriverNavMap` is a slimmed sibling: it takes the route geometry, the stops with per-stop done/active state, the driver's live position, and centers on the active stop.

- [ ] **Step 2: Create DriverNavMap**

`fuel-dashboard/src/components/dispatch/DriverNavMap.tsx`:
```tsx
"use client";

import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect } from "react";
import { LatLng } from "@/lib/dispatch";

// Leaflet's default icon URLs break under bundlers — pin them (same as DispatchMap).
const icon = (color: string) =>
  L.divIcon({
    className: "",
    html: `<div style="background:${color};width:16px;height:16px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 3px rgba(0,0,0,.5)"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });

function Recenter({ center }: { center: LatLng | null }) {
  const map = useMap();
  useEffect(() => { if (center) map.setView([center.lat, center.lng], map.getZoom() < 14 ? 15 : map.getZoom()); }, [center, map]);
  return null;
}

export interface NavStop { seq: number; name: string | null; lat: number; lng: number; done: boolean; active: boolean }

export default function DriverNavMap({
  geometry, stops, driver, active,
}: {
  geometry: LatLng[];
  stops: NavStop[];
  driver: LatLng | null;
  active: LatLng | null;
}) {
  const first = active ?? driver ?? stops[0] ?? geometry[0] ?? { lat: 24.86, lng: 67.0 };
  return (
    <MapContainer center={[first.lat, first.lng]} zoom={14} style={{ height: "100%", width: "100%" }}>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
      {geometry.length >= 2 && <Polyline positions={geometry.map((p) => [p.lat, p.lng])} pathOptions={{ color: "#2563eb", weight: 4, opacity: 0.7 }} />}
      {stops.map((s) => (
        <Marker key={s.seq} position={[s.lat, s.lng]} icon={icon(s.done ? "#16a34a" : s.active ? "#dc2626" : "#6b7280")}>
          <Popup>{s.name || `Stop ${s.seq}`}{s.active ? " (current)" : s.done ? " (done)" : ""}</Popup>
        </Marker>
      ))}
      {driver && <Marker position={[driver.lat, driver.lng]} icon={icon("#7c3aed")}><Popup>You</Popup></Marker>}
      <Recenter center={active} />
    </MapContainer>
  );
}
```

- [ ] **Step 3: Restructure the driver job page around the map**

In `driver/job/page.tsx`:
- Add a dynamic import (Leaflet is client-only, matching `RouteBuilder`'s `dynamic(() => import("./DispatchMap"), { ssr: false })`):
```typescript
import dynamic from "next/dynamic";
const DriverNavMap = dynamic(() => import("@/components/dispatch/DriverNavMap"), { ssr: false });
import type { NavStop } from "@/components/dispatch/DriverNavMap";
```
- Track the driver's live position with a `watchPosition` effect storing `driverPos` state (reuse the geolocation pattern already in the file).
- Derive the **active stop** = first route stop whose `stopId` has no completion:
```typescript
  const completions = data.stopCompletions ?? [];
  const doneIds = new Set(completions.map((c) => c.stopId));
  const activeStop = route.stops.find((s) => s.stopId == null || !doneIds.has(s.stopId)) ?? null;
  const navStops: NavStop[] = route.stops.map((s) => ({
    seq: s.seq, name: s.name, lat: s.lat, lng: s.lng,
    done: s.stopId != null && doneIds.has(s.stopId),
    active: activeStop?.seq === s.seq,
  }));
```
- Render the map above the stop list (fixed height, e.g. 320px) and a single prominent action button that completes the **active** stop and auto-advances:
```tsx
  {activeStop && jobActive && (
    <button
      onClick={() => activeStop.stopId != null && completeBin(activeStop.stopId)}
      disabled={completingStopId != null}
      className="w-full mt-3 py-3 rounded-xl text-sm font-bold text-white disabled:opacity-50"
      style={{ background: "#16a34a" }}
    >
      {completingStopId != null ? "Saving…" : `Done — ${activeStop.name || `Stop ${activeStop.seq}`}`}
    </button>
  )}
```
- `completeBin` already calls `load()` on success, which refetches `stopCompletions`; because `activeStop` is derived from that, the map + button auto-advance to the next bin with no extra action. The map `active` prop re-centers via the `Recenter` component. Keep the existing per-row list below for visibility, and keep the "Open in Google Maps" link per stop as an optional external nav aid.
- When `completeStop` returns `jobReset` (persistent) or the job completes, `load()` reflects the new state (a reset job reopens with all bins un-done; a completed job shows completed). No timer is introduced anywhere.

- [ ] **Step 4: Verify build**

Run: `cd fuel-dashboard && npm run build` → succeeds

- [ ] **Step 5: Commit**

```bash
git add fuel-dashboard/src/components/dispatch/DriverNavMap.tsx fuel-dashboard/src/app/driver/job/page.tsx
git commit -m "feat(driver): in-app map with auto-advance to the next bin"
```

---

### Task 11: Full verification

- [ ] **Step 1: Backend — full suite + build + boot**

Run: `cd fuel-backend && npx jest --verbose` → all suites pass
Run: `cd fuel-backend && npm run build` → clean
Run (boot check, copy `.env` from the main checkout first if absent): `PORT=3902 timeout 40 node dist/main.js` → "Nest application successfully started", and the new routes (`settings`, `:id/events/:eventId/remark`, `:id/reset`, `:id/persistent`) appear in the mapped-routes log.

- [ ] **Step 2: Dashboard — build**

Run: `cd fuel-dashboard && npm run build` → succeeds (all routes prerender)

- [ ] **Step 3: Apply migration 007 to the DB**

Run (from the main checkout's `.env` credentials):
```bash
mysql -h 192.168.20.170 -u dev -p'dev@iteck123' gs < fuel-backend/migrations/007_route_optimization.sql
```
Verify: `SHOW TABLES LIKE 'fd_manager_settings'` exists; `SHOW COLUMNS FROM fd_route_events LIKE 'remark'`, `SHOW COLUMNS FROM fd_assignments LIKE 'persistent'`, and `SHOW COLUMNS FROM fd_stop_completions LIKE 'photo_path'` (Null = YES) all present. (If the CLI is unavailable, run the DDL through any client against the same DB. This is the human's step — the controller does not run DDL against the shared DB automatically.)

- [ ] **Step 4: Debug APK build (optional, needs Android SDK)**

Run: `bash fuel-driver-app/scripts/build-debug-apk.sh` → prints the `app-debug.apk` path. (Skip if no Android SDK on the build host; the script is still delivered.)

- [ ] **Step 5: End-to-end smoke test (manual, servers running)**

1. Manager: toggle "Require completion photo" off → driver completes a bin **without** a photo; toggle on → photo demanded again.
2. Driver: in-app map shows the route; tap "Done — <bin>" → bin turns green, map auto-centers on the next bin, no app switch.
3. Complete the last bin of a **persistent** assignment → job resets (bins reopen) instead of disappearing; a non-persistent one completes.
4. Force a skip (drive past a bin) → manager gets a "skipped <bin>" toast; force an off-route → "off route" toast; add a remark on the monitor and confirm it persists.
5. Save a route with OSRM unreachable → "Saved without optimization" warning shows.

- [ ] **Step 6: Use superpowers:verification-before-completion, then finish the branch**

Use superpowers:finishing-a-development-branch to merge/PR `feature/route-optimization-enhancements`.
