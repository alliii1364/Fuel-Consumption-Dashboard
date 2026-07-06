"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams, useRouter } from "next/navigation";
import { Loader2, ArrowLeft, MapPin, Flag, Camera, CheckCircle2, WifiOff } from "lucide-react";
import { getMyJob, updateMyJobStatus, uploadProof, completeStop, Assignment, RouteDetail, StopCompletion, LatLng } from "@/lib/dispatch";
import { getDriverToken } from "@/lib/driverSession";
import { storeGet, storeSet, cacheKeys } from "@/lib/native/store";
import { capturePhoto } from "@/lib/native/camera";
import { startTracking, stopTracking } from "@/lib/native/location";
import type { NavStop } from "@/components/dispatch/DriverNavMap";

// Leaflet is client-only — dynamically import so it never runs during SSR/build.
const DriverNavMap = dynamic(() => import("@/components/dispatch/DriverNavMap"), { ssr: false });

// Driver-facing forward transitions.
const NEXT: Record<string, { to: string; label: string } | null> = {
  assigned: { to: "accepted", label: "Accept job" },
  accepted: { to: "en_route", label: "Start driving" },
  en_route: { to: "arrived", label: "Mark arrived" },
  arrived: { to: "completed", label: "Complete job" },
  completed: null,
  cancelled: null,
};

type JobData = { assignment: Assignment; route: RouteDetail; stopCompletions: StopCompletion[]; requirePhoto: boolean };

function DriverJobDetailInner() {
  const search = useSearchParams();
  const router = useRouter();
  const id = Number(search.get("id"));
  const [token, setToken] = useState<string | null>(null);
  const [data, setData] = useState<JobData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [podBusy, setPodBusy] = useState(false);
  const [podDone, setPodDone] = useState(false);
  const [completingStopId, setCompletingStopId] = useState<number | null>(null);
  const [driverPos, setDriverPos] = useState<LatLng | null>(null);
  const tracking = useRef(false);

  useEffect(() => {
    const t = getDriverToken();
    if (!t) { router.replace("/driver"); return; }
    setToken(t);
  }, [router]);

  const load = useCallback(async () => {
    if (!token || !id) return;
    try {
      const fresh = await getMyJob(token, id);
      setData(fresh);
      setOffline(false);
      setError(null);
      void storeSet(cacheKeys.job(id), fresh); // cache for offline
    } catch (e: any) {
      // Offline / server unreachable — fall back to the cached copy.
      const cached = await storeGet<JobData>(cacheKeys.job(id));
      if (cached) { setData(cached); setOffline(true); setError(null); }
      else setError(e?.message || "Failed to load job");
    }
  }, [token, id]);

  useEffect(() => { load(); }, [load]);

  // Report location to the manager while the job is in progress.
  useEffect(() => {
    const status = data?.assignment.status;
    if (!token) return;
    if (status === "en_route" && !tracking.current) {
      tracking.current = true;
      void startTracking(token, id);
    } else if (status && status !== "en_route" && tracking.current) {
      tracking.current = false;
      void stopTracking();
    }
    return () => { if (tracking.current) { tracking.current = false; void stopTracking(); } };
  }, [data?.assignment.status, token, id]);

  // Live driver position for the in-app map — separate from the periodic
  // startTracking() upload above, which only reports to the manager.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition(
      (p) => setDriverPos({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  async function advance(to: string) {
    if (!token) return;
    setBusy(true);
    try {
      await updateMyJobStatus(token, id, to);
      await load();
    } catch (e: any) {
      setError(e?.message || "Update failed");
    } finally {
      setBusy(false);
    }
  }

  async function captureProof() {
    if (!token) return;
    setPodBusy(true);
    setError(null);
    try {
      const photo = await capturePhoto();
      if (!photo) { setPodBusy(false); return; }
      // Attach current position if the browser/device offers it quickly.
      const pos = await new Promise<GeolocationPosition | null>((resolve) => {
        if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition((p) => resolve(p), () => resolve(null), { timeout: 5000 });
      });
      await uploadProof(token, id, {
        photo: photo.blob,
        lat: pos?.coords.latitude,
        lng: pos?.coords.longitude,
      });
      setPodDone(true);
    } catch (e: any) {
      setError(e?.message || "Proof upload failed");
    } finally {
      setPodBusy(false);
    }
  }

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
        navigator.geolocation.getCurrentPosition(
          (p) => resolve(p),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 10000 },
        );
      });
      if (!pos) {
        setError("Location is required — enable GPS and try again");
        return;
      }
      await completeStop(token, id, stopId, {
        photo: photo?.blob,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracyM: pos.coords.accuracy,
      });
      await load();
    } catch (e: any) {
      // 409 (already completed) just means our view was stale — refresh.
      if (String(e?.message).includes("already completed")) await load();
      else setError(e?.message || "Failed to complete bin");
    } finally {
      setCompletingStopId(null);
    }
  }

  if (!data) {
    if (error) return <div className="min-h-full flex items-center justify-center p-6 text-center text-sm text-red-600">{error}</div>;
    return <div className="min-h-full flex items-center justify-center"><Loader2 className="animate-spin text-primary" /></div>;
  }

  const { assignment: a, route } = data;
  const next = NEXT[a.status];
  const canCapturePod = a.status === "en_route" || a.status === "arrived";
  const completions = data.stopCompletions ?? [];
  const completionByStop = new Map(completions.map((c) => [c.stopId, c]));
  const jobActive = a.status === "accepted" || a.status === "en_route" || a.status === "arrived";

  // Active stop = first route stop whose stopId has no completion yet. Since
  // completeBin() calls load() on success (refetching stopCompletions), this
  // recomputes on every successful completion — the map and action button
  // auto-advance to the next bin with no extra state machine or timer.
  const doneIds = new Set(completions.map((c) => c.stopId));
  const activeStop = route.stops.find((s) => s.stopId == null || !doneIds.has(s.stopId)) ?? null;
  const navStops: NavStop[] = route.stops.map((s) => ({
    seq: s.seq,
    name: s.name,
    lat: s.lat,
    lng: s.lng,
    done: s.stopId != null && doneIds.has(s.stopId),
    active: activeStop?.seq === s.seq,
  }));

  return (
    <div className="max-w-md mx-auto pb-28">
      {/* Native-style app bar */}
      <header className="sticky top-0 z-10 flex items-center gap-2 px-3 py-3 shadow-sm" style={{ background: "var(--color-primary)" }}>
        <button onClick={() => router.push("/driver")} aria-label="Back" className="p-1 -ml-1" style={{ color: "rgba(255,255,255,0.95)" }}>
          <ArrowLeft size={20} />
        </button>
        <div className="min-w-0">
          <h1 className="font-bold text-white leading-tight truncate">{route.name}</h1>
          <p className="text-[11px] truncate" style={{ color: "rgba(255,255,255,0.85)" }}>
            {a.vehicleName || a.imei} · {a.priority} priority
          </p>
        </div>
      </header>

      <div className="p-4">
        {offline && (
          <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
            <WifiOff size={14} /> Offline — showing the last saved copy of this job.
          </div>
        )}

        <div className="bg-white rounded-xl px-4 py-3 shadow-sm mb-3 flex items-center justify-between">
          <span className="text-xs font-bold px-2 py-0.5 rounded-full text-white" style={{ background: "#7c3aed" }}>
            {a.status}
          </span>
          {route.totalDistanceKm != null && (
            <p className="text-xs text-gray-500 tabular-nums">
              {route.totalDistanceKm.toFixed(1)} km
              {route.totalDurationS ? ` · ~${Math.round(route.totalDurationS / 60)} min` : ""}
            </p>
          )}
        </div>

        <div className="rounded-xl overflow-hidden shadow-sm mb-3" style={{ height: 320 }}>
          <DriverNavMap
            geometry={route.geometry ?? []}
            stops={navStops}
            driver={driverPos}
            active={activeStop ? { lat: activeStop.lat, lng: activeStop.lng } : null}
          />
        </div>

        {activeStop && jobActive && (
          <button
            onClick={() => activeStop.stopId != null && completeBin(activeStop.stopId)}
            disabled={completingStopId != null}
            className="w-full mb-3 py-3 rounded-xl text-sm font-bold text-white disabled:opacity-50"
            style={{ background: "#16a34a" }}
          >
            {completingStopId != null ? "Saving…" : `Done — ${activeStop.name || `Stop ${activeStop.seq}`}`}
          </button>
        )}

        <div className="bg-white rounded-xl p-4 shadow-sm">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Bins ({completions.length}/{route.stops.length} done)
          </p>
          <div className="flex flex-col gap-2">
            {route.stops.map((s, i) => {
              const done = s.stopId != null ? completionByStop.get(s.stopId) : undefined;
              return (
                <div key={s.stopId ?? i} className="flex items-start gap-2.5">
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0 mt-0.5"
                    style={{ background: done ? "#16a34a" : i === route.stops.length - 1 ? "#16a34a" : "var(--color-primary)" }}
                  >
                    {done ? <CheckCircle2 size={13} /> : i === route.stops.length - 1 ? <Flag size={12} /> : i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800">{s.name || `Stop ${i + 1}`}</p>
                    {done ? (
                      <p className="text-xs flex items-center gap-1.5" style={{ color: done.inRange ? "#16a34a" : "#d97706" }}>
                        <CheckCircle2 size={11} />
                        {new Date(done.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        {!done.inRange && ` · out of range · ${done.distanceM}m`}
                      </p>
                    ) : (
                      <a
                        href={`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-blue-600 flex items-center gap-1"
                      >
                        <MapPin size={11} /> Navigate
                      </a>
                    )}
                  </div>
                  {!done && jobActive && s.stopId != null && (
                    <button
                      onClick={() => completeBin(s.stopId!)}
                      disabled={completingStopId != null}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold text-white flex-shrink-0 disabled:opacity-50"
                      style={{ background: "#16a34a" }}
                    >
                      <Camera size={12} />
                      {completingStopId === s.stopId ? "Saving…" : "Complete"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {canCapturePod && (
          <button
            onClick={captureProof}
            disabled={podBusy}
            className="mt-3 w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold border disabled:opacity-50"
            style={{ borderColor: podDone ? "#16a34a" : "var(--color-border)", color: podDone ? "#16a34a" : "#374151", background: "#fff" }}
          >
            {podDone ? <><CheckCircle2 size={16} /> Proof captured</> : <><Camera size={16} /> {podBusy ? "Uploading…" : "Capture proof of delivery"}</>}
          </button>
        )}

        {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
      </div>

      {next && (
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-white border-t" style={{ borderColor: "var(--color-border)", paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}>
          <button
            onClick={() => advance(next.to)}
            disabled={busy}
            className="w-full max-w-md mx-auto block py-3 rounded-xl text-sm font-bold text-white disabled:opacity-50"
            style={{ background: "var(--color-primary)" }}
          >
            {busy ? "Updating…" : next.label}
          </button>
        </div>
      )}
    </div>
  );
}

export default function DriverJobDetail() {
  return (
    <Suspense fallback={<div className="min-h-full flex items-center justify-center"><Loader2 className="animate-spin text-primary" /></div>}>
      <DriverJobDetailInner />
    </Suspense>
  );
}
