import type { DevicePoint, Vec2 } from "@/types";

export const CONFIDENCE_HIGH_THRESHOLD = 0.8;
export const CONFIDENCE_MEDIUM_THRESHOLD = 0.5;

export class Anchor {
  mean: Vec2;
  variance: number;
  startTimestamp: number;
  endTimestamp: number | null;
  confidence: number;
  lastUpdateTimestamp: number;

  constructor(mean: Vec2, variance: number, startTimestamp: number, confidence: number = 0.25, lastUpdateTimestamp?: number) {
    this.mean = mean;
    this.variance = variance;
    this.startTimestamp = startTimestamp;
    this.endTimestamp = null;
    this.confidence = confidence;
    this.lastUpdateTimestamp = lastUpdateTimestamp ?? startTimestamp;
  }

  clone(): Anchor {
    const cloned = new Anchor([this.mean[0], this.mean[1]], this.variance, this.startTimestamp, this.confidence, this.lastUpdateTimestamp);
    cloned.endTimestamp = this.endTimestamp;
    return cloned;
  }

  getConfidence(timestamp: number, decayRate: number): number {
    const timeDiffMinutes = (timestamp - this.lastUpdateTimestamp) / 60000;
    return Math.max(0, Math.min(1, this.confidence * Math.exp(-decayRate * timeDiffMinutes)));
  }

  getConfidenceLevel(timestamp: number, decayRate: number): "high" | "medium" | "low" {
    const conf = this.getConfidence(timestamp, decayRate);
    if (conf >= CONFIDENCE_HIGH_THRESHOLD) return "high";
    if (conf >= CONFIDENCE_MEDIUM_THRESHOLD) return "medium";
    return "low";
  }

  mahalanobis2(m: DevicePoint): number {
    const dx = m.mean[0] - this.mean[0];
    const dy = m.mean[1] - this.mean[1];
    const distanceSq = dx * dx + dy * dy;
    const totalVariance = Math.max(this.variance + m.variance, 1e-6); // prevent division by zero
    return distanceSq / totalVariance;
  }

  kalmanUpdate(m: DevicePoint, gainRate: number): void {
    // Compute gain based on accuracy
    const accuracy = 1 / (1 + m.accuracy);
    const gain = gainRate * accuracy;

    // Update confidence asymptotically
    this.confidence = 1 - (1 - this.confidence) * Math.exp(-gain);
    this.confidence = Math.max(0, Math.min(1, this.confidence));

    // Scalar Kalman filter update
    const measurementVariance = m.variance;
    const totalVariance = this.variance + measurementVariance;
    const kalmanGain = this.variance / totalVariance;

    const residualX = m.mean[0] - this.mean[0];
    const residualY = m.mean[1] - this.mean[1];
    this.mean = [this.mean[0] + kalmanGain * residualX, this.mean[1] + kalmanGain * residualY];

    const processNoise = 0.1; // small constant for model uncertainty
    this.variance = (1 - kalmanGain) * this.variance + processNoise;
    this.lastUpdateTimestamp = m.timestamp;
  }
}
