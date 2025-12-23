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
  const stationaryCount = 200;
  const moveCount = 30;
  const settleCount = 8;
  const stepMs = 60_000;

  const measurements: any[] = [];
  for (let i = 0; i < stationaryCount; i++) {
    measurements.push(makeMeasurement((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, t0 + i * stepMs, 10));
  }

  // movement phase
  for (let i = 0; i < moveCount; i++) {
    const x = 120 + (Math.random() - 0.5) * 4;
    const y = (Math.random() - 0.5) * 4;
    measurements.push(makeMeasurement(x, y, t0 + (stationaryCount + i) * stepMs, 10, 1.1, true));
  }

  // stable at new location
  for (let i = 0; i < settleCount; i++) measurements.push(makeMeasurement(120 + (Math.random() - 0.5) * 1, (Math.random() - 0.5) * 1, t0 + (stationaryCount + moveCount + i) * stepMs, 8));

  const snaps = engine.processMeasurements(measurements);

  // final snapshot check: ensure old far components faded/removed
  const final = snaps[snaps.length - 1];
  const finalComps = final?.data.components as any[] | undefined;
  const farCount = (finalComps ?? []).filter((c) => {
    const dx = (c.mean?.[0] ?? 0) - 120;
    const dy = (c.mean?.[1] ?? 0) - 0;
    return Math.hypot(dx, dy) > 40;
  }).length;

  if (farCount === 0) {
    console.log(`[PASS] retire — old distant components faded/removed (farCount=${farCount})`);
    process.exit(0);
  } else {
    console.error(`[FAIL] retire — old distant components remain (farCount=${farCount})`);
    process.exit(1);
  }

})().catch((err) => {
  console.error(err);
  process.exit(2);
});