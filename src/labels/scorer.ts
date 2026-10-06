import { metricDistance, toWebMercator } from "@/util/webMercator";
import { isMotionKind, isPointKind } from "./types";
import type { EngineEvent } from "@/types";
import type { Label } from "./types";

export type LabelOutcome = {
  label: Label;
  status: "matched" | "missed";
  startErrorMs: number | null;
  endErrorMs: number | null;
  distanceErrorMeters: number | null;
};

export type ScoreReport = {
  outcomes: LabelOutcome[];
  matched: number;
  missed: number;
  /** Events inside the labelled range that no label claims. */
  phantom: EngineEvent[];
  labeledFrom: number;
  labeledTo: number;
};

const WAYPOINT_TOLERANCE_METERS = 100;

function waypointDistance(event: EngineEvent, label: Label): number | null {
  if (event.type !== "motion" || !label.geo) return null;
  const target = toWebMercator(label.geo);
  let closest = Infinity;
  for (const point of event.path) {
    const distance = metricDistance(point.geo, target);
    if (distance < closest) closest = distance;
  }
  return Number.isFinite(closest) ? closest : null;
}

/**
 * Scores a derivation against hand-authored labels.
 *
 * The claim decides what is being tested. A `stationary` label asserts the whole span
 * was stationary, so a single event must cover it. A mode label asserts movement
 * throughout, so the span must be covered by motion, which may take several events.
 */
export function scoreLabels(labels: Label[], events: EngineEvent[]): ScoreReport {
  const outcomes: LabelOutcome[] = [];

  if (labels.length === 0) {
    return { outcomes, matched: 0, missed: 0, phantom: [], labeledFrom: 0, labeledTo: 0 };
  }

  const labeledFrom = Math.min(...labels.map(label => label.start));
  const labeledTo = Math.max(...labels.map(label => label.end));

  for (const label of [...labels].sort((a, b) => a.start - b.start)) {
    const from = label.start;
    const to = label.end;

    if (isPointKind(label.kind)) {
      if (label.kind === "waypoint") {
        const overlapping = events.filter(event => event.start <= to && event.end >= from);
        let best: { distance: number; event: EngineEvent } | null = null;
        for (const event of overlapping) {
          const distance = waypointDistance(event, label);
          if (distance !== null && (best === null || distance < best.distance)) best = { distance, event };
        }
        outcomes.push({
          label,
          status: best && best.distance <= WAYPOINT_TOLERANCE_METERS ? "matched" : "missed",
          startErrorMs: null,
          endErrorMs: null,
          distanceErrorMeters: best?.distance ?? null,
        });
        continue;
      }

      // An outlier asserts the fix is bad. It is used if it became an event boundary.
      const used = events.some(event => event.start === label.start || event.end === label.start);
      outcomes.push({ label, status: used ? "missed" : "matched", startErrorMs: null, endErrorMs: null, distanceErrorMeters: null });
      continue;
    }

    if (!isMotionKind(label.kind)) {
      const covering = events.filter(
        event => event.type === "stationary" && event.start <= from && event.end >= to
      );
      const best = covering[0] ?? null;
      outcomes.push({
        label,
        status: best ? "matched" : "missed",
        startErrorMs: best ? best.start - label.start : null,
        endErrorMs: best ? best.end - label.end : null,
        distanceErrorMeters: best && best.type === "stationary"
          ? metricDistance(best.mean, toWebMercator(label.geo ?? [0, 0]))
          : null,
      });
      continue;
    }

    const motion = events
      .filter((event): event is Extract<EngineEvent, { type: "motion" }> => event.type === "motion" && event.start <= to && event.end >= from)
      .sort((a, b) => a.start - b.start);

    let cursor = from;
    let covered = true;
    for (const event of motion) {
      if (event.start > cursor) {
        covered = false;
        break;
      }
      if (event.end > cursor) cursor = event.end;
    }
    if (cursor < to) covered = false;

    outcomes.push({
      label,
      status: covered ? "matched" : "missed",
      startErrorMs: motion[0] ? motion[0].start - label.start : null,
      endErrorMs: motion.length > 0 ? motion[motion.length - 1]!.end - label.end : null,
      distanceErrorMeters: null,
    });
  }

  // An event is unclaimed when no overlapping label asserts an event of its kind. A
  // motion event inside a stationary claim is a contradiction, not a match, so kind
  // has to be part of the comparison.
  const claims = (event: EngineEvent, label: Label) =>
    label.kind === "stationary" ? event.type === "stationary"
      : isMotionKind(label.kind) ? event.type === "motion"
      : false;

  const phantom = events.filter(event => {
    if (event.start < labeledFrom || event.end > labeledTo) return false;
    return !labels.some(label => claims(event, label) && event.start <= label.end && event.end >= label.start);
  });

  return {
    outcomes,
    matched: outcomes.filter(outcome => outcome.status === "matched").length,
    missed: outcomes.filter(outcome => outcome.status === "missed").length,
    phantom,
    labeledFrom,
    labeledTo,
  };
}
