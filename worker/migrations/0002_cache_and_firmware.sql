-- Everything else moves off KV.
--
-- Keeping half the state in an eventually-consistent store and half in a
-- strongly-consistent one produced two separate "why isn't this updating"
-- bugs: settings took 15-30s to reach the device, and a freshly published
-- firmware version was invisible in the dropdown for up to a minute. One
-- consistency model removes the whole category.
--
-- Binaries go to R2 rather than a column here: they are ~1.4MB each, which is
-- the wrong shape for a SQL row, and R2 is free to 10GB with no egress cost.

CREATE TABLE IF NOT EXISTS snapshots (
  login      TEXT PRIMARY KEY,     -- lowercased GitHub login
  fetched_at INTEGER NOT NULL,
  data       TEXT NOT NULL         -- JSON Snapshot
);

CREATE TABLE IF NOT EXISTS events (
  login TEXT PRIMARY KEY,
  data  TEXT NOT NULL              -- JSON DerivedEvent[]
);

CREATE TABLE IF NOT EXISTS firmware (
  version     TEXT PRIMARY KEY,
  sha256      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  source      TEXT NOT NULL,       -- 'ci' | 'upload'
  uploaded_at INTEGER NOT NULL
);

-- Small singletons: which firmware version is current, etc.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS firmware_uploaded ON firmware (uploaded_at DESC);
