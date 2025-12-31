import { test, expect } from "bun:test";
import { extractPositionsFromMessage } from "../src/api/traccarClient";

test("extract single position object", () => {
  const raw = { latitude: 49.1, longitude: -122.2, fixTime: "2025-12-01T00:00:00Z", accuracy: 12, deviceId: 1 };
  const out = extractPositionsFromMessage(raw);
  expect(out.length).toBe(1);
  const first = out[0]!;
  expect(first.lat).toBeCloseTo(49.1);
  expect(first.lon).toBeCloseTo(-122.2);
  expect(first.accuracy).toBe(12);
  expect(typeof first.timestamp).toBe("number");
});

test("extract positions from common wrappers", () => {
  const raw = {
    data: {
      positions: [
        { latitude: 1, longitude: 2, fixTime: "2020-09-13T12:26:40.000Z", deviceId: 2 },
        { latitude: 3, longitude: 4, fixTime: "2020-09-13T12:27:40.000Z", deviceId: 3 },
      ],
    },
  };
  const out = extractPositionsFromMessage(raw);
  expect(out.length).toBe(2);
  const first = out[0]!;
  const second = out[1]!;
  expect(first.lat).toBe(1);
  expect(first.lon).toBe(2);
  expect(second.lat).toBe(3);
  expect(second.lon).toBe(4);
});

test("ignore non-position objects", () => {
  const raw = { foo: { bar: "baz" }, items: [{ a: 1 }, { b: 2 }] };
  const out = extractPositionsFromMessage(raw);
  expect(out.length).toBe(0);
});
