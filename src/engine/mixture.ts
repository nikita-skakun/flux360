import type { Vec2, Cov2 } from "./gaussian";
import { predictCov, mahalanobisSquared, updateWithMeasurement } from "./gaussian";
import Timeline from "./timeline";

export type Component = {
  mean: Vec2;
  cov: Cov2;
  weight: number;
  source?: string;
  lastUpdate?: number;
};

export type Measurement = {
  mean: Vec2;
  cov: Cov2;
  timestamp: number;
  source?: string;
};

export type MixtureSnapshot = {
  timestamp: number;
  components: Component[];
};

export class MixtureEngine {
  components: Component[] = [];
  timeline = new Timeline<MixtureSnapshot>(1000);

  // thresholds
  spawnMahalanobis = 9; // ~3 sigma
  pruneWeight = 1e-6;
  maxComponents = 32;

  processNoiseMeters = 2;

  predictAll() {
    this.components = this.components.map((c) => ({ ...c, cov: predictCov(c.cov, this.processNoiseMeters) }));
  }

  updateWithMeasurement(meas: Measurement) {
    // compute likelihood / update each component
    let explained = false;
    // update existing components
    for (const c of this.components) {
      const dx: [number, number] = [meas.mean[0] - c.mean[0], meas.mean[1] - c.mean[1]];
      const mahal2 = mahalanobisSquared(dx, c.cov);
      if (mahal2 < this.spawnMahalanobis) {
        // update
        const res = updateWithMeasurement(c.mean, c.cov, meas.mean, meas.cov);
        c.mean = res.mean;
        c.cov = res.cov;
        c.weight = c.weight + 0.05; // increment evidence
        c.lastUpdate = meas.timestamp;
        explained = true;
      } else {
        // decay weight slightly
        c.weight *= 0.95;
      }
    }

    // spawn if not explained
    if (!explained) {
      const newComp: Component = {
        mean: meas.mean,
        cov: meas.cov,
        weight: 0.1,
        source: meas.source,
        lastUpdate: meas.timestamp,
      };
      this.components.push(newComp);
    }

    // normalize weights
    let sum = this.components.reduce((s, c) => s + c.weight, 0);
    if (sum <= 0) sum = 1;
    for (const c of this.components) c.weight /= sum;

    // prune
    this.components = this.components.filter((c) => c.weight >= this.pruneWeight);
    // limit count
    if (this.components.length > this.maxComponents) {
      this.components.sort((a, b) => b.weight - a.weight);
      this.components = this.components.slice(0, this.maxComponents);
    }

    this.appendSnapshot(meas.timestamp);
  }

  appendSnapshot(ts: number) {
    const snapshot: MixtureSnapshot = {
      timestamp: ts,
      components: this.components.map((c) => ({ ...c })),
    };
    this.timeline.append(ts, snapshot);
  }

  reset() {
    this.components = [];
    this.timeline = new Timeline<MixtureSnapshot>(1000);
  }
}

export default MixtureEngine;
