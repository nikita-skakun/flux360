import { beforeEach, describe, expect, test } from "bun:test";
import { makeDevice, synthTrack } from "./synth";
import { ServerState, checkpointCount, db, resetDatabase } from "./harness";
import type { RawGpsPosition } from "@/types";

beforeEach(resetDatabase);

function track(): RawGpsPosition[] {
  return synthTrack({
    device: 1,
    startTime: Date.now() - 3 * 3_600_000,
    sampleMs: 10_000,
    driveSeconds: 1200,
    parkSeconds: 1800,
    speedMps: 13.9,
    accuracy: 6,
    parkJitterMeters: 0.5,
    lon0: 10,
    lat0: 50,
    cycles: 3,
  });
}

function checkpointRows(deviceId: number): number {
  const row = db.query(`SELECT COUNT(*) AS count FROM engine_checkpoints WHERE deviceId = ?`).get(deviceId) as { count: number } | null;
  return row?.count ?? 0;
}

describe("checkpoint flush", () => {
  test("a shutdown flushes state the interval gate would have deferred", () => {
    const st = new ServerState(7);
    st.handleDevices([makeDevice(1)]);

    const all = track();
    const half = Math.floor(all.length / 2);
    st.handlePositions(all.slice(0, half));
    expect(checkpointCount(st, 1)).toBe(1);

    const firstCheckpoint = st.engineCheckpoints[1]?.[0]?.timestamp ?? 0;
    // Six more fixes at a ten second cadence, so the engine advances by a minute,
    // which is inside the five minute checkpoint interval.
    st.handlePositions(all.slice(half, half + 6));
    const advanced = st.engines[1]?.lastTimestamp ?? 0;
    expect(advanced).toBeGreaterThan(firstCheckpoint);
    expect(advanced - firstCheckpoint).toBeLessThan(5 * 60 * 1000);

    expect(checkpointCount(st, 1)).toBe(1);
    expect(checkpointRows(1)).toBe(1);

    st.flush();

    expect(checkpointCount(st, 1)).toBe(2);
    expect(checkpointRows(1)).toBe(2);
    const newest = st.engineCheckpoints[1]?.at(-1);
    expect(newest?.timestamp).toBe(st.engines[1]?.lastTimestamp ?? 0);
  });

  test("flushing twice without new input does not pile up duplicate checkpoints", () => {
    const st = new ServerState(7);
    st.handleDevices([makeDevice(1)]);
    st.handlePositions(track());

    st.flush();
    const after = checkpointCount(st, 1);
    st.flush();
    expect(checkpointCount(st, 1)).toBe(after);
  });

  test("an engine that never saw a fix is not checkpointed", () => {
    const st = new ServerState(7);
    st.handleDevices([makeDevice(1), makeDevice(2)]);
    st.handlePositions(track());

    st.flush();
    expect(checkpointCount(st, 2)).toBe(0);
  });

  test("the flushed checkpoint is complete enough to restore the timeline", () => {
    const st = new ServerState(7);
    st.handleDevices([makeDevice(1)]);
    const all = track();
    const half = Math.floor(all.length / 2);

    st.handlePositions(all.slice(0, half));
    const early = (st.engines[1]?.closed ?? []).length;
    st.handlePositions(all.slice(half));
    st.flush();

    const restored = new ServerState(7);
    restored.handleDevices([makeDevice(1)]);
    // Restoring replays from the newest checkpoint, so the closed set has to match.
    expect((restored.engines[1]?.closed ?? []).length).toBeGreaterThanOrEqual(early);
    expect((restored.engines[1]?.closed ?? []).length).toBe((st.engines[1]?.closed ?? []).length);
  });
});
