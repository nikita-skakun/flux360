import { WORLD_R } from "@/util/webMercator";
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

export function getRadiusFromVariance(variance: number): number {
  return Math.sqrt(Math.max(1e-6, variance));
}

export function haversineDistance(a: Vec2, b: Vec2): number {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;

  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const dPhi = (lat2 - lat1) * Math.PI / 180;
  const dLambda = (lon2 - lon1) * Math.PI / 180;

  const a_val = Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) *
    Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a_val), Math.sqrt(1 - a_val));

  return WORLD_R * c;
}

export function computeBearing(from: Vec2, to: Vec2): number {
  const [lon1, lat1] = from;
  const [lon2, lat2] = to;

  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const dLambda = (lon2 - lon1) * Math.PI / 180;

  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const theta = Math.atan2(y, x);

  return (theta * 180 / Math.PI + 360) % 360;
}

export function computeBounds(points: Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
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

export function pointLineDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);

  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  const tClamped = Math.max(0, Math.min(1, t));
  const projX = a[0] + tClamped * dx;
  const projY = a[1] + tClamped * dy;

  return Math.hypot(p[0] - projX, p[1] - projY);
}
