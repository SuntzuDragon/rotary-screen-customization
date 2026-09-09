-- Device state lives here rather than in KV.
--
-- These records are small, written often, and must be readable immediately
-- after a write -- pushing settings from the browser should take effect at
-- once. KV is eventually consistent (15-30s) and caps writes at 1000/day, so
-- it was the wrong store for this; it keeps the GitHub snapshot, which is
-- read-heavy and rarely written, and is exactly what it is good at.

CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  secret_hash   TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  last_seen     INTEGER,
  fw_version    TEXT,
  config        TEXT NOT NULL          -- JSON DeviceConfig
);

-- One row per device: the tail of its ring buffer, replaced wholesale.
CREATE TABLE IF NOT EXISTS device_logs (
  device_id TEXT PRIMARY KEY,
  at        INTEGER NOT NULL,
  lines     TEXT NOT NULL              -- JSON string[]
);

-- Optional per-user GitHub token, encrypted at rest.
CREATE TABLE IF NOT EXISTS user_tokens (
  device_id TEXT PRIMARY KEY,
  encrypted TEXT NOT NULL
);

-- The cron walks every registered device each tick; make that a cheap scan.
CREATE INDEX IF NOT EXISTS devices_last_seen ON devices (last_seen);
