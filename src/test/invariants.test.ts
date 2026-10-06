import { beforeEach, describe, expect, test } from "bun:test";
import { checkInvariants, stationaryFit } from "@/labels/invariants";
import { makeDevice, synthTrack } from "./synth";
import type { ChannelName } from "./synth";
import { ServerState, closedEngineEventsFor, resetDatabase } from "./harness";
import { asWebMercatorCoord } from "@/types";
import type { EngineEvent } from "@/types";

beforeEach(resetDatabase);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function drive(channel: ChannelName | "dense", seed = 1) {
  const startTime = Date.now() - 2 * DAY;
  return {
    startTime,
    positions: synthTrack({
      device: 1,
      startTime,
      driveSeconds: 1200,
      parkSeconds: 1800,
      cycles: 24,
      lon0: 10,
      lat0: 50,
      seed,
      ...(channel === "dense" ? { sampleMs: 10_000, accuracy: 6 } : { channel }),
    }),
  };
}

function stationary(overrides: Partial<Extract<EngineEvent, { type: "stationary" }>> = {}): Extract<EngineEvent, { type: "stationary" }> {
  return { type: "stationary", start: 0, end: 1000, mean: asWebMercatorCoord([1_000_000, 6_400_000]), variance: 4, isDraft: false, ...overrides };
}

describe("checkInvariants", () => {
  for (const channel of ["dense", "phone", "airtag", "google"] as const) {
    test(`engine output satisfies every invariant on the ${channel} channel`, () => {
      const { positions } = drive(channel);
      const st = new ServerState(7);
      st.handleDevices([makeDevice(1)]);
      st.handlePositions(positions);

      const events = closedEngineEventsFor(st, 1);
      expect(events.length).toBeGreaterThan(0);
      expect(checkInvariants(1, positions, events)).toEqual([]);
    });
  }

  test("a stationary event whose span contains a far fix scores badly", () => {
    const anchor = [1_000_000, 6_400_000] as const;
    const far = synthTrack({
      device: 1,
      startTime: 0,
      sampleMs: 10_000,
      driveSeconds: 600,
      parkSeconds: 0,
      cycles: 1,
      speedMps: 30,
      accuracy: 5,
      lon0: 10,
      lat0: 50,
    });

    const event = stationary({ start: far[0]!.timestamp, end: far[far.length - 1]!.timestamp, mean: asWebMercatorCoord([anchor[0], anchor[1]]), variance: 4 });
    const fit = stationaryFit(far, event);

    // Not a violation, because the mean describes the settling window and a dropout can
    // hide a trip. It is a quality number, and here it is far outside the accuracy.
    expect(checkInvariants(1, far, [event])).toEqual([]);
    expect(fit.fixes).toBe(far.length);
    expect(fit.maxFixDistanceMeters).toBeGreaterThan(1000);
  });

  test("a stationary event with no fixes inside it asserts nothing", () => {
    const { positions } = drive("airtag");
    const outside = stationary({ start: positions[0]!.timestamp - 10 * DAY, end: positions[0]!.timestamp - 9 * DAY });

    const violations = checkInvariants(1, positions, [outside]);
    expect(violations.map(v => v.rule)).toContain("stationary-without-fixes");
  });

  test("overlapping events are rejected", () => {
    const violations = checkInvariants(1, [], [
      stationary({ start: 0, end: 5000 }),
      stationary({ start: 4000, end: 9000 }),
    ]);
    expect(violations.map(v => v.rule)).toContain("events-overlap");
  });

  test("a motion event claiming less than the distance between its endpoints is rejected", () => {
    const violations = checkInvariants(1, [], [
      {
        type: "motion",
        start: 0,
        end: 1000,
        startAnchor: asWebMercatorCoord([0, 0]),
        endAnchor: asWebMercatorCoord([0, 0]),
        path: [
          { device: 1, geo: asWebMercatorCoord([1_000_000, 6_400_000]), accuracy: 5, timestamp: 0 },
          { device: 1, geo: asWebMercatorCoord([1_002_000, 6_400_000]), accuracy: 5, timestamp: 300 },
          { device: 1, geo: asWebMercatorCoord([1_008_000, 6_400_000]), accuracy: 5, timestamp: 700 },
          { device: 1, geo: asWebMercatorCoord([1_010_000, 6_400_000]), accuracy: 5, timestamp: 1000 },
        ],
        outliers: [],
        distance: 1,
        isDraft: false,
        bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      },
    ]);
    expect(violations.map(v => v.rule)).toContain("motion-distance-below-straight-line");
  });
});
