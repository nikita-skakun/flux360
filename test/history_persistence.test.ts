import { test, expect } from "bun:test";
import type { DevicePoint } from "@/types";

const makePoint = (device: number, timestamp: number, lat: number, lon: number) => ({
  device,
  timestamp,
  lat,
  lon,
  mean: [lat, lon],
  variance: 1,
  accuracy: 10,
  anchorAgeMs: 0,
}) as DevicePoint;

test("per-device merge preserves previous history when new locations arrive", () => {
  const prev = [makePoint(1, 1000, 1, 2), makePoint(1, 2000, 3, 4)];
  const next = [makePoint(1, 3000, 5, 6)];
  const merged = [...prev, ...next].sort((a, b) => a.timestamp - b.timestamp);
  expect(merged.length).toBe(3);
  const ts = merged.map((s) => s.timestamp);
  expect(ts).toEqual([1000, 2000, 3000]);
});
