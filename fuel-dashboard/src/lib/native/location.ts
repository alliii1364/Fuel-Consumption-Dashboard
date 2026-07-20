// Driver location reporting. While a job is active, periodically POST the
// device's GPS to the backend so the manager's live monitor tracks the driver.
//
// - Native app: prefers @capacitor-community/background-geolocation (a
//   foreground-service tracker that keeps running with the screen off). Falls
//   back to @capacitor/geolocation if that plugin isn't present.
// - Web/PWA: uses the browser Geolocation API (foreground only).
import { isNative } from "./index";
import { reportLocation } from "../dispatch";

export interface LivePing {
  lat: number;
  lng: number;
  speed?: number;
  accuracyM?: number;
}

let stopFn: (() => void) | null = null;

async function post(token: string, assignmentId: number, p: LivePing) {
  try {
    await reportLocation(token, [{ ...p, assignmentId, recordedAt: new Date().toISOString() }]);
  } catch {
    // Offline / transient — drop this ping; the next one will resync position.
  }
}

/** Begin reporting location for an active assignment. Idempotent. */
export async function startTracking(token: string, assignmentId: number): Promise<void> {
  await stopTracking();

  // Native background tracker (best-effort dynamic import).
  if (isNative()) {
    try {
      const bg: any = await import("@capacitor-community/background-geolocation");
      const watcherId = await bg.BackgroundGeolocation.addWatcher(
        {
          requestPermissions: true,
          stale: false,
          distanceFilter: 25,
          backgroundMessage: "Sharing your location for the active job",
          backgroundTitle: "FuelIQ Driver",
        },
        (loc: any, err: any) => {
          if (err || !loc) return;
          void post(token, assignmentId, {
            lat: loc.latitude,
            lng: loc.longitude,
            speed: loc.speed != null ? loc.speed * 3.6 : undefined, // m/s → km/h
            accuracyM: loc.accuracy,
          });
        },
      );
      stopFn = () => bg.BackgroundGeolocation.removeWatcher({ id: watcherId });
      return;
    } catch {
      // plugin not available — fall through to browser geolocation
    }
  }

  if (typeof navigator === "undefined" || !navigator.geolocation) return;
  const id = navigator.geolocation.watchPosition(
    (pos) => {
      void post(token, assignmentId, {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        speed: pos.coords.speed != null ? pos.coords.speed * 3.6 : undefined,
        accuracyM: pos.coords.accuracy,
      });
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
  );
  stopFn = () => navigator.geolocation.clearWatch(id);
}

export async function stopTracking(): Promise<void> {
  if (stopFn) {
    try { stopFn(); } catch {}
    stopFn = null;
  }
}
