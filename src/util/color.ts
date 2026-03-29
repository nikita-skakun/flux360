import ColorHash from "color-hash";

export type Color = [number, number, number];

const ch = new ColorHash({
  saturation: [0.45, 0.55, 0.65],
  lightness: [0.50, 0.56, 0.62],
});

const cache = new Map<number, Color>();

export function colorForDevice(deviceId: number): Color {
  const cached = cache.get(deviceId);
  if (cached) return cached;
  const rgb = ch.rgb(String(deviceId));
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

function lerpColor(a: Color, b: Color, t: number): Color {
  const clamped = Math.max(0, Math.min(1, t));
  return [
    a[0] + (b[0] - a[0]) * clamped,
    a[1] + (b[1] - a[1]) * clamped,
    a[2] + (b[2] - a[2]) * clamped,
  ];
}

export function colorForDeltaSeconds(deltaSec: number): string {
  const GREEN = parseHexColor('#22c55e');
  const BLUE = parseHexColor('#2563eb');
  const YELLOW = parseHexColor('#eab308');
  const RED = parseHexColor('#ef4444');

  if (!GREEN || !BLUE || !YELLOW || !RED) return '#ef4444';
  if (deltaSec <= 30) return rgbToHex(...lerpColor(GREEN, BLUE, deltaSec / 30));
  if (deltaSec <= 60) return rgbToHex(...lerpColor(BLUE, YELLOW, (deltaSec - 30) / 30));
  if (deltaSec <= 180) return rgbToHex(...lerpColor(YELLOW, RED, (deltaSec - 60) / 120));

  return '#ef4444';
}
