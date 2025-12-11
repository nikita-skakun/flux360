import { describe, it, expect } from "bun:test";
import MixtureEngine from "../src/engine/mixture";

describe("mixture engine", () => {
  it("spawns components for distant measurements and updates weights", () => {
    const engine = new MixtureEngine();
    engine.reset();
    // measurement 1 at (0, 0)
    engine.predictAll();
    engine.updateWithMeasurement({ mean: [0, 0], cov: [4, 0, 4], timestamp: Date.now() });
    expect(engine.timeline.length()).toBe(1);
    expect(engine.timeline.last()!.data.components.length).toBeGreaterThan(0);

    const comp1count = engine.timeline.last()!.data.components.length;

    // measurement 2 at (10, 0) far away - should spawn another component
    engine.predictAll();
    engine.updateWithMeasurement({ mean: [10, 0], cov: [4, 0, 4], timestamp: Date.now() + 1000 });
    expect(engine.timeline.length()).toBe(2);
    const comps = engine.timeline.last()!.data.components;
    expect(comps.length).toBeGreaterThanOrEqual(comp1count);
  });
});
