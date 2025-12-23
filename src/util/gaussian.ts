export type Cov2 = [number, number, number];

export function measurementCovFromAccuracy(accuracyMeters: number): Cov2 {
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
  measurementCovFromAccuracy,
  eigenDecomposition,
};