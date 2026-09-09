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

const cfgKey = (id: string) => `dev:${id}:cfg`;
const authKey = (id: string) => `dev:${id}:auth`;
// Snapshots and derived events are keyed by GitHub login, not device, so two
// devices watching the same account share one set of API calls.
const snapKey = (login: string) => `snap:${login.toLowerCase()}`;
const evKey = (login: string) => `ev:${login.toLowerCase()}`;
const patKey = (id: string) => `dev:${id}:pat`;

export interface DeviceAuth {
  secretHash: string;
  registeredAt: number;
  lastSeen: number;
}

async function getJSON<T>(env: Env, k: string): Promise<T | null> {
  return env.DEVICES.get<T>(k, 'json');
}

export const getConfig = (env: Env, id: string) => getJSON<DeviceConfig>(env, cfgKey(id));
export const getAuth = (env: Env, id: string) => getJSON<DeviceAuth>(env, authKey(id));
export const getSnapshot = (env: Env, login: string) => getJSON<Snapshot>(env, snapKey(login));

export async function getEvents(env: Env, login: string): Promise<DerivedEvent[]> {
  return (await getJSON<DerivedEvent[]>(env, evKey(login))) ?? [];
}

export const putConfig = (env: Env, id: string, c: DeviceConfig) =>
  env.DEVICES.put(cfgKey(id), JSON.stringify(c));

export const putAuth = (env: Env, id: string, a: DeviceAuth) =>
  env.DEVICES.put(authKey(id), JSON.stringify(a));

export const putSnapshot = (env: Env, login: string, s: Snapshot) =>
  env.DEVICES.put(snapKey(login), JSON.stringify(s));

/** Keep a bounded ring of synthesised events -- the device only renders a handful. */
export const putEvents = (env: Env, login: string, ev: DerivedEvent[]) =>
  env.DEVICES.put(evKey(login), JSON.stringify(ev.slice(0, 25)));

export async function ensureConfig(env: Env, id: string): Promise<DeviceConfig> {
  const existing = await getConfig(env, id);
  if (existing) {
    // Migrate stored configs forward: a deck that no longer exists (the
    // sparkline, say) would otherwise linger in KV and show up in the config
    // UI as a screen the firmware cannot render.
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

export const putUserToken = (env: Env, id: string, encrypted: string) =>
  env.DEVICES.put(patKey(id), encrypted);

export const getUserToken = (env: Env, id: string) => env.DEVICES.get(patKey(id), 'text');
export const clearUserToken = (env: Env, id: string) => env.DEVICES.delete(patKey(id));

/* ---------- firmware ---------- */

// Merged images live in KV rather than R2: ~1.4MB each against a 25MB
// per-value limit, and it keeps the whole deploy to a single binding. Each
// published version is kept so the settings page can offer a choice, including
// rolling back.
const FW_INDEX = 'fw:index';
const fwBinKey = (version: string) => `fw:bin:${version}`;
const statusKey = (id: string) => `dev:${id}:status`;

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

export const getStatus = (env: Env, id: string) => getJSON<DeviceStatus>(env, statusKey(id));

/**
 * Recent device log lines, shipped over Wi-Fi.
 *
 * The serial port is exactly what is unavailable when provisioning misbehaves --
 * the browser holds it — so the one moment worth observing is the one moment we
 * cannot attach a monitor. Shipping a bounded tail over HTTP makes that
 * debuggable without the cable.
 */
const logKey = (id: string) => `dev:${id}:log`;

export const MAX_LOG_LINES = 200;

export const getDeviceLog = (env: Env, id: string) =>
  getJSON<{ at: number; lines: string[] }>(env, logKey(id));

/**
 * Overwrite, never append.
 *
 * The device ships a snapshot of its whole ring each time, so a plain put is
 * correct and idempotent. Appending meant a read-modify-write against KV, which
 * is eventually consistent -- a second shipment could read a stale copy and
 * silently discard the first, which is exactly how the boot sequence kept
 * disappearing from the log we were using to debug the boot sequence.
 */
export async function putDeviceLog(env: Env, id: string, lines: string[]) {
  await env.DEVICES.put(
    logKey(id),
    JSON.stringify({
      at: Math.floor(Date.now() / 1000),
      lines: lines.slice(-MAX_LOG_LINES),
    }),
  );
}

export const putStatus = (env: Env, id: string, s: DeviceStatus) =>
  env.DEVICES.put(statusKey(id), JSON.stringify(s));

/** Device ids known to the cron job. */
export async function listDeviceIds(env: Env): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.DEVICES.list({ prefix: 'dev:', cursor, limit: 1000 });
    for (const k of page.keys) {
      const m = /^dev:([^:]+):cfg$/.exec(k.name);
      if (m?.[1]) ids.push(m[1]);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return ids;
}
