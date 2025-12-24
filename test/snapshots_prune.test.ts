import { test, expect } from "bun:test";
import { pruneSnapshots } from "../src/lib/snapshots";

test("pruneSnapshots keeps only the last-day entries", () => {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const cutoff = now - oneDay;

  const snaps = [
    { timestamp: cutoff - 1000, data: { components: [] } },
    { timestamp: cutoff + 1000, data: { components: [] } },
    { timestamp: now, data: { components: [] } },
  ];

  const pruned = pruneSnapshots(snaps, cutoff);
  expect(pruned.length).toBe(2);
  expect(pruned.map((s) => s.timestamp)).toEqual([cutoff + 1000, now]);
});