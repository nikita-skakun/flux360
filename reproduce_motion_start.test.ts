
import type { DevicePoint } from "@/ui/types";
import { test } from "bun:test";

const VERBOSE = process.env["VERBOSE"] === "1" || process.argv.includes("--verbose");

test("reproduce_motion_start", async () => {
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
    engine.setMotionProfile("person");
    const t0 = Date.now();

    // Stabilize anchor at origin with high-accuracy measurements
    if (VERBOSE) console.log("Phase 1: Stabilizing anchor at (0,0)");
    for (let i = 0; i < 20; i++) {
        engine.processMeasurements([makeMeasurement(0, 0, t0 + i * 1000, 5)]);
    }

    // Simulate person walking at 1.4 m/s with 10m GPS accuracy
    if (VERBOSE) console.log("\nPhase 2: walking away at 1.4m/s");

    let detectedAtStep = -1;
    for (let i = 1; i <= 10; i++) {
        const t = t0 + 20000 + i * 1000;
        const x = 1.4 * i;
        engine.processMeasurements([makeMeasurement(x, 0, t, 10)]);

        const frame = engine.getDebugFrames().pop();
        if (frame) {
            if (VERBOSE) console.log(`Step ${i} (x=${x.toFixed(2)}): Decision=${frame.decision} Dist=${frame.motionDistance?.toFixed(2)} Score=${frame.motionScore?.toFixed(2)}`);
            if (frame.decision === 'motion-start') {
                detectedAtStep = i;
                break;
            }
        }
    }

    if (detectedAtStep !== -1) {
        console.log(`Motion detected at step ${detectedAtStep}`);
    } else {
        console.log("Motion NOT detected in 10 steps");
    }
});
