import { test, expect } from "bun:test";
import { normalizeSnapshots } from "../src/lib/snapshots";

test("normalizeSnapshots converts second-based timestamps to milliseconds and sorts", () => {
  const now = Date.now();
  const tSeconds = Math.floor((now - 3600_000) / 1000); // one hour ago, in seconds
  const tMs = now;

  const snaps = [
    { timestamp: tSeconds as any, data: { components: [] } },
    { timestamp: tMs as any, data: { components: [] } },
  ];

  const out = normalizeSnapshots(snaps as any);
  expect(out.length).toBe(2);
  expect(out[0].timestamp).toBe(tSeconds * 1000);
  expect(out[1].timestamp).toBe(tMs);
});