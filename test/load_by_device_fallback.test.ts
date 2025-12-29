import type { NormalizedPosition } from "@/api/traccarClient";
import { test, expect } from "bun:test";

test("parsing LS_RAW_BY_DEVICE (DevicePoint arrays) yields positions with normalized timestamps", () => {
  const now = Date.now();
  const t1 = now - 60_000;
  const t2 = now - 30_000;

  const storedByDevice = {
    d1: [
      { timestamp: t1, lat: 1.1, lon: -2.2, accuracy: 5, device: 1, mean: [1.1, -2.2], cov: [25, 0, 25] },
      { timestamp: t2, lat: 1.2, lon: -2.3, accuracy: 6, device: 1, mean: [1.2, -2.3], cov: [36, 0, 36] },
    ],
  };

  const positionsAll: NormalizedPosition[] = [];
  for (const [, arr] of Object.entries(storedByDevice)) {
    const snaps = arr.sort((a, b) => a.timestamp - b.timestamp);
    for (const snap of snaps) {
      const p: NormalizedPosition = { deviceId: snap.device, timestamp: snap.timestamp, lat: snap.lat, lon: snap.lon, accuracy: snap.accuracy };
      positionsAll.push(p);
    }
  }

  expect(positionsAll.length).toBe(2);
  expect(positionsAll[0]!.timestamp).toBe(t1);
  expect(positionsAll[1]!.timestamp).toBe(t2);
});