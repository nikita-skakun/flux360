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

export function parseHexColor(hex: string): Color | null {
  const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

export function getColorForDevice(
  deviceId: number,
  deviceColor?: string | null
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
