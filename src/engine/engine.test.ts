import { expect, test, describe } from "bun:test";
import { Engine } from "./engine";
import { toWebMercator } from "../util/webMercator";
import type { DevicePoint, Vec2, Timestamp, MotionEvent, MotionDraft } from "../types";

const START_TIME = 1000000 as Timestamp;
const P1: Vec2 = [13.405, 52.520]; // Berlin center

function createPoint(lngLat: Vec2, time: number, device = 1): DevicePoint {
    return {
        device,
        geo: lngLat,
        mean: toWebMercator(lngLat),
        timestamp: time as Timestamp,
        accuracy: 5,
        anchorStartTimestamp: time as Timestamp,
        confidence: 1,
        sourceDeviceId: null
    };
}

describe("Engine Core Logic", () => {
    test("Stationary stability with noise", () => {
        const engine = new Engine();
        const points: DevicePoint[] = [];

        // 50 points in the same spot
        for (let i = 0; i < 50; i++) {
            points.push(createPoint(P1, START_TIME + i * 1000, 1));
        }

        engine.processMeasurements(points);
        expect(engine.draft?.type).toBe("stationary");
        expect(engine.closed.length).toBe(0);
    });

    test("Significant trip detection", () => {
        const engine = new Engine();
        let time = START_TIME;

        // 50 points stationary
        engine.processMeasurements(Array.from({ length: 50 }, (_, i) =>
            createPoint(P1, time + i * 1000, 101)
        ));
        time += 50000;

        // Move 300m away
        engine.processMeasurements(Array.from({ length: 15 }, (_, i) =>
            createPoint([P1[0] + 0.005, P1[1]], time + i * 1000, 101)
        ));
        time += 15000;

        // Now settle (Need 15s duration in RECENT window)
        engine.processMeasurements(Array.from({ length: 20 }, (_, i) =>
            createPoint([P1[0] + 0.005, P1[1]], time + i * 5000, 101)
        ));

        expect(engine.draft?.type).toBe("stationary");
        expect(engine.closed.length).toBe(2); // Stationary + Motion
        const motion = engine.closed.find(e => e.type === 'motion') as MotionEvent;
        // Settling points should be trimmed from the path tail
        expect(motion.path.length).toBeLessThan(40);
    });

    test("Non-coherent jitter rejection (Alignment Gate)", () => {
        const engine = new Engine();
        let time = START_TIME;

        // 50 points stationary
        engine.processMeasurements(Array.from({ length: 50 }, (_, i) =>
            createPoint(P1, time + i * 1000, 103)
        ));
        time += 50000;

        // 10 points far apart but in different directions (N, E, S, W)
        const jitter: DevicePoint[] = [];
        for (let i = 0; i < 10; i++) {
            const angle = (i % 4) * Math.PI / 2;
            const jump = 0.0004;
            jitter.push(createPoint([P1[0] + jump * Math.cos(angle), P1[1] + jump * Math.sin(angle)], time + i * 1000, 103));
        }
        engine.processMeasurements(jitter);

        // These should be absorbed as "stationary mush" because they are not coherent
        expect(engine.draft?.type).toBe("stationary");
        expect(engine.closed.length).toBe(0);
    });

    test("Slow drift absorption (Velocity Threshold)", () => {
        const engine = new Engine();
        let time = START_TIME;

        // Initial Stationary
        engine.processMeasurements(Array.from({ length: 50 }, (_, i) =>
            createPoint(P1, time + i * 1000, 102)
        ));
        time += 50000;

        // Slow drift: 92m over 8 minutes (480s)
        const driftPoints: DevicePoint[] = [];
        for (let i = 0; i < 48; i++) {
            const jump = 0.00002;
            driftPoints.push(createPoint([P1[0] + i * jump, P1[1]], time + i * 10000, 102));
        }
        engine.processMeasurements(driftPoints);
        time += 480000;

        // Settle
        engine.processMeasurements(Array.from({ length: 20 }, (_, i) =>
            createPoint([P1[0] + 48 * 0.00002, P1[1]], time + i * 5000, 102)
        ));

        expect(engine.draft?.type).toBe("stationary");
        expect(engine.closed.length).toBe(0);
    });

    test("Stationary breakout (100m Hard Radius)", () => {
        const engine = new Engine();
        let time = START_TIME;

        // Initial Stationary
        engine.processMeasurements(Array.from({ length: 50 }, (_, i) =>
            createPoint(P1, time + i * 1000, 104)
        ));
        time += 50000;

        // Large jump: 150m away (roughly 0.00135 degrees)
        // This would be absorbed by a 1000m² "mega-anchor" but should be caught by the 100m breakout
        const jumpPoint = [P1[0] + 0.0015, P1[1]] as Vec2;

        // 5 points at the jump location (PENDING_MIN = 5)
        const breakoutPoints: DevicePoint[] = [];
        for (let i = 0; i < 5; i++) {
            breakoutPoints.push(createPoint(jumpPoint, time + i * 1000, 104));
        }
        engine.processMeasurements(breakoutPoints);

        // Should transition to motion because 150m > 100m breakout radius
        expect(engine.draft?.type).toBe("motion");
    });

    test("High-radius jitter absorption", () => {
        const engine = new Engine();
        let time = START_TIME;

        // Initial Stationary
        engine.processMeasurements(Array.from({ length: 50 }, (_, i) =>
            createPoint(P1, time + i * 1000, 105)
        ));
        time += 50000;

        // Jittery move: 80m path, 60m displacement, 120s duration
        // Displacement 66m is < 5 * 20 = 100m.
        // Path distance 80m is < 8 * 20 = 160m.
        const jitterPoints: DevicePoint[] = [];
        const jumpPoint = [P1[0] + 0.0006, P1[1]] as Vec2; // ~66m displacement
        for (let i = 0; i < 5; i++) {
            // Give it some distance but not enough to pass the 160m total path or 100m net disp
            jitterPoints.push(createPoint(jumpPoint, time + i * 24000, 105));
        }
        engine.processMeasurements(jitterPoints);
        time += 120000;

        // Settle
        engine.processMeasurements(Array.from({ length: 20 }, (_, i) =>
            createPoint(jumpPoint, time + i * 5000, 105)
        ));

        // Should NOT transition to motion because it's too small/slow
        expect(engine.draft?.type).toBe("stationary");
        expect(engine.closed.length).toBe(0);
    });

    test("Motion merging (refineHistory)", () => {
        const engine = new Engine();
        let time = START_TIME;

        // 1. Initial Stationary
        engine.processMeasurements(Array.from({ length: 50 }, (_, i) => createPoint(P1, time + i * 1000, 106)));
        time += 60000;

        // 2. Motion A (300m)
        const P2: Vec2 = [P1[0] + 0.003, P1[1]];
        engine.processMeasurements(Array.from({ length: 20 }, (_, i) => createPoint(P2, time + i * 5000, 106)));
        time += 100000;

        // 3. Brief Stationary (120s) - less than 5 min threshold
        engine.processMeasurements(Array.from({ length: 20 }, (_, i) => createPoint(P2, time + i * 6000, 106)));
        time += 120000;

        // 4. Motion B (300m further)
        const P3: Vec2 = [P2[0] + 0.003, P2[1]];
        engine.processMeasurements(Array.from({ length: 20 }, (_, i) => createPoint(P3, time + i * 5000, 106)));
        time += 100000;

        // Settle
        engine.processMeasurements(Array.from({ length: 20 }, (_, i) => createPoint(P3, time + i * 5000, 106)));

        // Before refinement, we should have multiple segments
        expect(engine.closed.length).toBeGreaterThan(2);

        // After refinement
        engine.refineHistory();

        // Adjacent motions separated by a short stop should merge into one
        const motions = engine.closed.filter(e => e.type === 'motion');
        expect(motions.length).toBe(1);
    });

    test("Sparse GPS data settlement", () => {
        const engine = new Engine();
        let time = START_TIME;

        // 1. Stationary at P1
        engine.processMeasurements(Array.from({ length: 50 }, (_, i) => createPoint(P1, time + i * 1000, 106)));
        time += 50000;

        // 2. Jump 500m to P2
        const P2: Vec2 = [P1[0] + 0.005, P1[1]];

        // 3. Sparse jitter at P2 (points arriving every 3-5 minutes)
        const offsets: Vec2[] = [
            [0.00001, 0.00002], [-0.00001, 0.00001], [0.00001, -0.00001],
            [0.00002, 0], [-0.00001, -0.00002], [0, 0.00001],
            [0.00001, 0.00001], [-0.00002, 0], [0.00001, -0.00001],
            [0, 0.00002], [-0.00001, 0.00001], [0.00001, 0],
        ];
        for (const off of offsets) {
            const jittered: Vec2 = [P2[0] + off[0], P2[1] + off[1]];
            engine.processMeasurements([createPoint(jittered, time, 106)]);
            time += 180000 + Math.random() * 120000; // 3-5 min gaps
        }

        // Should settle quickly, not drag on as a long false motion
        const motionEvents = engine.closed.filter((e): e is MotionEvent => e.type === 'motion');
        for (const m of motionEvents) {
            const durationSec = (m.end - m.start) / 1000;
            expect(durationSec).toBeLessThan(1200);
        }
    });

    test("Motion draft predecessor linkage", () => {
        const engine = new Engine();
        let time = START_TIME;

        // 1. Stationary
        engine.processMeasurements(Array.from({ length: 50 }, (_, i) =>
            createPoint(P1, time + i * 1000, 107)
        ));
        time += 50000;

        // 2. Start moving fast
        engine.processMeasurements(Array.from({ length: 10 }, (_, i) =>
            createPoint([P1[0] + (i * 0.0001), P1[1]], time + i * 1000, 107)
        ));

        expect(engine.draft?.type).toBe("motion");
        const draft = engine.draft as MotionDraft;
        expect(draft.predecessor).toBeDefined();
        expect(draft.predecessor.type).toBe("stationary");
        expect(draft.predecessor.start).toBe(START_TIME);
    });

    test("Significant loop detection (Reproduction of absorption bug)", () => {
        const engine = new Engine();
        let time = START_TIME;

        // 1. Initial Stationary at P1
        engine.processMeasurements(Array.from({ length: 50 }, (_, i) =>
            createPoint(P1, time + i * 1000, 108)
        ));
        time += 50000;

        // 2. Drive a 2km loop and return to P1
        // We go 1000m north, then 1000m south back to P1
        const P_MID: Vec2 = [P1[0], P1[1] + 0.009]; // ~1000m north

        // Outward
        engine.processMeasurements(Array.from({ length: 10 }, (_, i) =>
            createPoint([P1[0], P1[1] + i * 0.0009], time + i * 10000, 108)
        ));
        time += 100000;

        // Return
        engine.processMeasurements(Array.from({ length: 10 }, (_, i) =>
            createPoint([P_MID[0], P_MID[1] - i * 0.0009], time + i * 10000, 108)
        ));
        time += 100000;

        // 3. Settle at P1
        engine.processMeasurements(Array.from({ length: 20 }, (_, i) =>
            createPoint(P1, time + i * 5000, 108)
        ));

        // This trip has totalDistance ~2000m, but startEndDist ~0m.
        // It SHOULD be committed as a motion.
        // If it's absorbed, engine.closed.length will be 0 (all merged into stationary draft).
        const motions = engine.closed.filter(e => e.type === 'motion');
        expect(motions.length).toBe(1);
    });

    test("Flyer jitter rejection (outlier loop prevention)", () => {
        const engine = new Engine();
        let time = START_TIME;

        // 1. Initial Stationary at P1
        engine.processMeasurements(Array.from({ length: 50 }, (_, i) =>
            createPoint(P1, time + i * 1000, 109)
        ));
        time += 50000;

        // 2. Flyer scenario: 5 points total
        // p1, p2 near anchor
        // p3 far flyer (400m away)
        // p4, p5 near anchor (causes settlement)
        const flyerPoints: DevicePoint[] = [
            createPoint(P1, time, 109),
            createPoint(P1, time + 20000, 109),
            createPoint([P1[0] + 0.004, P1[1]], time + 387000, 109), // ~400m away
            createPoint(P1, time + 582000, 109),
            createPoint(P1, time + 588000, 109),
        ];
        engine.processMeasurements(flyerPoints);

        // 3. Settle at P1 for real
        engine.processMeasurements(Array.from({ length: 20 }, (_, i) =>
            createPoint(P1, time + 600000 + i * 5000, 109)
        ));

        // This has distance ~800m and maxDev ~400m, but ONLY 5 points and 1 flyer.
        // It SHOULD be absorbed as mush, not committed as a motion.
        const motions = engine.closed.filter(e => e.type === 'motion');
        expect(motions.length).toBe(0);
    });

    test("Snapshot lastTimestamp persistence and safety", () => {
        const engine = new Engine();
        const p1 = createPoint(P1, START_TIME, 1);
        const p2 = createPoint(P1, START_TIME + 1000, 1);
        const p3 = createPoint(P1, START_TIME + 2000, 1);

        engine.processMeasurements([p1, p2, p3]);
        expect(engine.lastTimestamp).toBe(START_TIME + 2000);

        const snapshot = engine.createSnapshot();
        const engine2 = new Engine();
        engine2.restoreSnapshot(snapshot);

        // Verify lastTimestamp is restored
        expect(engine2.lastTimestamp).toBe(START_TIME + 2000);

        // Feed out-of-order point (ServerState would usually prevent this if lastTimestamp is correct)
        const pOld = createPoint(P1, START_TIME + 500, 1);
        engine2.processMeasurements([pOld]);

        // Engine itself just updates lastTimestamp, but we want to ensure it doesn't break draft start
        expect(engine2.draft?.start).toBe(START_TIME);
    });
});
