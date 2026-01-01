import type { Cov2, Vec2 } from "@/ui/types";

export function addCov(a: Cov2, b: Cov2): Cov2 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function detCov(a: Cov2): number {
  return a[0] * a[2] - a[1] * a[1];
}

export function invertCov(a: Cov2): Cov2 {
  const d = detCov(a);
  if (!isFinite(d) || Math.abs(d) < 1e-12) {
    return [1e12, 0, 1e12];
  }
  const inv = 1 / d;
  return [a[2] * inv, -a[1] * inv, a[0] * inv];
}

export function mulCovVec(a: Cov2, v: Vec2): Vec2 {
  const [a00, a01, a11] = a;
  return [a00 * v[0] + a01 * v[1], a01 * v[0] + a11 * v[1]];
}

export function mulMatMat(a: Cov2, b: Cov2): Cov2 {
  const a00 = a[0];
  const a01 = a[1];
  const a11 = a[2];
  const b00 = b[0];
  const b01 = b[1];
  const b11 = b[2];
  const r00 = a00 * b00 + a01 * b01;
  const r01 = a00 * b01 + a01 * b11;
  const r11 = a01 * b01 + a11 * b11;
  return [r00, r01, r11];
}

export function symmetric(c: Cov2): Cov2 {
  return [c[0], (c[1] + c[1]) / 2, c[2]];
}