import type { DevicePoint } from "@/ui/types";
import { Anchor } from "./anchor";

export type EngineSnapshot = { activeAnchor: Anchor; closedAnchors: Anchor[]; candidateAnchor: Anchor | null; timestamp: number };

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
        if (dist2 < 9) { // threshold for 3-sigma
          // update the anchor using Kalman
          this.activeAnchor.kalmanUpdate(m);
          // discard candidate
          this.candidateAnchor = null;
        } else {
          // not consistent with active
          if (this.candidateAnchor !== null) {
            const candDist2 = this.candidateAnchor.mahalanobis2(m);
            if (candDist2 < 9) {
              // update candidate
              this.candidateAnchor.kalmanUpdate(m);
              this.candidateAnchor.supportCount++;
              // check promotion
              if (this.candidateAnchor.supportCount >= 2) {
                // promote
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
      this.lastTimestamp = m.timestamp;
      snapshots.push({ activeAnchor: this.activeAnchor, closedAnchors: [...this.closedAnchors], candidateAnchor: this.candidateAnchor, timestamp: this.lastTimestamp });
    }
    return snapshots;
  }

  getCurrentSnapshot(): EngineSnapshot {
    if (this.activeAnchor === null) {
      throw new Error("No measurements processed yet");
    }
    return { activeAnchor: this.activeAnchor, closedAnchors: [...this.closedAnchors], candidateAnchor: this.candidateAnchor, timestamp: this.lastTimestamp! };
  }
}
