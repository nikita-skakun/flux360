export type Color = [number, number, number];

function simpleHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return Math.abs(hash);
}

function hslToRgb(h: number, s: number, l: number): Color {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h >= 0 && h < 60) {
    [r, g, b] = [c, x, 0];
  } else if (h >= 60 && h < 120) {
    [r, g, b] = [x, c, 0];
  } else if (h >= 120 && h < 180) {
    [r, g, b] = [0, c, x];
  } else if (h >= 180 && h < 240) {
    [r, g, b] = [0, x, c];
  } else if (h >= 240 && h < 300) {
    [r, g, b] = [x, 0, c];
  } else if (h >= 300 && h <= 360) {
    [r, g, b] = [c, 0, x];
  }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

const cache = new Map<number, Color>();

export function colorForDevice(deviceId: number): Color {
  const cached = cache.get(deviceId);
  if (cached) return cached;

  const str = String(deviceId);
  const hash = simpleHash(str);

  const hue = hash % 360;
  const saturations = [0.45, 0.55, 0.65];
  const lightnesses = [0.50, 0.56, 0.62];

  const s = saturations[Math.floor(hash / 360) % saturations.length] ?? 0.55;
  const l = lightnesses[Math.floor(hash / (360 * saturations.length)) % lightnesses.length] ?? 0.56;

  const rgb = hslToRgb(hue, s, l);
  cache.set(deviceId, rgb);
  return rgb;
}

function parseHexColor(hex: string): Color | null {
  const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

export function getColorForDevice(
  deviceId: number,
  deviceColor: string | null
): Color {
  // If device has a custom color, use it
  if (deviceColor) {
    const parsed = parseHexColor(deviceColor);
    if (parsed) return parsed;
  }

  // Fall back to generated color
  return colorForDevice(deviceId);
}

export function rgbaString(color: Color, a: number = 1): string {
  const [r, g, b] = color;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

const clampChannel = (value: number): number =>
  Math.max(0, Math.min(255, Math.round(value)));

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${clampChannel(r).toString(16).padStart(2, "0")}${clampChannel(g).toString(16).padStart(2, "0")}${clampChannel(b).toString(16).padStart(2, "0")}`;
}

export function isLightHexColor(hex: string): boolean {
  const parsed = parseHexColor(hex);
  if (!parsed) return false;
  const [r, g, b] = parsed;
  return (r * 299 + g * 587 + b * 114) / 1000 > 186;
}

function lerpColor(a: Color, b: Color, t: number): Color {
  const clamped = Math.max(0, Math.min(1, t));
  return [
    a[0] + (b[0] - a[0]) * clamped,
    a[1] + (b[1] - a[1]) * clamped,
    a[2] + (b[2] - a[2]) * clamped,
  ];
}

export function colorForDeltaSeconds(deltaSec: number): string {
  const GREEN = parseHexColor("#22c55e");
  const BLUE = parseHexColor("#2563eb");
  const YELLOW = parseHexColor("#eab308");
  const RED = parseHexColor("#ef4444");

  if (!GREEN || !BLUE || !YELLOW || !RED) return "#ef4444";
  if (deltaSec <= 30) return rgbToHex(...lerpColor(GREEN, BLUE, deltaSec / 30));
  if (deltaSec <= 60) return rgbToHex(...lerpColor(BLUE, YELLOW, (deltaSec - 30) / 30));
  if (deltaSec <= 180) return rgbToHex(...lerpColor(YELLOW, RED, (deltaSec - 60) / 120));

  return "#ef4444";
}
