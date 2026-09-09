-- Hand-uploaded images belong to whoever uploaded them.
--
-- The upload endpoint authenticates with a *device* key, and device keys are
-- self-minted by an unauthenticated register call. So "authenticated" there
-- meant "anyone", and an upload could take any version string it liked: it
-- could overwrite a CI build in place, become fw_latest, and be preselected in
-- everybody's flash dropdown. Ten junk uploads also evicted every real build
-- through the prune.
--
-- An owner column fixes all three. CI rows have owner NULL and are the only
-- ones the public list offers or fw_latest can point at; an upload is visible
-- only to the device that made it, and only ever displaces other uploads.
ALTER TABLE firmware ADD COLUMN owner TEXT;

CREATE INDEX IF NOT EXISTS firmware_owner ON firmware (owner, uploaded_at DESC);
