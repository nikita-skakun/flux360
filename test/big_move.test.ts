#!/usr/bin/env bun

(async () => {
  const VERBOSE = process.env.VERBOSE === "1" || process.argv.includes("--verbose");
  const { Engine } = await import("../src/engine/engine");

  const makeMeasurement = (x: number, y: number, t: number, accuracy = 5, speed?: number, motion?: boolean) => {
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
  const stationaryCount = 50;
  const stepMs = 60_000;

  const measurements: any[] = [];
  for (let i = 0; i < stationaryCount; i++) measurements.push(makeMeasurement((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, t0 + i * stepMs, 6));

  // single strong report far away
  measurements.push(makeMeasurement(200, 0, t0 + stationaryCount * stepMs, 5));
  measurements.push(makeMeasurement(201, -1, t0 + (stationaryCount + 1) * stepMs, 5));

  const snaps = engine.processMeasurements(measurements);

  if (VERBOSE) {
    console.log("index,timestamp,bestMeanX,bestMeanY,bestWeight,distToNew");
    for (let i = 0; i < snaps.length; i++) {
      const s = snaps[i];
      if (!s) continue;
      const comps = s.data?.components as any[] | undefined;
      if (!comps || comps.length === 0) {
        console.log(`${i},${s.timestamp ?? ""},,,0,`);
        continue;
      }
      const best = comps.reduce((a, b) => ((a.weight ?? 0) >= (b.weight ?? 0) ? a : b));
      const bestMean = best.mean ?? [0, 0];
      const distToNew = Math.hypot(bestMean[0] - 200, bestMean[1] - 0);
      console.log(`${i},${s.timestamp ?? ""},${bestMean[0].toFixed(2)},${bestMean[1].toFixed(2)},${((best.weight ?? 0).toFixed(3))},${distToNew.toFixed(2)}`);
    }
  }

  const firstClose = snaps.findIndex((s) => {
    const comps = s?.data.components as any[] | undefined;
    if (!comps || comps.length === 0) return false;
    const best = comps.reduce((a, b) => ((a.weight ?? 0) >= (b.weight ?? 0) ? a : b));
    const bestMean = best.mean ?? [0, 0];
    const distToNew = Math.hypot(bestMean[0] - 200, bestMean[1] - 0);
    return distToNew < 20;
  });

  if (firstClose >= 0) {
    console.log(`[PASS] big_move — first snapshot near new location: index=${firstClose}`);
    process.exit(0);
  } else {
    console.error(`[FAIL] big_move — no snapshot with best component near new location (<20m)`);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(2);
});