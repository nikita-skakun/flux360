import type { Vec2 } from "@/types";

export const EPSILON = 1e-6;

function add(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]];
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}

function mul(a: Vec2, scalar: number): Vec2 {
  return [a[0] * scalar, a[1] * scalar];
}

export function dot(a: Vec2, b: Vec2): number {
  return (a[0] * b[0]) + (a[1] * b[1]);
}

export function length(v: Vec2): number {
  return Math.hypot(v[0], v[1]);
}

export function distance(a: Vec2, b: Vec2): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function distancePointToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < EPSILON) {
    const dx = px - ax;
    const dy = py - ay;
    return dx * dx + dy * dy;
  }
  const t = Math.min(1, Math.max(0, ((px - ax) * abx + (py - ay) * aby) / lenSq));
  const projx = ax + t * abx;
  const projy = ay + t * aby;
  const dx = px - projx;
  const dy = py - projy;
  return dx * dx + dy * dy;
}

export function distancePointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  return Math.sqrt(distancePointToSegmentSq(p[0], p[1], a[0], a[1], b[0], b[1]));
}

export function distancePointToPolyline(px: number, py: number, polyline: Vec2[], skipIdx = -1): number {
  if (polyline.length === 0) return 0;
  if (polyline.length === 1) {
    const pt = polyline[0]!;
    const dx = px - pt[0];
    const dy = py - pt[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  let minSq = Infinity;
  const n = polyline.length;
  for (let k = 0; k < n - 1; k++) {
    if (k === skipIdx) continue;
    if (k + 1 === skipIdx) {
      const a = polyline[k]!;
      const b = polyline[k + 2]!;
      const dSq = distancePointToSegmentSq(px, py, a[0], a[1], b[0], b[1]);
      if (dSq < minSq) minSq = dSq;
    } else {
      const a = polyline[k]!;
      const b = polyline[k + 1]!;
      const dSq = distancePointToSegmentSq(px, py, a[0], a[1], b[0], b[1]);
      if (dSq < minSq) minSq = dSq;
    }
  }
  return Math.sqrt(minSq);
}

export function nearestPointOnPolyline(p: Vec2, polyline: Vec2[]): Vec2 {
  if (polyline.length === 0) return p;
  if (polyline.length === 1) return polyline[0]!;

  let best: Vec2 = polyline[0]!;
  let bestDist = Infinity;

  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i]!;
    const ab = sub(polyline[i + 1]!, a);
    const lenSq = dot(ab, ab);
    const candidate = lenSq < EPSILON ? a : add(a, mul(ab, Math.min(1, Math.max(0, dot(sub(p, a), ab) / lenSq))));

    const d = length(sub(p, candidate));
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }

  return best;
}
