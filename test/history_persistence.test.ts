import { test, expect } from "bun:test";
import { mergeSnapshots } from "../src/lib/snapshots";

const makeSnap = (device: string, timestamp: number, lat: number, lon: number) => ({
  timestamp,
  data: {
    components: [
      {
        mean: [0, 0] as [number, number],
        lat,
        lon,
        device,
      },
    ],
  },
});

test("per-device merge preserves previous history when new locations arrive", () => {
  const prev = [makeSnap("d1", 1000, 1, 2), makeSnap("d1", 2000, 3, 4)];
  const next = [makeSnap("d1", 3000, 5, 6)];
  const merged = mergeSnapshots(prev, next);
  expect(merged.length).toBe(3);
  const ts = merged.map((s) => s.timestamp);
  expect(ts).toEqual([1000, 2000, 3000]);
});
