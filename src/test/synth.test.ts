import { describe, expect, test } from "bun:test";
import { CHANNELS, synthTrack } from "./synth";

const DAY = 86_400_000;

function build(channel: keyof typeof CHANNELS, cycles = 20) {
  return synthTrack({
    channel,
    device: 1,
    startTime: Date.now() - 3 * DAY,
    driveSeconds: 1200,
    parkSeconds: 1800,
    cycles,
    lon0: 10,
    lat0: 50,
  });
}

function gaps(track: { timestamp: number }[]): number[] {
  return track.slice(1).map((p, i) => p.timestamp - track[i]!.timestamp);
}

function metersBetween(a: { geo: [number, number] }, b: { geo: [number, number] }): number {
  const dLat = (b.geo[1] - a.geo[1]) * 111_320;
  const dLon = (b.geo[0] - a.geo[0]) * 111_320 * Math.cos((b.geo[1] * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

describe("synthTrack", () => {
  test("accuracy stays inside the channel's reported range", () => {
    for (const name of ["phone", "airtag", "google"] as const) {
      const profile = CHANNELS[name];
      for (const point of build(name)) {
        expect(point.accuracy).toBeGreaterThanOrEqual(profile.accuracyMin);
        expect(point.accuracy).toBeLessThanOrEqual(profile.accuracyMax);
      }
    }
  });

  test("cadence differs by orders of magnitude between channels", () => {
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    const phone = median(gaps(build("phone")));
    const airtag = median(gaps(build("airtag")));
    const google = median(gaps(build("google")));

    // The whole point of the generator: a dense channel where speed is readable off
    // consecutive fixes, and sparse ones where it is not.
    expect(phone).toBe(CHANNELS.phone.sampleMs);
    expect(airtag).toBe(CHANNELS.airtag.sampleMs);
    expect(google).toBeGreaterThanOrEqual(CHANNELS.google.sampleMs);
    expect(google).toBeGreaterThan(airtag * 10);
    expect(Math.max(...gaps(build("google")))).toBeGreaterThan(60 * 60_000);
  });

  test("dropouts land inside the configured gap window", () => {
    const profile = CHANNELS.airtag;
    const longGaps = gaps(build("airtag")).filter(g => g > profile.sampleMs);
    expect(longGaps.length).toBeGreaterThan(0);
    for (const gap of longGaps) {
      expect(gap).toBeGreaterThanOrEqual(profile.gapMsMin);
      expect(gap).toBeLessThanOrEqual(profile.gapMsMax);
    }
  });

  test("distance over a drive step lets the true speed be recovered", () => {
    const speedMps = 13.9;
    const startTime = Date.now() - DAY;
    const track = synthTrack({
      device: 1,
      startTime,
      driveSeconds: 1200,
      parkSeconds: 1800,
      cycles: 8,
      speedMps,
      sampleMs: 10_000,
      accuracy: 6,
      lon0: 10,
      lat0: 50,
    });

    // Every step that starts inside a drive leg should sit at the configured speed.
    // This is what makes the minimum-speed bound meaningful: the fixture has to
    // actually be consistent with the speed it claims.
    const measured: number[] = [];
    for (let i = 1; i < track.length; i++) {
      const previous = track[i - 1]!;
      const current = track[i]!;
      const cyclePositionMs = (previous.timestamp - startTime) % 3_000_000;
      if (cyclePositionMs >= 1200 * 1000) continue;
      measured.push(metersBetween(previous, current) / ((current.timestamp - previous.timestamp) / 1000));
    }

    expect(measured.length).toBeGreaterThan(100);
    for (const speed of measured) expect(Math.abs(speed - speedMps)).toBeLessThan(speedMps * 0.02);
  });

  test("a dropout covers the ground travelled during it", () => {
    const track = build("airtag");
    const longGaps = track.slice(1).map((p, i) => ({ p, previous: track[i]!, gap: p.timestamp - track[i]!.timestamp }))
      .filter(entry => entry.gap > CHANNELS.airtag.sampleMs && entry.gap < 60 * 60_000);

    expect(longGaps.length).toBeGreaterThan(0);
    for (const entry of longGaps) {
      const travelled = metersBetween(entry.previous, entry.p);
      // A parked device barely moves, so only assert the bound that a real vehicle
      // could not exceed. The gap must not be a ten second step in disguise.
      expect(travelled).toBeLessThanOrEqual((entry.gap / 1000) * 30);
    }
  });

  test("the same seed reproduces the track exactly", () => {
    const options = {
      device: 3, startTime: 1_700_000_000_000, driveSeconds: 1200, parkSeconds: 1800,
      cycles: 10, lon0: 10, lat0: 50, channel: "google" as const,
    };
    expect(synthTrack(options)).toEqual(synthTrack(options));
  });
});
