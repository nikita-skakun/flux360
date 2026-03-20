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

export function distancePointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const abLenSq = dot(ab, ab);
  if (abLenSq < EPSILON) return length(sub(p, a));

  return length(sub(p, add(a, mul(ab, Math.min(1, Math.max(0, dot(sub(p, a), ab) / abLenSq))))));
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
