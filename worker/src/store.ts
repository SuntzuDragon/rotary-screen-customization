import type { DeviceConfig, DerivedEvent, Env, Snapshot } from './types';
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
