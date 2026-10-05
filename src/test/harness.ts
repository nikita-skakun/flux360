import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "flux360-test-"));
process.env["FLUX360_DB_PATH"] = join(dir, "test.sqlite");

export const { db } = await import("@/server/db");
export const { ServerState } = await import("@/server/serverState");

const TABLES = [
  "events",
  "engine_checkpoints",
  "group_members",
  "groups",
  "device_metadata",
  "device_shares",
  "user_tokens",
];

export function resetDatabase() {
  for (const table of TABLES) db.run(`DELETE FROM ${table}`);
}

// One shared temp directory serves every test file in this process, so cleanup
// is tied to process exit rather than to any single file's afterAll.
export function cleanupDatabase() {
  rmSync(dir, { recursive: true, force: true });
}

export function countRows(table: string): number {
  return (db.query(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
}

export function countRowsFor(table: string, column: string, value: number): number {
  return (db.query(`SELECT count(*) AS c FROM ${table} WHERE ${column} = ?`).get(value) as { c: number }).c;
}

export type State = InstanceType<typeof ServerState>;

export type EventRow = { type: string; start: number; end: number; isDraft?: boolean };

export function closedEventsFor(state: State, id: number): EventRow[] {
  return ((state.eventsByDevice[id] ?? []) as EventRow[]).filter(e => !e.isDraft);
}

/** Mirror the checkpoint write the server does, in both memory and the database. */
export function seedCheckpoint(state: State, id: number) {
  const engine = (state as unknown as { engines: Record<number, { createSnapshot: () => unknown }> }).engines[id];
  if (!engine) throw new Error(`no engine for ${id}`);
  const snapshot = engine.createSnapshot();
  const timestamp = Date.now();
  db.run(`INSERT OR REPLACE INTO engine_checkpoints (deviceId, timestamp, snapshotJson) VALUES (?, ?, ?)`, [id, timestamp, JSON.stringify(snapshot)]);
  const checkpoints = (state as unknown as { engineCheckpoints: Record<number, { timestamp: number; snapshot: unknown }[]> }).engineCheckpoints;
  checkpoints[id] = [{ timestamp, snapshot }];
}

export function pendingHistoryRequests(state: State): { deviceId: number; from: number; to: number }[] {
  return (state as unknown as { drainHistoryRequests: () => { deviceId: number; from: number; to: number }[] }).drainHistoryRequests();
}

export function checkpointCount(state: State, id: number): number {
  return ((state as unknown as { engineCheckpoints: Record<number, unknown[]> }).engineCheckpoints[id] ?? []).length;
}

export function internals(state: State): {
  engineCheckpoints: Record<number, { timestamp: number; snapshot: unknown }[]>;
  positionsAll: unknown[];
  eventRows: Record<number, Map<string, number>>;
} {
  return state as unknown as {
    engineCheckpoints: Record<number, { timestamp: number; snapshot: unknown }[]>;
    positionsAll: unknown[];
    eventRows: Record<number, Map<string, number>>;
  };
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
