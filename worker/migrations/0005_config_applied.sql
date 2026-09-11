-- What the dial is actually showing.
--
-- "Pushed" was confirmed by re-reading the service's own payload, which proves
-- the write landed and nothing about the device. The dial now echoes back the
-- config.updatedAt it last applied, so the settings page can say "the dial has
-- these settings" as a fact rather than a guess about propagation.
ALTER TABLE devices ADD COLUMN config_applied INTEGER;
