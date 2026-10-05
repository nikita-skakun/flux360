import { beforeEach, describe, expect, test } from "bun:test";
import { makeDevice, synthTrack } from "./synth";
import { ServerState, pendingHistoryRequests, resetDatabase } from "./harness";
import type { RawGpsPosition } from "@/types";

beforeEach(resetDatabase);

function dedupeKey(p: RawGpsPosition): string {
  return `${p.device}:${p.timestamp}:${p.geo[1]}:${p.geo[0]}`;
}

function summarize(st: { engines: Record<number, { closed: { type: string; start: number; end: number }[] }> }): string[] {
  return (st.engines[1]?.closed ?? []).map(ev => `${ev.type}:${ev.start}:${ev.end}`).sort();
}

function drive() {
  const now = Date.now();
  return synthTrack({
    device: 1,
    startTime: now - 3 * 3_600_000,
    sampleMs: 10_000,
    driveSeconds: 1200,
    parkSeconds: 1800,
    speedMps: 13.9,
    accuracy: 6,
    jitter: 0.000004,
    lon0: 10,
    lat0: 50,
    cycles: 3,
  });
}

describe("position ingest", () => {
  test("a batch deferred for history is not marked as processed", () => {
    const st = new ServerState(7);
    st.handleDevices([makeDevice(1)]);

    const track = drive();
    const missing = track[400]!;
    st.handlePositions(track.filter((_, index) => index !== 400));
    expect(st.engines[1]?.lastTimestamp).toBeGreaterThan(0);

    // With no checkpoint to rewind to, the late fix cannot be absorbed incrementally,
    // so the entity is dropped and its history is requested instead.
    st.engineCheckpoints[1] = [];
    pendingHistoryRequests(st);
    st.handlePositions([missing]);

    expect(pendingHistoryRequests(st).map(r => r.deviceId)).toEqual([1]);
    // The engine was dropped, so the late fix has to stay replayable. Marking it here
    // would spend its key and the fetched range would then filter it back out.
    expect(st.consumedKeys.has(dedupeKey(missing))).toBe(false);
  });

  test("a rewind reproduces the in-order event set exactly", () => {
    const track = drive();
    const missingIndex = 800;

    const inOrder = new ServerState(7);
    inOrder.handleDevices([makeDevice(1)]);
    inOrder.handlePositions(track);
    const expected = summarize(inOrder);
    expect(expected.length).toBeGreaterThan(0);

    resetDatabase();

    const rewound = new ServerState(7);
    rewound.handleDevices([makeDevice(1)]);
    const chunkSize = 180;
    for (let start = 0; start < track.length; start += chunkSize) {
      const slice = track.slice(start, start + chunkSize).filter((_, offset) => start + offset !== missingIndex);
      if (slice.length > 0) rewound.handlePositions(slice);
    }
    rewound.handlePositions([track[missingIndex]!]);

    // A checkpoint rewind must land on the same timeline as feeding the same fixes in
    // order. Filtering a restored checkpoint by its timestamp instead of the closed
    // boundary double counted the in-flight motion's predecessor.
    expect(summarize(rewound)).toEqual(expected);
  });

  test("a rewound batch replays from the checkpoint without double feeding", () => {
    const st = new ServerState(7);
    st.handleDevices([makeDevice(1)]);

    const track = drive();
    const missingIndex = 800;
    const missing = track[missingIndex]!;

    // Feed in chunks so a checkpoint lands at each chunk boundary. A single batch would
    // only leave one checkpoint at the watermark, which is after the late fix.
    const chunkSize = 180;
    for (let start = 0; start < track.length; start += chunkSize) {
      const slice = track.slice(start, start + chunkSize).filter((_, offset) => start + offset !== missingIndex);
      if (slice.length > 0) st.handlePositions(slice);
    }
    expect(st.engineCheckpoints[1]!.length).toBeGreaterThan(1);

    st.handlePositions([missing]);

    // No history should be requested when a resident checkpoint can serve the rewind.
    expect(pendingHistoryRequests(st)).toEqual([]);
    expect(st.engines[1]?.lastTimestamp).toBeGreaterThanOrEqual(missing.timestamp);
  });
});
