import type { DevicePoint } from "@/ui/types";
import { test, expect } from "bun:test";

const VERBOSE = process.env["VERBOSE"] === "1" || process.argv.includes("--verbose");

test("stationary_transition", async () => {
  const { Engine } = await import("../src/engine/engine");

  const makeMeasurement = (x: number, y: number, t: number, accuracy = 10) => {
    return {
      device: 0,
      mean: [x, y],
      cov: [accuracy * accuracy, 0, accuracy * accuracy],
      timestamp: t,
      accuracy,
      lat: 0,
      lon: 0,
      anchorAgeMs: 0,
    } as DevicePoint;
  };

  const engine = new Engine();
  const t0 = Date.now();
  const stationaryCount = 30;
  const moveCount = 6;
  const settleCount = 6;
  const stepMs = 60_000;

  const measurements: DevicePoint[] = [];
  for (let i = 0; i < stationaryCount; i++) measurements.push(makeMeasurement((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, t0 + i * stepMs, 10));
  for (let i = 0; i < moveCount; i++) {
    const x = 120 + (Math.random() - 0.5) * 4;
    const y = (Math.random() - 0.5) * 4;
    measurements.push(makeMeasurement(x, y, t0 + (stationaryCount + i) * stepMs, 8));
  }
  for (let i = 0; i < settleCount; i++) measurements.push(makeMeasurement(120 + (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5, t0 + (stationaryCount + moveCount + i) * stepMs, 6));

  const snaps = engine.processMeasurements(measurements);

  const final = snaps[snaps.length - 1];
  const comp = final?.activeAnchor;
  const distToNew = comp ? Math.hypot(comp.mean[0] - 120, comp.mean[1] - 0) : Infinity;

  expect(distToNew < 10).toBe(true);
  if (VERBOSE) console.log(`stationary_transition distToNew=${distToNew.toFixed(2)}`);
});