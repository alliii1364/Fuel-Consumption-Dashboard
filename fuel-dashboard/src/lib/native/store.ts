// Persistent key/value store. Uses Capacitor Preferences (durable native
// storage) when available, falling back to localStorage in the browser.
// Used to cache job data so the driver app works offline.
import { Preferences } from "@capacitor/preferences";

export async function storeSet(key: string, value: unknown): Promise<void> {
  const v = JSON.stringify(value);
  try {
    await Preferences.set({ key, value: v });
  } catch {
    try { localStorage.setItem(key, v); } catch {}
  }
}

export async function storeGet<T>(key: string): Promise<T | null> {
  try {
    const { value } = await Preferences.get({ key });
    if (value != null) return JSON.parse(value) as T;
  } catch {
    try {
      const v = localStorage.getItem(key);
      if (v != null) return JSON.parse(v) as T;
    } catch {}
  }
  return null;
}

// Convenience helpers for the driver job cache.
export const cacheKeys = {
  jobs: "fueliq_cache_jobs",
  job: (id: number) => `fueliq_cache_job_${id}`,
};
