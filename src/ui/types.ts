export type Vec2 = [number, number];

export type DevicePoint = {
  device: number;
  sourceDeviceId?: number;
  lat: number;
  lon: number;
  mean: Vec2;
  variance: number;
  timestamp: number;
  accuracy: number;
  anchorAgeMs: number;
  confidence: number;
};
