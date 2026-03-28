import { EPSILON, distancePointToSegment, sub, dot, length, nearestPointOnPolyline } from "@/util/vec2";
import type { NormalizedPosition, Vec2 } from "@/types";

const BASE_SLACK_METERS = 0.2;
const MIN_ANCHOR_ALLOWED_DEVIATION = 1;
const STATIONARY_MERGE_DIST_METERS = 60;
const DENSE_DELTA_MS = 15_000;
const SUPPORT_CAP_MS = 180_000;
const TIME_WEIGHT_SCALE_MS = 60_000;

const baseAccuracyWeight = (radius: number): number => 50 / (50 + Math.max(0, radius));

// Calculate the angle (in degrees) between three points
const calculateTurnAngleDeg = (prev: Vec2, curr: Vec2, next: Vec2): number => {
  const v1 = sub(curr, prev);
  const v2 = sub(next, curr);
  const len1 = length(v1);
  const len2 = length(v2);

  if (len1 < EPSILON || len2 < EPSILON) return 0;

  const cosAngle = dot(v1, v2) / (len1 * len2);
  const clampedCos = Math.max(-1, Math.min(1, cosAngle));
  const angleDeg = Math.acos(clampedCos) * (180 / Math.PI);
  return Math.min(180, angleDeg);
};

type MotionAnchor = {
  center: Vec2;
  radius: number;
  centerWeight: number;
  sourceStart: number;
  sourceEnd: number;
};

export function computeBestFitMotionPath(path: NormalizedPosition[]): Vec2[] {
  if (path.length < 2) return path.map(p => p.geo);

  const n = path.length;
  const endpoints: Vec2[] = [[path[0]!.geo[0], path[0]!.geo[1]], [path[n - 1]!.geo[0], path[n - 1]!.geo[1]]];
  const anchors: MotionAnchor[] = [];

  const flushRun = (start: number, end: number): void => {
    let sumW = 0;
    let sumX = 0;
    let sumY = 0;
    let sumR = 0;
    let sumSupport = 0;

    for (let i = start; i <= end; i++) {
      const p = path[i]!;
      const radius = Math.max(0, p.accuracy);
      const localW = baseAccuracyWeight(radius);

      const prev = i > 0 ? path[i - 1] : null;
      const next = i < n - 1 ? path[i + 1] : null;
      const rawPrev = prev ? (p.timestamp - prev.timestamp) : (next ? (next.timestamp - p.timestamp) : 0);
      const rawNext = next ? (next.timestamp - p.timestamp) : rawPrev;
      const dtPrev = Math.max(0, Math.min(SUPPORT_CAP_MS, Number.isFinite(rawPrev) ? rawPrev : 0));
      const dtNext = Math.max(0, Math.min(SUPPORT_CAP_MS, Number.isFinite(rawNext) ? rawNext : 0));

      sumW += localW;
      sumX += p.geo[0] * localW;
      sumY += p.geo[1] * localW;
      sumR += radius * localW;
      sumSupport += (dtPrev + dtNext) * 0.5;
    }

    const denom = Math.max(sumW, EPSILON);
    const center: Vec2 = [sumX / denom, sumY / denom];
    const meanRadius = sumR / denom;
    const runLen = (end - start) + 1;
    const aggregatedRadius = runLen > 1 ? (meanRadius / Math.sqrt(runLen)) : meanRadius;

    const timeSupportWeight = Math.max(0, Math.min(1, sumSupport / (sumSupport + TIME_WEIGHT_SCALE_MS)));
    const centerWeight = 1 - ((1 - baseAccuracyWeight(aggregatedRadius)) * (1 - timeSupportWeight));

    anchors.push({
      center,
      radius: Math.max(0, aggregatedRadius),
      centerWeight,
      sourceStart: start,
      sourceEnd: end,
    });
  };

  flushRun(0, 0);

  if (n > 2) {
    let runStart = 1;
    for (let i = 2; i <= n - 2; i++) {
      const prev = path[i - 1]!;
      const curr = path[i]!;
      const timeGap = curr.timestamp - prev.timestamp;
      const dSq = Math.pow(curr.geo[0] - prev.geo[0], 2) + Math.pow(curr.geo[1] - prev.geo[1], 2);

      if (timeGap > DENSE_DELTA_MS && dSq > STATIONARY_MERGE_DIST_METERS * STATIONARY_MERGE_DIST_METERS) {
        flushRun(runStart, i - 1);
        runStart = i;
      }
    }
    flushRun(runStart, n - 2);
  }

  flushRun(n - 1, n - 1);

  if (anchors.length < 2) return endpoints;

  const greedy: Vec2[] = [[anchors[0]!.center[0], anchors[0]!.center[1]]];
  let current = 0;

  while (current < anchors.length - 1) {
    const currentAnchor = anchors[current]!;
    let chosen = current + 1;

    // Deterministic tie-break: choose the furthest feasible anchor.
    for (let candidate = anchors.length - 1; candidate > current; candidate--) {
      const targetAnchor = anchors[candidate]!;
      const fromIdx = currentAnchor.sourceStart;
      const toIdx = targetAnchor.sourceEnd;
      let connectable = true;

      for (let i = fromIdx; i <= toIdx; i++) {
        const p = path[i]!;
        const r = Math.max(0, p.accuracy);
        const d = distancePointToSegment(p.geo, currentAnchor.center, targetAnchor.center);
        const slack = BASE_SLACK_METERS + ((1 - baseAccuracyWeight(r)) * Math.min(8, r * 0.12));
        if (d > r + slack + EPSILON) {
          connectable = false;
          break;
        }
      }
      if (!connectable) continue;

      // Prevent over-compression by requiring skipped anchor centers to stay close enough
      // to the proposed segment, scaled by each anchor's confidence.
      for (let i = current + 1; i < candidate; i++) {
        const anchor = anchors[i]!;
        const allowed = Math.max(MIN_ANCHOR_ALLOWED_DEVIATION, anchor.radius * (0.2 + (0.8 * (1 - anchor.centerWeight))));
        if (distancePointToSegment(anchor.center, currentAnchor.center, targetAnchor.center) > allowed + EPSILON) {
          connectable = false;
          break;
        }
      }
      if (!connectable) continue;

      chosen = candidate;
      break;
    }

    const chosenCenter = anchors[chosen]!.center;
    greedy.push([chosenCenter[0], chosenCenter[1]]);
    current = chosen;
  }

  // Inline coverage enforcement using monotonic segment cursor.
  if (greedy.length >= 2) {
    let segCursor = 0;

    for (let i = 0; i < n; i++) {
      if (greedy.length < 2) break;

      const point = path[i]!;
      const radius = Math.max(0, point.accuracy);
      segCursor = Math.min(segCursor, greedy.length - 2);

      while (segCursor < greedy.length - 2) {
        const currDist = distancePointToSegment(point.geo, greedy[segCursor]!, greedy[segCursor + 1]!);
        const nextDist = distancePointToSegment(point.geo, greedy[segCursor + 1]!, greedy[segCursor + 2]!);
        if (nextDist <= currDist) segCursor++;
        else break;
      }

      const dist = distancePointToSegment(point.geo, greedy[segCursor]!, greedy[segCursor + 1]!);
      if (dist > radius + EPSILON) {
        const prev = greedy[segCursor]!;
        const next = greedy[segCursor + 1]!;

        // Check if inserting this point would create an unreasonably sharp turn
        // (less than threshold) - if so, skip it unless the coverage deficit is huge
        const turnAngleDeg = calculateTurnAngleDeg(prev, point.geo, next);
        const coverageDeficit = Math.max(0, dist - radius);

        // Only skip insertion if:
        // 1. Turn angle is very sharp (acute), AND
        // 2. Coverage deficit is small relative to accuracy
        // Note: turnAngleDeg 0 is straight, 180 is backtrack.
        const isAcuteTurn = turnAngleDeg > 60;
        const isSmallDeficit = coverageDeficit < radius * 0.5;

        if (!(isAcuteTurn && isSmallDeficit)) {
          greedy.splice(segCursor + 1, 0, [point.geo[0], point.geo[1]]);
          segCursor++;
        }
      }
    }
  }

  if (greedy.length < 2) return endpoints;

  // Simplification 1: Remove collinear points and merge very small consecutive turns
  const simplified: Vec2[] = [greedy[0]!];

  for (let i = 1; i < greedy.length; i++) {
    const prev = simplified[simplified.length - 1]!;
    const curr = greedy[i]!;

    // Always keep distinct points
    const dx = curr[0] - prev[0];
    const dy = curr[1] - prev[1];
    if ((dx * dx) + (dy * dy) < EPSILON * EPSILON) continue;

    // Check if collinear with next point
    if (i + 1 < greedy.length) {
      const next = greedy[i + 1]!;
      const turnAngleDeg = calculateTurnAngleDeg(prev, curr, next);

      // Skip this point if it's collinear (0°) or creates a tiny insignificant turn
      if (turnAngleDeg < 4) continue;
    }

    simplified.push(curr);
  }

  // Simplification 2: Greedily remove redundant vertices to minimize the path while preserving coverage.
  // This eliminates anchors that became redundant once specific points were inserted for coverage.
  const calculateMaxExcess = (testPath: Vec2[]): number => {
    let maxExcess = 0;
    for (const p of path) {
      const nearest = nearestPointOnPolyline(p.geo, testPath);
      const d = length(sub(nearest, p.geo));
      const r = Math.max(0, p.accuracy);
      const slack = BASE_SLACK_METERS + ((1 - baseAccuracyWeight(r)) * Math.min(8, r * 0.12));
      const excess = d - (r + slack);
      if (excess > maxExcess) maxExcess = excess;
    }
    return maxExcess;
  };

  let final = [...simplified];
  let currentMaxExcess = calculateMaxExcess(final);

  for (let i = 1; i < final.length - 1;) {
    const candidate = final.filter((_, idx) => idx !== i);
    const candidateMaxExcess = calculateMaxExcess(candidate);

    // Allow removal if it doesn't worsen the fit beyond a tiny tolerance, 
    // ensuring that pre-existing outlier points don't block simplification of the rest of the path.
    if (candidateMaxExcess <= Math.max(0, currentMaxExcess) + EPSILON) {
      final = candidate;
      currentMaxExcess = candidateMaxExcess;
    } else {
      i++;
    }
  }

  return final.length >= 2 ? final : endpoints;
}
