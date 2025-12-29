import "./index.css";
import { computeNextTimelineTime } from "@/lib/timeline";
import { degreesToMeters, metersToDegrees } from "./util/geo";
import { pruneSnapshots } from "@/lib/snapshots";
import { TimelineSlider } from "./ui/TimelineSlider";
import { useEffect, useState, useRef, useMemo } from "react";
import { useLocalStorageBoolean } from "@/hooks/useLocalStorage";
import MapView from "./ui/MapView";
import type { DevicePoint } from "@/ui/types";
import type { Cov2 } from "@/ui/types";
import type { EngineSnapshot } from "@/engine/engine";
import type { ComponentSnapshot } from "@/engine/mixture";
import type { NormalizedPosition } from "@/api/traccarClient";

export function App() {
  type WorldBounds = { minX: number; minY: number; maxX: number; maxY: number };

  const [timelineTime, setTimelineTime] = useState<number | null>(null);
  const [rawSnapshotsByDevice, setRawSnapshotsByDevice] = useState<Record<number, DevicePoint[]>>({});
  const rawSnapshots = useMemo(() => mergedArrayFromByDevice(rawSnapshotsByDevice), [rawSnapshotsByDevice]);
  const [engineSnapshotsByDevice, setEngineSnapshotsByDevice] = useState<Record<number, DevicePoint[]>>({});
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
  function safeGetJSON<T = unknown>(key: string): T | null {
    const v = safeGetItem(key);
    if (v == null) return null;
    try { return JSON.parse(v) as T; } catch (e) { return null; }
  }

  const [showRaw, setShowRaw] = useLocalStorageBoolean(LS_UI_SHOW_RAW, true);
  const [showEstimates, setShowEstimates] = useLocalStorageBoolean(LS_UI_SHOW_ESTIMATES, true);
  const [showAllPast, setShowAllPast] = useLocalStorageBoolean(LS_UI_SHOW_HISTORY, false);

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


  function measurementCovFromAccuracy(accuracyMeters: number): Cov2 {
    const v = accuracyMeters * accuracyMeters;
    return [v, 0, v];
  }

  async function buildEngineSnapshotsFromByDevice(byDevice: Record<string, DevicePoint[]>, cutoff: number): Promise<DevicePoint[]> {
    try {
      const { Engine } = await import("@/engine/engine");
      const engineByDevice: Record<number, DevicePoint[]> = {};
      const mergedEngine: DevicePoint[] = [];

      for (const [deviceKey, arr] of Object.entries(byDevice)) {
        const deviceId = Number(deviceKey);
        // Use DevicePoint[] directly for engine processing
        const measurements = arr.slice().sort((a: DevicePoint, b: DevicePoint) => (a.timestamp - b.timestamp));

        if (measurements.length === 0) {
          engineByDevice[deviceId] = [];
          continue;
        }

        const enginePerDevice = new Engine();
        const engineSnapRaw: EngineSnapshot[] = enginePerDevice.processMeasurements(measurements);

        const engineSnap: DevicePoint[] = engineSnapRaw.flatMap((s_: EngineSnapshot, idx: number) => {
          return s_.data.components.map((c: ComponentSnapshot) => {
            const diagMax = Math.max(c.cov[0], c.cov[2]);
            const accuracyVal = Math.max(1, Math.round(Math.sqrt(Math.max(1e-6, diagMax))));
            const { lat: compLat, lon: compLon } = typeof refLat === "number" && typeof refLon === "number" ? metersToDegrees(c.mean[0], c.mean[1], refLat, refLon) : { lat: 0, lon: 0 };
            return { mean: c.mean, cov: c.cov, timestamp: s_.timestamp, device: deviceId, lat: compLat, lon: compLon, accuracy: accuracyVal } as DevicePoint;
          });
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

  function mergedArrayFromByDevice(out: Record<string, DevicePoint[]>) {
    return Object.values(out).flat().sort((a, b) => a.timestamp - b.timestamp);
  }

  function ensureTimelineTimeWithinCutoff(mergedArray: DevicePoint[], cutoff: number) {
    setTimelineTime((prev) =>
      prev == null ? mergedArray[mergedArray.length - 1]?.timestamp ?? Date.now() : prev < cutoff ? mergedArray[mergedArray.length - 1]?.timestamp ?? Date.now() : prev
    );
  }

  // Merge incoming per-device raw snapshots with the existing state, prune by cutoff,
  // update timeline time to remain within retained range, and return the pruned merged array.
  function mergeAndApplyRawSnapshots(incomingByDevice: Record<string, DevicePoint[]>, cutoff: number): DevicePoint[] {
    let prunedMergedArray: DevicePoint[] = [];
    setRawSnapshotsByDevice((prevByDevice) => {
      const mergedByDevice: Record<string, DevicePoint[]> = { ...(prevByDevice ?? {}) };
      for (const [deviceKey, arr] of Object.entries(incomingByDevice)) {
        const existing = mergedByDevice[deviceKey] ?? [];
        const merged = [...existing, ...arr].sort((a, b) => a.timestamp - b.timestamp);
        mergedByDevice[deviceKey] = pruneSnapshots(merged, cutoff);
      }
      const mergedArray = Object.values(mergedByDevice).flat().sort((a, b) => a.timestamp - b.timestamp);
      prunedMergedArray = pruneSnapshots(mergedArray, cutoff);
      ensureTimelineTimeWithinCutoff(prunedMergedArray, cutoff);
      return mergedByDevice;
    });
    return prunedMergedArray;
  }

  // Load persisted raw snapshots and build derived state (runs once on mount)
  useEffect(() => {
    try {
      if (typeof window === "undefined") return;

      // Expect per-device persisted format: Record<string, DevicePoint[]>
      const parsedByDevice = safeGetJSON<Record<string, DevicePoint[]>>(LS_RAW_BY_DEVICE);
      if (parsedByDevice && typeof parsedByDevice === "object") {
        const byDevice: Record<string, DevicePoint[]> = {};
        const reconstructed: DevicePoint[] = [];
        for (const [k, arr] of Object.entries(parsedByDevice)) {
          if (!Array.isArray(arr)) continue;
          const re = (
            arr
              .map((p) => {
                if (!p) return null;
                if (typeof p.timestamp !== "number" || typeof p.lat !== "number" || typeof p.lon !== "number") return null;
                return { ...p };
              })
              .filter(Boolean) as DevicePoint[]
          ).sort((a, b) => a.timestamp - b.timestamp);
          if (re.length > 0) {
            byDevice[k] = re;
            reconstructed.push(...re);
          }
        }
        if (reconstructed.length === 0) return;
        const baseLat = reconstructed[0]?.lat;
        const baseLon = reconstructed[0]?.lon;
        if (typeof baseLat !== "number" || typeof baseLon !== "number") return;

        setRefLat(baseLat);
        setRefLon(baseLon);
        const cutoff = Date.now() - HISTORY_MS;

        mergeAndApplyRawSnapshots(byDevice, cutoff);

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const s of reconstructed) {
          minX = Math.min(minX, s.mean[0]);
          minY = Math.min(minY, s.mean[1]);
          maxX = Math.max(maxX, s.mean[0]);
          maxY = Math.max(maxY, s.mean[1]);
        }

        // On reload, reset timeline to the latest persisted timestamp unconditionally
        setTimelineTime(reconstructed[reconstructed.length - 1]?.timestamp ?? Date.now());

        // build engine-derived snapshots asynchronously (shared helper)
        buildEngineSnapshotsFromByDevice(byDevice, cutoff);
      }

      // Defer setting `worldBounds` to the selected-time logic so historic raw data
      // does not force an automatic zoom on load.

    } catch (e) { }
  }, []);

  // Traccar connection settings (persisted in localStorage)
  const [baseUrlInput, setBaseUrlInput] = useState<string>(() => safeGetItem("traccar:baseUrl") ?? "");
  const [secureInput, setSecureInput] = useState<boolean>(() => (safeGetItem("traccar:secure") ?? "false") === "true");
  const [tokenInput, setTokenInput] = useState<string>(() => safeGetItem("traccar:token") ?? "");
  // applied (active) settings used by the client; change these via Apply/Save
  const [traccarBaseUrl, setTraccarBaseUrl] = useState<string | null>(() => safeGetItem("traccar:baseUrl") ?? null);
  const [traccarSecure, setTraccarSecure] = useState<boolean>(() => (safeGetItem("traccar:secure") ?? "false") === "true");
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



  const [wsStatus, setWsStatus] = useState<"unknown" | "connecting" | "connected" | "disconnected" | "error">("unknown");
  const [wsError, setWsError] = useState<string | null>(null);
  const [wsApplyCounter, setWsApplyCounter] = useState(0);

  function applySettings() {
    // Persist settings safely
    safeSetItem("traccar:baseUrl", baseUrlInput || null);
    safeSetItem("traccar:secure", secureInput.toString());
    safeSetItem("traccar:token", tokenInput || null);

    setTraccarBaseUrl(baseUrlInput || null);
    setTraccarSecure(secureInput);
    setTraccarToken(tokenInput || null);

    if (baseUrlInput && baseUrlInput.trim() !== "") {
      // attempt to connect
      setWsStatus("connecting");
      setWsError(null);
    } else {
      // don't attempt to connect when no URL provided
      setWsStatus("disconnected");
      setWsError("No Base URL configured");
    }

    setWsApplyCounter((c) => c + 1);
  }

  function clearSettings() {
    setBaseUrlInput("");
    setSecureInput(false);
    setTokenInput("");
    // Clear persisted settings safely
    safeSetItem("traccar:baseUrl", null);
    safeSetItem("traccar:secure", "false");
    safeSetItem("traccar:token", null);
    setTraccarBaseUrl(null);
    setTraccarSecure(false);
    setTraccarToken(null);
    setWsStatus("disconnected");
    setWsError(null);
    setWsApplyCounter((c) => c + 1);
  }

  function processPositions(positions: NormalizedPosition[]) {
    if (!positions || positions.length === 0) return;

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
    const posByDevice = new Map<number, NormalizedPosition[]>();
    for (const p of positionsWithDevice) {
      const key = p.device;
      if (!posByDevice.has(key)) posByDevice.set(key, []);
      posByDevice.get(key)!.push(p);
    }
    for (const arr of posByDevice.values()) arr.sort((a, b) => a.timestamp - b.timestamp);

    // Compute world bounds from incoming positions
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const arr of posByDevice.values()) {
      for (const p of arr) {
        const { x, y } = degreesToMeters(p.lat, p.lon, baseLat, baseLon);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }

    // Build raw per-position device points (history of measurements), keep per-device and merged lists
    const rawByDevice: Record<string, DevicePoint[]> = {};
    let mergedRaw: DevicePoint[] = [];
    for (const [deviceKey, arr] of posByDevice) {
      const rawArr: DevicePoint[] = arr.map((p) => {
        const { x, y } = degreesToMeters(p.lat, p.lon, baseLat, baseLon);
        const comp: DevicePoint = {
          mean: [x, y] as [number, number],
          cov: measurementCovFromAccuracy(p.accuracy),
          accuracy: p.accuracy,
          lat: p.lat,
          lon: p.lon,
          device: deviceKey,
          timestamp: p.timestamp,
        };
        return comp;
      });
      rawArr.sort((a, b) => a.timestamp - b.timestamp);
      rawByDevice[deviceKey] = rawArr;
      mergedRaw.push(...rawArr);
    }
    mergedRaw.sort((a, b) => a.timestamp - b.timestamp);

    const cutoff = Date.now() - HISTORY_MS;

    // Merge with previous device-point histories per device using the shared helper
    const prevMergedArray = mergedArrayFromByDevice(rawSnapshotsByDevice ?? {});
    const prevLatest = prevMergedArray[prevMergedArray.length - 1]?.timestamp ?? null;
    const prunedMergedArray = mergeAndApplyRawSnapshots(rawByDevice, cutoff);
    mergedRaw = prunedMergedArray;
    const newLatest = prunedMergedArray[prunedMergedArray.length - 1]?.timestamp ?? null;
    // Advance timeline to new latest if the user was already at the previous latest (or timeline unset/expired)
    setTimelineTime((prevTime) => computeNextTimelineTime(prevTime, prevLatest, newLatest, cutoff));

    // Convert to engine measurements and run each device through its own Engine instance
    (async () => {
      await buildEngineSnapshotsFromByDevice(rawByDevice, cutoff);
      // default timeline time to the latest raw snapshot (history should be raw)
      setTimelineTime((prev) =>
        prev == null ? mergedRaw[mergedRaw.length - 1]?.timestamp ?? Date.now() : prev < cutoff ? mergedRaw[mergedRaw.length - 1]?.timestamp ?? Date.now() : prev
      );
      // Do not set world bounds from the full incoming positions (which may include history).
      // World bounds are computed from the UI-selected time and filters so historic raw data
      // doesn't trigger an automatic zoom.
    })();

  }

  useEffect(() => {
    // If there is no configured base URL, do not attempt to connect
    if (!traccarBaseUrl) {
      clientCloseRef.current?.();
      setWsStatus("disconnected");
      // leave wsError alone if it already contains a helpful message, otherwise clear
      setWsError((prev) => (prev && prev.includes("No Base URL") ? prev : prev ?? null));
      return;
    }

    // update status for this connection attempt
    setWsStatus("connecting");
    setWsError(null);

    const knownDevices = new Set<number>();
    let seen = new Set<string>();
    let positionsAll: NormalizedPosition[] = [];

    function dedupeKey(p: { deviceId?: number; timestamp?: number; lat?: number; lon?: number }) {
      return `${p.deviceId}:${p.timestamp}:${p.lat}:${p.lon}`;
    }

    function insertSortedByTimestamp(arr: NormalizedPosition[], item: NormalizedPosition) {
      let lo = 0;
      let hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((arr[mid]?.timestamp ?? 0) <= item.timestamp) lo = mid + 1;
        else hi = mid;
      }
      arr.splice(lo, 0, item);
    }

    // Pre-seed positionsAll and seen with persisted device points so old locations are preserved
    try {
      if (rawSnapshots && rawSnapshots.length > 0) {
        for (const s of rawSnapshots) {
          const comp = s;
          const p: NormalizedPosition = { timestamp: comp.timestamp, lat: comp.lat, lon: comp.lon, accuracy: typeof comp.accuracy === "number" ? comp.accuracy : 50, deviceId: comp.device };
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
          baseUrl: traccarBaseUrl ?? undefined,
          secure: traccarSecure,
          auth: traccarToken ? { type: "token", token: traccarToken } : undefined,
          autoReconnect: true,
          reconnectInitialMs: 1000,
          reconnectMaxMs: 30000,
          onPosition: (p) => {
            const key = dedupeKey(p);
            if (seen.has(key)) return;
            seen.add(key);
            insertSortedByTimestamp(positionsAll, p);
            knownDevices.add(Number(p.deviceId));
            processPositions(positionsAll);
          },
          onOpen: () => {
            (async () => {
              setWsStatus("connected");
              setWsError(null);
              // attempt resync for known devices if any (prefer WS request, fallback to REST)
              try {
                // derive base from baseUrl for REST and devices API
              const derivedBase = traccarBaseUrl ? { baseUrl: traccarBaseUrl, secure: traccarSecure } : undefined;

              // if we can discover device names via the devices endpoint, fetch them so labels are friendly
              let deviceNameMap: Record<number, string>;
              if (derivedBase) {
                const devices = await fetchDevices({ ...derivedBase, auth: traccarToken ? { type: "token", token: traccarToken } : undefined });
                const nameMap: Record<number, string> = {};
                const iconMap: Record<number, string> = {};
                for (const d of devices) {
                  if (d && d.id != null) {
                    nameMap[d.id] = d.name;
                    iconMap[d.id] = d.emoji;
                  }
                }
                setDeviceNames(nameMap);
                setDeviceIcons(iconMap);
                deviceNameMap = nameMap;
                // include discovered devices in the fetch list
                for (const id of Object.keys(nameMap)) knownDevices.add(Number(id));
                // refresh current positions with names and icons
                processPositions(positionsAll);
              } else {
                deviceNameMap = {};
              }

              for (const deviceId of knownDevices) {
                if (deviceId == null || Number.isNaN(Number(deviceId))) continue;
                const from = new Date(Math.max(0, Date.now() - HISTORY_MS));
                const to = new Date();

                try {
                  if (!derivedBase) {
                    continue;
                  }

                  const fetched = await fetchPositions({ ...derivedBase, auth: traccarToken ? { type: "token", token: traccarToken } : undefined }, Number(deviceId), from, to, {});
                  if (fetched && fetched.length > 0) {
                    for (const p of fetched) {
                      const key = dedupeKey(p);
                      if (seen.has(key)) continue;
                      seen.add(key);
                      positionsAll.push(p);
                    }
                    positionsAll.sort((a, b) => a.timestamp - b.timestamp);

                    processPositions(positionsAll);
                  }
                } catch (e) { }
              }
            } catch (e) { }
            })().catch(() => {});
          },
          onClose: (ev) => {
            const code = ev?.code;
            const reason = ev?.reason;
            const detail = code != null ? (reason ? `code=${code} reason=${reason}` : `code=${code}`) : "closed";
            setWsStatus((prev) => (prev === "error" ? "error" : "disconnected"));
            setWsError((prev) => prev ?? `WebSocket closed: ${detail}`);
            console.warn("Traccar WS closed:", ev);
          },
          onError: (err) => {
            const message = err instanceof Event ? "WebSocket connection error (check URL/token and server)" : (err instanceof Error ? err.message : String(err));
            setWsStatus("error");
            setWsError(message);
            console.warn("Traccar WS error:", err);
          },
        });

        // keep a handle for debugging and allow manual close
        (window as unknown as { __traccarClient?: unknown }).__traccarClient = client;
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
  }, [traccarBaseUrl, traccarSecure, traccarToken, wsApplyCounter]);

  // helper to find the most recent snapshot before or at a given time
  function findLatestSnapshotBeforeOrAt(snaps: DevicePoint[], time: number): DevicePoint | null {
    if (!Array.isArray(snaps) || snaps.length === 0) return null;
    let lo = 0;
    let hi = snaps.length - 1;
    let result: DevicePoint | null = null;
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
  const visibleComponentsAtTime = (time: number): DevicePoint[] => {
    const engineComps = showEstimates
      ? Object.values(engineSnapshotsByDevice).flatMap((arr) => {
          const p = findLatestSnapshotBeforeOrAt(arr, time);
          return p ? [p] : [];
        })
      : [];

    const rawComps = showRaw
      ? showAllPast
        ? rawSnapshots.filter((s) => s.timestamp <= time)
        : Object.values(rawSnapshotsByDevice).flatMap((arr) => {
            const p = findLatestSnapshotBeforeOrAt(arr, time);
            return p ? [p] : [];
          })
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
      const m = c.mean;
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
        deviceNames={deviceNames}
        deviceIcons={deviceIcons}
        overlay={
          <div className="flex flex-col gap-2">
            <div className="w-full">
              <div className="mb-3 p-2 rounded bg-muted/10 border">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    className="border rounded px-2 py-1 w-[24rem]"
                    placeholder="Traccar Base URL (e.g. localhost:8082)"
                    value={baseUrlInput}
                    onChange={(e) => setBaseUrlInput(e.target.value)}
                  />
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={secureInput}
                      onChange={(e) => setSecureInput(e.target.checked)}
                    />
                    Secure (HTTPS/WSS)
                  </label>
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
                    if (!traccarBaseUrl) {
                      setWsStatus("disconnected");
                      setWsError("No Base URL configured");
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
                return chosen ? (
                  <div className="p-2 rounded border bg-white/90 text-foreground">
                    <div className="flex items-start">
                      <div className="flex-1">
                        <div className="text-sm font-medium">{deviceNames[chosen.device] ?? chosen.device}</div>
                        <div className="text-xs text-foreground/70">Accuracy: {typeof chosen.accuracy === 'number' ? Math.round(chosen.accuracy) : ""}m</div>
                      </div>
                      <button aria-label="Deselect device" title="Close" className="ml-2 text-sm px-2 py-1 rounded border" onClick={() => setSelectedDeviceId(null)}>×</button>
                    </div>
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
