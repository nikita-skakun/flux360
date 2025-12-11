import { describe, it, expect } from "bun:test";
import { normalizePosition, fetchPositions } from "../src/api/traccarClient";

describe("normalizePosition", () => {
  it("normalizes a basic traccar position object", () => {
    const raw = {
      latitude: 52.52,
      longitude: 13.405,
      accuracy: 5,
      deviceTime: "2024-01-01T00:00:00Z",
      protocol: "mock",
    };
    const n = normalizePosition(raw, 100);
    expect(n).not.toBeNull();
    expect(n!.lat).toBeCloseTo(52.52);
    expect(n!.lon).toBeCloseTo(13.405);
    expect(n!.accuracy).toBe(5);
    expect(n!.timestamp).toBe(new Date("2024-01-01T00:00:00Z").getTime());
    expect(n!.source).toBe("mock");
  });

  it("handles missing accuracy and time gracefully", () => {
    const raw = {
      latitude: 0,
      longitude: 0,
    };
    const before = Date.now();
    const n = normalizePosition(raw, 99);
    const after = Date.now();
    expect(n).not.toBeNull();
    expect(n!.accuracy).toBe(99);
    expect(n!.timestamp).toBeGreaterThanOrEqual(before);
    expect(n!.timestamp).toBeLessThanOrEqual(after);
  });
});

describe("fetchPositions", () => {
  it("constructs a valid URL and parses positions", async () => {
    let lastUrl = "";
    let lastHeaders: any = {};
    const fakeFetch = async (url: string, opts: any) => {
      lastUrl = url;
      lastHeaders = opts?.headers ?? {};
      const res = {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [
          { latitude: 1, longitude: 2, accuracy: 10, time: 1700000000000, protocol: "t1" },
        ],
      };
      return res;
    };

    const baseUrl = "https://traccar.example.com/api";
    const deviceId = 123;
    const from = new Date("2024-01-01T00:00:00Z");
    const to = new Date("2024-01-02T00:00:00Z");

    const positions = await fetchPositions(
      { baseUrl, auth: { type: "basic", username: "u", password: "p" }, fetchImpl: (fakeFetch as any) },
      deviceId,
      from,
      to
    );

    expect(positions.length).toBe(1);
    expect(positions[0]!.lat).toBe(1);
    expect(positions[0]!.lon).toBe(2);

    // URL contains query params
    expect(lastUrl).toContain("deviceId=123");
    expect(lastUrl).toContain("from=2024-01-01T00%3A00%3A00.000Z");
    expect(lastUrl).toContain("to=2024-01-02T00%3A00%3A00.000Z");

    // Authorization header is set
    expect(lastHeaders.Authorization).toBeDefined();
  });
});
