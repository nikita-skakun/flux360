import type { Cov2, DevicePoint, Vec2 } from "@/ui/types";
import { addCov, invertCov, mulCovVec, mulMatMat, symmetric } from "./cov_utils";

export const CONFIDENCE_HIGH_THRESHOLD = 0.8;
export const CONFIDENCE_MEDIUM_THRESHOLD = 0.4;

export class Anchor {
  mean: Vec2;
  cov: Cov2;
  startTimestamp: number;
  endTimestamp: number | null;
  confidence: number;
  lastUpdateTimestamp: number;

  constructor(mean: Vec2, cov: Cov2, startTimestamp: number, confidence: number = 0.5, lastUpdateTimestamp?: number) {
    this.mean = mean;
    this.cov = symmetric(cov);
    this.startTimestamp = startTimestamp;
    this.endTimestamp = null;
    this.confidence = confidence;
    this.lastUpdateTimestamp = lastUpdateTimestamp ?? startTimestamp;
  }

  clone(): Anchor {
    const cloned = new Anchor([this.mean[0], this.mean[1]], [this.cov[0], this.cov[1], this.cov[2]], this.startTimestamp, this.confidence, this.lastUpdateTimestamp);
    cloned.endTimestamp = this.endTimestamp;
    return cloned;
  }

  getConfidence(timestamp: number, decayRate: number): number {
    const timeDiff = timestamp - this.lastUpdateTimestamp;
    return Math.max(0, Math.min(1, this.confidence * Math.exp(-decayRate * timeDiff)));
  }

  getConfidenceLevel(timestamp: number, decayRate: number): "high" | "medium" | "low" {
    const conf = this.getConfidence(timestamp, decayRate);
    if (conf >= CONFIDENCE_HIGH_THRESHOLD) return "high";
    if (conf >= CONFIDENCE_MEDIUM_THRESHOLD) return "medium";
    return "low";
  }

  mahalanobis2(m: DevicePoint): number {
    const r: Vec2 = [m.mean[0] - this.mean[0], m.mean[1] - this.mean[1]];
    const S = addCov(this.cov, m.cov);
    const Si = invertCov(S);
    const Si_r = mulCovVec(Si, r);
    return r[0] * Si_r[0] + r[1] * Si_r[1];
  }

  kalmanUpdate(m: DevicePoint, gainRate: number): void {
    // Compute gain based on accuracy
    const accuracy = 1 / (1 + m.accuracy);
    const gain = gainRate * accuracy;

    // Update confidence asymptotically
    this.confidence = 1 - (1 - this.confidence) * Math.exp(-gain);
    this.confidence = Math.max(0, Math.min(1, this.confidence));

    // Kalman filter update
    const P = this.cov;
    const R = m.cov;
    const S = addCov(P, R);
    const Si = invertCov(S);

    const K = mulMatMat(P, Si);

    const r: Vec2 = [m.mean[0] - this.mean[0], m.mean[1] - this.mean[1]];
    const delta = mulCovVec(K, r);
    this.mean = [this.mean[0] + delta[0], this.mean[1] + delta[1]];

    const IminusK = [1 - K[0], -K[1], 1 - K[2]] as Cov2;

    const APA = mulMatMat(mulMatMat(IminusK, P), IminusK);
    const K_R = mulMatMat(K, R);
    const KRKT = mulMatMat(K_R, K);

    const newP = addCov(APA, KRKT);
    this.cov = symmetric(newP);
    this.lastUpdateTimestamp = m.timestamp;
  }
}