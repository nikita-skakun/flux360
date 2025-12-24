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