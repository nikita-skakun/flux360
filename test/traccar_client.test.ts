import { test, expect } from "bun:test";

test("normalizePosition extracts deviceId and source", async () => {
  const { normalizePosition } = await import("../src/api/traccarClient");

  const raw = {
    latitude: 49.0,
    longitude: -122.0,
    deviceId: 42,
    time: "2025-12-01T00:00:00Z",
    accuracy: 10,
  } as any;

  const norm = normalizePosition(raw);
  expect(norm).toBeTruthy();
  expect(norm!.deviceId).toBe(42);
  expect(norm!.source).toBe("42");
  expect(typeof norm!.timestamp).toBe("number");
});

test("extractPositionsFromMessage respects default accuracy", async () => {
  const { extractPositionsFromMessage } = await import("../src/api/traccarClient");
  const now = Date.now();
  const msg = { positions: [{ latitude: 1.0, longitude: 2.0, time: now }] };
  const res = extractPositionsFromMessage(msg, 123);
  expect(res.length).toBe(1);
  expect(res[0].accuracy).toBe(123);
});