import { EPSILON, distancePointToSegment } from "@/util/vec2";
import type { NormalizedPosition, Vec2 } from "@/types";

const COVERAGE_LINEAR_PASSES = 2;
const BASE_SLACK_METERS = 0.2;
const MIN_ANCHOR_ALLOWED_DEVIATION = 1;
const DENSE_DELTA_MS = 15_000;
const SUPPORT_CAP_MS = 180_000;
const TIME_WEIGHT_SCALE_MS = 60_000;

const baseAccuracyWeight = (radius: number): number => 50 / (50 + Math.max(0, radius));

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
      const rawNext = next ? (p.timestamp - next.timestamp) : rawPrev;
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
      if ((curr.timestamp - prev.timestamp) > DENSE_DELTA_MS) {
        flushRun(runStart, i - 1);
        runStart = i;
      }
    }
    flushRun(runStart, n - 2);
  }

  if (n > 1) flushRun(n - 1, n - 1);

  if (anchors.length < 2) return [[path[0]!.geo[0], path[0]!.geo[1]], [path[n - 1]!.geo[0], path[n - 1]!.geo[1]]];

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
    for (let pass = 0; pass < COVERAGE_LINEAR_PASSES; pass++) {
      let insertedAny = false;
      let segCursor = 0;

      for (let i = 0; i < n; i++) {
        if (greedy.length < 2) break;

        const center = path[i]!.geo;
        const radius = Math.max(0, path[i]!.accuracy);
        segCursor = Math.min(segCursor, greedy.length - 2);

        while (segCursor < greedy.length - 2) {
          const currDist = distancePointToSegment(center, greedy[segCursor]!, greedy[segCursor + 1]!);
          const nextDist = distancePointToSegment(center, greedy[segCursor + 1]!, greedy[segCursor + 2]!);
          if (nextDist <= currDist) segCursor++;
          else break;
        }

        const dist = distancePointToSegment(center, greedy[segCursor]!, greedy[segCursor + 1]!);
        if (dist > radius + EPSILON) {
          greedy.splice(segCursor + 1, 0, [center[0], center[1]]);
          segCursor++;
          insertedAny = true;
        }
      }

      if (!insertedAny) break;
    }
  }

  if (greedy.length < 2) return [[path[0]!.geo[0], path[0]!.geo[1]], [path[n - 1]!.geo[0], path[n - 1]!.geo[1]]];

  // Final deterministic de-duplication of adjacent near-identical vertices.
  const compact: Vec2[] = [greedy[0]!];
  for (let i = 1; i < greedy.length; i++) {
    const prev = compact[compact.length - 1]!;
    const curr = greedy[i]!;
    const dx = curr[0] - prev[0];
    const dy = curr[1] - prev[1];
    if ((dx * dx) + (dy * dy) > (EPSILON * EPSILON)) compact.push(curr);
  }

  return compact.length >= 2 ? compact : [[path[0]!.geo[0], path[0]!.geo[1]], [path[n - 1]!.geo[0], path[n - 1]!.geo[1]]];
}
