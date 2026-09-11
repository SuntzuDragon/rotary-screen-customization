import type {
  DeviceConfig,
  DerivedEvent,
  DeviceStatus,
  Env,
  FirmwareIndex,
  FirmwareMeta,
  Snapshot,
} from './types';
import { ALL_DECKS, defaultConfig } from './types';

/*
 * Device state lives in D1; the GitHub snapshot stays in KV.
 *
 * Reads fall back to the old KV keys once and migrate the row across, so a
 * device provisioned before this change keeps its identity and settings. The
 * legacy keys are left in place rather than deleted -- they cost nothing and a
 * rollback stays possible.
 */
const legacyCfgKey = (id: string) => `dev:${id}:cfg`;
const legacyAuthKey = (id: string) => `dev:${id}:auth`;
const legacyPatKey = (id: string) => `dev:${id}:pat`;

// Snapshots and derived events are keyed by GitHub login, not device, so two
// devices watching the same account share one set of API calls.
const snapKey = (login: string) => `snap:${login.toLowerCase()}`;
const evKey = (login: string) => `ev:${login.toLowerCase()}`;

export interface DeviceAuth {
  secretHash: string;
  registeredAt: number;
  lastSeen: number;
}

interface DeviceRow {
  id: string;
  secret_hash: string;
  registered_at: number;
  last_seen: number | null;
  fw_version: string | null;
  wifi_ssid: string | null;
  wifi_rssi: number | null;
  config_applied: number | null;
  config: string;
}

async function getJSON<T>(env: Env, k: string): Promise<T | null> {
  return env.DEVICES.get<T>(k, 'json');
}

const row = (env: Env, id: string) =>
  env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(id).first<DeviceRow>();

/** Pull a pre-D1 device across on first touch. Returns the migrated row. */
async function migrateFromKv(env: Env, id: string): Promise<DeviceRow | null> {
  const [auth, cfg] = await Promise.all([
    getJSON<DeviceAuth>(env, legacyAuthKey(id)),
    getJSON<DeviceConfig>(env, legacyCfgKey(id)),
  ]);
  if (!auth) return null;

  const config = cfg ?? defaultConfig(env.DEFAULT_LOGIN);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO devices (id, secret_hash, registered_at, last_seen, fw_version, config)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  )
    .bind(id, auth.secretHash, auth.registeredAt, auth.lastSeen, JSON.stringify(config))
    .run();

  const pat = await env.DEVICES.get(legacyPatKey(id), 'text');
  if (pat) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO user_tokens (device_id, encrypted) VALUES (?, ?)',
    )
      .bind(id, pat)
      .run();
  }
  return row(env, id);
}

async function deviceRow(env: Env, id: string): Promise<DeviceRow | null> {
  return (await row(env, id)) ?? (await migrateFromKv(env, id));
}

export async function getAuth(env: Env, id: string): Promise<DeviceAuth | null> {
  const r = await deviceRow(env, id);
  return r
    ? { secretHash: r.secret_hash, registeredAt: r.registered_at, lastSeen: r.last_seen ?? 0 }
    : null;
}

export async function putAuth(env: Env, id: string, a: DeviceAuth) {
  await env.DB.prepare(
    `INSERT INTO devices (id, secret_hash, registered_at, last_seen, config)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET secret_hash = excluded.secret_hash,
                                   last_seen   = excluded.last_seen`,
  )
    .bind(id, a.secretHash, a.registeredAt, a.lastSeen, JSON.stringify(defaultConfig(env.DEFAULT_LOGIN)))
    .run();
}

export async function getConfig(env: Env, id: string): Promise<DeviceConfig | null> {
  const r = await deviceRow(env, id);
  if (!r) return null;
  try {
    return JSON.parse(r.config) as DeviceConfig;
  } catch {
    return null;
  }
}

export async function putConfig(env: Env, id: string, c: DeviceConfig) {
  await env.DB.prepare('UPDATE devices SET config = ? WHERE id = ?')
    .bind(JSON.stringify(c), id)
    .run();
}

export async function ensureConfig(env: Env, id: string): Promise<DeviceConfig> {
  const existing = await getConfig(env, id);
  if (existing) {
    // Migrate stored configs forward: a deck that no longer exists would
    // otherwise linger and show up as a screen the firmware cannot render.
    const decks = existing.decks.filter((d) => (ALL_DECKS as string[]).includes(d));
    if (decks.length !== existing.decks.length) {
      const migrated = { ...existing, decks: decks.length ? decks : [...ALL_DECKS] };
      await putConfig(env, id, migrated);
      return migrated;
    }
    return existing;
  }
  const fresh = defaultConfig(env.DEFAULT_LOGIN);
  await putConfig(env, id, fresh);
  return fresh;
}

export async function getStatus(env: Env, id: string): Promise<DeviceStatus | null> {
  const r = await deviceRow(env, id);
  return r
    ? {
        fwVersion: r.fw_version,
        lastSeen: r.last_seen ?? 0,
        wifiSsid: r.wifi_ssid ?? null,
        wifiRssi: r.wifi_rssi ?? null,
        configApplied: r.config_applied ?? null,
      }
    : null;
}

export async function putStatus(env: Env, id: string, st: DeviceStatus) {
  await env.DB.prepare(
    `UPDATE devices SET fw_version = ?, last_seen = ?, wifi_ssid = ?, wifi_rssi = ?,
                        config_applied = ? WHERE id = ?`,
  )
    .bind(
      st.fwVersion,
      st.lastSeen,
      st.wifiSsid ?? null,
      st.wifiRssi ?? null,
      st.configApplied ?? null,
      id,
    )
    .run();
}

/* ---------- snapshots and events ---------- */

/**
 * Cache scope for a login's snapshot.
 *
 * Public data fetched with the shared token is cached per login, so several
 * devices watching the same account cost one set of API calls. Data fetched
 * with somebody's *own* token is not shareable -- it can include their private
 * repositories -- so it is cached per device instead. Without this split, one
 * user adding a PAT would publish their private repos to every other device
 * watching the same username.
 */
export const snapshotScope = (login: string, privateForDevice: string | null) =>
  privateForDevice ? `${login.toLowerCase()}#${privateForDevice}` : login.toLowerCase();

/** Reads fall back to the old KV keys once, so nothing is lost in the move. */
export async function getSnapshot(env: Env, scope: string): Promise<Snapshot | null> {
  const key = scope.toLowerCase();
  const r = await env.DB.prepare('SELECT data FROM snapshots WHERE login = ?')
    .bind(key)
    .first<{ data: string }>();
  if (r) {
    try {
      return JSON.parse(r.data) as Snapshot;
    } catch {
      return null;
    }
  }
  const legacy = await getJSON<Snapshot>(env, snapKey(key));
  if (legacy) await putSnapshot(env, key, legacy);
  return legacy;
}

export async function putSnapshot(env: Env, scope: string, s: Snapshot) {
  await env.DB.prepare(
    `INSERT INTO snapshots (login, fetched_at, data) VALUES (?, ?, ?)
     ON CONFLICT(login) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data`,
  )
    .bind(scope.toLowerCase(), s.fetchedAt, JSON.stringify(s))
    .run();
}

export async function getEvents(env: Env, scope: string): Promise<DerivedEvent[]> {
  const r = await env.DB.prepare('SELECT data FROM events WHERE login = ?')
    .bind(scope.toLowerCase())
    .first<{ data: string }>();
  if (r) {
    try {
      return JSON.parse(r.data) as DerivedEvent[];
    } catch {
      return [];
    }
  }
  return (await getJSON<DerivedEvent[]>(env, evKey(scope))) ?? [];
}

/** Keep a bounded ring of synthesised events -- the device renders a handful. */
export async function putEvents(env: Env, scope: string, ev: DerivedEvent[]) {
  await env.DB.prepare(
    `INSERT INTO events (login, data) VALUES (?, ?)
     ON CONFLICT(login) DO UPDATE SET data = excluded.data`,
  )
    .bind(scope.toLowerCase(), JSON.stringify(ev.slice(0, 25)))
    .run();
}

/* ---------- user tokens ---------- */

/** A pasted token replaces whatever this device had, app sign-in included. */
export async function putUserToken(
  env: Env,
  id: string,
  encrypted: string,
  login: string | null = null,
) {
  await env.DB.prepare(
    `INSERT INTO user_tokens (device_id, encrypted, kind, login) VALUES (?, ?, 'pat', ?)
     ON CONFLICT(device_id) DO UPDATE SET
       encrypted = excluded.encrypted, kind = 'pat', login = excluded.login,
       refresh_enc = NULL, expires_at = NULL, refresh_expires_at = NULL,
       version = user_tokens.version + 1, lease_until = NULL`,
  )
    .bind(id, encrypted, login)
    .run();
}

export async function getUserToken(env: Env, id: string): Promise<string | null> {
  await deviceRow(env, id); // ensures a pre-D1 device has been migrated
  const r = await env.DB.prepare('SELECT encrypted FROM user_tokens WHERE device_id = ?')
    .bind(id)
    .first<{ encrypted: string }>();
  return r?.encrypted ?? null;
}

/* ---------- GitHub App sign-in ---------- */

export interface GithubAuthRow {
  kind: 'pat' | 'app';
  /** The access token for an app sign-in, or the PAT itself. Encrypted. */
  encrypted: string;
  login: string | null;
  refresh_enc: string | null;
  expires_at: number | null;
  refresh_expires_at: number | null;
  version: number;
  lease_until: number | null;
}

export async function getGithubAuth(env: Env, id: string): Promise<GithubAuthRow | null> {
  await deviceRow(env, id); // ensures a pre-D1 device has been migrated
  return env.DB.prepare(
    `SELECT kind, encrypted, login, refresh_enc, expires_at, refresh_expires_at, version, lease_until
       FROM user_tokens WHERE device_id = ?`,
  )
    .bind(id)
    .first<GithubAuthRow>();
}

export interface AppTokenWrite {
  /** Both already encrypted. */
  access: string;
  refresh: string;
  expiresAt: number;
  refreshExpiresAt: number;
}

/** A fresh app sign-in replaces whatever this device had. */
export async function putAppToken(env: Env, id: string, t: AppTokenWrite & { login: string }) {
  await env.DB.prepare(
    `INSERT INTO user_tokens
       (device_id, encrypted, kind, login, refresh_enc, expires_at, refresh_expires_at, version, lease_until)
     VALUES (?, ?, 'app', ?, ?, ?, ?, 0, NULL)
     ON CONFLICT(device_id) DO UPDATE SET
       encrypted = excluded.encrypted, kind = 'app', login = excluded.login,
       refresh_enc = excluded.refresh_enc, expires_at = excluded.expires_at,
       refresh_expires_at = excluded.refresh_expires_at,
       version = user_tokens.version + 1, lease_until = NULL`,
  )
    .bind(id, t.access, t.login, t.refresh, t.expiresAt, t.refreshExpiresAt)
    .run();
}

/**
 * Claim the right to spend this row's refresh token. The conditional update is
 * the lock: exactly one caller per version gets `true`.
 */
export async function claimRefresh(env: Env, id: string, version: number, now: number) {
  const r = await env.DB.prepare(
    `UPDATE user_tokens SET lease_until = ?
      WHERE device_id = ? AND version = ? AND (lease_until IS NULL OR lease_until < ?)`,
  )
    .bind(now + 30, id, version, now)
    .run();
  return (r.meta.changes ?? 0) === 1;
}

/**
 * Store a refreshed pair -- but only over the version the lease was taken on,
 * so a new sign-in that landed meanwhile is never overwritten by an old refresh.
 */
export async function storeRefreshed(env: Env, id: string, version: number, t: AppTokenWrite) {
  await env.DB.prepare(
    `UPDATE user_tokens
        SET encrypted = ?, refresh_enc = ?, expires_at = ?, refresh_expires_at = ?,
            version = version + 1, lease_until = NULL
      WHERE device_id = ? AND version = ?`,
  )
    .bind(t.access, t.refresh, t.expiresAt, t.refreshExpiresAt, id, version)
    .run();
}

/** Hold off further refresh attempts until `until` -- used to back off after a failure. */
export async function setRefreshLease(env: Env, id: string, version: number, until: number) {
  await env.DB.prepare('UPDATE user_tokens SET lease_until = ? WHERE device_id = ? AND version = ?')
    .bind(until, id, version)
    .run();
}

/** Sign-ins in flight live ten minutes. */
const OAUTH_STATE_TTL = 600;

export async function putOAuthState(env: Env, state: string, deviceId: string, binderHash: string) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    // Sweep abandoned flows while here, so the table never accumulates.
    env.DB.prepare('DELETE FROM oauth_states WHERE created_at < ?').bind(now - OAUTH_STATE_TTL),
    env.DB.prepare(
      'INSERT INTO oauth_states (state, device_id, binder_hash, created_at) VALUES (?, ?, ?, ?)',
    ).bind(state, deviceId, binderHash, now),
  ]);
}

/** Single use: the row is deleted as it is read. Null when missing or stale. */
export async function takeOAuthState(
  env: Env,
  state: string,
): Promise<{ deviceId: string; binderHash: string } | null> {
  const r = await env.DB.prepare(
    'DELETE FROM oauth_states WHERE state = ? RETURNING device_id, binder_hash, created_at',
  )
    .bind(state)
    .first<{ device_id: string; binder_hash: string; created_at: number }>();
  if (!r || Math.floor(Date.now() / 1000) - r.created_at > OAUTH_STATE_TTL) return null;
  return { deviceId: r.device_id, binderHash: r.binder_hash };
}

export async function clearUserToken(env: Env, id: string) {
  // The cached data this token fetched goes with it. Those rows are keyed
  // `login#deviceid` and nothing else ever reads them, so leaving them behind
  // means private repository data outliving the credential that fetched it.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_tokens WHERE device_id = ?').bind(id),
    env.DB.prepare('DELETE FROM snapshots WHERE login LIKE ?').bind(`%#${id}`),
    env.DB.prepare('DELETE FROM events WHERE login LIKE ?').bind(`%#${id}`),
  ]);
}

/* ---------- device logs ---------- */

export const MAX_LOG_LINES = 200;

export async function getDeviceLog(env: Env, id: string) {
  const r = await env.DB.prepare('SELECT at, lines FROM device_logs WHERE device_id = ?')
    .bind(id)
    .first<{ at: number; lines: string }>();
  if (!r) return null;
  try {
    return { at: r.at, lines: JSON.parse(r.lines) as string[] };
  } catch {
    return null;
  }
}

/**
 * Replace, never append. The device ships a snapshot of its whole ring, so this
 * is idempotent -- and appending against an eventually-consistent store used to
 * lose the very boot sequence we were trying to read.
 */
export async function putDeviceLog(env: Env, id: string, lines: string[]) {
  await env.DB.prepare(
    `INSERT INTO device_logs (device_id, at, lines) VALUES (?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET at = excluded.at, lines = excluded.lines`,
  )
    .bind(id, Math.floor(Date.now() / 1000), JSON.stringify(lines.slice(-MAX_LOG_LINES)))
    .run();
}

/* ---------- firmware ---------- */

/*
 * Firmware: metadata in D1, images in KV.
 *
 * The index moved so a published release shows up in the dropdown at once
 * rather than after KV's read lag. The images stayed: they are ~1.4MB blobs
 * read a handful of times, which is a shape KV handles well and a SQL row does
 * not. R2 would be tidier still, but it has to be switched on in the dashboard
 * and that flow asks for a card even for the free tier -- not worth it for
 * 14MB.
 *
 * Ordering matters when publishing: write the image, confirm it is readable,
 * then insert the row. The index is the source of truth, so a version can never
 * be advertised before its image can actually be downloaded.
 */
const fwBinKey = (version: string) => `fw:bin:${version}`;

export const MAX_FIRMWARE_VERSIONS = 10;

/** Per-device cap on hand-uploaded images. */
export const MAX_FIRMWARE_UPLOADS = 3;

/** Ceiling on how many devices one cron run will refresh. */
export const MAX_CRON_DEVICES = 200;

export const getFirmwareBin = (env: Env, version: string) =>
  env.DEVICES.get(fwBinKey(version), 'arrayBuffer');

/**
 * The builds a caller may choose from: every CI build, plus that caller's own
 * uploads. Anyone can mint a device id, so an upload is only ever offered back
 * to the device that made it -- otherwise the dropdown would be a way to put a
 * stranger's binary in front of somebody about to flash their board.
 */
export async function getFirmwareIndex(
  env: Env,
  viewer: string | null = null,
): Promise<FirmwareIndex | null> {
  const rows = await env.DB.prepare(
    `SELECT version, sha256, size, source, uploaded_at, owner FROM firmware
      WHERE owner IS NULL OR owner = ?
      ORDER BY uploaded_at DESC`,
  ).bind(viewer).all<{
    version: string;
    sha256: string;
    size: number;
    source: string;
    uploaded_at: number;
    owner: string | null;
  }>();

  const versions = (rows.results ?? []).map((r) => ({
    version: r.version,
    sha256: r.sha256,
    size: r.size,
    source: r.source as 'ci' | 'upload',
    uploadedAt: r.uploaded_at,
    owner: r.owner,
  }));
  if (versions.length === 0) return null;

  // fw_latest only ever names a CI build, so fall back to the newest one of
  // those rather than to versions[0], which could be the caller's own upload.
  const latest = await env.DB.prepare("SELECT value FROM meta WHERE key = 'fw_latest'")
    .first<{ value: string }>();
  const newestCi = versions.find((v) => v.owner === null);
  return { latest: latest?.value ?? newestCi?.version ?? versions[0]!.version, versions };
}

/**
 * Store an image, pruning beyond MAX_FIRMWARE_VERSIONS.
 *
 * A CI build (owner null) becomes the latest. An upload never does, and never
 * overwrites a row it does not own -- both are how a self-minted device key
 * would otherwise turn into "everybody's default firmware".
 */
export async function publishFirmware(env: Env, meta: FirmwareMeta, bin: ArrayBuffer) {
  const owner = meta.owner ?? null;

  const claimed = await env.DB.prepare('SELECT owner FROM firmware WHERE version = ?')
    .bind(meta.version)
    .first<{ owner: string | null }>();
  if (claimed && (claimed.owner ?? null) !== owner) {
    throw new Error(`version ${meta.version} already belongs to someone else`);
  }

  await env.DEVICES.put(fwBinKey(meta.version), bin);

  const writes = [
    env.DB.prepare(
      `INSERT INTO firmware (version, sha256, size, source, uploaded_at, owner)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(version) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size,
                                          source = excluded.source,
                                          uploaded_at = excluded.uploaded_at`,
    ).bind(meta.version, meta.sha256, meta.size, meta.source, meta.uploadedAt, owner),
  ];
  if (owner === null) {
    writes.push(
      env.DB.prepare(
        `INSERT INTO meta (key, value) VALUES ('fw_latest', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).bind(meta.version),
    );
  }
  await env.DB.batch(writes);

  // Prune within the owner's own bucket. Sharing one bucket meant a handful of
  // junk uploads could evict every real release.
  const stale = await env.DB.prepare(
    owner === null
      ? 'SELECT version FROM firmware WHERE owner IS NULL ORDER BY uploaded_at DESC LIMIT -1 OFFSET ?1'
      : 'SELECT version FROM firmware WHERE owner = ?2 ORDER BY uploaded_at DESC LIMIT -1 OFFSET ?1',
  )
    .bind(...(owner === null ? [MAX_FIRMWARE_VERSIONS] : [MAX_FIRMWARE_UPLOADS, owner]))
    .all<{ version: string }>();
  for (const r of stale.results ?? []) {
    await env.DEVICES.delete(fwBinKey(r.version));
    await env.DB.prepare('DELETE FROM firmware WHERE version = ?').bind(r.version).run();
  }
}

/**
 * Device ids the cron job should refresh. A SELECT, where KV needed a
 * rate-limited list.
 *
 * Registration is open, so the row count is not something we control. Bounding
 * this on last_seen keeps the GitHub call budget proportional to the devices
 * actually in use rather than to the number of ids anyone has ever minted, and
 * taking the oldest first means a burst of new rows cannot crowd out the
 * devices that have been running for months.
 */
export async function listDeviceIds(env: Env, activeWithin = 7 * 86400): Promise<string[]> {
  const cutoff = Math.floor(Date.now() / 1000) - activeWithin;
  const res = await env.DB.prepare(
    `SELECT id FROM devices WHERE last_seen IS NOT NULL AND last_seen >= ?
      ORDER BY registered_at ASC LIMIT ?`,
  )
    .bind(cutoff, MAX_CRON_DEVICES)
    .all<{ id: string }>();
  return (res.results ?? []).map((r) => r.id);
}

/**
 * How many devices registered in the last hour.
 *
 * Registration is deliberately open -- a device mints its own identity on first
 * boot, with nothing to authenticate against. That makes an hourly ceiling the
 * only thing standing between a script and an unbounded devices table.
 */
export async function recentRegistrations(env: Env, withinSeconds = 3600): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE registered_at >= ?')
    .bind(Math.floor(Date.now() / 1000) - withinSeconds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
