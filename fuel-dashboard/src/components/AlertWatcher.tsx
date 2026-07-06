"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui";
import { getDeviationAlerts } from "@/lib/dispatch";

const POLL_MS = 20_000;

/**
 * Portal-wide deviation popups: polls the alert feed while a manager is
 * signed in and toasts each new off-route event once (cursor persisted in
 * localStorage so a refresh doesn't re-toast). Inert on driver/login pages.
 */
export default function AlertWatcher() {
  const { token, username } = useAuth();
  const pathname = usePathname();
  const toast = useToast();
  const busy = useRef(false);

  const enabled =
    !!token && !pathname.startsWith("/driver") && !pathname.startsWith("/login");

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const cursorKey = `fueliq_alert_cursor_${username || "anon"}`;

    async function poll() {
      if (busy.current || cancelled) return;
      busy.current = true;
      try {
        const raw = localStorage.getItem(cursorKey);
        const since = raw != null && raw !== "" ? Number(raw) : NaN;
        const { cursor, alerts } = await getDeviationAlerts(
          token!,
          Number.isFinite(since) ? since : undefined,
        );
        localStorage.setItem(cursorKey, String(cursor));
        if (!cancelled) {
          for (const a of alerts) {
            toast.show({
              tone: "error",
              title: `${a.driverName || "Driver"} is ${a.distanceM != null ? `${a.distanceM}m ` : ""}off route`,
              description: `${a.routeName || "Route"} — tap to open the live monitor`,
              href: "/dispatch/monitor",
              duration: 10_000,
            });
          }
        }
      } catch {
        // Silent — the next poll retries.
      } finally {
        busy.current = false;
      }
    }

    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled, token, username, toast]);

  return null;
}
