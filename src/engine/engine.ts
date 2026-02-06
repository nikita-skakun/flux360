import type { DevicePoint } from "@/ui/types";
import { Anchor } from "./anchor";

export type EngineSnapshot = { activeAnchor: Anchor | null; closedAnchors: Anchor[]; candidateAnchor: Anchor | null; timestamp: number; activeConfidence: number };

const DECAY_RATE_ACTIVE = 0.001;
const DECAY_RATE_CANDIDATE = 0.01;
const GAIN_RATE = 2.0;
const MIN_USABLE_CONFIDENCE = 0.1;

export type DebugDecision = 'initialized' | 'updated' | 'resisted' | 'candidate-updated' | 'candidate-created' | 'promoted' | 'active-ended' | 'none';
export type DebugFrame = {
  timestamp: number;
  sourceDeviceId: number | undefined;
  measurement: { lat: number; lon: number; accuracy: number; mean: [number, number]; cov: [number, number, number]; };
  before: { mean: [number, number]; cov: [number, number, number]; confidence: number; startTimestamp: number; lastUpdateTimestamp: number } | null;
  after: { mean: [number, number]; cov: [number, number, number]; confidence: number; startTimestamp: number; lastUpdateTimestamp: number } | null;
  mahalanobis2: number | null;
  decision: DebugDecision;
};

const DEBUG_BUFFER_SIZE = 200;

export class Engine {
  activeAnchor: Anchor | null = null;
  closedAnchors: Anchor[] = [];
  candidateAnchor: Anchor | null = null;
  lastTimestamp: number | null = null;

  // debug buffer (per-engine)
  private debugFrames: DebugFrame[] = [];
  private seenDebugKeys = new Set<string>();

  getDebugFrames(): DebugFrame[] { return [...this.debugFrames]; }

  clearDebugFrames(): void {
    this.debugFrames = [];
    this.seenDebugKeys.clear();
  }

  private pushDebugFrame(frame: DebugFrame) {
    const key = `${frame.timestamp}:${frame.measurement.lat}:${frame.measurement.lon}:${frame.measurement.accuracy}:${frame.sourceDeviceId ?? ''}`;
    if (this.seenDebugKeys.has(key)) return;
    this.seenDebugKeys.add(key);
    this.debugFrames.push(frame);
    if (this.debugFrames.length > DEBUG_BUFFER_SIZE) {
      this.debugFrames.sort((a, b) => a.timestamp - b.timestamp);
      this.debugFrames.splice(0, this.debugFrames.length - DEBUG_BUFFER_SIZE);
    }
  }

  processMeasurements(ms: DevicePoint[]): EngineSnapshot[] {
    const snapshots: EngineSnapshot[] = [];
    for (const m of ms) {
      // capture state before
      const beforeAnchor = this.activeAnchor ? this.activeAnchor.clone() : null;
      let mahalanobis2: number | null = null;
      let decision: DebugDecision = 'none';

      if (this.activeAnchor === null) {
        // Initialize with the first measurement
        this.activeAnchor = new Anchor([m.mean[0], m.mean[1]], m.cov, m.timestamp);
        decision = 'initialized';
      } else {
        const dist2 = this.activeAnchor.mahalanobis2(m);
        mahalanobis2 = dist2;
        if (dist2 < 25) { // threshold for ~5-sigma
          // update the anchor using Kalman
          this.activeAnchor.kalmanUpdate(m, GAIN_RATE);
          decision = 'updated';
          // discard candidate
          this.candidateAnchor = null;
        } else {
          // not consistent with active
          decision = 'resisted';
          if (this.candidateAnchor !== null) {
            const candDist2 = this.candidateAnchor.mahalanobis2(m);
            if (candDist2 < 25) {
              // update candidate
              this.candidateAnchor.kalmanUpdate(m, GAIN_RATE);
              decision = 'candidate-updated';
              // check promotion
              const candidateConf = this.candidateAnchor.getConfidence(m.timestamp, DECAY_RATE_CANDIDATE);
              const activeConf = this.activeAnchor.getConfidence(m.timestamp, DECAY_RATE_ACTIVE);
              const timeSinceActiveUpdate = m.timestamp - this.activeAnchor.lastUpdateTimestamp;
              const staleBonus = Math.min(0.3, timeSinceActiveUpdate / 600000); // up to 30% boost after 10 min of no updates
              if (candidateConf > activeConf - staleBonus) {
                // promote
                this.activeAnchor.endTimestamp = m.timestamp;
                this.closedAnchors.push(this.activeAnchor);
                this.activeAnchor = this.candidateAnchor;
                this.candidateAnchor = null;
                decision = 'promoted';
              }
            } else {
              // not consistent with candidate, create new candidate
              this.candidateAnchor = new Anchor([m.mean[0], m.mean[1]], m.cov, m.timestamp);
              decision = 'candidate-created';
            }
          } else {
            // create candidate
            this.candidateAnchor = new Anchor([m.mean[0], m.mean[1]], m.cov, m.timestamp);
            decision = 'candidate-created';
          }
        }
      }

      if (this.activeAnchor && this.activeAnchor.getConfidence(m.timestamp, DECAY_RATE_ACTIVE) < MIN_USABLE_CONFIDENCE) {
        this.activeAnchor.endTimestamp = m.timestamp;
        this.closedAnchors.push(this.activeAnchor);
        this.activeAnchor = null;
        decision = 'active-ended';
      }

      // capture state after
      const afterAnchor = this.activeAnchor ? this.activeAnchor.clone() : null;

      // push debug frame (non-intrusive)
      this.pushDebugFrame({
        timestamp: m.timestamp,
        sourceDeviceId: m.sourceDeviceId,
        measurement: { lat: m.lat, lon: m.lon, accuracy: m.accuracy, mean: [m.mean[0], m.mean[1]], cov: [m.cov[0], m.cov[1], m.cov[2]] },
        before: beforeAnchor ? { mean: [beforeAnchor.mean[0], beforeAnchor.mean[1]], cov: [beforeAnchor.cov[0], beforeAnchor.cov[1], beforeAnchor.cov[2]], confidence: beforeAnchor.confidence, startTimestamp: beforeAnchor.startTimestamp, lastUpdateTimestamp: beforeAnchor.lastUpdateTimestamp } : null,
        after: afterAnchor ? { mean: [afterAnchor.mean[0], afterAnchor.mean[1]], cov: [afterAnchor.cov[0], afterAnchor.cov[1], afterAnchor.cov[2]], confidence: afterAnchor.confidence, startTimestamp: afterAnchor.startTimestamp, lastUpdateTimestamp: afterAnchor.lastUpdateTimestamp } : null,
        mahalanobis2,
        decision,
      });

      this.lastTimestamp = m.timestamp;
      snapshots.push({ activeAnchor: this.activeAnchor, closedAnchors: [...this.closedAnchors], candidateAnchor: this.candidateAnchor, timestamp: this.lastTimestamp, activeConfidence: this.activeAnchor ? this.activeAnchor.getConfidence(this.lastTimestamp, DECAY_RATE_ACTIVE) : 0 });
    }
    return snapshots;
  }

  getCurrentSnapshot(): EngineSnapshot {
    return { activeAnchor: this.activeAnchor, closedAnchors: [...this.closedAnchors], candidateAnchor: this.candidateAnchor, timestamp: this.lastTimestamp!, activeConfidence: this.activeAnchor ? this.activeAnchor.getConfidence(this.lastTimestamp!, DECAY_RATE_ACTIVE) : 0 };
  }

  getDominantAnchorAt(timestamp: number): Anchor | null {
    const candidates: Anchor[] = [];
    if (this.activeAnchor && this.activeAnchor.startTimestamp <= timestamp) {
      candidates.push(this.activeAnchor);
    }
    for (const anchor of this.closedAnchors) {
      if (anchor.startTimestamp <= timestamp && (anchor.endTimestamp === null || timestamp <= anchor.endTimestamp)) {
        candidates.push(anchor);
      }
    }
    if (candidates.length === 0) return null;
    let best: Anchor | null = null;
    let bestConf = -1;
    for (const anchor of candidates) {
      const conf = anchor.getConfidence(timestamp, DECAY_RATE_ACTIVE);
      if (conf > bestConf) {
        bestConf = conf;
        best = anchor;
      }
    }
    return best;
  }
}
