import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { makeDevice, synthTrack } from "./synth";
import { asRawGpsCoord } from "@/types";
import { buildEngineSnapshotsFromByDevice } from "@/server/serverUtils";
import type { RawGpsPosition, TraccarDevice } from "@/types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Config = {
  devices: number;
  days: number;
  sampleMs: number;
};

function buildTracks(cfg: Config, startTime: number): RawGpsPosition[] {
  const out: RawGpsPosition[] = [];
  const cycleSamples = Math.round((3000 * 1000) / cfg.sampleMs);
  const cycles = Math.ceil((cfg.days * DAY) / (cycleSamples * cfg.sampleMs));
  for (let d = 0; d < cfg.devices; d++) {
    out.push(...synthTrack({
      device: d + 1,
      startTime,
      sampleMs: cfg.sampleMs,
      driveSeconds: 1200,
      parkSeconds: 1800,
      speedMps: 13.9,
      accuracy: 6,
      jitter: 0.000004,
      lon0: 10 + d * 0.01,
      lat0: 50 + d * 0.01,
      cycles,
    }));
  }
  return out;
}

function dbBytes(path: string, table: string): number {
  const probe = new Database(path, { readonly: true });
  const sql = `SELECT SUM(LENGTH(eventJson)) AS b FROM ${table}`;
  const row = probe.query(sql).get() as { b: number | null };
  probe.close();
  return row.b ?? 0;
}

function checkpointBytes(state: unknown): number {
  const s = state as { engineCheckpoints: Record<number, { snapshot: unknown }[]> };
  let total = 0;
  for (const list of Object.values(s.engineCheckpoints)) {
    for (const cp of list) total += JSON.stringify(cp.snapshot).length;
  }
  return total;
}

async function run(cfg: Config) {
  const dir = `/tmp/flux360-bench-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  const dbPath = `${dir}/bench.sqlite`;
  process.env["FLUX360_DB_PATH"] = dbPath;

  const { ServerState } = await import("@/server/serverState");
  const { db } = await import("@/server/db");

  const devices: TraccarDevice[] = Array.from({ length: cfg.devices }, (_, i) => makeDevice(i + 1));
  const tracks = buildTracks(cfg, Date.now() - cfg.days * DAY);
  const ingestedPositions = tracks.length;

  const st = new ServerState(cfg.days + 1);
  st.handleDevices(devices);
  const rssBoot = process.memoryUsage.rss();

  const ingestStart = performance.now();
  st.handlePositions(tracks);
  const ingestMs = performance.now() - ingestStart;

  const rssIngest = process.memoryUsage.rss();
  const positions = (st as unknown as { positionsAll: RawGpsPosition[] }).positionsAll.length;
  const events = Object.values(st.eventsByDevice).reduce((a, l) => a + l.length, 0);

  // Steady state: continue from where each device actually finished, so the
  // appended fixes do not look like a teleport and trigger motion every batch.
  const lastGeo = new Map<number, ReturnType<typeof asRawGpsCoord>>();
  let lastTrackTs = 0;
  for (const p of tracks) {
    lastGeo.set(p.device, p.geo);
    if (p.timestamp > lastTrackTs) lastTrackTs = p.timestamp;
  }
  tracks.length = 0;

  const sampleFor = (i: number): RawGpsPosition[] => {
    const device = (i % cfg.devices) + 1;
    const geo = lastGeo.get(device) ?? asRawGpsCoord([10, 50]);
    return [{ device, timestamp: 0, geo, accuracy: 6 }];
  };

  const WARMUP = 60;
  const SAMPLES = 400;
  for (let i = 0; i < WARMUP; i++) st.handlePositions(sampleFor(i));

  (globalThis as Record<string, unknown>)['__worst'] = { TOTAL: 0 };
  const samples: number[] = [];
  // Continue strictly after the bulk data. Starting at wall clock time would look
  // like out-of-order data whenever the generated span overshoots the requested days.
  let ts = Math.max(Date.now(), lastTrackTs + cfg.sampleMs);
  for (let i = 0; i < SAMPLES; i++) {
    const batch = sampleFor(i);
    for (const p of batch) p.timestamp = ts;
    const t = performance.now();
    st.handlePositions(batch);
    samples.push(performance.now() - t);
    ts += cfg.sampleMs;
  }
  const slowest = samples.map((ms, i) => ({ ms, i })).sort((a, b) => b.ms - a.ms).slice(0, 6);
  console.log(`slowest batches        : ${slowest.map(s => `#${s.i}=${s.ms.toFixed(0)}ms`).join(" ")}`);
  const over50 = samples.filter(x => x > 50).length;
  console.log(`batches over 50ms      : ${over50}/${SAMPLES}`);
  samples.sort((a, b) => a - b);
  const steadyMs = samples[Math.floor(samples.length / 2)] ?? 0;
  const steadyP95 = samples[Math.floor(samples.length * 0.95)] ?? 0;

  const worstP = (globalThis as Record<string, unknown>)["__worst"] as Record<string, number> | undefined;
  if (worstP) {
    const parts = Object.entries(worstP).sort((a, b) => b[1] - a[1]);
    console.log(`  WORST-batch breakdown: ${parts.map(([k, v]) => `${k}=${v.toFixed(1)}`).join(" ")}`);
  }

  // breakdown: cost of the all-device re-sort that runs on every batch
  const sortAll = performance.now();
  for (const list of Object.values(st.eventsByDevice)) list.sort((a, b) => b.start - a.start);
  const sortAllMs = performance.now() - sortAll;

  const snapshotAll = performance.now();
  buildEngineSnapshotsFromByDevice({}, st.engines, {}, Object.keys(st.engines).map(Number));
  const snapshotAllMs = performance.now() - snapshotAll;

  const cpBytes = checkpointBytes(st);
  const eventBytes = dbBytes(dbPath, "events");

  console.log(`\n=== ${cfg.devices} devices x ${cfg.days} days @ ${cfg.sampleMs / 1000}s ===`);
  console.log(`raw positions ingested : ${ingestedPositions.toLocaleString()}`);
  console.log(`events derived         : ${events.toLocaleString()}`);
  console.log(`bulk ingest            : ${ingestMs.toFixed(0)}ms`);
  console.log(`rss boot/ingest/end    : ${(rssBoot / 1048576).toFixed(0)} / ${(rssIngest / 1048576).toFixed(0)} / ${(process.memoryUsage.rss() / 1048576).toFixed(0)} MB`);
  console.log(`steady-state batch     : median ${steadyMs.toFixed(2)}ms  p95 ${steadyP95.toFixed(2)}ms`);
  console.log(`  re-sort all events   : ${sortAllMs.toFixed(2)}ms`);
  console.log(`  rebuild all snapshots: ${snapshotAllMs.toFixed(2)}ms`);
  function enginePoints(state: unknown): number {
    const s = state as { engines: Record<number, { closed: unknown[]; draft: unknown }> };
    let total = 0;
    for (const engine of Object.values(s.engines)) {
      for (const ev of engine.closed) {
        const e = ev as { type: string; path?: unknown[]; outliers?: unknown[] };
        total += (e.path?.length ?? 0) + (e.outliers?.length ?? 0);
      }
      const d = engine.draft as { type?: string; path?: unknown[]; outliers?: unknown[]; recent?: unknown[]; pending?: unknown[]; predecessor?: { recent?: unknown[]; pending?: unknown[] } } | null;
      if (d) {
        total += (d.path?.length ?? 0) + (d.outliers?.length ?? 0) + (d.recent?.length ?? 0) + (d.pending?.length ?? 0);
        total += (d.predecessor?.recent?.length ?? 0) + (d.predecessor?.pending?.length ?? 0);
      }
    }
    return total;
  }

  const closingEvents = Object.values(st.eventsByDevice).reduce((a, l) => a + l.filter(e => !e.isDraft).length, 0);

  const pendingHistory = (st as unknown as { drainHistoryRequests: () => unknown[] }).drainHistoryRequests();
  const restartStart = performance.now();
  const restarted = new ServerState(cfg.days + 1);
  restarted.handleDevices(devices);
  const restartMs = performance.now() - restartStart;
  const restoredEvents = Object.values(restarted.eventsByDevice).reduce((a, l) => a + l.filter(e => !e.isDraft).length, 0);

  Bun.gc(true);
  Bun.gc(true);
  const mem = process.memoryUsage();
  
  console.log(`resident positions     : ${positions.toLocaleString()} (hot window)`);
  console.log(`history requests       : ${pendingHistory.length}`);
  console.log(`engine-held points     : ${enginePoints(st).toLocaleString()}`);
  console.log(`cold restart           : ${restartMs.toFixed(0)}ms  events restored ${restoredEvents.toLocaleString()}/${closingEvents.toLocaleString()}`);
  console.log(`live heap / rss        : ${(mem.heapUsed / 1048576).toFixed(0)} MB / ${(mem.rss / 1048576).toFixed(0)} MB`);
  console.log(`db events table        : ${(eventBytes / 1024).toFixed(0)} KB`);
  console.log(`in-memory checkpoints  : ${(cpBytes / 1024).toFixed(0)} KB  (previously ~${((58 * eventBytes) / 1048576).toFixed(0)} MB at 58x)`);

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

const DEVICES = Number(process.argv[2] ?? "10");
const DAYS = Number(process.argv[3] ?? "2");
await run({ devices: DEVICES, days: DAYS, sampleMs: 10_000 });
