import { Database } from "bun:sqlite";

export const db = new Database("flux360.sqlite");

// Initialize tables
db.run(`
  CREATE TABLE IF NOT EXISTS position_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deviceId INTEGER NOT NULL,
    geoLon REAL NOT NULL,
    geoLat REAL NOT NULL,
    accuracy REAL NOT NULL,
    timestamp INTEGER NOT NULL,
    createdAt INTEGER DEFAULT (cast(strftime('%s', 'now') as int))
  );

  CREATE INDEX IF NOT EXISTS idx_position_events_device_time ON position_events(deviceId, timestamp);

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
