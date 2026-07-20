"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import {
  Trash2, Upload, Wand2, Save, MapPin, ChevronUp, ChevronDown, X, Warehouse, Plus, Check,
} from "lucide-react";
import {
  createRoute,
  updateRoute,
  uploadKmlRoute,
  getDepots,
  createDepot,
  StopInput,
  RouteDetail,
  Depot,
} from "@/lib/dispatch";

const DispatchMap = dynamic(() => import("./DispatchMap"), { ssr: false });

interface Props {
  token: string;
  onSaved: () => void;
  /** When set, the builder edits this existing route instead of creating a new one. */
  editRoute?: RouteDetail | null;
  onCancelEdit?: () => void;
  /** Surface success/error to the parent (toast). */
  notify?: { success: (t: string, d?: string) => void; error: (t: string, d?: string) => void };
}

type BuilderStop = StopInput & { name: string; radiusM: number };

export default function RouteBuilder({ token, onSaved, editRoute, onCancelEdit, notify }: Props) {
  const isEdit = !!editRoute;
  const [name, setName] = useState("");
  const [stops, setStops] = useState<BuilderStop[]>([]);
  const [optimize, setOptimize] = useState(true);
  // KML files (Google Earth/My Maps exports, etc.) usually already encode a
  // deliberate stop order — default this to OFF so import preserves it,
  // unlike manual builds where OSRM optimization is the more useful default.
  const [kmlOptimize, setKmlOptimize] = useState(false);
  const [corridorM, setCorridorM] = useState(150);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Yard/depot state — the round-trip start & end.
  const [depots, setDepots] = useState<Depot[]>([]);
  const [selectedDepotId, setSelectedDepotId] = useState<number | null>(null);
  const [yardMode, setYardMode] = useState(false);
  const [pendingYard, setPendingYard] = useState<{ lat: number; lng: number } | null>(null);
  const [newYardName, setNewYardName] = useState("");

  const selectedDepot = depots.find((d) => d.depotId === selectedDepotId) ?? null;

  // Load the manager's yards once; default selection to their default yard.
  useEffect(() => {
    getDepots(token)
      .then((d) => {
        setDepots(d);
        setSelectedDepotId((cur) => cur ?? d.find((x) => x.isDefault)?.depotId ?? d[0]?.depotId ?? null);
      })
      .catch(() => {});
  }, [token]);

  // Hydrate the form when an edit target is supplied (and reset on exit).
  useEffect(() => {
    if (editRoute) {
      setName(editRoute.name);
      setCorridorM(editRoute.corridorBufferM ?? 150);
      setOptimize(editRoute.optimized);
      setSelectedDepotId(editRoute.depot?.depotId ?? null);
      setStops(
        editRoute.stops.map((s) => ({
          name: s.name ?? `Bin ${s.seq}`,
          lat: s.lat,
          lng: s.lng,
          type: s.type,
          radiusM: s.radiusM ?? 100,
        })),
      );
      setError(null);
    }
  }, [editRoute]);

  function resetForm() {
    setName("");
    setStops([]);
    setCorridorM(150);
    setOptimize(true);
    setKmlOptimize(false);
    setError(null);
    setYardMode(false);
    setPendingYard(null);
    setNewYardName("");
  }

  function addStop(lat: number, lng: number) {
    setStops((s) => [...s, { lat, lng, name: `Bin ${s.length + 1}`, radiusM: 100, type: "pickup" }]);
  }

  // Map clicks place the yard while in yard mode, otherwise drop a pickup bin.
  function onMapClick(lat: number, lng: number) {
    if (yardMode) setPendingYard({ lat, lng });
    else addStop(lat, lng);
  }

  async function saveYard() {
    if (!pendingYard || !newYardName.trim()) return;
    try {
      const depot = await createDepot(token, {
        name: newYardName.trim(),
        lat: pendingYard.lat,
        lng: pendingYard.lng,
      });
      setDepots(await getDepots(token));
      setSelectedDepotId(depot.depotId);
      setYardMode(false);
      setPendingYard(null);
      setNewYardName("");
      notify?.success("Yard saved", depot.name);
    } catch (e: any) {
      notify?.error("Failed to save yard", e?.message);
    }
  }
  function removeStop(i: number) {
    setStops((s) => s.filter((_, idx) => idx !== i));
  }
  function patchStop(i: number, patch: Partial<BuilderStop>) {
    setStops((s) => s.map((st, idx) => (idx === i ? { ...st, ...patch } : st)));
  }
  function moveStop(i: number, dir: -1 | 1) {
    setStops((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.length) return s;
      const next = [...s];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function save() {
    if (!name.trim()) { setError("Give the route a name"); return; }
    if (selectedDepotId == null) { setError("Select or add a yard (the route's start & end)"); return; }
    if (stops.length < 1) { setError("Add at least one pickup bin on the map"); return; }
    setSaving(true);
    setError(null);
    const payload = {
      name: name.trim(),
      depotId: selectedDepotId,
      stops: stops.map((s) => ({ name: s.name, lat: s.lat, lng: s.lng, type: s.type, radiusM: s.radiusM })),
      optimize: optimize && stops.length >= 2,
      corridorBufferM: corridorM,
    };
    try {
      if (isEdit && editRoute) {
        const saved = await updateRoute(token, editRoute.routeId, payload);
        if (saved?.degraded) notify?.error("Saved without optimization", "Routing engine unreachable — straight-line route used. Check OSRM.");
        else notify?.success("Route updated", name.trim());
        onCancelEdit?.();
      } else {
        const saved = await createRoute(token, payload);
        if (saved?.degraded) notify?.error("Saved without optimization", "Routing engine unreachable — straight-line route used. Check OSRM.");
        else notify?.success("Route created", name.trim());
        resetForm();
      }
      onSaved();
    } catch (e: any) {
      setError(e?.message || "Failed to save route");
      notify?.error("Failed to save route", e?.message);
    } finally {
      setSaving(false);
    }
  }

  async function onKml(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSaving(true);
    setError(null);
    try {
      await uploadKmlRoute(token, file, {
        name: name.trim() || undefined,
        corridorBufferM: corridorM,
        optimize: kmlOptimize,
      });
      notify?.success("KML imported", file.name);
      resetForm();
      onSaved();
    } catch (e: any) {
      setError(e?.message || "KML import failed");
      notify?.error("KML import failed", e?.message);
    } finally {
      setSaving(false);
      e.target.value = "";
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-4">
      <div className="relative rounded-xl overflow-hidden border" style={{ borderColor: "var(--color-border)", height: 460 }}>
        <DispatchMap
          stops={stops.map((s, i) => ({ ...s, seq: i + 1 }))}
          depot={
            yardMode
              ? (pendingYard ? { ...pendingYard, name: newYardName || "New yard" } : null)
              : (selectedDepot ? { lat: selectedDepot.lat, lng: selectedDepot.lng, name: selectedDepot.name } : null)
          }
          onMapClick={onMapClick}
        />
        {yardMode && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[1000] px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-lg" style={{ background: "#0f172a" }}>
            Click the map to place your yard
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="rounded-xl p-4 border" style={{ borderColor: "var(--color-border)", background: "#fff" }}>
          {isEdit && (
            <div className="flex items-center justify-between mb-3 px-2 py-1.5 rounded-lg" style={{ background: "rgba(var(--color-primary-rgb),0.08)" }}>
              <span className="text-xs font-bold" style={{ color: "var(--color-primary)" }}>
                Editing route #{editRoute!.routeId}
              </span>
              <button onClick={() => { resetForm(); onCancelEdit?.(); }} className="text-gray-400 hover:text-gray-700" title="Cancel edit">
                <X size={14} />
              </button>
            </div>
          )}

          <div className="mb-3">
            <label className="text-xs font-semibold text-gray-500 uppercase flex items-center gap-1.5">
              <Warehouse size={13} className="text-gray-700" /> Yard <span className="text-gray-400 normal-case font-normal">(start &amp; end)</span>
            </label>
            {yardMode ? (
              <div className="mt-1 flex flex-col gap-2 p-2 rounded-lg" style={{ background: "rgba(15,23,42,0.05)" }}>
                <p className="text-[11px] text-gray-500">
                  {pendingYard
                    ? `Placed at ${pendingYard.lat.toFixed(4)}, ${pendingYard.lng.toFixed(4)}`
                    : "Click the map to place the yard."}
                </p>
                <input
                  value={newYardName}
                  onChange={(e) => setNewYardName(e.target.value)}
                  placeholder="Yard name (e.g. Main Depot)"
                  className="w-full px-2 py-1.5 rounded border text-sm"
                  style={{ borderColor: "#E5E7EB" }}
                />
                <div className="flex gap-2">
                  <button
                    onClick={saveYard}
                    disabled={!pendingYard || !newYardName.trim()}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-bold text-white disabled:opacity-40"
                    style={{ background: "var(--color-primary)" }}
                  >
                    <Check size={12} /> Save yard
                  </button>
                  <button
                    onClick={() => { setYardMode(false); setPendingYard(null); setNewYardName(""); }}
                    className="px-2 py-1 rounded text-xs font-semibold text-gray-500"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-1 flex gap-2">
                <select
                  value={selectedDepotId ?? ""}
                  onChange={(e) => setSelectedDepotId(e.target.value ? Number(e.target.value) : null)}
                  className="flex-1 min-w-0 px-2 py-2 rounded-lg border text-sm bg-white"
                  style={{ borderColor: "#E5E7EB" }}
                >
                  <option value="">{depots.length ? "Select a yard…" : "No yards yet"}</option>
                  {depots.map((d) => (
                    <option key={d.depotId} value={d.depotId}>
                      {d.name}{d.isDefault ? " (default)" : ""}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => { setYardMode(true); setPendingYard(null); setNewYardName(""); }}
                  className="flex items-center gap-1 px-2.5 rounded-lg text-xs font-semibold border flex-shrink-0"
                  style={{ borderColor: "#E5E7EB", color: "#374151" }}
                  title="Add a new yard"
                >
                  <Plus size={13} /> New
                </button>
              </div>
            )}
          </div>

          <label className="text-xs font-semibold text-gray-500 uppercase">Route name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. North Karachi collection"
            className="w-full mt-1 mb-3 px-3 py-2 rounded-lg border text-sm"
            style={{ borderColor: "#E5E7EB" }}
          />

          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-500 uppercase">Corridor (m)</span>
            <input
              type="number"
              value={corridorM}
              min={20}
              onChange={(e) => setCorridorM(parseInt(e.target.value) || 150)}
              className="w-24 px-2 py-1 rounded-lg border text-sm text-right"
              style={{ borderColor: "#E5E7EB" }}
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700 mb-3 cursor-pointer">
            <input type="checkbox" checked={optimize} onChange={(e) => setOptimize(e.target.checked)} />
            <Wand2 size={14} className="text-primary" /> Optimize stop order (OSRM)
          </label>

          {error && <p className="text-xs text-red-600 mb-2">{error}</p>}

          <button
            onClick={save}
            disabled={saving}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-bold text-white disabled:opacity-50"
            style={{ background: "var(--color-primary)" }}
          >
            <Save size={15} /> {saving ? "Saving…" : isEdit ? "Update route" : "Save route"}
          </button>

          {!isEdit && (
            <>
              <label className="mt-2 w-full flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-semibold cursor-pointer border" style={{ borderColor: "#E5E7EB", color: "#374151" }}>
                <Upload size={15} /> Import KML
                <input type="file" accept=".kml" hidden onChange={onKml} />
              </label>
              <label className="flex items-center gap-2 text-xs text-gray-600 mt-1.5 cursor-pointer">
                <input type="checkbox" checked={kmlOptimize} onChange={(e) => setKmlOptimize(e.target.checked)} />
                <Wand2 size={12} className="text-primary" /> Optimize KML stop order (OSRM)
              </label>
              <p className="text-[10px] text-gray-400 mt-1">
                {kmlOptimize
                  ? "Stops will be re-sequenced by OSRM for the shortest route."
                  : "Off preserves the KML's original placemark order (1, 2, 3…)."}
              </p>
            </>
          )}
        </div>

        <div className="rounded-xl p-4 border flex-1" style={{ borderColor: "var(--color-border)", background: "#fff" }}>
          <div className="flex items-center gap-2 mb-2">
            <MapPin size={14} className="text-primary" />
            <span className="text-xs font-semibold text-gray-500 uppercase">Pickup bins ({stops.length})</span>
          </div>
          {stops.length === 0 ? (
            <p className="text-xs text-gray-400">Click the map to drop pickup bins, or import a KML file.</p>
          ) : (
            <div className="flex flex-col gap-2 max-h-72 overflow-auto">
              {stops.map((s, i) => (
                <div key={i} className="rounded-lg px-2 py-2 bg-gray-50">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-bold text-primary w-4 text-center">{i + 1}</span>
                    <input
                      value={s.name}
                      onChange={(e) => patchStop(i, { name: e.target.value })}
                      className="flex-1 min-w-0 px-2 py-1 border rounded text-xs"
                      style={{ borderColor: "#E5E7EB" }}
                      placeholder={`Stop ${i + 1}`}
                    />
                    <button onClick={() => moveStop(i, -1)} disabled={i === 0} className="text-gray-400 hover:text-gray-700 disabled:opacity-30" title="Move up">
                      <ChevronUp size={14} />
                    </button>
                    <button onClick={() => moveStop(i, 1)} disabled={i === stops.length - 1} className="text-gray-400 hover:text-gray-700 disabled:opacity-30" title="Move down">
                      <ChevronDown size={14} />
                    </button>
                    <button onClick={() => removeStop(i)} className="text-gray-400 hover:text-red-500" title="Remove">
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between mt-1 pl-6 pr-1">
                    <span className="text-[10px] text-gray-400">{s.lat.toFixed(4)}, {s.lng.toFixed(4)}</span>
                    <label className="flex items-center gap-1 text-[10px] text-gray-500">
                      radius
                      <input
                        type="number"
                        value={s.radiusM}
                        min={10}
                        onChange={(e) => patchStop(i, { radiusM: parseInt(e.target.value) || 100 })}
                        className="w-14 px-1 py-0.5 border rounded text-[10px] text-right"
                        style={{ borderColor: "#E5E7EB" }}
                      />
                      m
                    </label>
                  </div>
                </div>
              ))}
            </div>
          )}
          {optimize && stops.length >= 2 && (
            <p className="text-[10px] text-gray-400 mt-2">Stop order may be re-sequenced by OSRM on save.</p>
          )}
        </div>
      </div>
    </div>
  );
}
