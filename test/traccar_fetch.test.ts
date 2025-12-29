import { test, expect } from "bun:test";
import { fetchPositions, fetchDevices } from "../src/api/traccarClient";

test("fetchPositions uses Authorization header and omits token query parameter", async () => {
  let recordedUrl: string | null = null;
  let recordedInit: RequestInit | null = null;
  const fakeFetch = async (url: string, init: RequestInit) => {
    recordedUrl = url;
    recordedInit = init;
    return { ok: true, json: async () => [] };
  };

  await fetchPositions({ baseUrl: "example", auth: { type: "token", token: "abc123" }, fetchImpl: fakeFetch as typeof fetch }, 42, new Date(1600000000000));

  expect(recordedUrl).toBeTruthy();
  const u = new URL(recordedUrl!);
  expect(u.pathname.endsWith("/positions")).toBe(true);
  expect(u.searchParams.get("deviceId")).toBe("42");
  expect(u.searchParams.get("token")).toBe(null);

  expect(recordedInit).toBeTruthy();
  expect(recordedInit!.headers).toBeTruthy();
  const h = new Headers(recordedInit!.headers as HeadersInit);
  expect(h.get("Authorization")).toBe("Bearer abc123");
});

test("fetchDevices uses Authorization header and omits token query parameter", async () => {
  let recordedUrl: string | null = null;
  let recordedInit: RequestInit | null = null;
  const fakeFetch = async (url: string, init: RequestInit) => {
    recordedUrl = url;
    recordedInit = init;
    return { ok: true, json: async () => [] };
  };

  await fetchDevices({ baseUrl: "example", auth: { type: "token", token: "t0k" }, fetchImpl: fakeFetch as typeof fetch });

  expect(recordedUrl).toBeTruthy();
  const u = new URL(recordedUrl!);
  expect(u.pathname.endsWith("/devices")).toBe(true);
  expect(u.searchParams.get("token")).toBe(null);

  expect(recordedInit).toBeTruthy();
  expect(recordedInit!.headers).toBeTruthy();
  const h = new Headers(recordedInit!.headers as HeadersInit);
  expect(h.get("Authorization")).toBe("Bearer t0k");
});
