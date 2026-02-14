import { test, expect } from "bun:test";
import type { DevicePoint } from "@/types";

const VERBOSE = process.env["VERBOSE"] === "1" || process.argv.includes("--verbose");

test("adapt", async () => {
  const { Engine } = await import("../src/engine/engine");

  const makeMeasurement = (x: number, y: number, t: number, accuracy = 20) => {
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
  const stationaryCount = 60;
  const movingCount = 30;
  const stepMs = 60_000;

  const measurements: any[] = [];
  for (let i = 0; i < stationaryCount; i++) measurements.push(makeMeasurement(0, 0, t0 + i * stepMs, 20));
  for (let i = 0; i < movingCount; i++) {
    const x = 120 + (Math.random() - 0.5) * 6;
    const y = (Math.random() - 0.5) * 6;
    measurements.push(makeMeasurement(x, y, t0 + (stationaryCount + i) * stepMs, 20));
  }

  const snaps = engine.processMeasurements(measurements);

  if (VERBOSE) {
    console.log("index,timestamp,meanX,meanY,variance");
    for (let i = 0; i < snaps.length; i++) {
      const s = snaps[i];
      if (!s) continue;
      const comp = s.activeAnchor;
      if (!comp) continue;
      console.log(`${i},${s.timestamp},${comp.mean[0].toFixed(2)},${comp.mean[1].toFixed(2)},${comp.variance.toFixed(2)}`);
    }
  }

  const firstClose = snaps.findIndex((s) => {
    const comp = s.activeAnchor;
    if (!comp) return false;
    const distToNew = Math.hypot(comp.mean[0] - 120, comp.mean[1] - 0);
    return distToNew < 20;
  });

  expect(firstClose >= 0).toBe(true);
  if (VERBOSE) console.log(`adapt firstClose=${firstClose}`);
});