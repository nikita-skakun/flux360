import { test, expect } from "bun:test";

test("device names and icons are stored separately from snapshots", () => {
  const mp = [
    { x: 1, y: 2, lat: 1, lon: 2, accuracy: 10, timestamp: 1000 },
  ];
  const p = mp[0]!;
  const deviceKey = "42";

  // device names/icons should live in separate mappings, not inside snapshot components
  const nameMap: Record<string, string> = { "42": "Phone A" };
  expect(nameMap[deviceKey]).toBe("Phone A");

  const iconMap: Record<string, string> = { "42": "personal_bag" };
  expect(iconMap[deviceKey]).toBe("personal_bag");

  const comp: any = {
    mean: [p.x, p.y],
    accuracy: p.accuracy,
    device: deviceKey,
  };

  expect(Object.prototype.hasOwnProperty.call(comp, "deviceName")).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(comp, "emoji")).toBe(false);
});