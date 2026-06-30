// Driver PWA session — kept separate from the manager AuthContext so the two
// can be logged in independently (different token, different role).
const KEY = "fueliq_driver_token";

export function getDriverToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setDriverToken(token: string): void {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    /* ignore */
  }
}

export function clearDriverToken(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function driverNameFromToken(token: string): string {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.name ?? payload.username ?? "Driver";
  } catch {
    return "Driver";
  }
}
