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

export function haversineDistance(a: Vec2, b: Vec2): number {
  const R = 6371e3; // Earth radius in meters
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

  return R * c;
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
