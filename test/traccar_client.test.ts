import { test, expect } from "bun:test";

test("normalizePosition extracts device", async () => {
  const { normalizePosition } = await import("../src/api/positions");

  const raw = {
    latitude: 49.0,
    longitude: -122.0,
    deviceId: 42,
    fixTime: "2025-12-01T00:00:00Z",
    accuracy: 10,
  };

  const norm = normalizePosition(raw);
  expect(norm).toBeTruthy();
  expect(norm!.device).toBe(42);
  expect(typeof norm!.timestamp).toBe("number");
});
