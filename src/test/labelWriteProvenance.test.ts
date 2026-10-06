import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppDevice } from "@/types";

const sent: { type: string; payload: unknown }[] = [];

// The store persists through window.localStorage, which the test runtime does not provide.
const memory = new Map<string, string>();
const memoryStorage: Storage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
  key: (index: number) => [...memory.keys()][index] ?? null,
  get length() {
    return memory.size;
  },
};
Object.defineProperty(globalThis, "window", { value: { localStorage: memoryStorage }, configurable: true });

mock.module("@/wsRPC", () => ({
  closeWebSocket: () => {},
  sendRPC: async (type: string, payload: unknown) => {
    sent.push({ type, payload });
    return { payload: { labels: [] } };
  },
}));

const { useStore } = await import("@/store");

const GROUP_ID = -4;
const DEVICE_ID = 11;

function group(memberDeviceIds: number[]): AppDevice {
  return {
    id: GROUP_ID, name: "Pair", icon: "group", color: null, lastSeen: null,
    effectiveMotionProfile: "person", motionProfile: null, isOwner: true, memberDeviceIds,
  };
}

function device(id: number): AppDevice {
  return {
    id, name: `Device ${id}`, icon: "device", color: null, lastSeen: null,
    effectiveMotionProfile: "person", motionProfile: null, isOwner: true, memberDeviceIds: null,
  };
}

function labelOnWire(): { memberDeviceIds?: number[] } {
  return (sent[0]?.payload as { label: { memberDeviceIds?: number[] } }).label;
}

describe("group label provenance", () => {
  beforeEach(() => {
    sent.length = 0;
    useStore.setState({
      entities: { [GROUP_ID]: group([DEVICE_ID, 12]), [DEVICE_ID]: device(DEVICE_ID) },
      labelsByEntity: {},
      labelError: null,
      labelHistory: [],
    });
  });

  test("an outlier marked on a group records the devices it was made against", async () => {
    await useStore.getState().writeLabel({
      id: "o1", deviceId: GROUP_ID, kind: "outlier", start: 1000, end: 1000, createdAt: 1,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe("set_label");
    expect(labelOnWire().memberDeviceIds).toEqual([DEVICE_ID, 12]);
    expect(useStore.getState().labelError).toBeNull();
  });

  test("a label keeps the membership it was originally recorded with", async () => {
    await useStore.getState().writeLabel({
      id: "o2", deviceId: GROUP_ID, kind: "outlier", start: 2000, end: 2000, createdAt: 2, memberDeviceIds: [99],
    });
    expect(labelOnWire().memberDeviceIds).toEqual([99]);
  });

  test("a label on a plain device is left alone", async () => {
    await useStore.getState().writeLabel({
      id: "p1", deviceId: DEVICE_ID, kind: "stationary", start: 0, end: 1000, createdAt: 3,
    });
    expect(labelOnWire().memberDeviceIds).toBeUndefined();
  });

  test("a group whose members are unknown is still refused, rather than silently accepted", async () => {
    useStore.setState({ entities: { [GROUP_ID]: group([]) } });
    await useStore.getState().writeLabel({
      id: "o3", deviceId: GROUP_ID, kind: "outlier", start: 3000, end: 3000, createdAt: 4,
    });
    expect(sent).toHaveLength(0);
    expect(useStore.getState().labelError).toBe("a group label must record the devices it was made against");
  });

  test("an overlapping span never reaches the wire", async () => {
    useStore.setState({
      labelsByEntity: { [DEVICE_ID]: [{ id: "s1", deviceId: DEVICE_ID, kind: "stationary", start: 0, end: 5000, createdAt: 0 }] },
    });
    await useStore.getState().writeLabel({ id: "s2", deviceId: DEVICE_ID, kind: "car", start: 1000, end: 2000, createdAt: 5 });
    expect(sent).toHaveLength(0);
    expect(useStore.getState().labelError).toBe("overlaps an existing stationary label");
  });
});
