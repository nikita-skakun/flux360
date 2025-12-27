import ColorHash, { type ColorValueArray } from "color-hash";

const ch = new ColorHash({
  // soften colors a bit by lowering saturation and increasing lightness
  saturation: [0.45, 0.55, 0.65],
  lightness: [0.50, 0.56, 0.62],
});

export function colorForDevice(deviceId: number): ColorValueArray {
  return ch.rgb(String(deviceId));
}

export function rgbaString(color: ColorValueArray, a: number = 1): string {
  const [r, g, b] = color;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
