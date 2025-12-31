import type { DevicePoint } from "@/ui/types";
import { Mixture, type ComponentSnapshot } from "./mixture";

export type EngineSnapshot = { timestamp: number; data: { components: ComponentSnapshot[] } };

export class Engine {
  mixture: Mixture;

  constructor() {
    this.mixture = new Mixture();
  }

  processMeasurements(ms: DevicePoint[]): EngineSnapshot[] {
    return ms.map(m => {
      this.mixture.update(m);
      return { timestamp: m.timestamp, data: { components: this.mixture.snapshot() } };
    });
  }
}
