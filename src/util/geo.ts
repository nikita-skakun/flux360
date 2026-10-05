import type { Bounds, Vec2 } from "@/types";

/** Radius in metres, since variance is metres squared. */
export function getRadiusFromVariance(variance: number): number {
  return Math.sqrt(Math.max(1e-6, variance));
}

export function computeBounds(points: Vec2[]): Bounds {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function paddedLngLatBounds(sw: Vec2, ne: Vec2): [Vec2, Vec2] {
  const padding = Math.max(0.001, (ne[0] - sw[0]) * 0.1, (ne[1] - sw[1]) * 0.1);
  return [
    [sw[0] - padding, sw[1] - padding],
    [ne[0] + padding, ne[1] + padding]
  ];
}