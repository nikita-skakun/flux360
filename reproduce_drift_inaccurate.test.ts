
import type { DevicePoint } from "@/ui/types";
import { test, expect } from "bun:test";

const VERBOSE = process.env["VERBOSE"] === "1" || process.argv.includes("--verbose");

test("reproduce_drift_inaccurate", async () => {
    const { Engine } = await import("./src/engine/engine");

    const makeMeasurement = (x: number, y: number, t: number, accuracy: number) => {
        return {
            mean: [x, y],
            variance: accuracy * accuracy,
            timestamp: t,
            accuracy,
            lat: 0,
            lon: 0,
        } as DevicePoint;
    };

    const engine = new Engine();
    engine.setMotionProfile("car");
    const t0 = Date.now();

    // Stabilize anchor at origin
    for (let i = 0; i < 20; i++) {
        engine.processMeasurements([makeMeasurement(0, 0, t0 + i * 1000, 10)]);
    }

    // Feed highly inaccurate report (204m accuracy) to verify minimal impact
    if (VERBOSE) console.log("\nPhase 2: Inaccurate reports at 400m, Acc=204m");

    const t = t0 + 20000;
    engine.processMeasurements([makeMeasurement(400, 0, t, 204)]);

    const frame = engine.getDebugFrames().pop();
    if (frame) {
        if (VERBOSE) {
            console.log(`Decision=${frame.decision}`);
            console.log(`Conf=${frame.before?.confidence.toFixed(2)} -> ${frame.after?.confidence.toFixed(2)}`);
            console.log(`Sep=${frame.trendSeparation?.toFixed(1)}`);
        }
        // Inaccurate reports should have minimal impact on confidence due to variance² penalty
        expect(frame.after?.confidence).toBeGreaterThan(0.85);
    }
});
