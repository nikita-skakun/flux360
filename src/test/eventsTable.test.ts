import { beforeEach, describe, expect, test } from "bun:test";
import { EngineEventSchema } from "@/types";
import { makeDevice, synthTrack } from "./synth";
import {
  ServerState, closedEventsFor, countRows,
  countRowsFor, db, resetDatabase,
} from "./harness";

beforeEach(resetDatabase);

function sixHourDrive(device = 1, lon0 = 10, lat0 = 50) {
  const now = Date.now();
  return synthTrack({
    device,
    startTime: now - 6 * 3_600_000,
    sampleMs: 10_000,
    driveSeconds: 1200,
    parkSeconds: 1800,
    speedMps: 13.9,
    accuracy: 6,
    jitter: 0.000004,
    lon0,
    lat0,
    cycles: 8,
  });
}

describe("events table", () => {
  test("closed events are persisted as rows", () => {
    const st = new ServerState(7);
    st.handleDevices([makeDevice(1)]);
    st.handlePositions(sixHourDrive());

    const inMemory = closedEventsFor(st, 1);
    expect(inMemory.length).toBeGreaterThan(0);
    expect(countRows("events")).toBe(inMemory.length);
  });

  test("event rows survive a restart and rehydrate into the timeline", () => {
    const track = sixHourDrive();

    const first = new ServerState(7);
    first.handleDevices([makeDevice(1)]);
    first.handlePositions(track);
    const before = closedEventsFor(first, 1).length;
    expect(before).toBeGreaterThan(0);

    const second = new ServerState(7);
    second.handleDevices([makeDevice(1)]);
    expect(closedEventsFor(second, 1).length).toBe(before);
  });

  test("range query returns only events overlapping the window", () => {
    const st = new ServerState(7);
    st.handleDevices([makeDevice(1)]);
    st.handlePositions(sixHourDrive());

    const nonDraft = closedEventsFor(st, 1);
    expect(nonDraft.length).toBeGreaterThan(2);

    const pivot = nonDraft[Math.floor(nonDraft.length / 2)];
    if (!pivot) throw new Error("no pivot event");

    const rows = db.query(
      `SELECT eventJson FROM events WHERE entityId = 1 AND start <= ? AND end >= ? ORDER BY start ASC`
    ).all(pivot.end, pivot.start) as { eventJson: string }[];

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const ev = JSON.parse(row.eventJson) as { start: number; end: number };
      expect(ev.start).toBeLessThanOrEqual(pivot.end);
      expect(ev.end).toBeGreaterThanOrEqual(pivot.start);
    }
  });

  test("every stored row round-trips through the wire schema", () => {
    const st = new ServerState(7);
    st.handleDevices([makeDevice(1)]);
    st.handlePositions(sixHourDrive());

    const rows = db.query(`SELECT eventJson FROM events`).all() as { eventJson: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const parsed = EngineEventSchema.safeParse(JSON.parse(row.eventJson));
      expect(parsed.success).toBe(true);
    }
  });

  test("group rebuild keeps rows consistent with the engine", () => {
    const st = new ServerState(7);
    st.handleDevices([makeDevice(1), makeDevice(2)]);

    const group = st.createGroup("pair", "group", [1, 2], "me");
    if (!group) throw new Error("group not created");

    st.handlePositions([...sixHourDrive(1, 10, 50), ...sixHourDrive(2, 10.00005, 50.00005)]);

    expect(countRowsFor("events", "entityId", group.id)).toBe(closedEventsFor(st, group.id).length);
  });

  test("deleting a group removes its rows", () => {
    const st = new ServerState(7);
    st.handleDevices([makeDevice(1), makeDevice(2)]);

    const group = st.createGroup("pair", "group", [1, 2], "me");
    if (!group) throw new Error("group not created");

    st.handlePositions([...sixHourDrive(1, 10, 50), ...sixHourDrive(2, 10.00005, 50.00005)]);
    expect(closedEventsFor(st, group.id).length).toBeGreaterThan(0);

    st.deleteGroup(group.id);
    expect(countRowsFor("events", "entityId", group.id)).toBe(0);
  });

  test("repeated batches do not duplicate rows", () => {
    const st = new ServerState(7);
    st.handleDevices([makeDevice(1)]);
    st.handlePositions(sixHourDrive());
    const afterFirst = countRows("events");

    for (let i = 0; i < 5; i++) st.handlePositions([]);
    expect(countRows("events")).toBe(afterFirst);
  });
});
