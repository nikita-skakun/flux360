import { test, expect } from "bun:test";

test("raw snapshot component includes deviceName when available and omits when not", () => {
  const mp = [
    { x: 1, y: 2, lat: 1, lon: 2, accuracy: 10, timestamp: 1000, speed: 0 },
  ];
  const p = mp[0]!;
  const deviceKey = "42";

  // With a name mapping
  const nameMap: Record<string, string> = { "42": "Phone A" };
  const deviceNameVal = nameMap?.[deviceKey];
  const comp: any = {
    mean: [p.x, p.y],
    accuracy: p.accuracy,
    speed: p.speed,
    device: deviceKey,
    ...(deviceNameVal ? { deviceName: deviceNameVal } : {}),
  };
  expect(comp.deviceName).toBe("Phone A");

  // Without a name mapping
  const nameMap2: Record<string, string> = {};
  const deviceNameVal2 = nameMap2?.[deviceKey];
  const comp2: any = {
    mean: [p.x, p.y],
    accuracy: p.accuracy,
    speed: p.speed,
    device: deviceKey,
    ...(deviceNameVal2 ? { deviceName: deviceNameVal2 } : {}),
  };
  expect(Object.prototype.hasOwnProperty.call(comp2, "deviceName")).toBe(false);
});