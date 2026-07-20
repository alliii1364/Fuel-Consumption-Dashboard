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
