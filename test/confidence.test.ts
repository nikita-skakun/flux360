import { test, expect } from "bun:test";
import { Anchor } from "../src/engine/anchor";
import type { DevicePoint } from "../src/ui/types";

const makePoint = (mean: [number, number], cov: [number, number, number], timestamp: number, accuracy: number = 10): DevicePoint => ({
  device: 0,
  mean,
  cov,
  timestamp,
  accuracy,
  lat: 0,
  lon: 0,
  anchorAgeMs: 0,
  confidence: 0,
});

test("confidence increases with consistent measurements and saturates", () => {
  const decayRate = 0.001;
  const gainRate = 2.0;
  const anchor = new Anchor([0, 0], [1, 0, 1], 0);
  const initialConf = anchor.getConfidence(0, decayRate);
  expect(initialConf).toBeCloseTo(0.5, 2);

  let prevConf = initialConf;
  // Add many consistent measurements
  for (let i = 1; i <= 10; i++) {
    const m = makePoint([0, 0], [1, 0, 1], i * 1000, 1);
    anchor.kalmanUpdate(m, gainRate);
    const conf = anchor.getConfidence(i * 1000, decayRate);
    expect(conf).toBeGreaterThanOrEqual(prevConf);
    expect(conf).toBeLessThanOrEqual(1);
    prevConf = conf;
  }

  // Should approach 1
  const finalConf = anchor.getConfidence(10 * 1000, decayRate);
  expect(finalConf).toBeGreaterThan(0.9);
});

test("confidence decays under silence", () => {
  const decayRate = 0.01; // faster decay for test
  const gainRate = 2.0;
  const anchor = new Anchor([0, 0], [1, 0, 1], 0);
  // Update once
  const m = makePoint([0, 0], [1, 0, 1], 1000, 1);
  anchor.kalmanUpdate(m, gainRate);
  const confAfterUpdate = anchor.getConfidence(1000, decayRate);
  expect(confAfterUpdate).toBeGreaterThan(0.5);

  // Wait without updates
  const confAfterDecay = anchor.getConfidence(1000 + 10000, decayRate); // 10 seconds
  expect(confAfterDecay).toBeLessThan(confAfterUpdate);
});

test("low-accuracy measurements increase confidence slowly", () => {
  const decayRate = 0.001;
  const gainRate = 2.0;
  const anchor = new Anchor([0, 0], [1, 0, 1], 0);

  // High accuracy measurement
  const highAccM = makePoint([0, 0], [1, 0, 1], 1000, 1); // accuracy=1
  anchor.kalmanUpdate(highAccM, gainRate);
  const confHigh = anchor.getConfidence(1000, decayRate);

  // Reset anchor
  const anchor2 = new Anchor([0, 0], [1, 0, 1], 0);

  // Low accuracy measurement
  const lowAccM = makePoint([0, 0], [100, 0, 100], 1000, 100); // accuracy=100
  anchor2.kalmanUpdate(lowAccM, gainRate);
  const confLow = anchor2.getConfidence(1000, decayRate);

  expect(confHigh).toBeGreaterThan(confLow);
});

test("single outliers do not spike confidence", () => {
  const decayRate = 0.001;
  const gainRate = 0.5;
  const anchor = new Anchor([0, 0], [1, 0, 1], 0);
  const initialConf = anchor.getConfidence(0, decayRate);

  // Outlier measurement far away
  const outlierM = makePoint([100, 100], [1, 0, 1], 1000, 1);
  // Even though outlier, kalmanUpdate is called, confidence should increase modestly
  anchor.kalmanUpdate(outlierM, gainRate);
  const confAfter = anchor.getConfidence(1000, decayRate);
  expect(confAfter).toBeGreaterThan(initialConf);
  expect(confAfter).toBeLessThan(0.9); // not spike high
});