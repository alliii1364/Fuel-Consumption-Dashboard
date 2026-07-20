// Detects whether we're running inside the Capacitor native shell (the Android
// app) vs a normal browser/PWA. Native-only plugins are dynamically imported
// behind this guard so the web build never pulls them in.
import { Capacitor } from "@capacitor/core";

export function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}
