import { test, expect } from "bun:test";
import { normalizeSnapshots } from "../src/lib/snapshots";

test("parsing LS_RAW_BY_DEVICE yields positions with normalized timestamps", () => {
  const now = Date.now();
  const t1 = now - 60_000; // one minute ago
  const t2 = now - 30_000; // 30 seconds ago

  const storedByDevice = {
    d1: [
      { timestamp: t1, data: { components: [{ lat: 1.1, lon: -2.2, accuracy: 5, device: 'd1' }] } },
      { timestamp: t2, data: { components: [{ lat: 1.2, lon: -2.3, accuracy: 6, device: 'd1' }] } },
    ],
  };

  const positionsAll: any[] = [];
  for (const [k, arr] of Object.entries(storedByDevice)) {
    const snaps = normalizeSnapshots(arr as any);
    for (const snap of snaps) {
      const comp = snap.data?.components?.[0];
      if (!comp) continue;
      const p = { timestamp: snap.timestamp, lat: comp.lat, lon: comp.lon, accuracy: comp.accuracy ?? 50, speed: comp.speed ?? 0, deviceId: comp.device ?? undefined, source: comp.source ?? undefined, raw: true };
      positionsAll.push(p);
    }
  }

  expect(positionsAll.length).toBe(2);
  expect(positionsAll[0].timestamp).toBe(t1);
  expect(positionsAll[1].timestamp).toBe(t2);
});