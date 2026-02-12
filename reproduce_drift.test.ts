
import type { DevicePoint } from "@/ui/types";
import { test, expect } from "bun:test";

const VERBOSE = process.env["VERBOSE"] === "1" || process.argv.includes("--verbose");

test("reproduce_slow_drift", async () => {
    const { Engine } = await import("./src/engine/engine");

    const makeMeasurement = (x: number, y: number, t: number, accuracy: number, deviceId: number = 0) => {
        return {
            device: deviceId,
            mean: [x, y],
            variance: accuracy * accuracy,
            timestamp: t,
            accuracy,
            lat: 0,
            lon: 0,
            anchorAgeMs: 0,
        } as DevicePoint;
    };

    const engine = new Engine();
    engine.setMotionProfile("car");
    const t0 = Date.now();

    // Stabilize anchor at origin with accurate measurements
    if (VERBOSE) console.log("Phase 1: Stabilizing anchor at (0,0)");
    for (let i = 0; i < 20; i++) {
        engine.processMeasurements([makeMeasurement(0, 0, t0 + i * 1000, 10)]);
    }

    const initialSnapshot = engine.getCurrentSnapshot();
    const anchor = initialSnapshot.activeAnchor;
    if (!anchor) throw new Error("No anchor created");

    if (VERBOSE) console.log(`Anchor stabilized at: [${anchor.mean[0].toFixed(2)}, ${anchor.mean[1].toFixed(2)}] Variance: ${anchor.variance.toFixed(2)}`);

    // Feed offset reports to trigger drift detection (40m accuracy)
    if (VERBOSE) console.log("\nPhase 2: Feeding offset points at (150,0) with accuracy 40m");
    const offsetBatchSize = 10;

    let finalMeanX = 0;
    for (let i = 0; i < offsetBatchSize; i++) {
        const t = t0 + 20000 + i * 1000;
        engine.processMeasurements([makeMeasurement(150, 0, t, 40)]);


        const frame = engine.getDebugFrames().pop();
        if (frame) {
            finalMeanX = frame.after?.mean[0] ?? 0;
            if (VERBOSE) console.log(`Step ${i + 1}: Decision=${frame.decision} AnchorMeanX=${finalMeanX.toFixed(2)} Conf=${frame.after?.confidence.toFixed(2)} Var=${frame.after?.variance.toFixed(2)} Sep=${frame.trendSeparation?.toFixed(1)}`);
        }
    }

    // Verify anchor moved significantly due to variance inflation
    expect(finalMeanX).toBeGreaterThan(20);
});
