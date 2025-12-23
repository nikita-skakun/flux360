#!/usr/bin/env bun

(async () => {
  const VERBOSE = process.env.VERBOSE === "1" || process.argv.includes("--verbose");
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
  const stationaryCount = 30;
  const moveCount = 6;
  const settleCount = 6;
  const stepMs = 60_000;

  const measurements: any[] = [];
  for (let i = 0; i < stationaryCount; i++) measurements.push(makeMeasurement((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, t0 + i * stepMs, 10));
  for (let i = 0; i < moveCount; i++) {
    const x = 120 + (Math.random() - 0.5) * 4;
    const y = (Math.random() - 0.5) * 4;
    measurements.push(makeMeasurement(x, y, t0 + (stationaryCount + i) * stepMs, 8, 1.2, true));
  }
  for (let i = 0; i < settleCount; i++) measurements.push(makeMeasurement(120 + (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5, t0 + (stationaryCount + moveCount + i) * stepMs, 6));

  const snaps = engine.processMeasurements(measurements);

  // check that final snapshot is 'still'
  const final = snaps[snaps.length - 1];
  const comps = final?.data.components as any[] | undefined;
  const best = comps && comps.length ? comps.reduce((a, b) => ((a.weight ?? 0) >= (b.weight ?? 0) ? a : b)) : null;
  const action = best?.action ?? null;

  if (action === 'still') {
    console.log(`[PASS] stationary_transition — final action=still`);
    process.exit(0);
  } else {
    console.error(`[FAIL] stationary_transition — final action=${String(action)}`);
    process.exit(1);
  }

})().catch((err) => {
  console.error(err);
  process.exit(2);
});