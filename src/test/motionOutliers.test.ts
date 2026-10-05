import { describe, expect, test } from "bun:test";
import { calculateOutlierScore, filterMotionOutliers } from "@/util/motionOutliers";
import { cosLatitude, toWebMercator } from "@/util/webMercator";
import type { Vec2 } from "@/types";

type Pt = { timestamp: number; geo: Vec2 };

const STEP = 10_000;

// The engine feeds Web Mercator metres, not degrees. Building the fixtures the
// same way matters: the score's ratio floor is an absolute distance, so degree
// fixtures silently score every outlier as zero.
const LAT = 50;
const along = (i: number) => toWebMercator([10 + i * 0.0002, LAT]);
// Offsets are stated in metres, so convert through the projection scale. Offsetting by
// raw Web Mercator units would make every fixture latitude dependent.
const offsetY = (i: number, metres: number) => {
  const p = along(i);
  return [p[0], p[1] + metres / cosLatitude(p[1])] as Vec2;
};
const COS_LAT = cosLatitude(along(0)[1]);

const geo = (p: Pt) => p.geo;

function run(points: Pt[], threshold?: number) {
  let path = points;
  let outliers: Pt[] = [];
  for (let i = 0; i < path.length; i++) {
    const r = threshold === undefined
      ? filterMotionOutliers(path, outliers, geo)
      : filterMotionOutliers(path, outliers, geo, threshold);
    path = r.cleanPath;
    outliers = r.newOutliers;
  }
  return { clean: path, outliers };
}

describe("calculateOutlierScore", () => {
  test("a straight line scores low", () => {
    const a = { timestamp: 0, geo: along(0) };
    const b = { timestamp: STEP, geo: along(1) };
    const c = { timestamp: 2 * STEP, geo: along(2) };
    expect(calculateOutlierScore(a, b, c, geo, COS_LAT).score).toBeLessThan(100);
  });

  test("a large lateral spike scores high", () => {
    const a = { timestamp: 0, geo: along(0) };
    const b = { timestamp: STEP, geo: offsetY(1, 500) };
    const c = { timestamp: 2 * STEP, geo: along(2) };
    expect(calculateOutlierScore(a, b, c, geo, COS_LAT).score).toBeGreaterThan(100);
  });
});

describe("filterMotionOutliers", () => {
  test("keeps a clean path intact", () => {
    const points: Pt[] = Array.from({ length: 60 }, (_, i) => ({ timestamp: i * STEP, geo: along(i) }));
    const { clean, outliers } = run(points);
    expect(clean.length).toBe(60);
    expect(outliers.length).toBe(0);
  });

  test("rejects an isolated spike", () => {
    const points: Pt[] = Array.from({ length: 60 }, (_, i) => ({ timestamp: i * STEP, geo: along(i) }));
    points[30] = { timestamp: 30 * STEP, geo: offsetY(30, 800) };
    const { clean, outliers } = run(points);
    expect(outliers.length).toBeGreaterThan(0);
    expect(clean.some(p => p.geo[1] > along(30)[1] + 400)).toBe(false);
  });

  test("rejects alternating spikes", () => {
    const points: Pt[] = Array.from({ length: 60 }, (_, i) => ({ timestamp: i * STEP, geo: along(i) }));
    for (const i of [28, 30, 32]) points[i] = { timestamp: i * STEP, geo: offsetY(i, 900) };
    const { clean, outliers } = run(points);
    expect(outliers.length).toBe(3);
    expect(clean.some(p => p.geo[1] > along(30)[1] + 400)).toBe(false);
  });

  test("a rejected point never becomes an anchor for later scoring", () => {
    // Two well-separated spikes: if the first were accepted as an anchor, the
    // second would be scored relative to it and survive.
    const points: Pt[] = Array.from({ length: 80 }, (_, i) => ({ timestamp: i * STEP, geo: along(i) }));
    points[20] = { timestamp: 20 * STEP, geo: offsetY(20, 900) };
    points[60] = { timestamp: 60 * STEP, geo: offsetY(60, 900) };
    const { outliers } = run(points);
    expect(outliers.length).toBe(2);
  });

  test("a sustained lateral offset is not treated as outlier noise", () => {
    // Both legs of every candidate are equally displaced, so the minimum lift is
    // zero and the detector deliberately passes it through as real movement.
    const points: Pt[] = Array.from({ length: 60 }, (_, i) => ({ timestamp: i * STEP, geo: along(i) }));
    for (let i = 28; i <= 32; i++) points[i] = { timestamp: i * STEP, geo: offsetY(i, 900) };
    const { clean } = run(points);
    expect(clean.filter(p => p.geo[1] > along(30)[1] + 400).length).toBe(5);
  });

  test("the last point is never filtered", () => {
    const points: Pt[] = Array.from({ length: 30 }, (_, i) => ({ timestamp: i * STEP, geo: along(i) }));
    const { clean } = run(points);
    expect(clean[clean.length - 1]?.timestamp).toBe(29 * STEP);
  });

  test("a short path is returned untouched", () => {
    const points: Pt[] = [
      { timestamp: 0, geo: along(0) },
      { timestamp: STEP, geo: along(1) },
    ];
    const { clean } = run(points);
    expect(clean.length).toBe(2);
  });

  test("a long motion stays inside a sane time budget", () => {
    const points: Pt[] = Array.from({ length: 4000 }, (_, i) => ({ timestamp: i * STEP, geo: along(i) }));
    const t = performance.now();
    run(points);
    const elapsed = performance.now() - t;
    expect(elapsed).toBeLessThan(1200);
  });
});
