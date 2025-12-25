import type { Measurement } from "./component";
import { Mixture } from "./mixture";

export type EngineSnapshot = { timestamp: number; data: { components: any[] } };

export class Engine {
  mixture: Mixture;

  constructor() {
    this.mixture = new Mixture();
  }

  processMeasurements(ms: Measurement[]): EngineSnapshot[] {
    if (!Array.isArray(ms)) return [];
    const measurements = ms.slice().sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    const snapshots: EngineSnapshot[] = [];

    for (const m of measurements) {
      this.mixture.update(m);
      // deep copy snapshot (include action and spawn metadata from mixture)
      const compSnap = this.mixture.snapshot().map((c) => ({ mean: [c.mean[0], c.mean[1]] as [number, number], cov: [c.cov[0], c.cov[1], c.cov[2]], weight: c.weight, action: (c as any).action, spawnedDuringMovement: (c as any).spawnedDuringMovement, createdAt: (c as any).createdAt }));
      snapshots.push({ timestamp: m.timestamp ?? Date.now(), data: { components: compSnap } });
    }

    return snapshots;
  }
}
