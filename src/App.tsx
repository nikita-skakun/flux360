import { Card, CardContent } from "@/components/ui/card";
import "./index.css";
import { useEffect, useState } from "react";
import MapView from "./ui/MapView";
import { TimelineSlider } from "./ui/TimelineSlider";
import type { ComponentUI } from "@/ui/types";
import { degreesToMeters } from "./util/geo";
import { measurementCovFromAccuracy, eigenDecomposition } from "@/util/gaussian";

export function App() {
  type DevPosition = { lat: number; lon: number; accuracy?: number; timestamp: number; source?: string; raw?: unknown };
  type Snapshot = { timestamp: number; data: { components: ComponentUI[] } };
  type WorldBounds = { minX: number; minY: number; maxX: number; maxY: number };

  const [timelineTime, setTimelineTime] = useState<number | null>(null);
  const [rawSnapshots, setRawSnapshots] = useState<Snapshot[]>([]);
  const [rawSnapshotsByDevice, setRawSnapshotsByDevice] = useState<Record<string, Snapshot[]>>({});
  const [engineSnapshotsByDevice, setEngineSnapshotsByDevice] = useState<Record<string, Snapshot[]>>({});
  const [refLat, setRefLat] = useState<number | null>(null);
  const [refLon, setRefLon] = useState<number | null>(null);
  const [worldBounds, setWorldBounds] = useState<WorldBounds | null>(null);
  const [showRaw, setShowRaw] = useState(true);
  const [showEstimates, setShowEstimates] = useState(true);
  const [showAllPast, setShowAllPast] = useState(false);

  useEffect(() => {
    async function loadData() {
      try {
        // Try loaded dev data from local dev server endpoint
        const res = await fetch('/api/dev-data/positions');
        if (!res.ok) throw new Error("no dev data");
        const positionsRaw = await res.json();
        if (!Array.isArray(positionsRaw) || positionsRaw.length === 0) return;
        const positionsFiltered = positionsRaw.filter((p): p is DevPosition => !!p && typeof p === "object" && typeof (p as Record<string, unknown>).lat === "number" && typeof (p as Record<string, unknown>).lon === "number" && typeof (p as Record<string, unknown>).timestamp === "number");
        if (positionsFiltered.length === 0) return;

        // Attach an explicit device key to each position (prefer raw.deviceId, fallback to `source`)
        const positions = positionsFiltered.map((p) => {
          const deviceFromRaw = (p.raw && (p.raw as any).deviceId) ?? undefined;
          const deviceKey = deviceFromRaw != null ? String(deviceFromRaw) : p.source ?? "unknown";
          return { ...p, device: deviceKey };
        });

        // Convert to measurements and build simple snapshots (UI-only)
        const first = positions[0];
        if (!first) return;
        const baseLat = first.lat;
        const baseLon = first.lon;
        setRefLat(baseLat);
        setRefLon(baseLon);

        // Group positions per device and sort each device stream by timestamp
        const posByDevice = new Map<string, DevPosition[]>();
        for (const p of positions) {
          const key = String(p.device ?? p.source ?? "unknown");
          if (!posByDevice.has(key)) posByDevice.set(key, []);
          posByDevice.get(key)!.push(p);
        }
        for (const arr of posByDevice.values()) {
          arr.sort((a, b) => a.timestamp - b.timestamp);
        }

        // Convert all positions into meters (per-device) and compute world bounds (min/max)
        const metersByDevice = new Map<string, any[]>();
        for (const [deviceKey, arr] of posByDevice) {
          const mp = arr.map((p) => {
            const { x, y } = degreesToMeters(p.lat, p.lon, baseLat, baseLon);
            const raw = (p as any).raw;
            // Prefer derived speed (computed from displacement) over device-reported speed
            const speed = typeof raw?.speed === "number" ? raw.speed : undefined;
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
                  weight: 1,
                  source: p.source,
                  lat: p.lat,
                  lon: p.lon,
                  raw: true,
                  speed: p.speed,
                  device: deviceKey,
                },
              ],
            },
          }));
          rawArr.sort((a, b) => a.timestamp - b.timestamp);
          rawByDevice[deviceKey] = rawArr;
          mergedRaw.push(...rawArr);
        }
        mergedRaw.sort((a, b) => a.timestamp - b.timestamp);
        setRawSnapshots(mergedRaw);
        setRawSnapshotsByDevice(rawByDevice);

        // Convert to engine measurements and run each device through its own Engine instance
        const engineByDevice: Record<string, Snapshot[]> = {};
        const mergedEngine: Snapshot[] = [];
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

              return { ...c, estimate: true, accuracyMeters, action, speed: displaySpeed, device: deviceKey };
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
      } catch (e) {
        console.warn("Could not load dev data: ", e);
      }
    }
    loadData();
  }, []);

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
