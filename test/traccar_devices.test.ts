import { test, expect } from "bun:test";
import { fetchDevices } from "../src/api/devices";

test("fetchDevices parses array response", async () => {
  const sample = [
    { id: 5, name: "Device A" },
    { id: 12, uniqueId: "unique-12" },
    { id: 3 },
  ];
  const fakeFetch = async (_: string) => ({ ok: true, json: async () => sample });
  const devices = await fetchDevices({ baseUrl: "example", secure: false, auth: { type: "none" }, fetchImpl: fakeFetch as typeof fetch });
  expect(devices.length).toBe(3);
  const names = devices.map((d) => d.name ?? "");
  expect(names[0]).toBe("Device A");
  expect(names[1]).toBe("unique-12");
  expect(names[2]).toBe("3");
});

test("fetchDevices parses object.data response", async () => {
  const sample = { data: [{ id: 7, name: "X" }, { id: 8, uniqueId: "Y" }] };
  const fakeFetch = async (_: string) => ({ ok: true, json: async () => sample });
  const devices = await fetchDevices({ baseUrl: "example", secure: false, auth: { type: "none" }, fetchImpl: fakeFetch as typeof fetch });
  expect(devices.length).toBe(2);
  expect(devices[0]!.id).toBe(7);
  expect(devices[0]!.name).toBe("X");
  expect(devices[1]!.id).toBe(8);
  expect(devices[1]!.name).toBe("Y");
});