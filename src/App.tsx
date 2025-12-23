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
  const [engineSnapshots, setEngineSnapshots] = useState<Snapshot[]>([]);
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
        const positions = positionsRaw.filter((p): p is DevPosition => !!p && typeof p === "object" && typeof (p as Record<string, unknown>).lat === "number" && typeof (p as Record<string, unknown>).lon === "number" && typeof (p as Record<string, unknown>).timestamp === "number");
        if (positions.length === 0) return;

        // Convert to measurements and build simple snapshots (UI-only)
        const first = positions[0];
        if (!first) return;
        const baseLat = first.lat;
        const baseLon = first.lon;
        setRefLat(baseLat);
        setRefLon(baseLon);

        // Convert all positions into meters and compute world bounds (min/max)
        const metersPos = positions.map((p) => {
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
          };
        });

        // Compute derived speeds for raw reports based on displacement / dt (overrides device speed)
        for (let i = 0; i < metersPos.length; i++) {
          const cur = metersPos[i] as any;
          const prev = metersPos[i - 1] as any | undefined;
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

        const initialBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
        const worldBounds = metersPos.reduce(
          (acc, mp) => ({
            minX: Math.min(acc.minX, mp.x),
            minY: Math.min(acc.minY, mp.y),
            maxX: Math.max(acc.maxX, mp.x),
            maxY: Math.max(acc.maxY, mp.y),
          }),
          initialBounds
        );

        // Build raw per-position snapshots (history of measurements)
        const rawArr: Snapshot[] = metersPos.map((p) => ({
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
              },
            ],
          },
        }));
        setRawSnapshots(rawArr);

        // Convert to engine measurements and run the engine (estimates)
        const measurements = metersPos.map((p) => ({
          mean: [p.x, p.y] as [number, number],
          cov: measurementCovFromAccuracy(p.accuracy),
          timestamp: p.timestamp,
          source: p.source,
          accuracy: p.accuracy,
          lat: p.lat,
          lon: p.lon,
          speed: p.speed,
        }));

        const { Engine } = await import("@/engine/engine");
        const engine = new Engine();
        // Ensure measurements are sorted the same way the engine expects
        const measurementsSorted = measurements.slice().sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
        const engineSnapRaw = engine.processMeasurements(measurementsSorted);
        // mark estimate components for optional styling and compute metadata (accuracy in meters, action, speed)
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

            return { ...c, estimate: true, accuracyMeters, action, speed: displaySpeed };
          });
          return { timestamp: s.timestamp, data: { components: comps } };
        });
        setEngineSnapshots(engineSnap);

        // default timeline time to the latest raw snapshot (history should be raw)
        setTimelineTime(rawArr[rawArr.length - 1]?.timestamp ?? engineSnap[engineSnap.length - 1]?.timestamp ?? Date.now());
        // store world bounds somewhere (pass into CanvasView via state)
        setWorldBounds(worldBounds);
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
      const engineComps = showEstimates ? findLatestSnapshotBeforeOrAt(engineSnapshots, timelineTime)?.data.components ?? [] : [];
      frame = { components: [...rawComps, ...engineComps] };
    } else {
      const selectedRawComps = showRaw ? findLatestSnapshotBeforeOrAt(rawSnapshots, timelineTime)?.data.components ?? [] : [];
      const selectedEngineComps = showEstimates ? findLatestSnapshotBeforeOrAt(engineSnapshots, timelineTime)?.data.components ?? [] : [];
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
