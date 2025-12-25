export type ComponentUI = {
  device: number;
  lat: number;
  lon: number;
  mean: [number, number];
  cov: [number, number,number];
  emoji: string;
  timestamp: number;
};
