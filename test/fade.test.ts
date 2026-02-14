import { test, expect } from "bun:test";
import type { DevicePoint } from "@/types";

const VERBOSE = process.env["VERBOSE"] === "1" || process.argv.includes("--verbose");

test("fade", async () => {
  const { Engine } = await import("../src/engine/engine");

  const makeMeasurement = (x: number, y: number, t: number, accuracy: number) => {
    return {
      device: 0,
      mean: [x, y],
      variance: accuracy * accuracy,
      timestamp: t,
      accuracy,
      lat: 0,
      lon: 0,
      anchorAgeMs: 0,
    } as DevicePoint;
  };

  const engine = new Engine();
  const t0 = Date.now();
  const stationaryCount = 40;
  const moveCount = 8;
  const stableCount = 6;
  const stepMs = 60_000;

  const measurements: DevicePoint[] = [];
  for (let i = 0; i < stationaryCount; i++) measurements.push(makeMeasurement((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, t0 + i * stepMs, 10));
  for (let i = 0; i < moveCount; i++) {
    const x = 120 + (Math.random() - 0.5) * 4;
    const y = (Math.random() - 0.5) * 4;
    measurements.push(makeMeasurement(x, y, t0 + (stationaryCount + i) * stepMs, 10));
  }
  for (let i = 0; i < stableCount; i++) measurements.push(makeMeasurement(120 + (Math.random() - 0.5) * 1, (Math.random() - 0.5) * 1, t0 + (stationaryCount + moveCount + i) * stepMs, 8));

  const snaps = engine.processMeasurements(measurements);

  const keyIndices = [stationaryCount - 1, stationaryCount + moveCount - 1, stationaryCount + moveCount + stableCount - 1];
  if (VERBOSE) {
    console.log("Processed snapshots:");
    for (const idx of keyIndices) {
      const s = snaps[idx];
      if (!s) continue;
      const comp = s.activeAnchor;
      if (!comp) continue;
      console.log(`Snapshot index=${idx}, timestamp=${s.timestamp}, mean=${comp.mean.map(v => v.toFixed(2)).join(",")}, variance=${comp.variance.toFixed(2)}`);
    }
  }

  const final = snaps[snaps.length - 1];
  const finalComps = final?.closedAnchors ?? [];
  const spawnedCount = finalComps.length; // number of closed anchors

  expect(spawnedCount).toBe(1); // one closed anchor from the move
  if (VERBOSE) console.log(`fade closedCount=${spawnedCount}`);

  // ensure active anchor is near 120 at the end
  const endComp = final?.activeAnchor;
  const distEnd = endComp ? Math.hypot(endComp.mean[0] - 120, endComp.mean[1] - 0) : Infinity;
  expect(distEnd < 10).toBe(true);
});