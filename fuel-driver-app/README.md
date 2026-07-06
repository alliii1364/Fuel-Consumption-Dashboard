# FuelIQ Driver — Android app

A Capacitor Android shell that wraps the existing `/driver` experience from
`fuel-dashboard` and adds native capabilities. Drivers log in, see their
assigned routes/stops, navigate, update job status, share their live location,
and capture proof of delivery.

## How it works

- The driver UI is the **same React code** as the web `/driver` app. We build a
  static export of it (`CAP_BUILD=1` in `fuel-dashboard`) and bundle it into
  `www/`, so the app works **offline** (assets are local; job data is cached).
- Native features are reached through a thin bridge in
  `fuel-dashboard/src/lib/native/` that uses Capacitor plugins when running in
  the app and falls back to web APIs in a browser:
  - **storage** (`@capacitor/preferences`) — offline job cache
  - **camera** (`@capacitor/camera`) — proof-of-delivery photos
  - **location** (`@capacitor-community/background-geolocation`, falls back to
    `@capacitor/geolocation`) — reports GPS while a job is `en_route`
- Backend endpoints (NestJS, role `driver`): `POST /me/devices`,
  `POST /me/location`, `POST /me/jobs/:id/proof`, plus the existing
  `/me/jobs*`. Manager views: `GET /assignments/:id/track` and
  `GET /assignments/:id/proof` (shown in the live monitor).

## Prerequisites (already set up on the build machine)

- JDK 17 at `~/tools/jdk17`, Android SDK at `~/Android/Sdk` (platform-tools,
  android-34, build-tools 34).
- Backend reachable from the device. The API base URL is **baked at build
  time** via `NEXT_PUBLIC_API_URL` (default `https://ifs.itecknologi.com`,
  i.e. the app calls `https://ifs.itecknologi.com/api`). Override it for LAN
  testing, e.g. `NEXT_PUBLIC_API_URL=http://192.168.18.199:3007`.

## Build a debug APK

```bash
export JAVA_HOME="$HOME/tools/jdk17"
export ANDROID_HOME="$HOME/Android/Sdk"

cd fuel-driver-app
# 1) export the driver UI + bundle + sync.
#    Defaults to the production backend (https://ifs.itecknologi.com).
npm run build
#    For a LAN test build instead, override the base URL:
# NEXT_PUBLIC_API_URL="http://<backend-ip>:3007" npm run build
# 2) assemble
cd android && ./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

`npm run build` = `build:web` (static export) → `prepare-www.mjs` (copy export
into `www/`, boot into `/driver.html`) → `cap sync`.

## Install on a device

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
# or copy dist/FuelIQ-Driver-debug.apk to the phone and tap to install
```

The phone must reach the backend (same LAN for the default http URL). Test
login: a driver with credentials set in the dashboard (Dispatch → Drivers).

## Permissions

Camera, fine/coarse + background location, foreground-service (location),
and notifications — declared in `android/app/src/main/AndroidManifest.xml`.
Android 13+ prompts at runtime; background location needs the user to choose
"Allow all the time".

## Not yet wired

- **Push notifications (FCM)** — needs a Firebase project
  (`google-services.json` + service-account key). The device-token endpoint
  (`POST /me/devices`) and DB table already exist; only the FCM send path and
  the native push registration remain.
- **Release signing** — currently debug-signed. For distribution, generate a
  keystore and configure `signingConfigs` in `android/app/build.gradle`.
