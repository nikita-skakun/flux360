import type { DevicePoint } from "@/ui/types";
import { Anchor } from "./anchor";

export type EngineSnapshot = { activeAnchor: Anchor | null; closedAnchors: Anchor[]; candidateAnchor: Anchor | null; timestamp: number; activeConfidence: number };

const DECAY_RATE_ACTIVE = 0.001;
const DECAY_RATE_CANDIDATE = 0.01;
const GAIN_RATE = 2.0;
const MIN_USABLE_CONFIDENCE = 0.1;

export class Engine {
  activeAnchor: Anchor | null = null;
  closedAnchors: Anchor[] = [];
  candidateAnchor: Anchor | null = null;
  lastTimestamp: number | null = null;

  processMeasurements(ms: DevicePoint[]): EngineSnapshot[] {
    const snapshots: EngineSnapshot[] = [];
    for (const m of ms) {
      if (this.activeAnchor === null) {
        // Initialize with the first measurement
        this.activeAnchor = new Anchor([m.mean[0], m.mean[1]], m.cov, m.timestamp);
      } else {
        const dist2 = this.activeAnchor.mahalanobis2(m);
        if (dist2 < 25) { // threshold for ~5-sigma
          // update the anchor using Kalman
          this.activeAnchor.kalmanUpdate(m, GAIN_RATE);
          // discard candidate
          this.candidateAnchor = null;
        } else {
          // not consistent with active
          if (this.candidateAnchor !== null) {
            const candDist2 = this.candidateAnchor.mahalanobis2(m);
            if (candDist2 < 25) {
              // update candidate
              this.candidateAnchor.kalmanUpdate(m, GAIN_RATE);
              // check promotion
              if (this.candidateAnchor.getConfidence(m.timestamp, DECAY_RATE_CANDIDATE) > this.activeAnchor.getConfidence(m.timestamp, DECAY_RATE_ACTIVE)) {
                // promote
                this.activeAnchor.endTimestamp = m.timestamp;
                this.closedAnchors.push(this.activeAnchor);
                this.activeAnchor = this.candidateAnchor;
                this.candidateAnchor = null;
              }
            } else {
              // not consistent with candidate, create new candidate
              this.candidateAnchor = new Anchor([m.mean[0], m.mean[1]], m.cov, m.timestamp);
            }
          } else {
            // create candidate
            this.candidateAnchor = new Anchor([m.mean[0], m.mean[1]], m.cov, m.timestamp);
          }
        }
      }
      if (this.activeAnchor && this.activeAnchor.getConfidence(m.timestamp, DECAY_RATE_ACTIVE) < MIN_USABLE_CONFIDENCE) {
        this.activeAnchor.endTimestamp = m.timestamp;
        this.closedAnchors.push(this.activeAnchor);
        this.activeAnchor = null;
      }
      this.lastTimestamp = m.timestamp;
      snapshots.push({ activeAnchor: this.activeAnchor, closedAnchors: [...this.closedAnchors], candidateAnchor: this.candidateAnchor, timestamp: this.lastTimestamp, activeConfidence: this.activeAnchor ? this.activeAnchor.getConfidence(this.lastTimestamp, DECAY_RATE_ACTIVE) : 0 });
    }
    return snapshots;
  }

  getCurrentSnapshot(): EngineSnapshot {
    return { activeAnchor: this.activeAnchor, closedAnchors: [...this.closedAnchors], candidateAnchor: this.candidateAnchor, timestamp: this.lastTimestamp!, activeConfidence: this.activeAnchor ? this.activeAnchor.getConfidence(this.lastTimestamp!, DECAY_RATE_ACTIVE) : 0 };
  }
}
