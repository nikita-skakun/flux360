import { beforeEach, describe, expect, test } from "bun:test";
import { makeDevice, synthTrack } from "./synth";
import {
  ServerState, checkpointCount, closedEventsFor,
  countRowsFor, pendingHistoryRequests, resetDatabase, seedCheckpoint,
} from "./harness";

beforeEach(resetDatabase);

function pairHistory() {
  const now = Date.now();
  const opts = {
    startTime: now - 5 * 3_600_000,
    sampleMs: 10_000,
    driveSeconds: 900,
    parkSeconds: 1500,
    speedMps: 13.9,
    accuracy: 6,
    jitter: 0.000004,
    cycles: 6,
  };
  // Two trackers at effectively the same place on the same route, which is the
  // realistic fusion case. Devices that diverge produce a merged stream of
  // alternating far-apart fixes, which the engine correctly reads as noise and
  // never turns into motion.
  return [
    ...synthTrack({ ...opts, device: 1, lon0: 10, lat0: 50 }),
    ...synthTrack({ ...opts, device: 2, lon0: 10.00005, lat0: 50.00005 }),
  ];
}

describe("group checkpoints", () => {
  test("a restart with unchanged membership keeps the group's derived events", () => {
    const history = pairHistory();

    const first = new ServerState(7);
    first.handleDevices([makeDevice(1), makeDevice(2)]);
    const group = first.createGroup("pair", "group", [1, 2], "me");
    if (!group) throw new Error("group not created");
    first.handlePositions(history);

    const before = closedEventsFor(first, group.id).length;
    expect(before).toBeGreaterThan(0);

    // The checkpoint has to be in the database, not just memory, for the restart to
    // find it and reuse the group's events instead of re-deriving them from Traccar.
    seedCheckpoint(first, group.id);
    expect(checkpointCount(first, group.id)).toBe(1);

    const second = new ServerState(7);
    second.handleDevices([makeDevice(1), makeDevice(2)]);

    expect(closedEventsFor(second, group.id).length).toBe(before);
  });

  test("membership change still forces a rebuild", () => {
    const st = new ServerState(7);
    st.handleDevices([makeDevice(1), makeDevice(2), makeDevice(3)]);
    const group = st.createGroup("pair", "group", [1, 2], "me");
    if (!group) throw new Error("group not created");

    st.handlePositions(pairHistory());
    expect(closedEventsFor(st, group.id).length).toBeGreaterThan(0);

    st.addDeviceToGroup(group.id, 3);
    const members = st.groups.find(g => g.id === group.id)?.memberDeviceIds ?? [];
    expect(members).toContain(3);

    // A rebuild now means dropping the derived events and re-fetching member history,
    // so the rows must be gone and the request must be queued.
    expect(closedEventsFor(st, group.id).length).toBe(0);
    expect(countRowsFor("events", "entityId", group.id)).toBe(0);
    const requested = pendingHistoryRequests(st);
    expect(requested.map(r => r.deviceId).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  test("a renamed group keeps its events", () => {
    const st = new ServerState(7);
    st.handleDevices([makeDevice(1), makeDevice(2)]);
    const group = st.createGroup("pair", "group", [1, 2], "me");
    if (!group) throw new Error("group not created");

    st.handlePositions(pairHistory());
    const before = closedEventsFor(st, group.id).length;

    st.updateGroupMetadata(group.id, { name: "renamed", icon: "group", color: "#ff0000", motionProfile: null });

    expect(closedEventsFor(st, group.id).length).toBe(before);
    expect(st.groups.find(g => g.id === group.id)?.name).toBe("renamed");
  });

  test("group rows and engine stay consistent after a rename", () => {
    const st = new ServerState(7);
    st.handleDevices([makeDevice(1), makeDevice(2)]);
    const group = st.createGroup("pair", "group", [1, 2], "me");
    if (!group) throw new Error("group not created");

    st.handlePositions(pairHistory());
    st.updateGroupMetadata(group.id, { name: "renamed", icon: "group", color: null, motionProfile: "car" });

    const expected = closedEventsFor(st, group.id).length;
    expect(countRowsFor("events", "entityId", group.id)).toBe(expected);
  });
});
