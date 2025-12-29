import type { DevicePoint } from "@/ui/types";
import { Mixture, type ComponentSnapshot } from "./mixture";

export type EngineSnapshot = { timestamp: number; data: { components: ComponentSnapshot[] } };

export class Engine {
  mixture: Mixture;

  constructor() {
    this.mixture = new Mixture();
  }

  processMeasurements(ms: DevicePoint[]): EngineSnapshot[] {
    if (!Array.isArray(ms)) return [];
    const measurements = ms.slice().sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    const snapshots: EngineSnapshot[] = [];

    for (const m of measurements) {
      this.mixture.update(m);
      const compSnap = this.mixture.snapshot().map((c: ComponentSnapshot) => ({ mean: [c.mean[0], c.mean[1]], cov: [c.cov[0], c.cov[1], c.cov[2]], consistency: c.consistency, weight: c.weight, action: c.action, spawnedDuringMovement: c.spawnedDuringMovement, createdAt: c.createdAt } as ComponentSnapshot));
      snapshots.push({ timestamp: m.timestamp ?? Date.now(), data: { components: compSnap } });
    }

    return snapshots;
  }
}
