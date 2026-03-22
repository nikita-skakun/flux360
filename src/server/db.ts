import { Database } from "bun:sqlite";

export const db = new Database("flux360.sqlite");

// Initialize tables
db.run(`
  CREATE TABLE IF NOT EXISTS position_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    geo_lng REAL NOT NULL,
    geo_lat REAL NOT NULL,
    accuracy REAL NOT NULL,
    timestamp INTEGER NOT NULL,
    created_at INTEGER DEFAULT (cast(strftime('%s', 'now') as int))
  );

  CREATE INDEX IF NOT EXISTS idx_position_events_device_time ON position_events(device_id, timestamp);

  CREATE TABLE IF NOT EXISTS engine_checkpoints (
    device_id INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    PRIMARY KEY (device_id, timestamp)
  );

  CREATE TABLE IF NOT EXISTS device_shares (
    device_id INTEGER NOT NULL,
    shared_with_username TEXT NOT NULL,
    shared_by_username TEXT NOT NULL,
    shared_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, shared_with_username)
  );
  
  CREATE INDEX IF NOT EXISTS idx_device_shares_user ON device_shares(shared_with_username);

  CREATE TABLE IF NOT EXISTS user_tokens (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    traccar_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_active INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_user_tokens_username ON user_tokens(username);
`);
