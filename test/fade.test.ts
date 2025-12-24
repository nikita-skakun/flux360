import { test, expect } from "bun:test";

const VERBOSE = process.env.VERBOSE === "1" || process.argv.includes("--verbose");

test("fade", async () => {
  const { Engine } = await import("../src/engine/engine");

  const makeMeasurement = (x: number, y: number, t: number, accuracy = 10, speed?: number, motion?: boolean) => {
    return {
      mean: [x, y] as [number, number],
      cov: [accuracy * accuracy, 0, accuracy * accuracy] as [number, number, number],
      timestamp: t,
      accuracy,
      speed,
      motion,
      source: "sim",
      lat: 0,
      lon: 0,
    } as any;
  };

  const engine = new Engine();
  const t0 = Date.now();
  const stationaryCount = 40;
  const moveCount = 8;
  const stableCount = 6;
  const stepMs = 60_000;

  const measurements: any[] = [];
  for (let i = 0; i < stationaryCount; i++) measurements.push(makeMeasurement((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, t0 + i * stepMs, 10));
  for (let i = 0; i < moveCount; i++) {
    const x = 120 + (Math.random() - 0.5) * 4;
    const y = (Math.random() - 0.5) * 4;
    measurements.push(makeMeasurement(x, y, t0 + (stationaryCount + i) * stepMs, 10, 1.2, true));
  }
  for (let i = 0; i < stableCount; i++) measurements.push(makeMeasurement(120 + (Math.random() - 0.5) * 1, (Math.random() - 0.5) * 1, t0 + (stationaryCount + moveCount + i) * stepMs, 8));

  const snaps = engine.processMeasurements(measurements);

  // summary
  const keyIndices = [stationaryCount - 1, stationaryCount + moveCount - 1, stationaryCount + moveCount + stableCount - 1];
  if (VERBOSE) {
    console.log("Processed snapshots:");
    for (const idx of keyIndices) {
      const s = snaps[idx];
      if (!s) continue;
      const comps = s.data.components as any[] | undefined;
      console.log(`Snapshot index=${idx}, timestamp=${s.timestamp}`);
      if (!comps || comps.length === 0) console.log(" no components");
      else console.log(` components: ${comps.map((c, i) => `${i}: mean=${c.mean.map((v: number) => v.toFixed(2)).join(",")}, w=${(c.weight ?? 0).toFixed(3)}, spawnedDuringMovement=${Boolean(c.spawnedDuringMovement)}`).join("; ")}`);
    }
  }

  // examine final snapshot and count movement-spawn remnants
  const final = snaps[snaps.length - 1];
  const finalComps = final?.data.components as any[] | undefined;
  const spawnedCount = finalComps ? finalComps.filter((c) => c.spawnedDuringMovement).length : 0;

  expect(spawnedCount).toBe(0);
  if (VERBOSE) console.log(`fade spawnedCount=${spawnedCount}`);
});