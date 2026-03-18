import { pointLineDistance } from "@/util/geo";
import type { NormalizedPosition, Vec2 } from "@/types";

export function smoothPath(points: NormalizedPosition[], iterations = 3): Vec2[] {
  if (points.length <= 2) return points.map(p => p.geo);

  let result: Vec2[] = points.map(p => [...p.geo] as Vec2);
  const radii = points.map(p => p.accuracy);
  const centers = points.map(p => p.geo);

  for (let iter = 0; iter < iterations; iter++) {
    result = result.map((curr, i, arr) => {
      if (i === 0 || i === arr.length - 1) return curr;

      const prev = arr[i - 1];
      const next = arr[i + 1];
      const center = centers[i];
      const r = radii[i];
      const pt = points[i];
      const prevPt = points[i - 1];
      const nextPt = points[i + 1];

      if (!prev || !next || !center || r === undefined || !pt || !prevPt || !nextPt) return curr;

      const dtPrev = pt.timestamp - prevPt.timestamp;
      const dtTotal = nextPt.timestamp - prevPt.timestamp;

      const ratio = dtTotal <= 0 ? 0.5 : Math.max(0, Math.min(1, dtPrev / dtTotal));
      const ideal: Vec2 = [
        prev[0] + (next[0] - prev[0]) * ratio,
        prev[1] + (next[1] - prev[1]) * ratio
      ];

      const straightLineConfidence = Math.max(0, Math.min(1, 60000 / Math.max(1, dtTotal)));
      const effectiveRadius = r * straightLineConfidence;

      const dPrevCenter = Math.hypot(center[0] - prev[0], center[1] - prev[1]);
      const dCenterNext = Math.hypot(next[0] - center[0], next[1] - center[1]);
      const dPrevNext = Math.hypot(next[0] - prev[0], next[1] - prev[1]);

      const detourRatio = (dPrevCenter + dCenterNext) / Math.max(0.1, dPrevNext);
      const detourMultiplier = Math.pow(Math.max(1, detourRatio), 2);
      const allowedPull = effectiveRadius * detourMultiplier;

      const dx = ideal[0] - center[0];
      const dy = ideal[1] - center[1];
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= allowedPull) return ideal;
      return [
        center[0] + (dx / dist) * allowedPull,
        center[1] + (dy / dist) * allowedPull
      ] as Vec2;
    });
  }

  return result;
}

export function simplifyPath(points: Vec2[], epsilon: number): Vec2[] {
  if (points.length < 3) return points;

  const simplified = [...points];

  let changed = true;
  while (changed && simplified.length >= 3) {
    changed = false;
    const keep = new Array(simplified.length).fill(true);
    // Don't consider the first or last point (anchors)
    for (let i = 1; i < simplified.length - 1; i++) {
      const prev = simplified[i - 1];
      const curr = simplified[i];
      const next = simplified[i + 1];
      if (!prev || !curr || !next) continue;

      const d = pointLineDistance(curr, prev, next);
      if (d <= epsilon) {
        keep[i] = false;
        changed = true;
      }
    }

    if (changed) {
      const nextPoints = simplified.filter((_, idx) => keep[idx]);
      // Safety: ensure we always keep at least the endpoints
      if (nextPoints.length < 2) break;
      simplified.length = 0;
      simplified.push(...nextPoints);
    }
  }

  return simplified;
}
