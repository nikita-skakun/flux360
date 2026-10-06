import { metricDistance, toWebMercator } from "@/util/webMercator";
import type { EngineEvent, RawGpsPosition } from "@/types";

/**
 * A property every correct derivation must hold, checkable from raw fixes and derived
 * events alone. No labels, no trust in any heuristic: if one of these fails, something
 * is provably wrong, which is a stronger statement than disagreeing with a label.
 */
export type InvariantViolation = {
  entityId: number;
  rule: string;
  detail: string;
  at: number;
};

const ALLOWED_EDGE_SLACK = 1.02;

function coveringFixes(positions: RawGpsPosition[], start: number, end: number): RawGpsPosition[] {
  return positions.filter(position => position.timestamp >= start && position.timestamp <= end);
}

/**
 * Checks the engine's own output against the fixes it was derived from.
 *
 * The rules that carry weight relate an event to its raw evidence: an event may not
 * claim more than the fixes support, and may not be unsupported at all. A stationary
 * event with no fixes inside it is an assertion about nothing, and a motion event
 * claiming less distance than the straight line between the fixes it covers has
 * traversed less than the shortest possible route.
 */
/**
 * How well a stationary event fits the fixes it covers. Not a pass/fail: its value is
 * that it is comparable across tuning runs, so a change that makes stops tighter or
 * looser shows up as a number rather than an opinion.
 */
export function stationaryFit(
  positions: RawGpsPosition[],
  event: Extract<EngineEvent, { type: "stationary" }>
): { fixes: number; radiusMeters: number; maxFixDistanceMeters: number } {
  const inside = coveringFixes(positions, event.start, event.end);
  let maxFixDistanceMeters = 0;
  for (const position of inside) {
    const distance = metricDistance(toWebMercator(position.geo), event.mean);
    if (distance > maxFixDistanceMeters) maxFixDistanceMeters = distance;
  }
  return { fixes: inside.length, radiusMeters: Math.sqrt(Math.max(0, event.variance)), maxFixDistanceMeters };
}

export function checkInvariants(
  entityId: number,
  positions: RawGpsPosition[],
  events: EngineEvent[]
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const ordered = [...events].sort((a, b) => a.start - b.start);

  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    if (current.start < previous.end) {
      violations.push({
        entityId,
        rule: "events-overlap",
        detail: `${previous.type} ending ${previous.end} overlaps ${current.type} starting ${current.start}`,
        at: current.start,
      });
    }
  }

  for (const event of events) {
    const inside = coveringFixes(positions, event.start, event.end);

    if (event.type === "stationary") {
      if (inside.length === 0) {
        violations.push({
          entityId,
          rule: "stationary-without-fixes",
          detail: `stationary event ${event.start}..${event.end} contains no raw fix`,
          at: event.start,
        });
      }
      // Deliberately no radius check here. The engine's mean and variance describe the
      // settling window rather than the whole span, and a dropout inside a stop can
      // genuinely hide a trip, so a far fix inside the span is not provably wrong.
      // It is a quality measure, which is what stationaryFit reports.
      continue;
    }

    if (event.path.length < 4) {
      violations.push({
        entityId,
        rule: "motion-path-degenerate",
        detail: `motion event ${event.start}..${event.end} has ${event.path.length} path points`,
        at: event.start,
      });
      continue;
    }

    // The engine computes distance over the real fixes, while the stored path is
    // bracketed by synthetic anchor points. Comparing against the interior endpoints
    // tests the same geometric claim without charging the reported distance for
    // points it never claimed to include.
    const first = event.path[1]!;
    const last = event.path[event.path.length - 2]!;
    // Event path points are already Web Mercator. Only RawGpsPosition needs projection.
    const straightLine = metricDistance(first.geo, last.geo);
    if (event.distance * ALLOWED_EDGE_SLACK < straightLine) {
      violations.push({
        entityId,
        rule: "motion-distance-below-straight-line",
        detail: `reported ${event.distance.toFixed(1)}m is below the ${straightLine.toFixed(1)}m between its interior endpoints`,
        at: event.start,
      });
    }
  }

  return violations;
}
