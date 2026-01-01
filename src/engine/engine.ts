import type { DevicePoint } from "@/ui/types";
import { Anchor } from "./anchor";

export type EngineSnapshot = { activeAnchor: Anchor; closedAnchors: Anchor[]; timestamp: number };

export class Engine {
  activeAnchor: Anchor | null = null;
  closedAnchors: Anchor[] = [];
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
        } else {
          // close the current anchor
          this.closedAnchors.push(this.activeAnchor);
          // create a new anchor
          this.activeAnchor = new Anchor([m.mean[0], m.mean[1]], m.cov, m.timestamp);
        }
      }
      this.lastTimestamp = m.timestamp;
      snapshots.push({ activeAnchor: this.activeAnchor, closedAnchors: [...this.closedAnchors], timestamp: this.lastTimestamp });
    }
    return snapshots;
  }

  getCurrentSnapshot(): EngineSnapshot {
    if (this.activeAnchor === null) {
      throw new Error("No measurements processed yet");
    }
    return { activeAnchor: this.activeAnchor, closedAnchors: [...this.closedAnchors], timestamp: this.lastTimestamp! };
  }
}
