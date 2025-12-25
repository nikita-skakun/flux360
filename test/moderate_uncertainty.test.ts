import { test, expect } from "bun:test";

const VERBOSE = process.env.VERBOSE === "1" || process.argv.includes("--verbose");

test("moderate_uncertainty", async () => {
  const { Engine } = await import("../src/engine/engine");

  const makeMeasurement = (x: number, y: number, t: number, accuracy = 60, speed?: number, motion?: boolean) => {
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
  const stationaryCount = 100;
  const stepMs = 60_000;

  const measurements: any[] = [];
  for (let i = 0; i < stationaryCount; i++) measurements.push(makeMeasurement((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, t0 + i * stepMs, 10));

  measurements.push(makeMeasurement(200, 0, t0 + stationaryCount * stepMs, 60));
  measurements.push(makeMeasurement(201, -1, t0 + (stationaryCount + 1) * stepMs, 60));

  const snaps = engine.processMeasurements(measurements);

  const firstClose = snaps.findIndex((s) => {
    const comps = s?.data.components as any[] | undefined;
    if (!comps) return false;
    const best = comps.reduce((a, b) => ((a.weight ?? 0) >= (b.weight ?? 0) ? a : b));
    const bestMean = best.mean ?? [0, 0];
    const distToNew = Math.hypot(bestMean[0] - 200, bestMean[1] - 0);
    return distToNew < 20;
  });

  expect(firstClose >= 0).toBe(true);
  if (VERBOSE) console.log(`moderate_uncertainty firstClose=${firstClose}`);
});