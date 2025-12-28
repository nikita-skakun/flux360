export type ComponentUI = {
  device: number;
  lat: number;
  lon: number;
  mean: [number, number];
  cov: [number, number,number];
  emoji: string;
  timestamp: number;
  // optional metadata
  deviceName?: string;
  accuracy?: number;
  accuracyMeters?: number;
  speed?: number;
  action?: string;
  raw?: boolean;
};
