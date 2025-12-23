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
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [refLat, setRefLat] = useState<number | null>(null);
  const [refLon, setRefLon] = useState<number | null>(null);
  const [worldBounds, setWorldBounds] = useState<WorldBounds | null>(null);
  const [showMarkers, setShowMarkers] = useState(true);
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

        // Build simple per-position snapshots so the UI can step through positions
        const arr: Snapshot[] = metersPos.map((p) => ({
          timestamp: p.timestamp,
          data: {
            components: [
              {
                mean: [p.x, p.y] as [number, number],
                cov: measurementCovFromAccuracy(p.accuracy),
                weight: 1,
                source: p.source,
              },
            ],
          },
        }));
        setSnapshots(arr);
        // default timeline time to the latest snapshot
        setTimelineTime(arr[arr.length - 1]?.timestamp ?? Date.now());
        // store world bounds somewhere (pass into CanvasView via state)
        setWorldBounds(worldBounds);
      } catch (e) {
        console.warn("Could not load dev data: ", e);
      }
    }
    loadData();
  }, []);

  let frame = { components: [] as ComponentUI[] };
  if (showMarkers && timelineTime != null && snapshots.length > 0) {
    if (showAllPast) {
      // show all snapshots with timestamp <= timelineTime
      const comps = snapshots.filter((s) => s.timestamp <= timelineTime).flatMap((s) => s.data.components);
      frame = { components: comps };
    } else {
      // show the most recent snapshot before or at timelineTime
      let selected: Snapshot | null = null;
      for (let i = snapshots.length - 1; i >= 0; i--) {
        const s = snapshots[i];
        if (!s) continue;
        if (s.timestamp <= timelineTime) {
          selected = s;
          break;
        }
      }
      frame = selected?.data ?? { components: [] };
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
                      snapshots={snapshots}
                      time={timelineTime ?? (snapshots[snapshots.length - 1]?.timestamp ?? Date.now())}
                      onChange={(t) => setTimelineTime(t)}
                    />
                    <div className="flex items-center gap-4 mt-2">
                      <p className="text-sm">Snapshots: {snapshots.length}</p>
                      <label className="flex items-center text-sm">
                        <input type="checkbox" className="mr-2" checked={showMarkers} onChange={(e) => setShowMarkers(e.target.checked)} />
                        Show Markers
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
