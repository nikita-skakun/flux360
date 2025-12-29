import { test, expect } from "bun:test";
import { mergeSnapshots } from "../src/lib/snapshots";
import type { DevicePoint } from "@/ui/types";

const makePoint = (device: number, timestamp: number, lat: number, lon: number, accuracy: number): DevicePoint => ({
  device,
  timestamp,
  mean: [0, 0],
  lat,
  lon,
  accuracy,
}) as DevicePoint;


test("mergeSnapshots prefers new accuracy when present", () => {
  const prev = [makePoint(1, 1000, 1, 2, 10)];
  const next = [makePoint(1, 1000, 1, 2, 25)];
  const merged = mergeSnapshots(prev, next);
  expect(merged.length).toBe(1);
  expect(merged[0]).toBeDefined();
  expect(merged[0]!.accuracy).toBe(25);
});
