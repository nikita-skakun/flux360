import { describe, expect, test } from "bun:test";
import {
  RECONNECT_BASE_MS, RECONNECT_MAX_MS, UNAUTHENTICATED_RETRY_MS, isSessionRejection, reconnectDelayMs,
} from "@/hooks/reconnect";

describe("reconnect policy", () => {
  test("a logged-out client retries at a steady interval", () => {
    expect(reconnectDelayMs(0, false)).toBe(UNAUTHENTICATED_RETRY_MS);
    expect(reconnectDelayMs(7, false)).toBe(UNAUTHENTICATED_RETRY_MS);
  });

  test("a logged-in client backs off from the base delay", () => {
    expect(reconnectDelayMs(0, true)).toBe(RECONNECT_BASE_MS);
    expect(reconnectDelayMs(1, true)).toBe(RECONNECT_BASE_MS * 2);
    expect(reconnectDelayMs(2, true)).toBe(RECONNECT_BASE_MS * 4);
  });

  test("the backoff is capped so a long outage does not wait forever", () => {
    expect(reconnectDelayMs(5, true)).toBe(RECONNECT_MAX_MS);
    expect(reconnectDelayMs(50, true)).toBe(RECONNECT_MAX_MS);
  });

  test("a negative attempt is treated as the first attempt", () => {
    expect(reconnectDelayMs(-3, true)).toBe(RECONNECT_BASE_MS);
  });

  test("only an explicit policy-violation close ends the session", () => {
    expect(isSessionRejection(1008)).toBe(true);

    // A restart, a dropped connection, a refused upgrade and a server-side error all
    // look like this and must leave the session alone.
    expect(isSessionRejection(1000)).toBe(false);
    expect(isSessionRejection(1006)).toBe(false);
    expect(isSessionRejection(1011)).toBe(false);
    expect(isSessionRejection(1013)).toBe(false);
  });

  test("a restart is survivable: retries continue without ever logging out", () => {
    // The old behaviour gave up after two attempts at 500ms and logged out, which a
    // container restart never fits inside.
    const delays = Array.from({ length: 12 }, (_, attempt) => reconnectDelayMs(attempt, true));
    expect(delays.every(delay => delay > 0)).toBe(true);
    expect(delays.reduce((total, delay) => total + delay, 0)).toBeGreaterThan(30_000);
  });
});
