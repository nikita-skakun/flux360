import type { Vec2 } from "@/types";

export function distance(a: Vec2, b: Vec2): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

export function distanceSquared(a: Vec2, b: Vec2): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

export function computeCentroid(points: Vec2[]): Vec2 {
  if (points.length === 0) return [0, 0];
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p[0];
    cy += p[1];
  }
  return [cx / points.length, cy / points.length];
}

export function directionFromPoints(from: Vec2, to: Vec2): Vec2 {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length === 0) return [0, 0];
  return [dx / length, dy / length];
}

export function getRadiusFromVariance(variance: number): number {
  return Math.sqrt(Math.max(1e-6, variance));
}
