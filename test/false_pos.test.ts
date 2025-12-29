import type { DevicePoint } from "@/ui/types";
import { test, expect } from "bun:test";

const VERBOSE = process.env.VERBOSE === "1" || process.argv.includes("--verbose");

test("false_pos", async () => {
  const { Engine } = await import("../src/engine/engine");

  const makeMeasurement = (x: number, y: number, t: number, accuracy = 8) => {
    return {
      device: 0,
      mean: [x, y],
      cov: [accuracy * accuracy, 0, accuracy * accuracy],
      timestamp: t,
      accuracy,
      lat: 0,
      lon: 0,
    } as DevicePoint;
  };

  const engine = new Engine();
  const t0 = Date.now();
  const count = 120;
  const stepMs = 60_000;

  const measurements: any[] = [];
  for (let i = 0; i < count; i++) {
    const jitterX = (Math.random() - 0.5) * 4;
    const jitterY = (Math.random() - 0.5) * 4;
    measurements.push(makeMeasurement(jitterX, jitterY, t0 + i * stepMs, 8));
  }

  measurements.push(makeMeasurement(18, -3, t0 + count * stepMs, 8));

  for (let i = count + 1; i < count + 20; i++) {
    const jitterX = (Math.random() - 0.5) * 4;
    const jitterY = (Math.random() - 0.5) * 4;
    measurements.push(makeMeasurement(jitterX, jitterY, t0 + i * stepMs, 8));
  }

  const snaps = engine.processMeasurements(measurements);

  if (VERBOSE) console.log("index,timestamp,bestMeanX,bestMeanY,bestWeight,distToOutlier");
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    if (!s) continue;
    const comps = s.data.components;
    if (comps.length === 0) {
      if (VERBOSE) console.log(`${i},${s.timestamp ?? ""},,,0,`);
      continue;
    }
    const best = comps.reduce((a, b) => (a.weight >= b.weight ? a : b));
    const bestMean = best.mean;
    const distToOutlier = Math.hypot(bestMean[0] - 18, bestMean[1] - -3);
    if (VERBOSE) console.log(`${i},${s.timestamp},${bestMean[0].toFixed(2)},${bestMean[1].toFixed(2)},${(best.weight).toFixed(3)},${distToOutlier.toFixed(2)}`);
  }

  const firstMoved = snaps.findIndex((s) => {
    const comps = s.data.components;
    if (comps.length === 0) return false;
    const best = comps.reduce((a, b) => (a.weight >= b.weight ? a : b));
    const bestMean = best.mean;
    const dist = Math.hypot(bestMean[0] - 18, bestMean[1] - -3);
    return dist < 8;
  });

  expect(firstMoved).toBe(-1);
  if (VERBOSE) console.log("false_pos ok");
});