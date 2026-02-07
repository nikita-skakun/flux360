import type { DevicePoint } from "@/ui/types";
import { test, expect } from "bun:test";

test("dominant anchor at timestamp", async () => {
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
  const t0 = 1000000;
  const step = 1000;

  const measurements1: DevicePoint[] = [];
  for (let i = 0; i < 10; i++) {
    measurements1.push(makeMeasurement(0, 0, t0 + i * step));
  }

  engine.processMeasurements(measurements1);
  const firstAnchor = engine.activeAnchor!;

  const dom1 = engine.getDominantAnchorAt(t0 + 5 * step);
  expect(dom1).toBe(firstAnchor);

  const measurements2: DevicePoint[] = [];
  for (let i = 0; i < 10; i++) {
    measurements2.push(makeMeasurement(100, 0, t0 + (10 + i) * step));
  }

  engine.processMeasurements(measurements2);
  const secondAnchor = engine.activeAnchor!;

  const dom2 = engine.getDominantAnchorAt(t0 + 15 * step);
  expect(dom2).toBe(secondAnchor);

  const dom3 = engine.getDominantAnchorAt(t0 + 2 * step);
  expect(dom3).toBe(firstAnchor);

  const dom4 = engine.getDominantAnchorAt(t0 - 1000);
  expect(dom4).toBeNull();

  const dom5 = engine.getDominantAnchorAt(t0 + 20 * step);
  expect(dom5).toBe(secondAnchor);
});