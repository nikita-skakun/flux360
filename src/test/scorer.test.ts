import { describe, expect, test } from "bun:test";
import { scoreLabels } from "@/labels/scorer";
import type { LabelOutcome } from "@/labels/scorer";
import { toWebMercator } from "@/util/webMercator";
import type { EngineEvent } from "@/types";
import type { Label } from "@/labels/types";

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function stationary(start: number, end: number, lon = 10, lat = 50): EngineEvent {
  return { type: "stationary", start, end, mean: toWebMercator([lon, lat]), variance: 4, isDraft: false };
}

function motion(start: number, end: number, lon = 10, lat = 50): EngineEvent {
  const path = [
    { device: 1, geo: toWebMercator([lon, lat]), accuracy: 5, timestamp: start },
    { device: 1, geo: toWebMercator([lon + 0.01, lat + 0.01]), accuracy: 5, timestamp: (start + end) / 2 },
    { device: 1, geo: toWebMercator([lon + 0.02, lat + 0.02]), accuracy: 5, timestamp: end },
  ];
  return {
    type: "motion",
    start,
    end,
    startAnchor: path[0]!.geo,
    endAnchor: path[2]!.geo,
    path,
    outliers: [],
    distance: 4000,
    isDraft: false,
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  };
}

function label(overrides: Partial<Label> = {}): Label {
  return { id: "l1", deviceId: 1, kind: "stationary", start: T0, end: T0 + HOUR, createdAt: 0, ...overrides };
}

describe("scoreLabels", () => {
  test("a stationary claim is matched by a covering event", () => {
    const report = scoreLabels([label()], [stationary(T0 - MINUTE, T0 + HOUR + MINUTE)]);
    expect(report.matched).toBe(1);
    expect(report.missed).toBe(0);
    expect(report.outcomes[0]?.endErrorMs).toBe(MINUTE);
  });

  test("a stationary claim is missed when no event covers it", () => {
    const report = scoreLabels([label()], [stationary(T0 + 30 * MINUTE, T0 + 2 * HOUR)]);
    expect(report.missed).toBe(1);
  });

  test("a mode claim needs the whole window covered by motion", () => {
    const car = label({ kind: "car" });
    expect(scoreLabels([car], [motion(T0 - MINUTE, T0 + HOUR)]).matched).toBe(1);

    const half = [motion(T0 - MINUTE, T0 + 20 * MINUTE), motion(T0 + 40 * MINUTE, T0 + HOUR)];
    expect(scoreLabels([car], half).missed).toBe(1);

    const whole = [motion(T0 - MINUTE, T0 + 40 * MINUTE), motion(T0 + 40 * MINUTE, T0 + HOUR + MINUTE)];
    expect(scoreLabels([car], whole).matched).toBe(1);
  });

  test("an event inside the labelled range that nothing claims is a phantom", () => {
    const report = scoreLabels([label()], [stationary(T0, T0 + 20 * MINUTE), motion(T0 + 20 * MINUTE, T0 + 40 * MINUTE)]);
    expect(report.phantom).toHaveLength(1);
    expect(report.phantom[0]?.type).toBe("motion");
  });

  test("an event outside the labelled range is not a phantom", () => {
    const report = scoreLabels([label()], [stationary(T0 + 2 * HOUR, T0 + 3 * HOUR)]);
    expect(report.phantom).toHaveLength(0);
  });

  test("an outlier claim fails only if the fix became an event boundary", () => {
    const outlier = label({ kind: "outlier", start: T0 + 10 * MINUTE, end: T0 + 10 * MINUTE });
    expect(scoreLabels([outlier], [stationary(T0, T0 + HOUR)]).matched).toBe(1);
    expect(scoreLabels([outlier], [stationary(T0, T0 + 10 * MINUTE)]).missed).toBe(1);
  });

  test("a waypoint claim checks the inferred path passed near it", () => {
    const near = label({ kind: "waypoint", start: T0, end: T0 + HOUR, geo: [10.01005, 50.01005] });
    const far = label({ kind: "waypoint", start: T0, end: T0 + HOUR, geo: [10.5, 50.5] });

    expect(scoreLabels([near], [motion(T0, T0 + HOUR)]).matched).toBe(1);
    expect(scoreLabels([far], [motion(T0, T0 + HOUR)]).missed).toBe(1);
    expect(scoreLabels([far], [motion(T0, T0 + HOUR)]).outcomes[0]?.distanceErrorMeters).toBeGreaterThan(100);
  });

  test("outcomes carry the matching errors for reporting", () => {
    const report = scoreLabels([label()], [stationary(T0 - MINUTE, T0 + HOUR)]);
    const outcomes: LabelOutcome[] = report.outcomes;
    expect(outcomes[0]?.startErrorMs).toBe(-MINUTE);
    expect(outcomes[0]?.status).toBe("matched");
  });

  test("no labels produces an empty report rather than treating everything as phantom", () => {
    const report = scoreLabels([], [stationary(T0, T0 + HOUR)]);
    expect(report).toEqual({ outcomes: [], matched: 0, missed: 0, phantom: [], labeledFrom: 0, labeledTo: 0 });
  });

  test("an empty mean is only compared when a location is claimed", () => {
    const report = scoreLabels([label({ geo: [10, 50] })], [stationary(T0, T0 + HOUR)]);
    expect(report.outcomes[0]?.distanceErrorMeters).toBeLessThan(1);
  });
});
