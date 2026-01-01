import type { DevicePoint } from "@/ui/types";
import { test, expect } from "bun:test";

const VERBOSE = process.env["VERBOSE"] === "1" || process.argv.includes("--verbose");

test("moderate_uncertainty", async () => {
  const { Engine } = await import("../src/engine/engine");

  const makeMeasurement = (x: number, y: number, t: number, accuracy = 60) => {
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
  const stationaryCount = 100;
  const stepMs = 60_000;

  const measurements: DevicePoint[] = [];
  for (let i = 0; i < stationaryCount; i++) measurements.push(makeMeasurement((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, t0 + i * stepMs, 10));

  measurements.push(makeMeasurement(200, 0, t0 + stationaryCount * stepMs, 10));
  measurements.push(makeMeasurement(201, -1, t0 + (stationaryCount + 1) * stepMs, 10));

  const snaps = engine.processMeasurements(measurements);

  const firstClose = snaps.findIndex((s) => {
    const comp = s.activeAnchor;
    if (!comp) return false;
    const distToNew = Math.hypot(comp.mean[0] - 200, comp.mean[1] - 0);
    return distToNew < 100;
  });

  expect(firstClose >= 0).toBe(true);
  if (VERBOSE) console.log(`moderate_uncertainty firstClose=${firstClose}`);
});