import { asRawGpsCoord } from "@/types";
import type { RawGpsPosition, TraccarDevice } from "@/types";

export const M_PER_DEG_LAT = 111320;

export function makeDevice(id: number, name?: string): TraccarDevice {
  return { id, name: name ?? `device-${id}`, lastUpdate: new Date().toISOString(), attributes: {} };
}

/**
 * Reporting behaviour of one real data source.
 *
 * Cadence and accuracy differ by orders of magnitude between a phone and a
 * battery-powered tag, and that difference is the whole problem rather than noise
 * around it: it decides whether a gap in the track is a measurement or a mystery. A
 * phone at 15 s and 10 m lets you read speed off consecutive fixes. A tracker at
 * four hours and 60 m tells you only that something moved, somewhere in that window,
 * by some means.
 */
export type ChannelName = "phone" | "airtag" | "google";

export type ChannelProfile = {
  sampleMs: number;
  /** Probability that a step becomes a dropout instead of the normal interval. */
  gapChance: number;
  gapMsMin: number;
  gapMsMax: number;
  accuracyMin: number;
  accuracyMax: number;
};

export const CHANNELS: Record<ChannelName, ChannelProfile> = {
  phone: {
    sampleMs: 15_000,
    gapChance: 0.02,
    gapMsMin: 2 * 60_000,
    gapMsMax: 20 * 60_000,
    accuracyMin: 5,
    accuracyMax: 25,
  },
  airtag: {
    sampleMs: 60_000,
    gapChance: 0.15,
    gapMsMin: 5 * 60_000,
    gapMsMax: 2 * 3600_000,
    accuracyMin: 30,
    accuracyMax: 50,
  },
  google: {
    sampleMs: 15 * 60_000,
    gapChance: 0.5,
    gapMsMin: 20 * 60_000,
    gapMsMax: 4 * 3600_000,
    accuracyMin: 50,
    accuracyMax: 70,
  },
};

type TrackOptions = {
  device: number;
  startTime: number;
  lon0: number;
  lat0: number;
  /** seconds of driving per cycle */
  driveSeconds: number;
  /** seconds parked per cycle */
  parkSeconds: number;
  cycles: number;
  /** Supplies defaults for sampleMs, accuracy range and gap behaviour. */
  channel?: ChannelName;
  speedMps?: number;
  sampleMs?: number;
  /** Fixed accuracy in metres. Ignored when accuracyMin/accuracyMax are given. */
  accuracy?: number;
  accuracyMin?: number;
  accuracyMax?: number;
  gapChance?: number;
  gapMsMin?: number;
  gapMsMax?: number;
  /** Metres of per-sample wander while parked. */
  parkJitterMeters?: number;
  /** Heading of the drive leg, as east and north components. */
  dirLon?: number;
  dirLat?: number;
  seed?: number;
};

/**
 * Deterministic pseudo-random generator, so a scenario is reproducible from its seed.
 * Returning the same sequence matters for tests that compare a rewound timeline with
 * an in-order one built from the same track.
 */
function makeRandom(seed: number): () => number {
  let state = (Math.abs(Math.trunc(seed)) || 1) % 2147483647;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

/**
 * Synthetic drive/park track with realistic, varied sampling.
 *
 * The walk is time driven rather than sample driven, so a dropout advances the
 * position by however far the vehicle travelled during the gap. That is the point:
 * a three hour gap with a five kilometre jump is a completely different signal from
 * a ten second step, and a generator that only emits dense fixes cannot produce it.
 *
 * Displacement is computed in metres and then projected, including the longitude
 * correction, so the track is geometrically faithful rather than merely plausible.
 */
export function synthTrack(opts: TrackOptions): RawGpsPosition[] {
  const channel = opts.channel ? CHANNELS[opts.channel] : null;
  const speedMps = opts.speedMps ?? 13.9;
  const sampleMs = opts.sampleMs ?? channel?.sampleMs ?? 10_000;
  const accuracyMin = opts.accuracyMin ?? channel?.accuracyMin ?? opts.accuracy ?? 6;
  const accuracyMax = opts.accuracyMax ?? channel?.accuracyMax ?? opts.accuracy ?? 6;
  const gapChance = opts.gapChance ?? channel?.gapChance ?? 0;
  const gapMsMin = opts.gapMsMin ?? channel?.gapMsMin ?? 0;
  const gapMsMax = opts.gapMsMax ?? channel?.gapMsMax ?? 0;
  const parkJitterMeters = opts.parkJitterMeters ?? 0.5;
  const dirLon = opts.dirLon ?? 0.7;
  const dirLat = opts.dirLat ?? 0.7;

  const rand = makeRandom(opts.seed ?? opts.device);
  const accuracyAt = () => accuracyMin + rand() * (accuracyMax - accuracyMin);

  const cycleMs = (opts.driveSeconds + opts.parkSeconds) * 1000;
  const totalMs = cycleMs * opts.cycles;
  const endTime = opts.startTime + totalMs;
  const directionLength = Math.hypot(dirLon, dirLat) || 1;

  const out: RawGpsPosition[] = [];
  let lon = opts.lon0;
  let lat = opts.lat0;
  let t = opts.startTime;

  while (t <= endTime) {
    out.push({ device: opts.device, timestamp: t, geo: asRawGpsCoord([lon, lat]), accuracy: accuracyAt() });

    const cyclePositionMs = (t - opts.startTime) % cycleMs;
    const isDriving = cyclePositionMs < opts.driveSeconds * 1000;

    const step = rand() < gapChance ? gapMsMin + rand() * (gapMsMax - gapMsMin) : sampleMs;
    t += step;

    if (isDriving) {
      const travelledMeters = speedMps * (step / 1000);
      const north = travelledMeters * (dirLat / directionLength);
      const east = travelledMeters * (dirLon / directionLength);
      lat += north / M_PER_DEG_LAT;
      lon += east / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
    } else {
      lat += ((rand() - 0.5) * parkJitterMeters) / M_PER_DEG_LAT;
      lon += ((rand() - 0.5) * parkJitterMeters) / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
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
  const rand = makeRandom(device);
  const driftMeters = driftPerSample * M_PER_DEG_LAT;

  for (let i = 0; i < samples; i++) {
    const north = (rand() - 0.5) * driftMeters;
    const east = (rand() - 0.5) * driftMeters;
    lat += north / M_PER_DEG_LAT;
    lon += east / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
    out.push({
      device,
      timestamp: startTime + i * sampleMs,
      geo: asRawGpsCoord([lon, lat]),
      accuracy,
    });
  }
  return out;
}
