import { test, expect } from "bun:test";
import { mergeSnapshots } from "../src/lib/snapshots";

const makeSnap = (device: string, timestamp: number, lat: number, lon: number, accuracy?: number, raw?: boolean) => ({
  timestamp,
  data: {
    components: [
      {
        mean: [0, 0] as [number, number],
        lat,
        lon,
        device,
        accuracy,
        raw,
      },
    ],
  },
});

test("mergeSnapshots preserves previous accuracy when new snapshot lacks accuracy", () => {
  const prev = [makeSnap("d1", 1000, 1, 2, 10)];
  const next = [makeSnap("d1", 1000, 1, 2)];
  const merged = mergeSnapshots(prev, next);
  expect(merged.length).toBe(1);
  expect(merged[0]).toBeDefined();
  expect(merged[0]!.data.components[0]).toBeDefined();
  expect(merged[0]!.data.components[0]!.accuracy).toBe(10);
});

test("mergeSnapshots prefers new accuracy when present", () => {
  const prev = [makeSnap("d1", 1000, 1, 2, 10)];
  const next = [makeSnap("d1", 1000, 1, 2, 25)];
  const merged = mergeSnapshots(prev, next);
  expect(merged.length).toBe(1);
  expect(merged[0]).toBeDefined();
  expect(merged[0]!.data.components[0]).toBeDefined();
  expect(merged[0]!.data.components[0]!.accuracy).toBe(25);
});
