import { beforeEach, describe, expect, test } from "bun:test";
import { makeDevice } from "./synth";
import { DAY, ServerState, resetDatabase } from "./harness";
import type { TraccarDevice } from "@/types";

beforeEach(resetDatabase);

function staleDevice(id: number, ageMs: number): TraccarDevice {
  return { ...makeDevice(id), lastUpdate: new Date(Date.now() - ageMs).toISOString() };
}

describe("device visibility", () => {
  test("a device offline for far longer than the retained history is still listed", () => {
    const state = new ServerState(2);
    state.handleDevices([staleDevice(1, 79 * DAY)]);

    expect(state.materializeAppDevices()[1]).toBeDefined();
  });

  test("its last seen is the time Traccar reported, not nothing", () => {
    const state = new ServerState(2);
    const reported = Date.now() - 79 * DAY;
    state.handleDevices([{ ...makeDevice(1), lastUpdate: new Date(reported).toISOString() }]);

    const lastSeen = state.materializeAppDevices()[1]?.lastSeen;
    expect(lastSeen).not.toBeNull();
    expect(Math.abs((lastSeen ?? 0) - reported)).toBeLessThan(1000);
  });

  test("a device that has never reported is still listed, with no last seen time", () => {
    const state = new ServerState(2);
    state.handleDevices([{ ...makeDevice(1), lastUpdate: null }]);

    const device = state.materializeAppDevices()[1];
    expect(device).toBeDefined();
    expect(device?.lastSeen).toBeNull();
  });

  test("a group reports the newest time among its members", () => {
    const state = new ServerState(2);
    const older = Date.now() - 79 * DAY;
    const newer = Date.now() - 40 * DAY;
    state.handleDevices([
      { ...makeDevice(1), lastUpdate: new Date(older).toISOString() },
      { ...makeDevice(2), lastUpdate: new Date(newer).toISOString() },
    ]);

    const group = state.createGroup("pair", "group", [1, 2], "me");
    expect(group).not.toBeNull();
    expect(Math.abs((group?.lastSeen ?? 0) - newer)).toBeLessThan(1000);
  });

  test("a group whose members have never reported has no last seen time", () => {
    const state = new ServerState(2);
    state.handleDevices([{ ...makeDevice(1), lastUpdate: null }, { ...makeDevice(2), lastUpdate: null }]);

    expect(state.createGroup("pair", "group", [1, 2], "me")?.lastSeen).toBeNull();
  });
});
