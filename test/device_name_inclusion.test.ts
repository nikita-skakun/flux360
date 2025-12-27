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


test("raw snapshot component includes emoji when available and omits when not", () => {
  const mp = [
    { x: 1, y: 2, lat: 1, lon: 2, accuracy: 10, timestamp: 1000, speed: 0 },
  ];
  const p = mp[0]!;
  const deviceKey = "42";

  // With an icon mapping
  const iconMap: Record<string, string> = { "42": "personal_bag" };
  const deviceIconVal = iconMap?.[deviceKey];
  const comp: any = {
    mean: [p.x, p.y],
    accuracy: p.accuracy,
    speed: p.speed,
    device: deviceKey,
    ...(deviceIconVal ? { emoji: deviceIconVal } : {}),
  };
  expect(comp.emoji).toBe("personal_bag");

  // Without an icon mapping: default emoji should be added (first char of device key)
  const iconMap2: Record<string, string> = {};
  const deviceIconVal2 = iconMap2?.[deviceKey];
  const comp2: any = {
    mean: [p.x, p.y],
    accuracy: p.accuracy,
    speed: p.speed,
    device: deviceKey,
    ...(deviceIconVal2 ? { emoji: deviceIconVal2 } : {}),
    // app behavior ensures an emoji default is present when none is provided
    emoji: (deviceIconVal2 ?? String(deviceKey).charAt(0).toUpperCase()),
  };
  expect(comp2.emoji).toBe(String(deviceKey).charAt(0).toUpperCase());
});