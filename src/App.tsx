// @ts-ignore - allow importing CSS without type declarations
import "./index.css";
import { CONFIDENCE_HIGH_THRESHOLD, CONFIDENCE_MEDIUM_THRESHOLD } from "./engine/anchor";
import { degreesToMeters, metersToDegrees } from "./util/geo";
import { Engine } from "./engine/engine";
import { useEffect, useState, useRef, useMemo } from "react";
import MapView from "./ui/MapView";
import type { Cov2, DevicePoint, Vec2 } from "@/ui/types";
import type { NormalizedPosition } from "@/api/traccarClient";

export function App() {
  type WorldBounds = { minX: number; minY: number; maxX: number; maxY: number };

  const [engineSnapshotsByDevice, setEngineSnapshotsByDevice] = useState<Record<number, DevicePoint[]>>({});
  const [refLat, setRefLat] = useState<number | null>(null);
  const [refLon, setRefLon] = useState<number | null>(null);
  const [worldBounds, setWorldBounds] = useState<WorldBounds | null>(null);
  const enginesRef = useRef<Record<number, Engine>>({});
  const RECENT_DEVICE_CUTOFF_MS = 24 * 60 * 60 * 1000; // 24 hours

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
    } catch {
      // ignore localStorage errors
    }
  }

  function measurementCovFromAccuracy(accuracyMeters: number): Cov2 {
    const v = accuracyMeters * accuracyMeters;
    return [v, 0, v];
  }

  function createDevicePoint(mean: Vec2, cov: Cov2, timestamp: number, deviceId: number, refLat: number | null, refLon: number | null, anchorAgeMs: number, confidence: number): DevicePoint {
    const diagMax = Math.max(cov[0], cov[2]);
    const accuracyVal = Math.max(1, Math.round(Math.sqrt(Math.max(1e-6, diagMax))));
    const { lat: compLat, lon: compLon } = (refLat != null && refLon != null) ? metersToDegrees(mean[0], mean[1], refLat, refLon) : { lat: 0, lon: 0 };
    return { mean, cov, timestamp, device: deviceId, lat: compLat, lon: compLon, accuracy: accuracyVal, anchorAgeMs, confidence };
  }

  function buildEngineSnapshotsFromByDevice(byDevice: Record<string, DevicePoint[]>): DevicePoint[] {
    try {
      for (const [deviceKey, arr] of Object.entries(byDevice)) {
        const deviceId = Number(deviceKey);
        if (!enginesRef.current[deviceId]) {
          enginesRef.current[deviceId] = new Engine();
        }
        enginesRef.current[deviceId].processMeasurements(arr);
      }
      const currentSnapshots: Record<number, DevicePoint[]> = {};
      for (const [deviceId, engine] of Object.entries(enginesRef.current)) {
        const snapshot = engine.getCurrentSnapshot();
        if (snapshot.activeAnchor) {
          const timestamp = engine.lastTimestamp ?? Date.now();
          const anchorAgeMs = Date.now() - snapshot.activeAnchor.startTimestamp;
          const point = createDevicePoint(snapshot.activeAnchor.mean, snapshot.activeAnchor.cov, timestamp, Number(deviceId), refLat, refLon, anchorAgeMs, snapshot.activeConfidence);
          currentSnapshots[Number(deviceId)] = [point];
        } else {
          currentSnapshots[Number(deviceId)] = [];
        }
      }
      setEngineSnapshotsByDevice(currentSnapshots);
      return Object.values(currentSnapshots).flat();
    } catch (e) {
      console.error("Error building engine snapshots:", e);
      return [];
    }
  }

  const [baseUrlInput, setBaseUrlInput] = useState<string>(() => safeGetItem("traccar:baseUrl") ?? "");
  const [secureInput, setSecureInput] = useState<boolean>(() => (safeGetItem("traccar:secure") ?? "false") === "true");
  const [tokenInput, setTokenInput] = useState<string>(() => safeGetItem("traccar:token") ?? "");
  const [traccarBaseUrl, setTraccarBaseUrl] = useState<string | null>(() => safeGetItem("traccar:baseUrl") ?? null);
  const [traccarSecure, setTraccarSecure] = useState<boolean>(() => (safeGetItem("traccar:secure") ?? "false") === "true");
  const [traccarToken, setTraccarToken] = useState<string | null>(() => safeGetItem("traccar:token") ?? null);
  const clientCloseRef = useRef<(() => void) | null>(null);
  const [deviceNames, setDeviceNames] = useState<Record<number, string>>({});
  const [deviceIcons, setDeviceIcons] = useState<Record<number, string>>({});
  const [deviceLastSeen, setDeviceLastSeen] = useState<Record<number, number | null>>({});

  const [wsStatus, setWsStatus] = useState<"unknown" | "connecting" | "connected" | "disconnected" | "error">("unknown");
  const [wsError, setWsError] = useState<string | null>(null);
  const [wsApplyCounter, setWsApplyCounter] = useState(0);

  function applySettings() {
    safeSetItem("traccar:baseUrl", baseUrlInput || null);
    safeSetItem("traccar:secure", secureInput.toString());
    safeSetItem("traccar:token", tokenInput || null);

    setTraccarBaseUrl(baseUrlInput || null);
    setTraccarSecure(secureInput);
    setTraccarToken(tokenInput || null);

    if (baseUrlInput && baseUrlInput.trim() !== "") {
      setWsStatus("connecting");
      setWsError(null);
    } else {
      setWsStatus("disconnected");
      setWsError("No Base URL configured");
    }

    setWsApplyCounter((c) => c + 1);
  }

  function clearSettings() {
    setBaseUrlInput("");
    setSecureInput(false);
    setTokenInput("");
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

    const first = positions[0];
    if (!first) return;
    const baseLat = first.lat;
    const baseLon = first.lon;
    setRefLat(baseLat);
    setRefLon(baseLon);

    const posByDevice = positions.reduce((acc, p) => {
      (acc[p.device] ||= []).push(p);
      return acc;
    }, {} as Record<number, NormalizedPosition[]>);
    for (const arr of Object.values(posByDevice)) arr.sort((a, b) => a.timestamp - b.timestamp);

    const rawByDevice: Record<number, DevicePoint[]> = {};
    for (const [deviceKey, arr] of Object.entries(posByDevice)) {
      const deviceId = Number(deviceKey);
      const rawArr: DevicePoint[] = arr.map((p) => {
        const { x, y } = degreesToMeters(p.lat, p.lon, baseLat, baseLon);
        const comp: DevicePoint = {
          mean: [x, y],
          cov: measurementCovFromAccuracy(p.accuracy),
          accuracy: p.accuracy,
          lat: p.lat,
          lon: p.lon,
          device: deviceId,
          timestamp: p.timestamp,
          anchorAgeMs: 0, // raw measurements don't have anchor age
          confidence: 0,
        };
        return comp;
      });
      rawByDevice[deviceId] = rawArr;
    }

    buildEngineSnapshotsFromByDevice(rawByDevice);

    // Update last seen timestamps
    const latestPerDevice: Record<number, number> = {};
    for (const p of positions) {
      latestPerDevice[p.device] = Math.max(latestPerDevice[p.device] ?? 0, p.timestamp);
    }
    setDeviceLastSeen(prev => ({ ...prev, ...latestPerDevice }));
  }

  useEffect(() => {
    if (!traccarBaseUrl) {
      clientCloseRef.current?.();
      setWsStatus("disconnected");
      setWsError((prev) => (prev && prev.includes("No Base URL") ? prev : prev ?? null));
      return;
    }

    setWsStatus("connecting");
    setWsError(null);

    const knownDevices = new Set<number>();
    let seen = new Set<string>();
    let positionsAll: NormalizedPosition[] = [];

    function dedupeKey(p: { device: number; timestamp: number; lat: number; lon: number }) {
      return `${p.device}:${p.timestamp}:${p.lat}:${p.lon}`;
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

    clientCloseRef.current?.();

    (async () => {
      try {
        const { connectRealtime, fetchPositions, fetchDevices } = await import("@/api/traccarClient");
        const client = connectRealtime({
          baseUrl: traccarBaseUrl ?? undefined,
          secure: traccarSecure,
          auth: traccarToken ? { type: "token", token: traccarToken } : { type: "none" },
          autoReconnect: true,
          reconnectInitialMs: 1000,
          reconnectMaxMs: 30000,
          onPosition: (p) => {
            const key = dedupeKey(p);
            if (seen.has(key)) return;
            seen.add(key);
            insertSortedByTimestamp(positionsAll, p);
            knownDevices.add(p.device);
            processPositions(positionsAll);
          },
          onOpen: () => {
            (async () => {
              setWsStatus("connected");
              setWsError(null);
              try {
                const derivedBase = traccarBaseUrl ? { baseUrl: traccarBaseUrl, secure: traccarSecure } : null;

                if (derivedBase) {
                  const devices = await fetchDevices({ ...derivedBase, auth: traccarToken ? { type: "token", token: traccarToken } : { type: "none" } });
                  const nameMap: Record<number, string> = {};
                  const iconMap: Record<number, string> = {};
                  const lastSeenMap: Record<number, number | null> = {};
                  for (const d of devices) {
                    if (d?.id != null) {
                      nameMap[d.id] = d.name;
                      iconMap[d.id] = d.emoji;
                      lastSeenMap[d.id] = d.lastSeen;
                    }
                  }
                  setDeviceNames(nameMap);
                  setDeviceIcons(iconMap);
                  setDeviceLastSeen(lastSeenMap);
                  for (const id of Object.keys(nameMap)) knownDevices.add(Number(id));
                }

                for (const deviceId of knownDevices) {
                  if (deviceId == null || Number.isNaN(deviceId) || derivedBase == null) continue;
                  const from = new Date(Math.max(0, Date.now() - RECENT_DEVICE_CUTOFF_MS));
                  const to = new Date();

                  try {
                    const fetched = await fetchPositions({ ...derivedBase, auth: traccarToken ? { type: "token", token: traccarToken } : { type: "none" } }, deviceId, from, to, {});
                    for (const p of fetched) {
                      const key = dedupeKey(p);
                      if (seen.has(key)) continue;
                      seen.add(key);
                      positionsAll.push(p);
                    }
                    processPositions(positionsAll);
                  } catch {
                    // ignore processing errors
                  }
                }
              } catch {
                // ignore fetch errors
              }
            })().catch(() => { });
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

        clientCloseRef.current = () => {
          client.close();
        };
      } catch (e) {
        console.warn("Could not initialize realtime traccar client:", e);
        setWsStatus("error");
        setWsError(String(e));
      }
    })();

    return () => {
      clientCloseRef.current?.();
    };
  }, [traccarBaseUrl, traccarSecure, traccarToken, wsApplyCounter]);

  function humanDurationSince(ts: number): string {
    const s = Math.round((Date.now() - (ts ?? Date.now())) / 1000);
    if (s < 5) return "just now";
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.round(h / 24);
    return `${d}d`;
  }

  const visibleComponents = useMemo(() => {
    const engineComps = Object.values(engineSnapshotsByDevice).flat();
    const allComps = engineComps;

    // Filter devices not seen in the last 24 hours using deviceLastSeen
    const cutoff = Date.now() - RECENT_DEVICE_CUTOFF_MS;
    const activeDevices = new Set<number>();
    for (const [device, lastSeen] of Object.entries(deviceLastSeen)) {
      if (lastSeen && lastSeen > cutoff) {
        activeDevices.add(Number(device));
      }
    }
    return allComps.filter((comp) => activeDevices.has(comp.device));
  }, [engineSnapshotsByDevice, deviceLastSeen]);

  const frame = { components: visibleComponents };

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
            </div>

            {selectedDeviceId ? (
              (() => {
                const engArr = engineSnapshotsByDevice[selectedDeviceId] ?? [];
                const chosen = engArr.length > 0 ? engArr[engArr.length - 1] : null;
                if (!chosen) return null;
                return (
                  <div className="p-2 rounded border bg-white/90 text-foreground">
                    <div className="flex items-start">
                      <div className="flex-1">
                        <div className="text-sm font-medium">{deviceNames[chosen.device] ?? chosen.device}</div>
                        <div className="text-xs text-foreground/70">Accuracy: {typeof chosen.accuracy === 'number' ? Math.round(chosen.accuracy) : ""} m · {(chosen.confidence >= CONFIDENCE_HIGH_THRESHOLD ? "High" : chosen.confidence >= CONFIDENCE_MEDIUM_THRESHOLD ? "Medium" : "Low")} confidence ({chosen.confidence.toFixed(2)})</div>
                        <div className="text-xs text-foreground/70">At location for: {humanDurationSince(Date.now() - chosen.anchorAgeMs)}</div>
                      </div>
                      <button aria-label="Deselect device" title="Close" className="ml-2 text-sm px-2 py-1 rounded border" onClick={() => setSelectedDeviceId(null)}>×</button>
                    </div>
                    <div className="text-xs text-foreground/70">Last updated: {humanDurationSince(deviceLastSeen[chosen.device] ?? chosen.timestamp)}</div>
                  </div>
                );
              })()
            ) : null}
          </div>
        }
      />
    </div>
  );
}

export default App;
