import { Card, CardContent } from "@/components/ui/card";
import "./index.css";
import { useEffect, useState, useRef } from "react";
import MapView from "./ui/MapView";
import { TimelineSlider } from "./ui/TimelineSlider";
import type { ComponentUI } from "@/ui/types";
import { degreesToMeters } from "./util/geo";
import { measurementCovFromAccuracy, eigenDecomposition } from "@/util/gaussian";
import { mergeSnapshots } from "@/lib/snapshots";

export function App() {
  type Snapshot = { timestamp: number; data: { components: ComponentUI[] } };
  type WorldBounds = { minX: number; minY: number; maxX: number; maxY: number };

  const [timelineTime, setTimelineTime] = useState<number | null>(null);
  const [rawSnapshots, setRawSnapshots] = useState<Snapshot[]>([]);
  const [rawSnapshotsByDevice, setRawSnapshotsByDevice] = useState<Record<string, Snapshot[]>>({});
  const [engineSnapshotsByDevice, setEngineSnapshotsByDevice] = useState<Record<string, Snapshot[]>>({});
  const [refLat, setRefLat] = useState<number | null>(null);
  const [refLon, setRefLon] = useState<number | null>(null);
  const [worldBounds, setWorldBounds] = useState<WorldBounds | null>(null);
  const LS_RAW_SNAPSHOTS = "traccar:rawSnapshots";
  const LS_RAW_BY_DEVICE = "traccar:rawSnapshotsByDevice";
  const LS_UI_SHOW_RAW = "ui:showRaw";
  const LS_UI_SHOW_ESTIMATES = "ui:showEstimates";
  const LS_UI_SHOW_HISTORY = "ui:showHistory";

  const [showRaw, setShowRaw] = useState<boolean>(() => {
    try {
      const v = typeof window !== "undefined" ? window.localStorage.getItem(LS_UI_SHOW_RAW) : null;
      return v == null ? true : v === "1";
    } catch (e) {
      return true;
    }
  });
  const [showEstimates, setShowEstimates] = useState<boolean>(() => {
    try {
      const v = typeof window !== "undefined" ? window.localStorage.getItem(LS_UI_SHOW_ESTIMATES) : null;
      return v == null ? true : v === "1";
    } catch (e) {
      return true;
    }
  });
  const [showAllPast, setShowAllPast] = useState<boolean>(() => {
    try {
      const v = typeof window !== "undefined" ? window.localStorage.getItem(LS_UI_SHOW_HISTORY) : null;
      return v == null ? false : v === "1";
    } catch (e) {
      return false;
    }
  });

  // Persist UI toggles
  useEffect(() => {
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(LS_UI_SHOW_RAW, showRaw ? "1" : "0");
    } catch (e) { }
  }, [showRaw]);

  useEffect(() => {
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(LS_UI_SHOW_ESTIMATES, showEstimates ? "1" : "0");
    } catch (e) { }
  }, [showEstimates]);

  useEffect(() => {
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(LS_UI_SHOW_HISTORY, showAllPast ? "1" : "0");
    } catch (e) { }
  }, [showAllPast]);

  // Persist raw snapshots to localStorage
  useEffect(() => {
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(LS_RAW_SNAPSHOTS, JSON.stringify(rawSnapshots));
    } catch (e) { }
  }, [rawSnapshots]);

  // Persist raw snapshots by device to localStorage (stronger per-device history persistence)
  useEffect(() => {
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(LS_RAW_BY_DEVICE, JSON.stringify(rawSnapshotsByDevice));
    } catch (e) { }
  }, [rawSnapshotsByDevice]);

  // Load persisted raw snapshots and build derived state (runs once on mount)
  useEffect(() => {
    try {
      if (typeof window === "undefined") return;

      // Prefer the newer per-device persisted format when available
      const storedByDevice = window.localStorage.getItem(LS_RAW_BY_DEVICE);
      if (storedByDevice) {
        try {
          const parsedByDevice = JSON.parse(storedByDevice);
          if (parsedByDevice && typeof parsedByDevice === "object") {
            const byDevice: Record<string, Snapshot[]> = {};
            const reconstructed: Snapshot[] = [];
            for (const [k, arr] of Object.entries(parsedByDevice)) {
              if (!Array.isArray(arr)) continue;
              const re = arr
                .map((snap: any) => {
                  const comp = snap.data?.components?.[0];
                  if (!comp) return null;
                  return { timestamp: snap.timestamp, data: { components: [{ ...comp }] } } as Snapshot;
                })
                .filter(Boolean) as Snapshot[];
              re.sort((a, b) => a.timestamp - b.timestamp);
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
            setRawSnapshots((prev) => mergeSnapshots(prev, reconstructed));

            setRawSnapshotsByDevice((prev) => {
              const out: Record<string, Snapshot[]> = { ...prev };
              for (const [k, arr] of Object.entries(byDevice)) {
                out[k] = mergeSnapshots(out[k] ?? [], arr);
              }
              return out;
            });

            let wb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
            for (const s of reconstructed) {
              const m = s.data.components[0]?.mean ?? [0, 0];
              wb.minX = Math.min(wb.minX, m[0]);
              wb.minY = Math.min(wb.minY, m[1]);
              wb.maxX = Math.max(wb.maxX, m[0]);
              wb.maxY = Math.max(wb.maxY, m[1]);
            }
            setWorldBounds(wb);

            setTimelineTime((prev) => prev ?? (reconstructed[reconstructed.length - 1]?.timestamp ?? Date.now()));

            // build engine-derived snapshots asynchronously
            (async () => {
              const { Engine } = await import("@/engine/engine");
              const engineByDevice: Record<string, Snapshot[]> = {};
              const mergedEngine: Snapshot[] = [];
              for (const [deviceKey, arr] of Object.entries(byDevice)) {
                const measurements = arr
                  .map((s) => {
                    const c = s.data.components[0] as any;
                    return { mean: c.mean, cov: measurementCovFromAccuracy(c.accuracy), timestamp: s.timestamp, source: c.source, accuracy: c.accuracy, lat: c.lat, lon: c.lon, speed: c.speed };
                  })
                  .sort((a, b) => a.timestamp - b.timestamp);
                const enginePerDevice = new Engine();
                const engineSnapRaw = enginePerDevice.processMeasurements(measurements);
                const engineSnap: Snapshot[] = engineSnapRaw.map((s_, idx) => {
                  const m = measurements[idx];
                  const prevM = measurements[idx - 1];
                  const comps = s_.data.components.map((c: any) => {
                    const { lambda1, lambda2 } = eigenDecomposition(c.cov);
                    const accuracyMeters = Math.round(Math.sqrt(Math.max(lambda1, lambda2)));
                    let action = (c.action as string | undefined) ?? "still";
                    let displaySpeed: number | undefined = undefined;
                    if (typeof m?.speed === "number") displaySpeed = m.speed;
                    else if (prevM && m && typeof m.timestamp === "number" && typeof prevM.timestamp === "number") {
                      const dt = (m.timestamp - prevM.timestamp) / 1000;
                      if (dt > 0) {
                        const dx = (m.mean?.[0] ?? 0) - (prevM.mean?.[0] ?? 0);
                        const dy = (m.mean?.[1] ?? 0) - (prevM.mean?.[1] ?? 0);
                        displaySpeed = Math.sqrt(dx * dx + dy * dy) / dt;
                      }
                    }
                    if (!c.action && typeof displaySpeed === "number") {
                      const speedThreshold = 0.5;
                      if (displaySpeed > speedThreshold) action = "moving";
                    }
                    return { ...c, estimate: true, accuracyMeters, action, speed: displaySpeed, device: deviceKey, deviceName: undefined as any };
                  });
                  return { timestamp: s_.timestamp, data: { components: comps } };
                });
                engineSnap.sort((a, b) => a.timestamp - b.timestamp);
                engineByDevice[deviceKey] = engineSnap;
                mergedEngine.push(...engineSnap);
              }
              mergedEngine.sort((a, b) => a.timestamp - b.timestamp);
              setEngineSnapshotsByDevice(engineByDevice);
            })();
          }
        } catch (e) {
          // ignore parsing errors
        }
      }

      // Fallback to old single-array persisted snapshots (backwards compatibility)
      const stored = window.localStorage.getItem(LS_RAW_SNAPSHOTS);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed) || parsed.length === 0) return;

      const baseLat = parsed[0]?.data?.components?.[0]?.lat;
      const baseLon = parsed[0]?.data?.components?.[0]?.lon;
      if (typeof baseLat !== "number" || typeof baseLon !== "number") return;

      const reconstructed: Snapshot[] = parsed
        .map((snap: any) => {
          const comp = snap.data?.components?.[0];
          if (!comp) return null;
          const { x, y } = degreesToMeters(comp.lat, comp.lon, baseLat, baseLon);
          return { timestamp: snap.timestamp, data: { components: [{ ...comp, mean: [x, y] }] } } as Snapshot;
        })
        .filter(Boolean) as Snapshot[];

      if (reconstructed.length === 0) return;

      setRefLat(baseLat);
      setRefLon(baseLon);
      setRawSnapshots((prev) => mergeSnapshots(prev, reconstructed));

      const byDevice: Record<string, Snapshot[]> = {};
      for (const s of reconstructed) {
        const k = String(s.data.components[0]?.device ?? "unknown");
        if (!byDevice[k]) byDevice[k] = [];
        byDevice[k].push(s);
      }
      for (const arr of Object.values(byDevice)) arr.sort((a, b) => a.timestamp - b.timestamp);

      // Merge per-device histories with any existing state instead of blindly replacing
      setRawSnapshotsByDevice((prev) => {
        const out: Record<string, Snapshot[]> = { ...prev };
        for (const [k, arr] of Object.entries(byDevice)) {
          out[k] = mergeSnapshots(out[k] ?? [], arr);
        }
        return out;
      });

      let wb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const s of reconstructed) {
        const m = s.data.components[0]?.mean ?? [0, 0];
        wb.minX = Math.min(wb.minX, m[0]);
        wb.minY = Math.min(wb.minY, m[1]);
        wb.maxX = Math.max(wb.maxX, m[0]);
        wb.maxY = Math.max(wb.maxY, m[1]);
      }
      setWorldBounds(wb);

      setTimelineTime((prev) => prev ?? (reconstructed[reconstructed.length - 1]?.timestamp ?? Date.now()));

      // build engine-derived snapshots asynchronously
      (async () => {
        const { Engine } = await import("@/engine/engine");
        const engineByDevice: Record<string, Snapshot[]> = {};
        const mergedEngine: Snapshot[] = [];
        for (const [deviceKey, arr] of Object.entries(byDevice)) {
          const measurements = arr
            .map((s) => {
              const c = s.data.components[0] as any;
              return { mean: c.mean, cov: measurementCovFromAccuracy(c.accuracy), timestamp: s.timestamp, source: c.source, accuracy: c.accuracy, lat: c.lat, lon: c.lon, speed: c.speed };
            })
            .sort((a, b) => a.timestamp - b.timestamp);
          const enginePerDevice = new Engine();
          const engineSnapRaw = enginePerDevice.processMeasurements(measurements);
          const engineSnap: Snapshot[] = engineSnapRaw.map((s_, idx) => {
            const m = measurements[idx];
            const prevM = measurements[idx - 1];
            const comps = s_.data.components.map((c: any) => {
              const { lambda1, lambda2 } = eigenDecomposition(c.cov);
              const accuracyMeters = Math.round(Math.sqrt(Math.max(lambda1, lambda2)));

              let action = (c.action as string | undefined) ?? "still";

              let displaySpeed: number | undefined = undefined;
              if (typeof m?.speed === "number") {
                displaySpeed = m.speed;
              } else if (prevM && m && typeof m.timestamp === "number" && typeof prevM.timestamp === "number") {
                const dt = (m.timestamp - prevM.timestamp) / 1000;
                if (dt > 0) {
                  const dx = (m.mean?.[0] ?? 0) - (prevM.mean?.[0] ?? 0);
                  const dy = (m.mean?.[1] ?? 0) - (prevM.mean?.[1] ?? 0);
                  displaySpeed = Math.sqrt(dx * dx + dy * dy) / dt;
                }
              }

              if (!c.action && typeof displaySpeed === "number") {
                const speedThreshold = 0.5;
                if (displaySpeed > speedThreshold) action = "moving";
              }

              return { ...c, estimate: true, accuracyMeters, action, speed: displaySpeed, device: deviceKey, deviceName: undefined as any };
            });
            return { timestamp: s_.timestamp, data: { components: comps } };
          });
          engineSnap.sort((a, b) => a.timestamp - b.timestamp);
          engineByDevice[deviceKey] = engineSnap;
          mergedEngine.push(...engineSnap);
        }
        mergedEngine.sort((a, b) => a.timestamp - b.timestamp);
        setEngineSnapshotsByDevice(engineByDevice);
      })();
    } catch (e) {
      /* ignore localStorage or engine errors */
    }
  }, []);

  // Traccar connection settings (persisted in localStorage)
  const [wsUrlInput, setWsUrlInput] = useState<string>(() => {
    try {
      return typeof window !== "undefined" ? window.localStorage.getItem("traccar:wsUrl") ?? "" : "";
    } catch (e) {
      return "";
    }
  });
  const [tokenInput, setTokenInput] = useState<string>(() => {
    try {
      return typeof window !== "undefined" ? window.localStorage.getItem("traccar:token") ?? "" : "";
    } catch (e) {
      return "";
    }
  });
  // applied (active) settings used by the client; change these via Apply/Save
  const [traccarWsUrl, setTraccarWsUrl] = useState<string | null>(() => {
    try {
      return typeof window !== "undefined" ? window.localStorage.getItem("traccar:wsUrl") ?? null : null;
    } catch (e) {
      return null;
    }
  });
  const [traccarToken, setTraccarToken] = useState<string | null>(() => {
    try {
      return typeof window !== "undefined" ? window.localStorage.getItem("traccar:token") ?? null : null;
    } catch (e) {
      return null;
    }
  });
  const clientCloseRef = useRef<() => void | null>(() => null);
  const clientRef = useRef<any>(null);
  const [deviceNames, setDeviceNames] = useState<Record<string, string>>({});

  // Ensure device-friendly names are applied to stored snapshots when device names are discovered/updated
  useEffect(() => {
    if (!deviceNames || Object.keys(deviceNames).length === 0) return;

    // Update raw snapshots per-device to include deviceName where missing or outdated
    setRawSnapshotsByDevice((prev) => {
      const prevObj = prev ?? {};
      let changed = false;
      const out: Record<string, Snapshot[]> = {};
      for (const [k, arr] of Object.entries(prevObj)) {
        const updated = arr.map((s) => {
          const comp = (s.data?.components?.[0] ?? {}) as any;
          const desired = deviceNames[k] ?? comp?.deviceName;
          if (comp?.deviceName !== desired) {
            changed = true;
            const newComp = { ...comp, deviceName: desired };
            return { ...s, data: { components: [newComp] } } as Snapshot;
          }
          return s;
        });
        out[k] = updated;
      }
      if (!changed) return prev;
      const mergedArray = Object.values(out).flat().sort((a, b) => a.timestamp - b.timestamp);
      setRawSnapshots(mergedArray);
      return out;
    });

    // Update engine-derived snapshots as well so estimates show friendly names
    setEngineSnapshotsByDevice((prev) => {
      const prevObj = prev ?? {};
      let changed = false;
      const out: Record<string, Snapshot[]> = {};
      for (const [k, arr] of Object.entries(prevObj)) {
        const updated = arr.map((s) => {
          const comp = (s.data?.components?.[0] ?? {}) as any;
          const desired = deviceNames[k] ?? comp?.deviceName;
          if (comp?.deviceName !== desired) {
            changed = true;
            const newComp = { ...comp, deviceName: desired };
            return { ...s, data: { components: [newComp] } } as Snapshot;
          }
          return s;
        });
        out[k] = updated;
      }
      if (!changed) return prev;
      return out;
    });
  }, [deviceNames]);

  const [wsStatus, setWsStatus] = useState<"unknown" | "connecting" | "connected" | "disconnected" | "error">("unknown");
  const [wsError, setWsError] = useState<string | null>(null);
  const [wsApplyCounter, setWsApplyCounter] = useState(0);

  function applySettings() {
    try {
      if (typeof window !== "undefined") {
        if (wsUrlInput) window.localStorage.setItem("traccar:wsUrl", wsUrlInput);
        else window.localStorage.removeItem("traccar:wsUrl");
        if (tokenInput) window.localStorage.setItem("traccar:token", tokenInput);
        else window.localStorage.removeItem("traccar:token");
      }
    } catch (e) {
      /* ignore localStorage errors */
    }

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
    try {
      if (typeof window !== "undefined") {
        window.localStorage.removeItem("traccar:wsUrl");
        window.localStorage.removeItem("traccar:token");
      }
    } catch (e) {
      /* ignore */
    }
    setTraccarWsUrl(null);
    setTraccarToken(null);
    setWsStatus("disconnected");
    setWsError(null);
    setWsApplyCounter((c) => c + 1);
  }

  function processPositions(positions: any[], nameMap?: Record<string, string>) {
    if (!positions || positions.length === 0) return;
    const nameMapLocal = nameMap ?? deviceNames;
    // Attach an explicit device key to each position (prefer deviceId, fallback to `source`)
    const positionsWithDevice = positions.map((p) => {
      const deviceKey = p.deviceId != null ? String(p.deviceId) : p.source ?? "unknown";
      return { ...p, device: deviceKey };
    });

    // Convert to measurements and build simple snapshots (UI-only)
    const first = positionsWithDevice[0];
    if (!first) return;
    const baseLat = first.lat;
    const baseLon = first.lon;
    setRefLat(baseLat);
    setRefLon(baseLon);

    // Group positions per device and sort each device stream by timestamp
    const posByDevice = new Map<string, any[]>();
    for (const p of positionsWithDevice) {
      const key = String(p.device ?? p.source ?? "unknown");
      if (!posByDevice.has(key)) posByDevice.set(key, []);
      posByDevice.get(key)!.push(p);
    }
    for (const arr of posByDevice.values()) arr.sort((a, b) => a.timestamp - b.timestamp);

    // Convert all positions into meters (per-device) and compute world bounds (min/max)
    const metersByDevice = new Map<string, any[]>();
    for (const [deviceKey, arr] of posByDevice) {
      const mp = arr.map((p) => {
        const { x, y } = degreesToMeters(p.lat, p.lon, baseLat, baseLon);
        const raw = (p as any).raw;
        const speed = typeof raw?.speed === "number" ? raw.speed : p.speed;
        return {
          lat: p.lat,
          lon: p.lon,
          accuracy: p.accuracy ?? 50,
          timestamp: p.timestamp,
          source: p.source,
          x,
          y,
          speed,
          device: deviceKey,
        };
      });
      metersByDevice.set(deviceKey, mp);
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

    const initialBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    let worldBoundsLocal = initialBounds;
    for (const mp of metersByDevice.values()) {
      for (const p of mp) {
        worldBoundsLocal = {
          minX: Math.min(worldBoundsLocal.minX, p.x),
          minY: Math.min(worldBoundsLocal.minY, p.y),
          maxX: Math.max(worldBoundsLocal.maxX, p.x),
          maxY: Math.max(worldBoundsLocal.maxY, p.y),
        };
      }
    }

    // Build raw per-position snapshots (history of measurements), keep per-device and merged lists
    const rawByDevice: Record<string, Snapshot[]> = {};
    const mergedRaw: Snapshot[] = [];
    for (const [deviceKey, mp] of metersByDevice) {
      const rawArr: Snapshot[] = mp.map((p) => ({
        timestamp: p.timestamp,
        data: {
          components: [
            {
              mean: [p.x, p.y] as [number, number],
              cov: measurementCovFromAccuracy(p.accuracy),
              accuracy: p.accuracy,
              weight: 1,
              source: p.source,
              lat: p.lat,
              lon: p.lon,
              raw: true,
              speed: p.speed,
              device: deviceKey,
              deviceName: nameMapLocal?.[deviceKey] ?? undefined,
            },
          ],
        },
      }));
      rawArr.sort((a, b) => a.timestamp - b.timestamp);
      rawByDevice[deviceKey] = rawArr;
      mergedRaw.push(...rawArr);
    }
    mergedRaw.sort((a, b) => a.timestamp - b.timestamp);

    // Merge with previous snapshots **per device** to keep per-device history persistent
    setRawSnapshotsByDevice((prevByDevice) => {
      const mergedByDevice: Record<string, Snapshot[]> = { ...(prevByDevice ?? {}) };
      for (const [deviceKey, arr] of Object.entries(rawByDevice)) {
        const existing = mergedByDevice[deviceKey] ?? [];
        mergedByDevice[deviceKey] = mergeSnapshots(existing, arr).sort((a, b) => a.timestamp - b.timestamp);
      }
      // recompute merged rawSnapshots (global list) from per-device lists
      const mergedArray = Object.values(mergedByDevice).flat().sort((a, b) => a.timestamp - b.timestamp);
      setRawSnapshots(mergedArray);
      return mergedByDevice;
    });

    // Convert to engine measurements and run each device through its own Engine instance
    const engineByDevice: Record<string, Snapshot[]> = {};
    const mergedEngine: Snapshot[] = [];
    (async () => {
      const { Engine } = await import("@/engine/engine");
      for (const [deviceKey, mp] of metersByDevice) {
        const measurements = mp.map((p) => ({
          mean: [p.x, p.y] as [number, number],
          cov: measurementCovFromAccuracy(p.accuracy),
          timestamp: p.timestamp,
          source: p.source,
          accuracy: p.accuracy,
          lat: p.lat,
          lon: p.lon,
          speed: p.speed,
        }));

        const enginePerDevice = new Engine();
        const measurementsSorted = measurements.slice().sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
        const engineSnapRaw = enginePerDevice.processMeasurements(measurementsSorted);

        const engineSnap: Snapshot[] = engineSnapRaw.map((s, idx) => {
          const m = measurementsSorted[idx];
          const prevM = measurementsSorted[idx - 1];
          const comps = s.data.components.map((c: any) => {
            const { lambda1, lambda2 } = eigenDecomposition(c.cov);
            const accuracyMeters = Math.round(Math.sqrt(Math.max(lambda1, lambda2)));

            // Prefer mixture's movement confidence if available
            let action = (c.action as string | undefined) ?? "still";

            // compute a display speed if possible (meters/second) from device or derived from consecutive measurements
            let displaySpeed: number | undefined = undefined;
            if (typeof m?.speed === "number") {
              displaySpeed = m.speed;
            } else if (prevM && m && typeof m.timestamp === "number" && typeof prevM.timestamp === "number") {
              const dt = (m.timestamp - prevM.timestamp) / 1000;
              if (dt > 0) {
                const dx = (m.mean?.[0] ?? 0) - (prevM.mean?.[0] ?? 0);
                const dy = (m.mean?.[1] ?? 0) - (prevM.mean?.[1] ?? 0);
                displaySpeed = Math.sqrt(dx * dx + dy * dy) / dt;
              }
            }

            // fallback movement detection when mixture didn't supply an action
            if (!c.action && typeof displaySpeed === "number") {
              const speedThreshold = 0.5; // m/s (fallback threshold)
              if (displaySpeed > speedThreshold) action = "moving";
            }

            return { ...c, estimate: true, accuracyMeters, action, speed: displaySpeed, device: deviceKey, deviceName: nameMapLocal?.[deviceKey] ?? undefined };
          });
          return { timestamp: s.timestamp, data: { components: comps } };
        });

        engineSnap.sort((a, b) => a.timestamp - b.timestamp);
        engineByDevice[deviceKey] = engineSnap;
        mergedEngine.push(...engineSnap);
      }

      mergedEngine.sort((a, b) => a.timestamp - b.timestamp);
      setEngineSnapshotsByDevice(engineByDevice);

      // default timeline time to the latest raw snapshot (history should be raw)
      setTimelineTime(mergedRaw[mergedRaw.length - 1]?.timestamp ?? mergedEngine[mergedEngine.length - 1]?.timestamp ?? Date.now());
      // store world bounds somewhere (pass into CanvasView via state)
      setWorldBounds(worldBoundsLocal);
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

    // Use Traccar realtime WebSocket for live updates
    // The realtime client will call `onPosition` for each received normalized position

    let lastTimestamps: Record<string, number> = {};
    let seen = new Set<string>();
    let positionsAll: any[] = [];
    // mapping from deviceKey -> friendly name (populated from Traccar /devices when available)
    let localDeviceNames: Record<string, string> | null = null;

    function dedupeKey(p: any) {
      return `${p.deviceId ?? p.source ?? ""}:${p.timestamp}:${p.lat}:${p.lon}`;
    }

    // Pre-seed positionsAll and seen with persisted snapshots so old locations are preserved
    try {
      if (rawSnapshots && rawSnapshots.length > 0) {
        for (const s of rawSnapshots) {
          const comp = s.data.components[0] as any;
          const p = { timestamp: s.timestamp, lat: comp.lat, lon: comp.lon, accuracy: comp.accuracy ?? 50, speed: comp.speed ?? 0, deviceId: comp.device ?? undefined, source: comp.source ?? undefined, raw: true };
          const key = dedupeKey(p);
          if (seen.has(key)) continue;
          seen.add(key);
          positionsAll.push(p);
          const deviceKey = String(comp.device ?? comp.source ?? "unknown");
          lastTimestamps[deviceKey] = Math.max(lastTimestamps[deviceKey] ?? 0, p.timestamp ?? 0);
        }
        positionsAll.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
        // Build initial UI from persisted positions
        processPositions(positionsAll);
      } else {
        try {
          const s = typeof window !== "undefined" ? window.localStorage.getItem(LS_RAW_SNAPSHOTS) : null;
          if (s) {
            const parsed = JSON.parse(s);
            if (Array.isArray(parsed)) {
              for (const snap of parsed) {
                try {
                  const comp = snap.data?.components?.[0];
                  if (!comp) continue;
                  const p = { timestamp: snap.timestamp, lat: comp.lat, lon: comp.lon, accuracy: comp.accuracy ?? 50, speed: comp.speed ?? 0, deviceId: comp.device ?? undefined, source: comp.source ?? undefined, raw: true };
                  const key = dedupeKey(p);
                  if (seen.has(key)) continue;
                  seen.add(key);
                  positionsAll.push(p);
                  const deviceKey = String(comp.device ?? comp.source ?? "unknown");
                  lastTimestamps[deviceKey] = Math.max(lastTimestamps[deviceKey] ?? 0, p.timestamp ?? 0);
                } catch (e) {
                  // ignore malformed persisted entry
                }
              }
              positionsAll.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
              processPositions(positionsAll);
            }
          }
        } catch (e) {
          /* ignore localStorage errors */
        }
      }
    } catch (e) {
      /* ignore seeding errors */
    }

    function processPositions(positions: any[], nameMap?: Record<string, string>) {
      if (!positions || positions.length === 0) return;
      const nameMapLocal = nameMap ?? deviceNames;
      // Attach an explicit device key to each position (prefer deviceId, fallback to `source`)
      const positionsWithDevice = positions.map((p) => {
        const deviceKey = p.deviceId != null ? String(p.deviceId) : p.source ?? "unknown";
        return { ...p, device: deviceKey };
      });

      // Convert to measurements and build simple snapshots (UI-only)
      const first = positionsWithDevice[0];
      if (!first) return;
      const baseLat = first.lat;
      const baseLon = first.lon;
      setRefLat(baseLat);
      setRefLon(baseLon);

      // Group positions per device and sort each device stream by timestamp
      const posByDevice = new Map<string, any[]>();
      for (const p of positionsWithDevice) {
        const key = String(p.device ?? p.source ?? "unknown");
        if (!posByDevice.has(key)) posByDevice.set(key, []);
        posByDevice.get(key)!.push(p);
      }
      for (const arr of posByDevice.values()) arr.sort((a, b) => a.timestamp - b.timestamp);

      // Convert all positions into meters (per-device) and compute world bounds (min/max)
      const metersByDevice = new Map<string, any[]>();
      for (const [deviceKey, arr] of posByDevice) {
        const mp = arr.map((p) => {
          const { x, y } = degreesToMeters(p.lat, p.lon, baseLat, baseLon);
          const raw = (p as any).raw;
          const speed = typeof raw?.speed === "number" ? raw.speed : p.speed;
          return {
            lat: p.lat,
            lon: p.lon,
            accuracy: p.accuracy ?? 50,
            timestamp: p.timestamp,
            source: p.source,
            x,
            y,
            speed,
            device: deviceKey,
          };
        });
        metersByDevice.set(deviceKey, mp);
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

      const initialBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      let worldBoundsLocal = initialBounds;
      for (const mp of metersByDevice.values()) {
        for (const p of mp) {
          worldBoundsLocal = {
            minX: Math.min(worldBoundsLocal.minX, p.x),
            minY: Math.min(worldBoundsLocal.minY, p.y),
            maxX: Math.max(worldBoundsLocal.maxX, p.x),
            maxY: Math.max(worldBoundsLocal.maxY, p.y),
          };
        }
      }

      // Build raw per-position snapshots (history of measurements), keep per-device and merged lists
      const rawByDevice: Record<string, Snapshot[]> = {};
      const mergedRaw: Snapshot[] = [];
      for (const [deviceKey, mp] of metersByDevice) {
        const rawArr: Snapshot[] = mp.map((p) => ({
          timestamp: p.timestamp,
          data: {
            components: [
              {
                mean: [p.x, p.y] as [number, number],
                cov: measurementCovFromAccuracy(p.accuracy),
                accuracy: p.accuracy,
                weight: 1,
                source: p.source,
                lat: p.lat,
                lon: p.lon,
                raw: true,
                speed: p.speed,
                device: deviceKey,
                deviceName: nameMapLocal?.[deviceKey] ?? undefined,
              },
            ],
          },
        }));
        rawArr.sort((a, b) => a.timestamp - b.timestamp);
        rawByDevice[deviceKey] = rawArr;
        mergedRaw.push(...rawArr);
      }
      mergedRaw.sort((a, b) => a.timestamp - b.timestamp);
      // Merge per-device histories to preserve each device's location history
      setRawSnapshotsByDevice((prevByDevice) => {
        const mergedByDevice: Record<string, Snapshot[]> = { ...(prevByDevice ?? {}) };
        for (const [deviceKey, arr] of Object.entries(rawByDevice)) {
          const existing = mergedByDevice[deviceKey] ?? [];
          mergedByDevice[deviceKey] = mergeSnapshots(existing, arr).sort((a, b) => a.timestamp - b.timestamp);
        }
        const mergedArray = Object.values(mergedByDevice).flat().sort((a, b) => a.timestamp - b.timestamp);
        setRawSnapshots(mergedArray);
        return mergedByDevice;
      });

      // Convert to engine measurements and run each device through its own Engine instance
      const engineByDevice: Record<string, Snapshot[]> = {};
      const mergedEngine: Snapshot[] = [];
      (async () => {
        const { Engine } = await import("@/engine/engine");
        for (const [deviceKey, mp] of metersByDevice) {
          const measurements = mp.map((p) => ({
            mean: [p.x, p.y] as [number, number],
            cov: measurementCovFromAccuracy(p.accuracy),
            timestamp: p.timestamp,
            source: p.source,
            accuracy: p.accuracy,
            lat: p.lat,
            lon: p.lon,
            speed: p.speed,
          }));

          const enginePerDevice = new Engine();
          const measurementsSorted = measurements.slice().sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
          const engineSnapRaw = enginePerDevice.processMeasurements(measurementsSorted);

          const engineSnap: Snapshot[] = engineSnapRaw.map((s, idx) => {
            const m = measurementsSorted[idx];
            const prevM = measurementsSorted[idx - 1];
            const comps = s.data.components.map((c: any) => {
              const { lambda1, lambda2 } = eigenDecomposition(c.cov);
              const accuracyMeters = Math.round(Math.sqrt(Math.max(lambda1, lambda2)));

              // Prefer mixture's movement confidence if available
              let action = (c.action as string | undefined) ?? "still";

              // compute a display speed if possible (meters/second) from device or derived from consecutive measurements
              let displaySpeed: number | undefined = undefined;
              if (typeof m?.speed === "number") {
                displaySpeed = m.speed;
              } else if (prevM && m && typeof m.timestamp === "number" && typeof prevM.timestamp === "number") {
                const dt = (m.timestamp - prevM.timestamp) / 1000;
                if (dt > 0) {
                  const dx = (m.mean?.[0] ?? 0) - (prevM.mean?.[0] ?? 0);
                  const dy = (m.mean?.[1] ?? 0) - (prevM.mean?.[1] ?? 0);
                  displaySpeed = Math.sqrt(dx * dx + dy * dy) / dt;
                }
              }

              // fallback movement detection when mixture didn't supply an action
              if (!c.action && typeof displaySpeed === "number") {
                const speedThreshold = 0.5; // m/s (fallback threshold)
                if (displaySpeed > speedThreshold) action = "moving";
              }

              return { ...c, estimate: true, accuracyMeters, action, speed: displaySpeed, device: deviceKey, deviceName: nameMapLocal?.[deviceKey] ?? undefined };
            });
            return { timestamp: s.timestamp, data: { components: comps } };
          });

          engineSnap.sort((a, b) => a.timestamp - b.timestamp);
          engineByDevice[deviceKey] = engineSnap;
          mergedEngine.push(...engineSnap);
        }

        mergedEngine.sort((a, b) => a.timestamp - b.timestamp);
        setEngineSnapshotsByDevice(engineByDevice);

        // default timeline time to the latest raw snapshot (history should be raw)
        setTimelineTime(mergedRaw[mergedRaw.length - 1]?.timestamp ?? mergedEngine[mergedEngine.length - 1]?.timestamp ?? Date.now());
        // store world bounds somewhere (pass into CanvasView via state)
        setWorldBounds(worldBoundsLocal);
      })();
    }

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
            positionsAll.push(p);
            // keep positions sorted
            positionsAll.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
            // update last timestamp per device
            const deviceKey = String(p.deviceId ?? p.source ?? "");
            lastTimestamps[deviceKey] = Math.max(lastTimestamps[deviceKey] ?? 0, p.timestamp ?? 0);
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
              let deviceNameMap: Record<string, string> | undefined;
              if (derivedBase) {
                try {
                  const devices = await fetchDevices({ baseUrl: derivedBase, auth: traccarToken ? { type: "token", token: traccarToken } : undefined });
                  const map: Record<string, string> = {};
                  for (const d of devices) {
                    if (d && d.id != null) map[String(d.id)] = d.name ?? String(d.id);
                  }
                  setDeviceNames(map);
                  deviceNameMap = map;
                  // refresh current positions with names
                  processPositions(positionsAll, deviceNameMap);
                } catch (e) {
                  // ignore device fetch errors
                }
              }

              for (const [deviceKey, ts] of Object.entries(lastTimestamps)) {
                if (!deviceKey) continue;
                const from = new Date(Math.max(0, (ts ?? 0) + 1));

                // try requesting history over WS first (if supported)
                let got = false;
                try {
                  // `client` is in scope via closure (assigned after connectRealtime returns)
                  if ((client as any)?.requestPositions) {
                    try {
                      const wsRes = await (client as any).requestPositions({ deviceId: deviceKey, from, timeoutMs: 3000 });
                      if (wsRes && wsRes.length > 0) {
                        for (const p of wsRes) {
                          const key = dedupeKey(p);
                          if (seen.has(key)) continue;
                          seen.add(key);
                          positionsAll.push(p);
                        }
                        positionsAll.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
                        processPositions(positionsAll, deviceNameMap);
                        got = true;
                      }
                    } catch (e) {
                      // ignore ws request errors and fall back
                    }
                  }
                } catch (e) {
                  // ignore
                }

                if (got) continue;

                // fallback to REST fetchPositions
                try {
                  if (!derivedBase) {
                    // No base URL could be derived from settings — skip resync
                    continue;
                  }

                  const fetched = await fetchPositions({ baseUrl: derivedBase }, deviceKey, from, null, {});
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
                } catch (e) {
                  // ignore per-device fetch errors
                }
              }
            } catch (e) {
              // ignore
            }
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
          } catch (e) {
            /* ignore */
          }
        };
        (clientRef as any).current = client;
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
      } catch (e) {
        /* ignore */
      }
    };
  }, [traccarWsUrl, traccarToken, wsApplyCounter]);

  // helper to find the most recent snapshot before or at a given time
  function findLatestSnapshotBeforeOrAt(snaps: Snapshot[], time: number): Snapshot | null {
    for (let i = snaps.length - 1; i >= 0; i--) {
      const s = snaps[i];
      if (!s) continue;
      if (s.timestamp <= time) return s;
    }
    return null;
  }

  let frame = { components: [] as ComponentUI[] };
  if (timelineTime != null) {
    if (showAllPast) {
      const rawComps = showRaw ? rawSnapshots.filter((s) => s.timestamp <= timelineTime).flatMap((s) => s.data.components) : [];
      const engineComps = showEstimates
        ? Object.values(engineSnapshotsByDevice).flatMap((arr) => findLatestSnapshotBeforeOrAt(arr, timelineTime)?.data.components ?? [])
        : [];
      frame = { components: [...rawComps, ...engineComps] };
    } else {
      const selectedRawComps = showRaw
        ? Object.values(rawSnapshotsByDevice).flatMap((arr) => findLatestSnapshotBeforeOrAt(arr, timelineTime)?.data.components ?? [])
        : [];
      const selectedEngineComps = showEstimates
        ? Object.values(engineSnapshotsByDevice).flatMap((arr) => findLatestSnapshotBeforeOrAt(arr, timelineTime)?.data.components ?? [])
        : [];
      frame = { components: [...selectedRawComps, ...selectedEngineComps] };
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <Card className="bg-card/50 backdrop-blur-sm border-muted w-[90vw] h-[90vh] overflow-hidden mx-auto">
        <CardContent className="pt-6 h-full flex flex-col">
          <div className="flex justify-center items-center gap-8 mb-2">
            <h1 className="text-center text-3xl sm:text-5xl font-bold">Traccar UI POC</h1>
          </div>
          <div className="flex-1 h-full">
            <MapView
              components={frame.components}
              refLat={refLat}
              refLon={refLon}
              worldBounds={worldBounds}
              height="100%"
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
                          placeholder="Token (optional)"
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
                        <input type="checkbox" className="mr-2" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
                        Show Raw
                      </label>
                      <label className="flex items-center text-sm">
                        <input type="checkbox" className="mr-2" checked={showEstimates} onChange={(e) => setShowEstimates(e.target.checked)} />
                        Show Estimates
                      </label>
                      <label className="flex items-center text-sm">
                        <input type="checkbox" className="mr-2" checked={showAllPast} onChange={(e) => setShowAllPast(e.target.checked)} />
                        Show History
                      </label>
                    </div>
                  </div>
                </div>
              }
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default App;
