import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";

const DB_PATH = process.env["FLUX360_DB_PATH"] ?? "data/flux360.sqlite";

mkdirSync(DB_PATH.slice(0, DB_PATH.lastIndexOf("/")) || ".", { recursive: true });

export const db = new Database(DB_PATH);

db.run("PRAGMA foreign_keys = ON;");
// Write-ahead logging keeps a commit from paying a full fsync, which otherwise
// shows up as sporadic 150-200ms stalls on position ingest.
db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA synchronous = NORMAL;");

// Initialize tables
// Traccar holds raw positions, so the local position cache is no longer created.
// Drop it on databases that predate that change so the space is reclaimed.
db.run(`DROP TABLE IF EXISTS position_events;`);

db.run(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entityId INTEGER NOT NULL,
    type TEXT NOT NULL,
    start INTEGER NOT NULL,
    end INTEGER NOT NULL,
    eventJson TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_entity_range ON events(entityId, start, end);

  CREATE TABLE IF NOT EXISTS engine_checkpoints (
    deviceId INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    snapshotJson TEXT NOT NULL,
    PRIMARY KEY (deviceId, timestamp)
  );

  CREATE TABLE IF NOT EXISTS device_shares (
    deviceId INTEGER NOT NULL,
    sharedWith TEXT NOT NULL,
    sharedBy TEXT NOT NULL,
    sharedAt INTEGER NOT NULL,
    PRIMARY KEY (deviceId, sharedWith)
  );
  
  CREATE INDEX IF NOT EXISTS idx_device_shares_user ON device_shares(sharedWith);

  CREATE TABLE IF NOT EXISTS user_tokens (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    traccarToken TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    lastActive INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_user_tokens_username ON user_tokens(username);

  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    icon TEXT,
    color TEXT,
    motionProfile TEXT,
    createdAt INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_groups_owner_username ON groups(owner);

  CREATE TABLE IF NOT EXISTS group_members (
    groupId INTEGER NOT NULL,
    deviceId INTEGER NOT NULL,
    PRIMARY KEY (groupId, deviceId),
    FOREIGN KEY (groupId) REFERENCES groups(id) ON DELETE CASCADE
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_device_single_group ON group_members(deviceId);

  CREATE TABLE IF NOT EXISTS device_metadata (
    deviceId INTEGER PRIMARY KEY,
    icon TEXT,
    color TEXT,
    motionProfile TEXT,
    updatedAt INTEGER NOT NULL
  );
`);
