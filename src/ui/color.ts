import ColorHash from "color-hash";

export type Color = [number, number, number];

interface ColorHashInstance { rgb(s: string): Color }
interface ColorHashCtor { new(opts?: { saturation?: number | number[]; lightness?: number | number[] }): ColorHashInstance }

const ch = new (ColorHash as unknown as ColorHashCtor)({
  // soften colors a bit by lowering saturation and increasing lightness
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

export function rgbaString(color: Color, a: number = 1): string {
  const [r, g, b] = color;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
