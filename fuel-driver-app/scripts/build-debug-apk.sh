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
