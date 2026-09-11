-- GitHub sign-in through a GitHub App, alongside pasted tokens.
--
-- A pasted PAT is one long-lived secret. An app sign-in is a pair: an access
-- token that dies after eight hours and a six-month refresh token that is
-- single-use -- every refresh returns a new pair and kills the old one.
-- `version` and `lease_until` exist for that: two requests refreshing at once
-- would otherwise both spend the same refresh token, and the second would find
-- it already gone and mark a good sign-in as broken.
ALTER TABLE user_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'pat';
ALTER TABLE user_tokens ADD COLUMN login TEXT;
ALTER TABLE user_tokens ADD COLUMN refresh_enc TEXT;
ALTER TABLE user_tokens ADD COLUMN expires_at INTEGER;
ALTER TABLE user_tokens ADD COLUMN refresh_expires_at INTEGER;
ALTER TABLE user_tokens ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_tokens ADD COLUMN lease_until INTEGER;

-- One row per sign-in in flight, deleted as it is used. `binder_hash` ties the
-- flow to the browser that started it; see the callback route for why.
CREATE TABLE IF NOT EXISTS oauth_states (
  state       TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL,
  binder_hash TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
