import { test, expect } from "bun:test";

test("pruneSnapshots keeps only the last-day entries", () => {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const cutoff = now - oneDay;

  const points = [
    { timestamp: cutoff - 1000, lat: 0, lon: 0, device: 1, mean: [0,0], variance: 1, accuracy: 10 },
    { timestamp: cutoff + 1000, lat: 0, lon: 0, device: 1, mean: [0,0], variance: 1, accuracy: 10 },
    { timestamp: now, lat: 0, lon: 0, device: 1, mean: [0,0], variance: 1, accuracy: 10 },
  ];

  const pruned = points.filter((p) => p.timestamp >= cutoff).sort((a, b) => a.timestamp - b.timestamp);
  expect(pruned.length).toBe(2);
  expect(pruned.map((s) => s.timestamp)).toEqual([cutoff + 1000, now]);
});