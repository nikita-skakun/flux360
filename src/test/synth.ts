import { asRawGpsCoord } from "@/types";
import type { RawGpsPosition, TraccarDevice } from "@/types";

export const M_PER_DEG_LAT = 111320;

export function makeDevice(id: number, name?: string): TraccarDevice {
  return { id, name: name ?? `device-${id}`, lastUpdate: new Date().toISOString(), attributes: {} };
}

type TrackOptions = {
  device: number;
  startTime: number;
  sampleMs: number;
  /** seconds of driving per cycle */
  driveSeconds: number;
  /** seconds parked per cycle */
  parkSeconds: number;
  speedMps: number;
  accuracy: number;
  /** metres of per-sample wander while parked */
  jitter: number;
  lon0: number;
  lat0: number;
  cycles: number;
  dirLon?: number;
  dirLat?: number;
};

export function synthTrack(opts: TrackOptions): RawGpsPosition[] {
  const { device, startTime, sampleMs, driveSeconds, parkSeconds, speedMps, accuracy, jitter, lon0, lat0, cycles } = opts;
  const dirLon = opts.dirLon ?? 0.7;
  const dirLat = opts.dirLat ?? 0.7;
  const driveSamples = Math.max(1, Math.round((driveSeconds * 1000) / sampleMs));
  const parkSamples = Math.max(1, Math.round((parkSeconds * 1000) / sampleMs));
  const cycle = driveSamples + parkSamples;
  const degPerSample = speedMps * (sampleMs / 1000) / M_PER_DEG_LAT;

  const out: RawGpsPosition[] = [];
  let lon = lon0;
  let lat = lat0;

  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < cycle; i++) {
      const idx = c * cycle + i;
      if (i < driveSamples) {
        lon += degPerSample * dirLon;
        lat += degPerSample * dirLat;
      } else {
        lon += Math.sin(idx * 1.7) * jitter;
        lat += Math.cos(idx * 2.3) * jitter;
      }
      out.push({
        device,
        timestamp: startTime + idx * sampleMs,
        geo: asRawGpsCoord([lon, lat]),
        accuracy,
      });
    }
  }
  return out;
}

/**
 * Deterministic pseudo-random track: useful when you want a long, irregular
 * history that is not just repeated drive/park cycles.
 */
export function synthWalk(opts: {
  device: number;
  startTime: number;
  sampleMs: number;
  samples: number;
  lon0: number;
  lat0: number;
  accuracy: number;
  driftPerSample: number;
}): RawGpsPosition[] {
  const { device, startTime, sampleMs, samples, lon0, lat0, accuracy, driftPerSample } = opts;
  const out: RawGpsPosition[] = [];
  let lon = lon0;
  let lat = lat0;
  let seed = device * 2654435761 % 2147483647;
  const rand = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };

  for (let i = 0; i < samples; i++) {
    lon += (rand() - 0.5) * driftPerSample;
    lat += (rand() - 0.5) * driftPerSample;
    out.push({
      device,
      timestamp: startTime + i * sampleMs,
      geo: asRawGpsCoord([lon, lat]),
      accuracy,
    });
  }
  return out;
}
