import { expect, test, describe } from "bun:test";
import { smoothPath } from "./pathSmoothing";

describe("smoothPath", () => {
    test("passes through with 2 or fewer points", () => {
        const result = smoothPath([
            { point: [0, 0], accuracy: 10, timestamp: 0 },
            { point: [100, 0], accuracy: 10, timestamp: 10000 },
        ]);
        expect(result).toEqual([[0, 0], [100, 0]]);
    });

    test("anchors first and last points", () => {
        const result = smoothPath([
            { point: [0, 0], accuracy: 1, timestamp: 0 },
            { point: [50, 50], accuracy: 100, timestamp: 5000 },
            { point: [100, 0], accuracy: 1, timestamp: 10000 },
        ]);
        expect(result[0]).toEqual([0, 0]);
        expect(result[result.length - 1]).toEqual([100, 0]);
    });

    test("pulls low-accuracy point toward time-weighted expected line", () => {
        const result = smoothPath([
            { point: [0, 0], accuracy: 1, timestamp: 0 },
            { point: [50, 50], accuracy: 100, timestamp: 5000 },
            { point: [100, 0], accuracy: 1, timestamp: 10000 },
        ]);
        // dtTotal = 10000. straightLineConfidence = 60000 / 10000 = 6 -> capped at 1.0
        // r = 100. effectiveRadius = 100.
        // dPrevC = hypot(50, 50) = 70.71. dCNext = hypot(50, -50) = 70.71. dPNext = 100.
        // detourRatio = (70.71 + 70.71) / 100 = 1.4142
        // detourMultiplier = 1.4142^2 = 2.0
        // allowedPull = 100 * 2.0 = 200m
        // Ideal is [50, 0]. Dist from [50, 50] to [50, 0] is 50m.
        // Since 50 <= 200, it snaps exactly to ideal.
        expect(result[1]![0]).toBeCloseTo(50, 2);
        expect(result[1]![1]).toBeCloseTo(0, 2);
    });

    test("time-weighting moves expected position along the segment", () => {
        const result = smoothPath([
            { point: [0, 0], accuracy: 1, timestamp: 0 },
            { point: [50, 50], accuracy: 100, timestamp: 1000 }, // Only 1s elapsed
            { point: [100, 0], accuracy: 1, timestamp: 10000 },
        ]);
        // Ideal position is [10, 0] because it's 10% of the way through the time gap.
        // Accuracy is 100, detourMultiplier is > 1. 
        // Allowed pull is large enough to cover the distance from [50, 50] to [10, 0] (hypto(40, 50) = 64).
        // Should snap exactly to the time-weighted ideal [10, 0].
        expect(result[1]![0]).toBeCloseTo(10, 2);
        expect(result[1]![1]).toBeCloseTo(0, 2);
    });

    test("constrains high-accuracy point to its circle", () => {
        const result = smoothPath([
            { point: [0, 0], accuracy: 1, timestamp: 0 },
            { point: [50, 50], accuracy: 5, timestamp: 5000 },
            { point: [100, 0], accuracy: 1, timestamp: 10000 },
        ]);
        // Ideal = [50, 0]. Center = [50, 50]. r = 5.
        // dtTotal = 10000 => straightLineConfidence = 1.0 => effectiveRadius = 5.
        // detourRatio = (70.71 + 70.71) / 100 = 1.4142.
        // detourMultiplier = 1.4142^2 = 2.0.
        // allowedPull = 5 * 2.0 = 10.0.
        // We move from [50, 50] toward [50, 0] by exactly 10m.
        // Expected position: [50, 40].
        expect(result[1]![0]).toBeCloseTo(50, 2);
        expect(result[1]![1]).toBeCloseTo(40, 2);
    });

    test("handles straight path (no change needed)", () => {
        const result = smoothPath([
            { point: [0, 0], accuracy: 5, timestamp: 0 },
            { point: [50, 0], accuracy: 5, timestamp: 5000 },
            { point: [100, 0], accuracy: 5, timestamp: 10000 },
        ]);
        for (const p of result) {
            expect(Math.abs(p[1])).toBeLessThan(1);
        }
    });

    test("preserves multi-point corners without over-smoothing", () => {
        // A sequence of points taking a 90-degree turn over 4 points.
        const result = smoothPath([
            { point: [0, 0], accuracy: 1, timestamp: 0 },
            { point: [50, 0], accuracy: 5, timestamp: 5000 },
            { point: [100, 50], accuracy: 5, timestamp: 10000 },
            { point: [100, 100], accuracy: 1, timestamp: 15000 },
        ]);
        // B = [50, 0]. Prev = [0, 0], Next = [100, 50].
        // Ideal is roughly [50, 25]. Distance from B to ideal is ~25m.
        // Detour ratio for B: dPrevC=50. dCNext=hypot(50, 50)=70.7. dPNext=hypot(100, 50)=111.8.
        // Ratio = 120.7 / 111.8 = 1.08.
        // Multiplier = 1.08^2 = 1.16.
        // Allowed pull = 5 * 1.16 = 5.8m.
        // B should move from [50, 0] toward [50, 25] by exactly 5.8m.
        // Result: [50, 5.8] for pass 1, but over 3 passes it subtly mutually relaxes.
        expect(result[1]![0]).toBeGreaterThan(49);
        expect(result[1]![0]).toBeLessThan(51);
        expect(result[1]![1]).toBeGreaterThan(4); // Y moved up slightly, but NOT all the way to 25.
        expect(result[1]![1]).toBeLessThan(7);

        // Similar subtle smoothing for C, preserving the shape of the curve.
        expect(result[2]![0]).toBeLessThan(96);
        expect(result[2]![0]).toBeGreaterThan(93);
        expect(result[2]![1]).toBeGreaterThan(49);
        expect(result[2]![1]).toBeLessThan(52);
    });

    test("amplifies pull for noise spikes causing geometric detours", () => {
        // Points A and C are at [0,0] and [100,0]. Point B is a massive spike at [50, 500].
        // Its geometric detour ratio is huge. Even if its accuracy is only 50m, 
        // the detour multiplier should allow it to be pulled almost entirely flat.
        const result = smoothPath([
            { point: [0, 0], accuracy: 1, timestamp: 0 },
            { point: [50, 500], accuracy: 50, timestamp: 5000 },
            { point: [100, 0], accuracy: 1, timestamp: 10000 },
        ]);

        // Allowed pull = effectiveRadius * detourMultiplier. 
        // detourRatio = (502 + 502) / 100 = 10.04
        // detourMultiplier = 100.8. allowedPull = 50 * 1 * 100.8 = 5000m.
        // It should snap perfectly to the expected position [50, 0].
        expect(result[1]![0]).toBe(50);
        expect(result[1]![1]).toBe(0);
    });

    test("large time gap between points reduces smoothing aggression", () => {
        // Point B has a massive time gap (10 minutes = 600000ms)
        // Its effective radius should expand 10x (5m -> 50m) allowing it to stay near 50,50
        const result = smoothPath([
            { point: [0, 0], accuracy: 1, timestamp: 0 },
            { point: [50, 50], accuracy: 5, timestamp: 300000 },
            { point: [100, 0], accuracy: 1, timestamp: 600000 },
        ]);

        // It should NOT be pulled all the way to 50,0 because the large gap means 
        // the straight-line assumption is weak.
        expect(result[1]![1]).toBeGreaterThan(45); // Stays near 50
    });
});
