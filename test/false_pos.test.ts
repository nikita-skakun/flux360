#!/usr/bin/env bun

(async () => {
  const VERBOSE = process.env.VERBOSE === "1" || process.argv.includes("--verbose");
  const { Engine } = await import("../src/engine/engine");

  const makeMeasurement = (x: number, y: number, t: number, accuracy = 8, speed?: number, motion?: boolean) => {
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
  const count = 120;
  const stepMs = 60_000;

  const measurements: any[] = [];
  for (let i = 0; i < count; i++) {
    const jitterX = (Math.random() - 0.5) * 4;
    const jitterY = (Math.random() - 0.5) * 4;
    measurements.push(makeMeasurement(jitterX, jitterY, t0 + i * stepMs, 8));
  }

  measurements.push(makeMeasurement(18, -3, t0 + count * stepMs, 8));

  for (let i = count + 1; i < count + 20; i++) {
    const jitterX = (Math.random() - 0.5) * 4;
    const jitterY = (Math.random() - 0.5) * 4;
    measurements.push(makeMeasurement(jitterX, jitterY, t0 + i * stepMs, 8));
  }

  const snaps = engine.processMeasurements(measurements);

  if (VERBOSE) console.log("index,timestamp,bestMeanX,bestMeanY,bestWeight,distToOutlier");
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    if (!s) continue;
    const comps = s.data?.components as any[] | undefined;
    if (!comps || comps.length === 0) {
      if (VERBOSE) console.log(`${i},${s.timestamp ?? ""},,,0,`);
      continue;
    }
    const best = comps.reduce((a, b) => ((a.weight ?? 0) >= (b.weight ?? 0) ? a : b));
    const bestMean = best.mean ?? [0, 0];
    const distToOutlier = Math.hypot(bestMean[0] - 18, bestMean[1] - -3);
    if (VERBOSE) console.log(`${i},${s.timestamp ?? ""},${bestMean[0].toFixed(2)},${bestMean[1].toFixed(2)},${((best.weight ?? 0).toFixed(3))},${distToOutlier.toFixed(2)}`);
  }

  const firstMoved = snaps.findIndex((s) => {
    const comps = s?.data.components as any[] | undefined;
    if (!comps) return false;
    const best = comps.reduce((a, b) => ((a.weight ?? 0) >= (b.weight ?? 0) ? a : b));
    const bestMean = best.mean ?? [0, 0];
    const dist = Math.hypot(bestMean[0] - 18, bestMean[1] - -3);
    return dist < 8;
  });

  if (firstMoved >= 0) {
    console.error(`[FAIL] false_pos — Engine moved to single outlier at index=${firstMoved}`);
    process.exit(1);
  } else {
    console.log(`[PASS] false_pos — Engine did NOT move to the single outlier`);
    process.exit(0);
  }

})().catch((err) => {
  console.error(err);
  process.exit(2);
});