import { describe, it, expect } from "bun:test";
import { covAdd, covDet, covInv, mahalanobisSquared, predictCov, updateWithMeasurement, measurementCovFromAccuracy } from "../src/engine/gaussian";

describe("gaussian ops", () => {
  it("det / inv works and mahalanobis", () => {
    const c = [4, 0, 9] as const; // diag
    const det = covDet(c as any);
    expect(det).toBe(36);
    const inv = covInv(c as any);
    expect(inv[0]).toBeCloseTo(1 / 4);
    expect(inv[2]).toBeCloseTo(1 / 9);
    const diff: [number, number] = [1, 1];
    const msq = mahalanobisSquared(diff, c as any);
    expect(msq).toBeCloseTo(1 / 4 + 1 / 9);
  });

  it("predict adds process noise", () => {
    const c = [1, 0, 1] as const;
    const p = predictCov(c as any, 2);
    expect(p[0]).toBeCloseTo(1 + 4);
  });

  it("updates mean and reduces covariance", () => {
    const mean: [number, number] = [0, 0];
    const cov: any = [100, 0, 100];
    const mmean: [number, number] = [10, 0];
    const mcov: any = [10, 0, 10];
    const res = updateWithMeasurement(mean, cov, mmean, mcov);
    expect(res.mean[0]).toBeGreaterThan(0);
    expect(res.cov[0]).toBeLessThan(100);
  });

  it("measurementCovFromAccuracy produces diagonal cov", () => {
    const c = measurementCovFromAccuracy(2);
    expect(c[0]).toBeCloseTo(4);
    expect(c[1]).toBe(0);
  });
});
