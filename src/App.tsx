import { Card, CardContent } from "@/components/ui/card";
import "./index.css";
import { useEffect, useState } from "react";
import MapView from "./ui/MapView";
import { TimelineSlider } from "./ui/TimelineSlider";
import type { ComponentUI } from "@/ui/types";
import { degreesToMeters } from "./util/geo";
import { measurementCovFromAccuracy } from "@/util/gaussian";

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
          return {
            lat: p.lat,
            lon: p.lon,
            accuracy: p.accuracy ?? 50,
            timestamp: p.timestamp,
            source: p.source,
            x,
            y,
          };
        });

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
        }));

        const { Engine } = await import("@/engine/engine");
        const engine = new Engine();
        const engineSnapRaw = engine.processMeasurements(measurements);
        // mark estimate components for optional styling
        const engineSnap: Snapshot[] = engineSnapRaw.map((s) => ({
          timestamp: s.timestamp,
          data: {
            components: s.data.components.map((c) => ({ ...c, estimate: true })),
          },
        }));
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

  let frame = { components: [] as ComponentUI[] };
  if (timelineTime != null) {
    if (showAllPast) {
      // When showing history, display raw measurement history (if enabled), and optionally show the latest estimate at that time
      const rawComps = showRaw ? rawSnapshots.filter((s) => s.timestamp <= timelineTime).flatMap((s) => s.data.components) : [];
      let engineComps: ComponentUI[] = [];
      if (showEstimates) {
        let selectedEngine: Snapshot | null = null;
        for (let i = engineSnapshots.length - 1; i >= 0; i--) {
          const s = engineSnapshots[i];
          if (!s) continue;
          if (s.timestamp <= timelineTime) {
            selectedEngine = s;
            break;
          }
        }
        engineComps = selectedEngine?.data.components ?? [];
      }
      frame = { components: [...rawComps, ...engineComps] };
    } else {
      // Show most recent raw and/or engine snapshot before or at timelineTime
      let selectedRaw: Snapshot | null = null;
      for (let i = rawSnapshots.length - 1; i >= 0; i--) {
        const s = rawSnapshots[i];
        if (!s) continue;
        if (s.timestamp <= timelineTime) {
          selectedRaw = s;
          break;
        }
      }
      let selectedEngine: Snapshot | null = null;
      for (let i = engineSnapshots.length - 1; i >= 0; i--) {
        const s = engineSnapshots[i];
        if (!s) continue;
        if (s.timestamp <= timelineTime) {
          selectedEngine = s;
          break;
        }
      }
      const comps: ComponentUI[] = [
        ...(showRaw ? selectedRaw?.data.components ?? [] : []),
        ...(showEstimates ? selectedEngine?.data.components ?? [] : []),
      ];
      frame = { components: comps };
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
