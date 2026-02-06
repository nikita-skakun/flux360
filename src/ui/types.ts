export type Vec2 = [number, number];
export type Cov2 = [number, number, number];

export type DevicePoint = {
  device: number;
  sourceDeviceId?: number;
  lat: number;
  lon: number;
  mean: Vec2;
  cov: Cov2;
  timestamp: number;
  accuracy: number;
  anchorAgeMs: number;
  confidence: number;
};
