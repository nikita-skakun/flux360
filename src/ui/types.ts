export type ComponentUI = {
  mean?: [number, number];
  cov?: [number, number, number];
  weight?: number;
  accuracy?: number;
  lat?: number;
  lon?: number;
  [key: string]: unknown;
};
