import { Card, CardContent } from "@/components/ui/card";
import "./index.css";
import { useEffect, useState } from "react";
import { CanvasView } from "./ui/CanvasView";
import { TimelineSlider } from "./ui/TimelineSlider";
import { degreesToMeters } from "./util/geo";
import MixtureEngine from "./engine/mixture";

export function App() {
  const [engine] = useState(() => new MixtureEngine());
  const [timelineIndex, setTimelineIndex] = useState(0);
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [center, setCenter] = useState<{ x: number; y: number } | null>(null);
  const [worldBounds, setWorldBounds] = useState<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null);

  useEffect(() => {
    async function loadData() {
      try {
        // Try loaded dev data from local dev server endpoint
        const res = await fetch('/api/dev-data/positions');
        if (!res.ok) throw new Error('no dev data');
        const positions = await res.json();
        if (!Array.isArray(positions) || positions.length === 0) return;

        // Convert to measurements and run engine; first convert to meter coordinates for bounds
        engine.reset();
        const refLat = positions[0].lat;
        const refLon = positions[0].lon;
        // Convert all positions into meters and compute world bounds (min/max)
        const metersPos = positions.map((p: any) => ({
          lat: p.lat,
          lon: p.lon,
          accuracy: p.accuracy,
          timestamp: p.timestamp,
          source: p.source,
          ...degreesToMeters(p.lat, p.lon, refLat, refLon),
        }));
        setCenter(null); // leave center null so CanvasView fitToBounds uses worldBounds
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const mp of metersPos) {
          minX = Math.min(minX, mp.x);
          maxX = Math.max(maxX, mp.x);
          minY = Math.min(minY, mp.y);
          maxY = Math.max(maxY, mp.y);
        }
        const worldBounds = { minX, minY, maxX, maxY };

        for (const p of metersPos) {
          const { x, y } = { x: p.x, y: p.y };
          const cov: [number, number, number] = p.accuracy
            ? [p.accuracy * p.accuracy, 0, p.accuracy * p.accuracy]
            : [100, 0, 100];
          engine.predictAll();
          engine.updateWithMeasurement({ mean: [x, y], cov, timestamp: p.timestamp, source: p.source });
        }
        const arr = engine.timeline.asArray();
        setSnapshots(arr);
        setTimelineIndex(Math.max(0, arr.length - 1));
        // store world bounds somewhere (pass into CanvasView via state)
        setWorldBounds(worldBounds);
      } catch (e) {
        console.warn("Could not load dev data: ", e);
      }
    }
    loadData();
  }, [engine]);

  const frame = snapshots[timelineIndex]?.data ?? { components: [] };

  return (
    <div className="container mx-auto p-8 text-center relative z-10">
        <div className="flex justify-center items-center gap-8 mb-8">
          <h1 className="text-center text-5xl font-bold">Traccar Mixture POC</h1>
        </div>

      <Card className="bg-card/50 backdrop-blur-sm border-muted">
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
              <CanvasView components={frame.components} refMeters={center ?? { x: 0, y: 0 }} worldBounds={worldBounds} />
            </div>
            <div className="text-left">
            
              <div className="mb-4">
                <TimelineSlider
                  length={snapshots.length}
                  index={timelineIndex}
                  onChange={(i) => setTimelineIndex(i)}
                />
              </div>
              <p className="text-sm">Snapshots: {snapshots.length}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default App;
