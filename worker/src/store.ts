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
  return r ? { fwVersion: r.fw_version, lastSeen: r.last_seen ?? 0 } : null;
}

export async function putStatus(env: Env, id: string, st: DeviceStatus) {
  await env.DB.prepare('UPDATE devices SET fw_version = ?, last_seen = ? WHERE id = ?')
    .bind(st.fwVersion, st.lastSeen, id)
    .run();
}

/* ---------- snapshots and events stay in KV ---------- */

export const getSnapshot = (env: Env, login: string) => getJSON<Snapshot>(env, snapKey(login));

export async function getEvents(env: Env, login: string): Promise<DerivedEvent[]> {
  return (await getJSON<DerivedEvent[]>(env, evKey(login))) ?? [];
}

export const putSnapshot = (env: Env, login: string, s: Snapshot) =>
  env.DEVICES.put(snapKey(login), JSON.stringify(s));

/** Keep a bounded ring of synthesised events -- the device renders a handful. */
export const putEvents = (env: Env, login: string, ev: DerivedEvent[]) =>
  env.DEVICES.put(evKey(login), JSON.stringify(ev.slice(0, 25)));

/* ---------- user tokens ---------- */

export async function putUserToken(env: Env, id: string, encrypted: string) {
  await env.DB.prepare(
    `INSERT INTO user_tokens (device_id, encrypted) VALUES (?, ?)
     ON CONFLICT(device_id) DO UPDATE SET encrypted = excluded.encrypted`,
  )
    .bind(id, encrypted)
    .run();
}

export async function getUserToken(env: Env, id: string): Promise<string | null> {
  await deviceRow(env, id); // ensures a pre-D1 device has been migrated
  const r = await env.DB.prepare('SELECT encrypted FROM user_tokens WHERE device_id = ?')
    .bind(id)
    .first<{ encrypted: string }>();
  return r?.encrypted ?? null;
}

export async function clearUserToken(env: Env, id: string) {
  await env.DB.prepare('DELETE FROM user_tokens WHERE device_id = ?').bind(id).run();
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

// Merged images live in KV rather than R2: ~1.4MB each against a 25MB
// per-value limit, and it keeps the whole deploy to a single binding. Each
// published version is kept so the settings page can offer a choice, including
// rolling back.
const FW_INDEX = 'fw:index';
const fwBinKey = (version: string) => `fw:bin:${version}`;

export const MAX_FIRMWARE_VERSIONS = 10;

export const getFirmwareIndex = (env: Env) => getJSON<FirmwareIndex>(env, FW_INDEX);

export const getFirmwareBin = (env: Env, version: string) =>
  env.DEVICES.get(fwBinKey(version), 'arrayBuffer');

/**
 * Store a build and make it the latest. Older builds are pruned beyond
 * MAX_FIRMWARE_VERSIONS so KV cannot grow without bound; a re-published version
 * replaces the existing entry rather than duplicating it.
 */
export async function publishFirmware(env: Env, meta: FirmwareMeta, bin: ArrayBuffer) {
  await env.DEVICES.put(fwBinKey(meta.version), bin);

  const index = (await getFirmwareIndex(env)) ?? { latest: meta.version, versions: [] };
  const versions = [meta, ...index.versions.filter((v) => v.version !== meta.version)];

  for (const stale of versions.slice(MAX_FIRMWARE_VERSIONS)) {
    await env.DEVICES.delete(fwBinKey(stale.version));
  }
  await env.DEVICES.put(
    FW_INDEX,
    JSON.stringify({ latest: meta.version, versions: versions.slice(0, MAX_FIRMWARE_VERSIONS) }),
  );
}

/** Device ids known to the cron job. A SELECT, where KV needed a rate-limited list. */
export async function listDeviceIds(env: Env): Promise<string[]> {
  const res = await env.DB.prepare('SELECT id FROM devices').all<{ id: string }>();
  return (res.results ?? []).map((r) => r.id);
}
