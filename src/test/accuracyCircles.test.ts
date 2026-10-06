import { describe, expect, test } from "bun:test";
import { buildAccuracyCircleCoords, computeBounds, paddedLngLatBounds } from "@/util/geo";
import { metricDistance, toWebMercator } from "@/util/webMercator";

describe("accuracy circles", () => {
  test("a ring point sits exactly the claimed ground radius from the centre", () => {
    // A metre radius must survive the projection, or the circle misrepresents the
    // accuracy it is supposed to communicate.
    for (const lat of [0, 25, 49, 60, -33]) {
      const center = toWebMercator([10, lat]);
      const ring = buildAccuracyCircleCoords(center, 100);
      for (const point of [ring[0], ring[16], ring[32], ring[48]]) {
        if (!point) continue;
        const distance = metricDistance(center, toWebMercator(point));
        expect(distance).toBeGreaterThan(99);
        expect(distance).toBeLessThan(101);
      }
    }
  });

  test("the ring is closed and evenly sized", () => {
    const center = toWebMercator([-122.4, 49.2]);
    const ring = buildAccuracyCircleCoords(center, 50);
    expect(ring).toHaveLength(65);
    expect(ring[0]).toEqual(ring[64]);

    const distances = ring.map(point => metricDistance(center, toWebMercator(point)));
    expect(Math.min(...distances)).toBeGreaterThan(49.5);
    expect(Math.max(...distances)).toBeLessThan(50.5);
  });

  test("a larger accuracy produces a proportionally larger ring", () => {
    const center = toWebMercator([10, 49]);
    const small = buildAccuracyCircleCoords(center, 20)[0];
    const large = buildAccuracyCircleCoords(center, 200)[0];
    expect(small).toBeDefined();
    expect(large).toBeDefined();
    expect(metricDistance(center, toWebMercator(large!)) / metricDistance(center, toWebMercator(small!))).toBeCloseTo(10, 1);
  });

  test("a zero radius collapses to the centre rather than degenerating", () => {
    const center = toWebMercator([10, 49]);
    const ring = buildAccuracyCircleCoords(center, 0);
    expect(ring.every(point => Math.abs(point[0] - 10) < 1e-9)).toBe(true);
  });

  test("bounds and padding still behave", () => {
    const bounds = computeBounds([[0, 1], [2, 3]]);
    expect(bounds).toEqual({ minX: 0, minY: 1, maxX: 2, maxY: 3 });

    const [sw, ne] = paddedLngLatBounds([0, 0], [1, 1]);
    expect(sw[0]).toBeLessThan(0);
    expect(ne[0]).toBeGreaterThan(1);
  });
});
