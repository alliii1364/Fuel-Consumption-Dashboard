"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, LogOut, MapPin, ChevronRight, Truck, Inbox } from "lucide-react";
import {
  driverLogin, getMyJobs, Assignment,
} from "@/lib/dispatch";
import {
  getDriverToken, setDriverToken, clearDriverToken, driverNameFromToken,
} from "@/lib/driverSession";
import { EmptyState, useToast } from "@/components/ui";
import { storeGet, storeSet, cacheKeys } from "@/lib/native/store";
import { initPush } from "@/lib/native/push";

const STATUS_COLORS: Record<string, string> = {
  assigned: "#6B7280", accepted: "#2563eb", en_route: "#f59e0b",
  arrived: "#16a34a", completed: "#16a34a", cancelled: "#9CA3AF",
};

export default function DriverHome() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setToken(getDriverToken());
    setReady(true);
  }, []);

  if (!ready) {
    return <Center><Loader2 className="animate-spin text-primary" /></Center>;
  }

  if (!token) {
    return <DriverLogin onLogin={(t) => { setDriverToken(t); setToken(t); }} />;
  }

  return <JobList token={token} onLogout={() => { clearDriverToken(); setToken(null); }} onOpen={(id) => router.push(`/driver/job?id=${id}`)} />;
}

function DriverLogin({ onLogin }: { onLogin: (token: string) => void }) {
  const [driverId, setDriverId] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!driverId.trim()) { setError("Enter your driver ID"); return; }
    if (!/^\d{4,8}$/.test(pin)) { setError("PIN must be 4–8 digits"); return; }
    setBusy(true); setError(null);
    try {
      const res = await driverLogin(Number(driverId), pin);
      onLogin(res.token);
    } catch (e: any) {
      setError(e?.message || "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Center>
      <form onSubmit={submit} className="w-full max-w-xs bg-white rounded-2xl p-6 shadow-sm">
        <div className="flex flex-col items-center mb-5">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-2" style={{ background: "var(--color-primary)" }}>
            <Truck size={26} color="#fff" />
          </div>
          <h1 className="font-bold text-gray-800">Driver Login</h1>
          <p className="text-xs text-gray-500">Enter your driver ID &amp; PIN</p>
        </div>
        <input
          value={driverId}
          onChange={(e) => setDriverId(e.target.value.replace(/\D/g, ""))}
          inputMode="numeric"
          placeholder="Driver ID"
          className="w-full mb-2 px-3 py-2.5 rounded-lg border text-sm"
          style={{ borderColor: "#E5E7EB" }}
        />
        <input
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
          inputMode="numeric"
          type="password"
          placeholder="PIN"
          className="w-full mb-3 px-3 py-2.5 rounded-lg border text-sm"
          style={{ borderColor: "#E5E7EB" }}
        />
        {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
        <button disabled={busy} className="w-full py-2.5 rounded-lg text-sm font-bold text-white disabled:opacity-50" style={{ background: "var(--color-primary)" }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </Center>
  );
}

function JobList({ token, onLogout, onOpen }: { token: string; onLogout: () => void; onOpen: (id: number) => void }) {
  const toast = useToast();
  const [jobs, setJobs] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);

  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    try {
      const fresh = await getMyJobs(token);
      setJobs(fresh);
      setOffline(false);
      void storeSet(cacheKeys.jobs, fresh); // cache for offline
    } catch (e: any) {
      const cached = await storeGet<Assignment[]>(cacheKeys.jobs);
      if (cached) { setJobs(cached); setOffline(true); }
      else toast.error("Failed to load jobs", e?.message);
    } finally {
      setLoading(false);
    }
  }, [token, toast]);

  useEffect(() => { load(); }, [load]);

  // Register for push notifications (native only); tapping a push opens the job.
  useEffect(() => {
    void initPush(token, onOpen);
  }, [token, onOpen]);

  return (
    <div className="max-w-md mx-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="font-bold text-gray-800">My Jobs</h1>
          <p className="text-xs text-gray-500">
            {driverNameFromToken(token)}{offline ? " · offline" : ""}
          </p>
        </div>
        <button onClick={onLogout} className="text-gray-400"><LogOut size={18} /></button>
      </div>

      {loading && <Center><Loader2 className="animate-spin text-primary" /></Center>}

      {!loading && jobs.length === 0 && (
        <EmptyState icon={Inbox} title="No active jobs" description="New assignments from your dispatcher will appear here." />
      )}

      <div className="flex flex-col gap-2.5">
        {jobs.map((j) => (
          <button key={j.assignmentId} onClick={() => onOpen(j.assignmentId)} className="text-left bg-white rounded-xl p-3.5 shadow-sm flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "rgba(var(--color-primary-rgb), 0.08)" }}>
              <MapPin size={18} className="text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-gray-800 text-sm truncate">{j.routeName || "Route"}</p>
              <p className="text-xs text-gray-500 truncate">{j.vehicleName || j.imei}</p>
            </div>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full text-white flex-shrink-0" style={{ background: STATUS_COLORS[j.status] }}>
              {j.status}
            </span>
            <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
          </button>
        ))}
      </div>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen flex items-center justify-center p-4">{children}</div>;
}
