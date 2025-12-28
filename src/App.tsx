import "./index.css";
import { computeNextTimelineTime } from "@/lib/timeline";
import { degreesToMeters } from "./util/geo";
import { mergeSnapshots, pruneSnapshots, normalizeSnapshots } from "@/lib/snapshots";
import { TimelineSlider } from "./ui/TimelineSlider";
import { useEffect, useState, useRef, useMemo } from "react";
import MapView from "./ui/MapView";
import type { ComponentUI } from "@/ui/types";
import type { Cov2 } from "./engine/component";

export function App() {
  type Snapshot = { timestamp: number; data: { components: ComponentUI[] } };
  type WorldBounds = { minX: number; minY: number; maxX: number; maxY: number };

  const [timelineTime, setTimelineTime] = useState<number | null>(null);
  const [rawSnapshotsByDevice, setRawSnapshotsByDevice] = useState<Record<number, Snapshot[]>>({});
  const rawSnapshots = useMemo(() => mergedArrayFromByDevice(rawSnapshotsByDevice), [rawSnapshotsByDevice]);
  const [engineSnapshotsByDevice, setEngineSnapshotsByDevice] = useState<Record<number, Snapshot[]>>({});
  const [refLat, setRefLat] = useState<number | null>(null);
  const [refLon, setRefLon] = useState<number | null>(null);
  const [worldBounds, setWorldBounds] = useState<WorldBounds | null>(null);
  const LS_RAW_SNAPSHOTS = "traccar:rawSnapshots";
  const LS_RAW_BY_DEVICE = "traccar:rawSnapshotsByDevice";
  const LS_UI_SHOW_RAW = "ui:showRaw";
  const LS_UI_SHOW_ESTIMATES = "ui:showEstimates";
  const LS_UI_SHOW_HISTORY = "ui:showHistory";
  const HISTORY_MS = 24 * 60 * 60 * 1000; // 24 hours

  // Safe localStorage helpers
  function safeGetItem(key: string): string | null {
    try {
      if (typeof window === "undefined") return null;
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }
  function safeSetItem(key: string, value: string | null): void {
    try {
      if (typeof window === "undefined") return;
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch (e) { }
  }
  function safeGetJSON<T = any>(key: string): T | null {
    const v = safeGetItem(key);
    if (v == null) return null;
    try { return JSON.parse(v) as T; } catch (e) { return null; }
  }

  const [showRaw, setShowRaw] = useState<boolean>(() => {
    const v = safeGetItem(LS_UI_SHOW_RAW);
    return v == null || v === "1";
  });
  const [showEstimates, setShowEstimates] = useState<boolean>(() => {
    const v = safeGetItem(LS_UI_SHOW_ESTIMATES);
    return v == null || v === "1";
  });
  const [showAllPast, setShowAllPast] = useState<boolean>(() => {
    const v = safeGetItem(LS_UI_SHOW_HISTORY);
    return v === "1";
  });

  // Persist UI toggles (combined)
  useEffect(() => {
    safeSetItem(LS_UI_SHOW_RAW, showRaw ? "1" : "0");
    safeSetItem(LS_UI_SHOW_ESTIMATES, showEstimates ? "1" : "0");
    safeSetItem(LS_UI_SHOW_HISTORY, showAllPast ? "1" : "0");
  }, [showRaw, showEstimates, showAllPast]);

  // Persist raw snapshots to localStorage
  // Avoid overwriting existing non-empty persisted data with an empty initial state on mount
  useEffect(() => {
    const existing = safeGetItem(LS_RAW_SNAPSHOTS);
    if (Array.isArray(rawSnapshots) && rawSnapshots.length === 0 && existing && existing !== "[]") {
      // Keep previously persisted non-empty snapshots and avoid clobbering them with an initial empty array
      return;
    }
    safeSetItem(LS_RAW_SNAPSHOTS, JSON.stringify(rawSnapshots));
  }, [rawSnapshots]);

  // Persist raw snapshots by device to localStorage (stronger per-device history persistence)
  // Avoid overwriting existing non-empty persisted per-device data with an empty initial state on mount
  useEffect(() => {
    const existing = safeGetItem(LS_RAW_BY_DEVICE);
    if (rawSnapshotsByDevice && Object.keys(rawSnapshotsByDevice).length === 0 && existing && existing !== "{}") {
      // Keep previously persisted non-empty by-device data and avoid clobbering it
      return;
    }
    safeSetItem(LS_RAW_BY_DEVICE, JSON.stringify(rawSnapshotsByDevice));
  }, [rawSnapshotsByDevice]);

  // small helpers to reduce duplication and keep logic in one place
  function computeDisplaySpeed(prevM: any | undefined, m: any | undefined): number | undefined {
    if (typeof m?.speed === "number") return m.speed;
    if (prevM && m && typeof m.timestamp === "number" && typeof prevM.timestamp === "number") {
      const dt = (m.timestamp - prevM.timestamp) / 1000;
      if (dt > 0) {
        const dx = (m.mean?.[0] ?? 0) - (prevM.mean?.[0] ?? 0);
        const dy = (m.mean?.[1] ?? 0) - (prevM.mean?.[1] ?? 0);
        return Math.sqrt(dx * dx + dy * dy) / dt;
      }
    }
    return undefined;
  }

  function measurementCovFromAccuracy(accuracyMeters: number): Cov2 {
    const v = accuracyMeters * accuracyMeters;
    return [v, 0, v];
  }

  async function buildEngineSnapshotsFromByDevice(byDevice: Record<string, any[]>, cutoff: number, nameMapLocal?: Record<string, string>): Promise<Snapshot[]> {
    try {
      const { Engine } = await import("@/engine/engine");
      const engineByDevice: Record<number, Snapshot[]> = {};
      const mergedEngine: Snapshot[] = [];

      for (const [deviceKey, arr] of Object.entries(byDevice)) {
        const deviceId = Number(deviceKey);
        // Normalize a variety of possible input shapes (snapshots or simple measurement objects)
        const measurements = ((arr ?? [])
          .map((s: any) => {
            if (!s) return null;
            if (s.mean) {
              return { mean: s.mean, cov: s.cov ?? measurementCovFromAccuracy(s.accuracy), timestamp: s.timestamp, accuracy: s.accuracy, lat: s.lat, lon: s.lon, speed: s.speed };
            }
            const c = s.data?.components?.[0];
            if (c) return { mean: c.mean, cov: measurementCovFromAccuracy(c.accuracy), timestamp: s.timestamp, accuracy: c.accuracy, lat: c.lat, lon: c.lon, speed: c.speed };
            if (s.x != null && s.y != null && typeof s.timestamp === "number") return { mean: [s.x, s.y], cov: measurementCovFromAccuracy(s.accuracy), timestamp: s.timestamp, accuracy: s.accuracy, lat: s.lat, lon: s.lon, speed: s.speed };
            return null;
          })
          .filter(Boolean)) as any[];

        measurements.sort((a: any, b: any) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

        if (measurements.length === 0) {
          engineByDevice[deviceId] = [];
          continue;
        }

        const enginePerDevice = new Engine();
        const engineSnapRaw = enginePerDevice.processMeasurements(measurements);
        const deviceNameValFromMap = (nameMapLocal ?? deviceNamesRef.current) ?? {};

        const engineSnap: Snapshot[] = engineSnapRaw.map((s_: any, idx: number) => {
          const m = measurements[idx];
          const prevM = measurements[idx - 1];
          const comps = s_.data.components.map((c: any) => {
            const diagMax = Math.max((c.cov?.[0] ?? 0), (c.cov?.[2] ?? 0));
            const accuracyMeters = Math.round(Math.sqrt(Math.max(1e-6, diagMax)));
            let action = (c.action as string | undefined) ?? "still";
            const displaySpeed = computeDisplaySpeed(prevM, m);
            if (!c.action && typeof displaySpeed === "number") {
              const speedThreshold = 0.5;
              if (displaySpeed > speedThreshold) action = "moving";
            }
            const deviceNameVal = deviceNameValFromMap?.[deviceId];
            const deviceIconVal = deviceIconsRef.current?.[deviceId];
            const emojiVal = deviceIconVal ?? String(deviceId).charAt(0).toUpperCase();
            return { ...c, estimate: true, accuracyMeters, action, speed: displaySpeed, device: deviceId, emoji: emojiVal, ...(deviceNameVal ? { deviceName: deviceNameVal } : {}) };
          });
          return { timestamp: s_.timestamp, data: { components: comps } };
        });

        engineSnap.sort((a, b) => a.timestamp - b.timestamp);
        engineByDevice[deviceId] = pruneSnapshots(engineSnap, cutoff);
        mergedEngine.push(...engineByDevice[deviceId]);
      }

      mergedEngine.sort((a, b) => a.timestamp - b.timestamp);
      setEngineSnapshotsByDevice(engineByDevice);
      return pruneSnapshots(mergedEngine, cutoff);
    } catch (e) {
      // ignore engine errors
      return [];
    }
  }

  function mergedArrayFromByDevice(out: Record<string, Snapshot[]>) {
    return Object.values(out).flat().sort((a, b) => a.timestamp - b.timestamp);
  }

  function ensureTimelineTimeWithinCutoff(mergedArray: Snapshot[], cutoff: number) {
    setTimelineTime((prev) =>
      prev == null ? mergedArray[mergedArray.length - 1]?.timestamp ?? Date.now() : prev < cutoff ? mergedArray[mergedArray.length - 1]?.timestamp ?? Date.now() : prev
    );
  }

  // Load persisted raw snapshots and build derived state (runs once on mount)
  useEffect(() => {
    try {
      if (typeof window === "undefined") return;

      // Prefer the newer per-device persisted format when available
      const parsedByDevice = safeGetJSON<Record<string, any>>(LS_RAW_BY_DEVICE);
      if (parsedByDevice && typeof parsedByDevice === "object") {
        const byDevice: Record<string, Snapshot[]> = {};
        const reconstructed: Snapshot[] = [];
        for (const [k, arr] of Object.entries(parsedByDevice)) {
          if (!Array.isArray(arr)) continue;
          const re = normalizeSnapshots(
            arr
              .map((snap: any) => {
                const comp = snap.data?.components?.[0];
                if (!comp) return null;
                const emojiVal = comp?.emoji ?? String(comp?.device ?? "unknown").charAt(0).toUpperCase();
                return { timestamp: snap.timestamp, data: { components: [{ ...comp, emoji: emojiVal }] } } as Snapshot;
              })
              .filter(Boolean) as Snapshot[]
          );
          if (re.length > 0) {
            byDevice[k] = re;
            reconstructed.push(...re);
          }
        }
        if (reconstructed.length === 0) return;
        const baseLat = reconstructed[0]?.data?.components?.[0]?.lat;
        const baseLon = reconstructed[0]?.data?.components?.[0]?.lon;
        if (typeof baseLat !== "number" || typeof baseLon !== "number") return;

        setRefLat(baseLat);
        setRefLon(baseLon);
        const cutoff = Date.now() - HISTORY_MS;

        setRawSnapshotsByDevice((prev) => {
          const out: Record<string, Snapshot[]> = { ...(prev ?? {}) };
          for (const [k, arr] of Object.entries(byDevice)) {
            const merged = mergeSnapshots(out[k] ?? [], arr).sort((a, b) => a.timestamp - b.timestamp);
            out[k] = pruneSnapshots(merged, cutoff);
          }
          const mergedArray = mergedArrayFromByDevice(out);
          // Ensure timelineTime is within the retained range
          ensureTimelineTimeWithinCutoff(mergedArray, cutoff);
          return out;
        });

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const s of reconstructed) {
          const m = s.data.components[0]?.mean ?? [0, 0];
          minX = Math.min(minX, m[0]);
          minY = Math.min(minY, m[1]);
          maxX = Math.max(maxX, m[0]);
          maxY = Math.max(maxY, m[1]);
        }
        // Defer setting `worldBounds` to the selected-time logic so historic raw data
        // does not force an automatic zoom on load.

        // On reload, reset timeline to the latest persisted timestamp unconditionally
        setTimelineTime(reconstructed[reconstructed.length - 1]?.timestamp ?? Date.now());

        // build engine-derived snapshots asynchronously (shared helper)
        buildEngineSnapshotsFromByDevice(byDevice, cutoff);
      }

      // Fallback to old single-array persisted snapshots (backwards compatibility)
      const parsed = safeGetJSON<any[]>(LS_RAW_SNAPSHOTS);
      if (!Array.isArray(parsed) || parsed.length === 0) return;

      const baseLat = parsed[0]?.data?.components?.[0]?.lat;
      const baseLon = parsed[0]?.data?.components?.[0]?.lon;
      if (typeof baseLat !== "number" || typeof baseLon !== "number") return;

      const reconstructed: Snapshot[] = normalizeSnapshots(
        parsed
          .map((snap: any) => {
            const comp = snap.data?.components?.[0];
            if (!comp) return null;
            const { x, y } = degreesToMeters(comp.lat, comp.lon, baseLat, baseLon);
            const emojiVal = comp?.emoji ?? String(comp?.device ?? "unknown").charAt(0).toUpperCase();
            return { timestamp: snap.timestamp, data: { components: [{ ...comp, mean: [x, y], emoji: emojiVal }] } } as Snapshot;
          })
          .filter(Boolean) as Snapshot[]
      );

      if (reconstructed.length === 0) return;

      setRefLat(baseLat);
      setRefLon(baseLon);
      const cutoff = Date.now() - HISTORY_MS;

      const byDevice: Record<string, Snapshot[]> = {};
      for (const s of reconstructed) {
        const k = String(s.data.components[0]?.device ?? "unknown");
        if (!byDevice[k]) byDevice[k] = [];
        byDevice[k].push(s);
      }
      for (const arr of Object.values(byDevice)) arr.sort((a, b) => a.timestamp - b.timestamp);

      // Merge per-device histories with any existing state instead of blindly replacing
      setRawSnapshotsByDevice((prev) => {
        const out: Record<string, Snapshot[]> = { ...(prev ?? {}) };
        for (const [k, arr] of Object.entries(byDevice)) {
          const merged = mergeSnapshots(out[k] ?? [], arr).sort((a, b) => a.timestamp - b.timestamp);
          out[k] = pruneSnapshots(merged, cutoff);
        }
        const mergedArray = mergedArrayFromByDevice(out);
        ensureTimelineTimeWithinCutoff(mergedArray, cutoff);
        return out;
      });

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of reconstructed) {
        const m = s.data.components[0]?.mean ?? [0, 0];
        minX = Math.min(minX, m[0]);
        minY = Math.min(minY, m[1]);
        maxX = Math.max(maxX, m[0]);
        maxY = Math.max(maxY, m[1]);
      }
      // Defer setting `worldBounds` to the selected-time logic so historic raw data
      // does not force an automatic zoom on load.

      // On reload, reset timeline to the latest persisted timestamp unconditionally
      setTimelineTime(reconstructed[reconstructed.length - 1]?.timestamp ?? Date.now());

      // build engine-derived snapshots asynchronously (shared helper)
      buildEngineSnapshotsFromByDevice(byDevice, cutoff);
    } catch (e) { }
  }, []);

  // Traccar connection settings (persisted in localStorage)
  const [wsUrlInput, setWsUrlInput] = useState<string>(() => safeGetItem("traccar:wsUrl") ?? "");
  const [tokenInput, setTokenInput] = useState<string>(() => safeGetItem("traccar:token") ?? "");
  // applied (active) settings used by the client; change these via Apply/Save
  const [traccarWsUrl, setTraccarWsUrl] = useState<string | null>(() => safeGetItem("traccar:wsUrl") ?? null);
  const [traccarToken, setTraccarToken] = useState<string | null>(() => safeGetItem("traccar:token") ?? null);
  const clientCloseRef = useRef<(() => void) | null>(null);
  const [deviceNames, setDeviceNames] = useState<Record<number, string>>({});
  const [deviceIcons, setDeviceIcons] = useState<Record<number, string>>({});
  // Keep a ref of device names/icons so callbacks created inside effects can read the latest mapping
  const deviceNamesRef = useRef<Record<number, string>>(deviceNames);
  const deviceIconsRef = useRef<Record<number, string>>(deviceIcons);
  useEffect(() => {
    deviceNamesRef.current = deviceNames;
  }, [deviceNames]);
  useEffect(() => {
    deviceIconsRef.current = deviceIcons;
  }, [deviceIcons]);

  // Ensure device-friendly names and icons are applied to stored snapshots when device metadata is discovered/updated
  useEffect(() => {
    if ((!deviceNames || Object.keys(deviceNames).length === 0) && (!deviceIcons || Object.keys(deviceIcons).length === 0)) return;

    const cutoff = Date.now() - HISTORY_MS;

    // Update raw snapshots per-device to include deviceName and emoji where missing or outdated
    setRawSnapshotsByDevice((prev) => {
      const prevObj = prev ?? {};
      let changed = false;
      const out: Record<number, Snapshot[]> = {};
      for (const [k, arr] of Object.entries(prevObj)) {
        const deviceId = Number(k);
        const updated = arr.map((s) => {
          const comp = (s.data?.components?.[0] ?? {}) as any;
          const desiredName = deviceNames[deviceId] ?? comp?.deviceName;
          const desiredIcon = deviceIcons[deviceId] ?? comp?.emoji;
          if (comp?.deviceName !== desiredName || comp?.emoji !== desiredIcon) {
            changed = true;
            const newComp = { ...comp, ...(desiredName ? { deviceName: desiredName } : {}), ...(desiredIcon ? { emoji: desiredIcon } : {}) };
            return { ...s, data: { components: [newComp] } } as Snapshot;
          }
          return s;
        });
        const pruned = pruneSnapshots(updated, cutoff);
        if (pruned.length !== arr.length) changed = true;
        out[deviceId] = pruned;
      }
      return changed ? out : prev;
    });

    // Update engine-derived snapshots as well so estimates show friendly names and icons
    setEngineSnapshotsByDevice((prev) => {
      const prevObj = prev ?? {};
      let changed = false;
      const out: Record<number, Snapshot[]> = {};
      for (const [k, arr] of Object.entries(prevObj)) {
        const deviceId = Number(k);
        const updated = arr.map((s) => {
          const comp = (s.data?.components?.[0] ?? {}) as any;
          const desiredName = deviceNames[deviceId] ?? comp?.deviceName;
          const desiredIcon = deviceIcons[deviceId] ?? comp?.emoji;
          if (comp?.deviceName !== desiredName || comp?.emoji !== desiredIcon) {
            changed = true;
            const newComp = { ...comp, ...(desiredName ? { deviceName: desiredName } : {}), ...(desiredIcon ? { emoji: desiredIcon } : {}) };
            return { ...s, data: { components: [newComp] } } as Snapshot;
          }
          return s;
        });
        const pruned = pruneSnapshots(updated, cutoff);
        if (pruned.length !== arr.length) changed = true;
        out[deviceId] = pruned;
      }
      if (!changed) return prev;
      return out;
    });
  }, [deviceNames, deviceIcons]);

  const [wsStatus, setWsStatus] = useState<"unknown" | "connecting" | "connected" | "disconnected" | "error">("unknown");
  const [wsError, setWsError] = useState<string | null>(null);
  const [wsApplyCounter, setWsApplyCounter] = useState(0);

  function applySettings() {
    // Persist settings safely
    safeSetItem("traccar:wsUrl", wsUrlInput || null);
    safeSetItem("traccar:token", tokenInput || null);

    setTraccarWsUrl(wsUrlInput || null);
    setTraccarToken(tokenInput || null);

    if (wsUrlInput && wsUrlInput.trim() !== "") {
      // attempt to connect
      setWsStatus("connecting");
      setWsError(null);
    } else {
      // don't attempt to connect when no URL provided
      setWsStatus("disconnected");
      setWsError("No WebSocket URL configured");
    }

    setWsApplyCounter((c) => c + 1);
  }

  function clearSettings() {
    setWsUrlInput("");
    setTokenInput("");
    // Clear persisted settings safely
    safeSetItem("traccar:wsUrl", null);
    safeSetItem("traccar:token", null);
    setTraccarWsUrl(null);
    setTraccarToken(null);
    setWsStatus("disconnected");
    setWsError(null);
    setWsApplyCounter((c) => c + 1);
  }

  function processPositions(positions: any[], nameMap?: Record<string, string>) {
    if (!positions || positions.length === 0) return;
    const nameMapLocal = nameMap ?? deviceNamesRef.current;
    const positionsWithDevice = positions.map((p) => {
      return { ...p, device: p.deviceId };
    });

    // Convert to measurements and build simple snapshots (UI-only)
    const first = positionsWithDevice[0];
    if (!first) return;
    const baseLat = first.lat;
    const baseLon = first.lon;
    setRefLat(baseLat);
    setRefLon(baseLon);

    // Group positions per device and sort each device stream by timestamp
    const posByDevice = new Map<number, any[]>();
    for (const p of positionsWithDevice) {
      const key = p.device;
      if (!posByDevice.has(key)) posByDevice.set(key, []);
      posByDevice.get(key)!.push(p);
    }
    for (const arr of posByDevice.values()) arr.sort((a, b) => a.timestamp - b.timestamp);

    // Convert all positions into meters (per-device) and compute world bounds (min/max)
    const metersByDevice = new Map<number, any[]>();
    for (const [deviceId, arr] of posByDevice) {
      const mp = arr.map((p) => {
        const { x, y } = degreesToMeters(p.lat, p.lon, baseLat, baseLon);
        const raw = (p as any).raw;
        const speed = typeof raw?.speed === "number" ? raw.speed : p.speed;
        return {
          lat: p.lat,
          lon: p.lon,
          accuracy: p.accuracy ?? 50,
          timestamp: p.timestamp,
          x,
          y,
          speed,
          device: deviceId,
        };
      });
      metersByDevice.set(deviceId, mp);
    }

    // Compute derived speeds per device (based on consecutive measurements for the same device)
    for (const mp of metersByDevice.values()) {
      for (let i = 0; i < mp.length; i++) {
        const cur = mp[i] as any;
        const prev = mp[i - 1] as any | undefined;
        if (prev && typeof cur.timestamp === "number" && typeof prev.timestamp === "number") {
          const dt = (cur.timestamp - prev.timestamp) / 1000;
          if (dt > 0) {
            const dx = cur.x - prev.x;
            const dy = cur.y - prev.y;
            cur.speed = Math.sqrt(dx * dx + dy * dy) / dt;
          } else {
            cur.speed = cur.speed ?? 0;
          }
        } else {
          cur.speed = cur.speed ?? 0;
        }
      }
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const mp of metersByDevice.values()) {
      for (const p of mp) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    const worldBoundsLocal = { minX, minY, maxX, maxY };

    // Build raw per-position snapshots (history of measurements), keep per-device and merged lists
    const rawByDevice: Record<string, Snapshot[]> = {};
    let mergedRaw: Snapshot[] = [];
    for (const [deviceKey, mp] of metersByDevice) {
      const rawArr: Snapshot[] = mp.map((p) => {
        const deviceNameVal = nameMapLocal?.[deviceKey];
        const deviceIconVal = deviceIconsRef.current?.[deviceKey];
        const emojiVal = deviceIconVal ?? String(deviceKey).charAt(0).toUpperCase();
        const comp: any = {
          mean: [p.x, p.y] as [number, number],
          cov: measurementCovFromAccuracy(p.accuracy),
          accuracy: p.accuracy,
          weight: 1,
          lat: p.lat,
          lon: p.lon,
          raw: true,
          speed: p.speed,
          device: deviceKey,
          emoji: emojiVal,
          ...(deviceNameVal ? { deviceName: deviceNameVal } : {}),
        };
        return { timestamp: p.timestamp, data: { components: [comp] } } as Snapshot;
      });
      rawArr.sort((a, b) => a.timestamp - b.timestamp);
      rawByDevice[deviceKey] = rawArr;
      mergedRaw.push(...rawArr);
    }
    mergedRaw.sort((a, b) => a.timestamp - b.timestamp);

    const cutoff = Date.now() - HISTORY_MS;

    // Merge with previous snapshots **per device** to keep per-device history persistent
    setRawSnapshotsByDevice((prevByDevice) => {
      // compute previous merged array/last timestamp so we can detect "at latest" positions
      const prevMergedArray = mergedArrayFromByDevice(prevByDevice ?? {});
      const prevLatest = prevMergedArray[prevMergedArray.length - 1]?.timestamp ?? null;

      const mergedByDevice: Record<string, Snapshot[]> = { ...(prevByDevice ?? {}) };
      for (const [deviceKey, arr] of Object.entries(rawByDevice)) {
        const existing = mergedByDevice[deviceKey] ?? [];
        const merged = mergeSnapshots(existing, arr).sort((a, b) => a.timestamp - b.timestamp);
        mergedByDevice[deviceKey] = pruneSnapshots(merged, cutoff);
      }
      // recompute merged rawSnapshots (global list) from per-device lists
      const mergedArray = Object.values(mergedByDevice).flat().sort((a, b) => a.timestamp - b.timestamp);
      const prunedMergedArray = pruneSnapshots(mergedArray, cutoff);
      mergedRaw = prunedMergedArray;

      const newLatest = prunedMergedArray[prunedMergedArray.length - 1]?.timestamp ?? null;
      // Advance timeline to new latest if the user was already at the previous latest (or timeline unset/expired)
      setTimelineTime((prevTime) => computeNextTimelineTime(prevTime, prevLatest, newLatest, cutoff));

      return mergedByDevice;
    });

    // Convert to engine measurements and run each device through its own Engine instance
    (async () => {
      const prunedMergedEngine = await buildEngineSnapshotsFromByDevice(Object.fromEntries(metersByDevice), cutoff, nameMapLocal);
      // default timeline time to the latest raw snapshot (history should be raw)
      setTimelineTime((prev) =>
        prev == null ? mergedRaw[mergedRaw.length - 1]?.timestamp ?? prunedMergedEngine[prunedMergedEngine.length - 1]?.timestamp ?? Date.now() : prev < cutoff ? mergedRaw[mergedRaw.length - 1]?.timestamp ?? prunedMergedEngine[prunedMergedEngine.length - 1]?.timestamp ?? Date.now() : prev
      );
      // Do not set world bounds from the full incoming positions (which may include history).
      // World bounds are computed from the UI-selected time and filters so historic raw data
      // doesn't trigger an automatic zoom.
    })();

  }

  useEffect(() => {
    // If there is no configured WS URL, do not attempt to connect
    if (!traccarWsUrl) {
      clientCloseRef.current?.();
      setWsStatus("disconnected");
      // leave wsError alone if it already contains a helpful message, otherwise clear
      setWsError((prev) => (prev && prev.includes("No WebSocket URL") ? prev : prev ?? null));
      return;
    }

    // update status for this connection attempt
    setWsStatus("connecting");
    setWsError(null);

    const knownDevices = new Set<number>();
    let seen = new Set<string>();
    let positionsAll: any[] = [];

    function dedupeKey(p: any) {
      return `${p.deviceId}:${p.timestamp}:${p.lat}:${p.lon}`;
    }

    function insertSortedByTimestamp(arr: any[], item: any) {
      const t = item.timestamp ?? 0;
      let lo = 0;
      let hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((arr[mid]?.timestamp ?? 0) <= t) lo = mid + 1;
        else hi = mid;
      }
      arr.splice(lo, 0, item);
    }

    // Pre-seed positionsAll and seen with persisted snapshots so old locations are preserved
    try {
      if (rawSnapshots && rawSnapshots.length > 0) {
        for (const s of rawSnapshots) {
          const comp = s.data.components[0] as any;
          const p = { timestamp: s.timestamp, lat: comp.lat, lon: comp.lon, accuracy: comp.accuracy ?? 50, speed: comp.speed ?? 0, deviceId: comp.device ?? undefined, raw: true };
          const key = dedupeKey(p);
          if (seen.has(key)) continue;
          seen.add(key);
          insertSortedByTimestamp(positionsAll, p);
          knownDevices.add(Number(comp.device));
        }
        setTimelineTime(positionsAll[positionsAll.length - 1]?.timestamp ?? Date.now());
        processPositions(positionsAll);
      }
    } catch (e) { }

    // close any previous client before creating a new one
    clientCloseRef.current?.();

    (async () => {
      try {
        const { connectRealtime, fetchPositions, fetchDevices } = await import("@/api/traccarClient");
        const client = connectRealtime({
          wsUrl: traccarWsUrl ?? undefined,
          auth: traccarToken ? { type: "token", token: traccarToken } : undefined,
          autoReconnect: true,
          defaultAccuracyMeters: 50,
          onPosition: (p) => {
            const key = dedupeKey(p);
            if (seen.has(key)) return;
            seen.add(key);
            insertSortedByTimestamp(positionsAll, p);
            knownDevices.add(Number(p.deviceId));
            processPositions(positionsAll);
          },
          onOpen: async () => {
            setWsStatus("connected");
            setWsError(null);
            // attempt resync for known devices if any (prefer WS request, fallback to REST)
            try {
              // derive base from ws url when possible for REST and devices API
              const derivedBase = (() => {
                try {
                  if (!traccarWsUrl) return undefined;
                  const u = new URL(traccarWsUrl);
                  if (u.protocol === "ws:") u.protocol = "http:";
                  if (u.protocol === "wss:") u.protocol = "https:";
                  if (u.pathname.endsWith("/api/socket")) u.pathname = u.pathname.replace(/\/socket$/, "");
                  if (u.pathname.endsWith("/socket")) u.pathname = u.pathname.replace(/\/socket$/, "");
                  return u.origin + (u.pathname === "/" ? "" : u.pathname);
                } catch (e) {
                  return undefined;
                }
              })();

              // if we can discover device names via the devices endpoint, fetch them so labels are friendly
              let deviceNameMap: Record<number, string> | undefined;
              if (derivedBase) {
                try {
                  const devices = await fetchDevices({ baseUrl: derivedBase, auth: traccarToken ? { type: "token", token: traccarToken } : undefined });
                  const nameMap: Record<number, string> = {};
                  const iconMap: Record<number, string> = {};
                  for (const d of devices) {
                    if (d && d.id != null) {
                      nameMap[d.id] = d.name ?? String(d.id);
                      if ((d as any).emoji) iconMap[d.id] = (d as any).emoji;
                    }
                  }
                  setDeviceNames(nameMap);
                  setDeviceIcons(iconMap);
                  deviceNameMap = nameMap;
                  // include discovered devices in the fetch list
                  for (const id of Object.keys(nameMap)) knownDevices.add(Number(id));
                  // refresh current positions with names and icons
                  processPositions(positionsAll, deviceNameMap);
                } catch (e) { }
              }

              for (const deviceId of knownDevices) {
                if (deviceId == null || Number.isNaN(Number(deviceId))) continue;
                const from = new Date(Math.max(0, Date.now() - HISTORY_MS));
                const to = new Date();

                try {
                  if (!derivedBase) {
                    continue;
                  }

                  const fetched = await fetchPositions({ baseUrl: derivedBase, auth: traccarToken ? { type: "token", token: traccarToken } : undefined }, Number(deviceId), from, to, {});
                  if (fetched && fetched.length > 0) {
                    for (const p of fetched) {
                      const key = dedupeKey(p);
                      if (seen.has(key)) continue;
                      seen.add(key);
                      positionsAll.push(p);
                    }
                    positionsAll.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

                    processPositions(positionsAll, deviceNameMap);
                  }
                } catch (e) { }
              }
            } catch (e) { }
          },
          onClose: (ev) => {
            const code = (ev as any)?.code;
            const reason = (ev as any)?.reason;
            const detail = code != null ? (reason ? `code=${code} reason=${reason}` : `code=${code}`) : "closed";
            setWsStatus((prev) => (prev === "error" ? "error" : "disconnected"));
            setWsError((prev) => prev ?? `WebSocket closed: ${detail}`);
            console.warn("Traccar WS closed:", ev);
          },
          onError: (err) => {
            const message = err instanceof Event ? "WebSocket connection error (check URL/token and server)" : (err && (err as any).message ? (err as any).message : String(err));
            setWsStatus("error");
            setWsError(message);
            console.warn("Traccar WS error:", err);
          },
        });

        // keep a handle for debugging and allow manual close
        (window as any).__traccarClient = client;
        clientCloseRef.current = () => {
          try {
            client.close();
          } catch (e) { }
        };
      } catch (e) {
        console.warn("Could not initialize realtime traccar client:", e);
        setWsStatus("error");
        setWsError(String(e));
      }
    })();

    // cleanup function for useEffect
    return () => {
      try {
        clientCloseRef.current?.();
      } catch (e) { }
    };
  }, [traccarWsUrl, traccarToken, wsApplyCounter]);

  // helper to find the most recent snapshot before or at a given time
  function findLatestSnapshotBeforeOrAt(snaps: Snapshot[], time: number): Snapshot | null {
    if (!Array.isArray(snaps) || snaps.length === 0) return null;
    let lo = 0;
    let hi = snaps.length - 1;
    let result: Snapshot | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = snaps[mid];
      if (!s) {
        hi = mid - 1;
        continue;
      }
      if (s.timestamp <= time) {
        result = s;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  }

  // Compute the effective time used for visibility (defaults to latest raw snapshot)
  const getEffectiveTimelineTime = () => timelineTime ?? (rawSnapshots[rawSnapshots.length - 1]?.timestamp ?? Date.now());

  // Small helper to display durations like "5m ago"
  function humanDurationSince(ts: number): string {
    const s = Math.round((Date.now() - (ts ?? Date.now())) / 1000);
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    return `${d}d ago`;
  }

  // Return the visible components at a given time according to UI toggles
  const visibleComponentsAtTime = (time: number): ComponentUI[] => {
    const engineComps = showEstimates
      ? Object.values(engineSnapshotsByDevice).flatMap((arr) => findLatestSnapshotBeforeOrAt(arr, time)?.data.components ?? [])
      : [];

    const rawComps = showRaw
      ? showAllPast
        ? rawSnapshots.filter((s) => s.timestamp <= time).flatMap((s) => s.data.components)
        : Object.values(rawSnapshotsByDevice).flatMap((arr) => findLatestSnapshotBeforeOrAt(arr, time)?.data.components ?? [])
      : [];

    return [...rawComps, ...engineComps];
  };

  const effectiveTime = useMemo(() => getEffectiveTimelineTime(), [timelineTime, rawSnapshots]);
  const visibleComponents = useMemo(() => visibleComponentsAtTime(effectiveTime), [effectiveTime, showAllPast, showRaw, showEstimates, rawSnapshots, rawSnapshotsByDevice, engineSnapshotsByDevice]);

  const frame = { components: visibleComponents };

  // Compute world bounds from the currently visible components only
  useEffect(() => {
    if (visibleComponents.length === 0) {
      setWorldBounds(null);
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of visibleComponents) {
      const m = (c as any).mean ?? [0, 0];
      if (typeof m[0] !== "number" || typeof m[1] !== "number") continue;
      minX = Math.min(minX, m[0]);
      minY = Math.min(minY, m[1]);
      maxX = Math.max(maxX, m[0]);
      maxY = Math.max(maxY, m[1]);
    }

    if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
      setWorldBounds(null);
    } else {
      setWorldBounds({ minX, minY, maxX, maxY });
    }
  }, [visibleComponents]);

  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null);

  return (
    <div className="h-screen w-screen">
      <MapView
        components={frame.components}
        refLat={refLat}
        refLon={refLon}
        worldBounds={worldBounds}
        height="100vh"
        selectedDeviceId={selectedDeviceId}
        onSelectDevice={(id) => setSelectedDeviceId(id)}
        overlay={
          <div className="flex flex-col gap-2">
            <div className="w-full">
              <div className="mb-3 p-2 rounded bg-muted/10 border">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    className="border rounded px-2 py-1 w-[36rem]"
                    placeholder="Traccar WS URL (e.g. ws://localhost:8082/api/socket)"
                    value={wsUrlInput}
                    onChange={(e) => setWsUrlInput(e.target.value)}
                  />
                  <input
                    type="password"
                    className="border rounded px-2 py-1 w-48"
                    placeholder="API Token"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                  />
                  <button className="px-3 py-1 rounded bg-primary text-white" onClick={() => applySettings()}>
                    Save
                  </button>
                  <button className="px-3 py-1 rounded border" onClick={() => clearSettings()}>
                    Clear
                  </button>
                  <button className="px-3 py-1 rounded border" onClick={() => {
                    if (!traccarWsUrl) {
                      setWsStatus("disconnected");
                      setWsError("No WebSocket URL configured");
                    } else {
                      setWsStatus("connecting");
                      setWsError(null);
                      setWsApplyCounter((c) => c + 1);
                    }
                  }}>
                    Reconnect
                  </button>
                  <button className="px-3 py-1 rounded border" onClick={() => { clientCloseRef.current?.(); setWsStatus("disconnected"); }}>
                    Disconnect
                  </button>
                </div>
                <div className="text-xs mt-2">
                  <span className="mr-2">Status: <strong>{wsStatus}</strong></span>
                  {wsError ? <span className="text-red-500">Error: {wsError}</span> : null}
                </div>
              </div>

              <TimelineSlider
                snapshots={rawSnapshots}
                time={timelineTime ?? (rawSnapshots[rawSnapshots.length - 1]?.timestamp ?? Date.now())}
                onChange={(t) => setTimelineTime(t)}
              />
              <div className="flex items-center gap-4 mt-2">
                <label className="flex items-center text-sm">
                  <input type="checkbox" className="mr-2" checked={showEstimates} onChange={(e) => setShowEstimates(e.target.checked)} />
                  Show Estimates
                </label>
                <label className="flex items-center text-sm">
                  <input type="checkbox" className="mr-2" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
                  Show Raw
                </label>
                <label className="flex items-center text-sm">
                  <input type="checkbox" className="mr-2" checked={showAllPast} onChange={(e) => setShowAllPast(e.target.checked)} />
                  Show History
                </label>
              </div>
            </div>

            {selectedDeviceId ? (
              (() => {
                const key = selectedDeviceId;
                const t = timelineTime ?? (rawSnapshots[rawSnapshots.length - 1]?.timestamp ?? Date.now());
                const rawSnap = findLatestSnapshotBeforeOrAt(rawSnapshotsByDevice[key] ?? [], t);
                const engSnap = findLatestSnapshotBeforeOrAt(engineSnapshotsByDevice[key] ?? [], t);
                const chosen = engSnap && (!rawSnap || (engSnap.timestamp ?? 0) >= (rawSnap.timestamp ?? 0)) ? engSnap : rawSnap;
                const comp = chosen?.data?.components?.[0] ?? null;
                return comp ? (
                  <div className="p-2 rounded border bg-white/90 text-foreground">
                    <div className="flex items-start">
                      <div className="flex-1">
                        <div className="text-sm font-medium">{(comp as any).deviceName ?? (comp as any).device}</div>
                        <div className="text-xs text-foreground/70">Action: {(comp as any).action ?? ""} • Accuracy: {(comp as any).accuracyMeters ??  ""}m</div>
                      </div>
                      <button aria-label="Deselect device" title="Close" className="ml-2 text-sm px-2 py-1 rounded border" onClick={() => setSelectedDeviceId(null)}>×</button>
                    </div>
                    {typeof (comp as any).speed === "number" ? <div className="text-xs text-foreground/70">Speed: {Math.round((comp as any).speed * 3.6)} km/h</div> : null}
                    <div className="text-xs text-foreground/70">Last updated: {humanDurationSince(chosen?.timestamp ?? Date.now())}</div>
                  </div>
                ) : null;
              })()
            ) : null}
          </div>
        }
      />
    </div>
  );
}

export default App;
