import { test, expect } from "bun:test";
import { fetchPositions, fetchDevices } from "../src/api/traccarClient";

test("fetchPositions includes token query parameter", async () => {
  let recordedUrl: string | null = null;
  let recordedInit: any = null;
  const fakeFetch = async (url: string, init?: any) => {
    recordedUrl = url;
    recordedInit = init;
    return { ok: true, json: async () => [] } as any;
  };

  await fetchPositions({ baseUrl: "http://example/api", auth: { type: "token", token: "abc123" }, fetchImpl: fakeFetch as any }, 42, new Date(1600000000000));

  expect(recordedUrl).toBeTruthy();
  const u = new URL(recordedUrl!);
  expect(u.pathname.endsWith("/positions")).toBe(true);
  expect(u.searchParams.get("deviceId")).toBe("42");
  expect(u.searchParams.get("token")).toBe("abc123");

  expect(recordedInit).toBeTruthy();
  expect(recordedInit.headers).toBeTruthy();
  expect(recordedInit.headers["Authorization"]).toBe("Bearer abc123");
});

test("fetchDevices includes token query parameter", async () => {
  let recordedUrl: string | null = null;
  const fakeFetch = async (url: string) => {
    recordedUrl = url;
    return { ok: true, json: async () => [] } as any;
  };

  await fetchDevices({ baseUrl: "http://example/api", auth: { type: "token", token: "t0k" }, fetchImpl: fakeFetch as any });

  expect(recordedUrl).toBeTruthy();
  const u = new URL(recordedUrl!);
  expect(u.pathname.endsWith("/devices")).toBe(true);
  expect(u.searchParams.get("token")).toBe("t0k");
});
