import { Component, type Measurement } from "./component";
import type { Cov2 } from "@/util/gaussian";

export type ComponentSnapshot = {
  mean: [number, number];
  cov: Cov2;
  consistency: number;
  weight: number;
  source?: string;
};

export class Mixture {
  components: Component[] = [];

  // thresholds (mah dist squared)
  highThresh = 4; // within ~2-sigma
  medThresh = 9; // within ~3-sigma
  overlapThresh = 25; // within ~5-sigma

  // update amounts
  highConsistencyInc = 0.08;
  medConsistencyInc = 0.02;
  decayFactor = 0.92; // reduce consistency when a measurement is very unlikely

  spawnInitialConsistency = 0.16;
  spawnCovScale = 2.5; // spawn with somewhat inflated covariance

  pruneBelow = 0.03; // remove components below this consistency

  constructor(initial?: Component) {
    if (initial) this.components.push(initial.clone());
  }

  // helper to compute weights === consistency clamped to [0,1]
  normalizeWeights(): void {
    for (const c of this.components) {
      c.consistency = Math.max(0, Math.min(1, c.consistency));
    }
  }

  snapshot(): ComponentSnapshot[] {
    // return deep copy for UI consumption
    return this.components.map((c) => ({ mean: [c.mean[0], c.mean[1]], cov: [c.cov[0], c.cov[1], c.cov[2]], consistency: c.consistency, weight: c.consistency, source: c.source }));
  }

  update(m: Measurement): void {
    if (!m) return;
    if (this.components.length === 0) {
      // initialize with a wide component to reflect initial uncertainty
      const init = new Component([m.mean[0], m.mean[1]], [m.cov[0] * 4, m.cov[1], m.cov[2] * 4], 1, m.source);
      this.components.push(init);
      return;
    }

    // find best matching component (by Mahalanobis squared distance)
    let bestIdx = -1;
    let bestD2 = Infinity;
    for (let i = 0; i < this.components.length; i++) {
      const comp = this.components[i]!;
      const d2 = comp.mahalanobis2(m);
      if (d2 < bestD2) {
        bestD2 = d2;
        bestIdx = i;
      }
    }

    // decide action
    if (bestIdx === -1) return;
    const best = this.components[bestIdx]!;

    if (bestD2 <= this.highThresh) {
      // high likelihood: full Kalman update, raise consistency
      best.kalmanUpdate(m, 1.0);
      best.consistency = Math.min(1, best.consistency + this.highConsistencyInc);
      // slightly decay other components
      this.components.forEach((c, idx) => {
        if (idx !== bestIdx) c!.consistency *= this.decayFactor;
      });
    } else if (bestD2 <= this.medThresh) {
      // medium likelihood: reduced gain
      best.kalmanUpdate(m, 0.35);
      best.consistency = Math.min(1, best.consistency + this.medConsistencyInc);
      this.components.forEach((c, idx) => {
        if (idx !== bestIdx) c!.consistency *= this.decayFactor;
      });
    } else if (bestD2 <= this.overlapThresh) {
      // low but overlapping: spawn a weak component representing the measurement
      const spawnCov: Cov2 = [m.cov[0] * this.spawnCovScale, m.cov[1], m.cov[2] * this.spawnCovScale];
      const spawned = new Component([m.mean[0], m.mean[1]], spawnCov, this.spawnInitialConsistency, m.source);
      this.components.push(spawned);
      // slightly reduce consistency of existing components (they didn't match well)
      this.components.forEach((c) => {
        if (c !== spawned) c.consistency *= this.decayFactor;
      });
    } else {
      // very unlikely: reduce consistency across the board
      this.components.forEach((c) => (c.consistency *= this.decayFactor));
    }

    // prune very small components
    this.components = this.components.filter((c) => c.consistency > this.pruneBelow);

    // enforce normalized or clamped consistencies
    this.normalizeWeights();
  }
}
