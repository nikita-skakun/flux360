import { describe, it, expect } from "bun:test";
import { degreesToMeters, metersToDegrees } from "../src/util/geo";

describe("geo utilities", () => {
  it("converts small lat/lon deltas into meters around equator", () => {
    const refLat = 0;
    const refLon = 0;
    const res = degreesToMeters(0.001, 0.001, refLat, refLon);
    // At equator: 1 degree ~ 111319.49 meters, so 0.001 deg ~ 111.32m
    expect(res.x).toBeGreaterThan(111);
    expect(res.x).toBeLessThan(112);
    expect(res.y).toBeGreaterThan(111);
    expect(res.y).toBeLessThan(112);
  });

  it("reversible conversions", () => {
    const refLat = 49.0456281;
    const refLon = -122.7586908;
    const { x, y } = degreesToMeters(49.0508555, -122.781283, refLat, refLon);
    const { lat, lon } = metersToDegrees(x, y, refLat, refLon);
    expect(lat).toBeCloseTo(49.0508555, 5);
    expect(lon).toBeCloseTo(-122.781283, 5);
  });
});
