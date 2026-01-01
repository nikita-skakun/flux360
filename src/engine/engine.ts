import type { DevicePoint } from "@/ui/types";
import { Mixture, type ComponentSnapshot } from "./mixture";

export type EngineSnapshot = { data: { components: ComponentSnapshot[] } };

export class Engine {
  mixture: Mixture;
  lastTimestamp: number | null = null;

  constructor() {
    this.mixture = new Mixture();
  }

  processMeasurements(ms: DevicePoint[]): void {
    for (const m of ms) {
      this.mixture.update(m);
      this.lastTimestamp = m.timestamp;
    }
  }

  getCurrentSnapshot(): EngineSnapshot {
    return { data: { components: this.mixture.snapshot() } };
  }
}
