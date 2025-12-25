import { test, expect } from "bun:test";

const VERBOSE = process.env.VERBOSE === "1" || process.argv.includes("--verbose");

test("two_move", async () => {
  const { Engine } = await import("../src/engine/engine");

  const makeMeasurement = (x: number, y: number, t: number, accuracy = 15, speed?: number, motion?: boolean) => {
    return {
      mean: [x, y] as [number, number],
      cov: [accuracy * accuracy, 0, accuracy * accuracy] as [number, number, number],
      timestamp: t,
      accuracy,
      speed,
      motion,
      lat: 0,
      lon: 0,
    } as any;
  };

  const engine = new Engine();
  const t0 = Date.now();
  const stationaryCount = 80;
  const stepMs = 60_000;

  const measurements: any[] = [];
  for (let i = 0; i < stationaryCount; i++) measurements.push(makeMeasurement(0, 0, t0 + i * stepMs, 10));

  measurements.push(makeMeasurement(120, 0, t0 + stationaryCount * stepMs, 20, 1.3, true));
  measurements.push(makeMeasurement(121, -1, t0 + (stationaryCount + 1) * stepMs, 20, 1.1, true));

  const snaps = engine.processMeasurements(measurements);

  if (VERBOSE) console.log("index,timestamp,bestMeanX,bestMeanY,bestWeight,distToNew");
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    if (!s) continue;
    const comps = s.data?.components as any[] | undefined;
    if (!comps || comps.length === 0) {
      if (VERBOSE) console.log(`${i},${s.timestamp ?? ""},,,0,`);
      continue;
    }
    const best = comps.reduce((a, b) => ((a.weight ?? 0) >= (b.weight ?? 0) ? a : b));
    const bestMean = best.mean ?? [0, 0];
    const distToNew = Math.hypot(bestMean[0] - 120, bestMean[1] - 0);
    if (VERBOSE) console.log(`${i},${s.timestamp ?? ""},${bestMean[0].toFixed(2)},${bestMean[1].toFixed(2)},${((best.weight ?? 0).toFixed(3))},${distToNew.toFixed(2)}`);
  }

  const firstClose = snaps.findIndex((s) => {
    const comps = s?.data.components as any[] | undefined;
    if (!comps || comps.length === 0) return false;
    const best = comps.reduce((a, b) => ((a.weight ?? 0) >= (b.weight ?? 0) ? a : b));
    const bestMean = best.mean ?? [0, 0];
    const distToNew = Math.hypot(bestMean[0] - 120, bestMean[1] - 0);
    return distToNew < 20;
  });

  expect(firstClose >= 0).toBe(true);
  if (VERBOSE) console.log(`two_move firstClose=${firstClose}`);
});