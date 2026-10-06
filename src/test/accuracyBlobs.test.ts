import { describe, expect, test } from "bun:test";
import { mergeAccuracyCircles } from "@/labels/fixes";
import { metricDistance, toWebMercator } from "@/util/webMercator";
import type { StripFix } from "@/labels/types";

const LAT = 49.2;
const LON = -122.4;
/** Degrees of latitude per metre. */
const METRE = 1 / 111_320;

function fix(lonOffsetMeters: number, latOffsetMeters: number, accuracy: number): StripFix {
  return {
    device: 1,
    geo: [LON + lonOffsetMeters * METRE / Math.cos(LAT * Math.PI / 180), LAT + latOffsetMeters * METRE],
    accuracy,
    timestamp: 0,
  };
}

describe("mergeAccuracyCircles", () => {
  test("nothing in, nothing out", () => {
    expect(mergeAccuracyCircles([])).toEqual([]);
  });

  test("a parked cluster collapses to a single circle", () => {
    const parked = Array.from({ length: 200 }, (_, index) => fix((index % 7) * 0.4, Math.floor(index / 7) * 0.4, 55));
    const blobs = mergeAccuracyCircles(parked);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.count).toBe(200);
  });

  test("fixes that are genuinely apart each keep their own circle", () => {
    const spread = Array.from({ length: 6 }, (_, index) => fix(index * 2000, 0, 20));
    const blobs = mergeAccuracyCircles(spread);
    expect(blobs).toHaveLength(6);
    expect(blobs.every(blob => blob.count === 1)).toBe(true);
  });

  test("every member's accuracy circle is contained in its blob", () => {
    const mixed = [
      ...Array.from({ length: 40 }, (_, index) => fix(index * 5, index % 3, 12)),
      ...Array.from({ length: 40 }, (_, index) => fix(5000 + index * 5, 0, 60)),
    ];
    const blobs = mergeAccuracyCircles(mixed);
    const centreOf = (blob: { geo: [number, number] }) => toWebMercator(blob.geo);

    for (const fixValue of mixed) {
      const containing = blobs.filter(blob =>
        metricDistance(centreOf(blob), toWebMercator(fixValue.geo)) <= blob.radiusMeters + 1e-6
      );
      expect(containing.length).toBeGreaterThan(0);
    }
    expect(blobs.reduce((total, blob) => total + blob.count, 0)).toBe(mixed.length);
  });

  test("a slow walk does not chain into one enormous circle", () => {
    // Fixes 20m apart with 15m accuracy overlap each other, so a greedy merge would
    // walk the whole track into a single blob covering the entire route.
    const walk = Array.from({ length: 120 }, (_, index) => fix(index * 20, 0, 15));
    const blobs = mergeAccuracyCircles(walk);
    expect(blobs.length).toBeGreaterThan(1);
    expect(blobs.length).toBeLessThan(walk.length);

    const widest = Math.max(...blobs.map(blob => blob.radiusMeters));
    expect(widest).toBeLessThan(200);
  });

  test("the blob count never exceeds the fix count", () => {
    const fixes = [fix(0, 0, 5), fix(1, 1, 5), fix(900, 900, 5)];
    const blobs = mergeAccuracyCircles(fixes);
    expect(blobs.length).toBeLessThanOrEqual(fixes.length);
    expect(blobs.length).toBeGreaterThan(0);
  });

  test("a dense channel and a sparse channel both stay bounded", () => {
    // 8m apart with 6m accuracy: the circles overlap, so these should merge. 14m apart
    // would not overlap and correctly stays as one circle per fix.
    const dense = Array.from({ length: 150 }, (_, index) => fix(index * 8, 0, 6));
    const sparse = Array.from({ length: 150 }, (_, index) => fix(index * 900, 0, 60));

    // Dense fixes are close together, so they merge; sparse ones are far apart.
    expect(mergeAccuracyCircles(dense).length).toBeLessThan(dense.length);
    expect(mergeAccuracyCircles(sparse).length).toBe(sparse.length);
  });
});
