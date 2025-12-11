export type Vec2 = [number, number];
export type Cov2 = [number, number, number]; // [a, b, c] representing [[a, b],[b, c]]

export function covAdd(c1: Cov2, c2: Cov2): Cov2 {
  return [c1[0] + c2[0], c1[1] + c2[1], c1[2] + c2[2]];
}

export function covDet(c: Cov2): number {
  return c[0] * c[2] - c[1] * c[1];
}

export function covInv(c: Cov2): Cov2 {
  const det = covDet(c);
  if (det === 0) throw new Error("Singular covariance");
  const inv = [c[2] / det, -c[1] / det, c[0] / det];
  return inv as Cov2;
}

export function mahalanobisSquared(diff: Vec2, cov: Cov2): number {
  // diff' * inv(cov) * diff
  const inv = covInv(cov);
  const [dx, dy] = diff;
  return dx * (inv[0] * dx + inv[1] * dy) + dy * (inv[1] * dx + inv[2] * dy);
}

export function predictCov(cov: Cov2, processNoiseMeters = 1): Cov2 {
  // Add isotropic process noise (variance = processNoiseMeters^2)
  const q = processNoiseMeters * processNoiseMeters;
  return [cov[0] + q, cov[1], cov[2] + q];
}

export function updateWithMeasurement(mean: Vec2, cov: Cov2, measMean: Vec2, measCov: Cov2): { mean: Vec2; cov: Cov2 } {
  // Kalman-like update: K = cov * (cov + measCov)^-1
  const s = covAdd(cov, measCov); // innovation covariance
  const invS = covInv(s);
  // K = cov * invS  (2x2 matrices multiply)
  const K00 = cov[0] * invS[0] + cov[1] * invS[1];
  const K01 = cov[0] * invS[1] + cov[1] * invS[2];
  const K10 = cov[1] * invS[0] + cov[2] * invS[1];
  const K11 = cov[1] * invS[1] + cov[2] * invS[2];

  const dx = measMean[0] - mean[0];
  const dy = measMean[1] - mean[1];
  const newMean: Vec2 = [mean[0] + K00 * dx + K01 * dy, mean[1] + K10 * dx + K11 * dy];

  // newCov = (I - K) * cov
  const I_K00 = 1 - K00;
  const I_K01 = -K01;
  const I_K10 = -K10;
  const I_K11 = 1 - K11;
  const n00 = I_K00 * cov[0] + I_K01 * cov[1];
  const n01 = I_K00 * cov[1] + I_K01 * cov[2];
  const n11 = I_K10 * cov[1] + I_K11 * cov[2];

  return { mean: newMean, cov: [n00, n01, n11] };
}

export function measurementCovFromAccuracy(accuracyMeters: number): Cov2 {
  // Convert an accuracy (1-sigma, meters) to diagonal covariance
  const v = accuracyMeters * accuracyMeters;
  return [v, 0, v];
}

export function eigenDecomposition(cov: Cov2): { lambda1: number; lambda2: number; angle: number } {
  // cov = [[a, b], [b, c]]
  const [a, b, c] = cov;
  const t = (a + c) / 2;
  const d = Math.sqrt(((a - c) / 2) * ((a - c) / 2) + b * b);
  const lambda1 = t + d;
  const lambda2 = t - d;
  // angle of principal axis
  const angle = 0.5 * Math.atan2(2 * b, a - c);
  return { lambda1, lambda2, angle };
}

export default {
  covAdd,
  covDet,
  covInv,
  mahalanobisSquared,
  predictCov,
  updateWithMeasurement,
  measurementCovFromAccuracy,
};
