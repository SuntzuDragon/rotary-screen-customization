import type { DeviceConfig, DevicePayload } from './types';

export interface Session {
  id: string;
  key: string;
}

const LS = 'rotary-stats.session';

/**
 * The device hands the browser `#d=<id>&k=<secret>` through Improv's redirect
 * URL, so a freshly provisioned device lands here already authenticated.
 */
export function readSession(): Session | null {
  const hash = new URLSearchParams(location.hash.slice(1));
  const id = hash.get('d');
  const key = hash.get('k');
  if (id && key) {
    const s = { id, key };
    localStorage.setItem(LS, JSON.stringify(s));
    history.replaceState(null, '', location.pathname);
    return s;
  }
  try {
    const raw = localStorage.getItem(LS);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session): Session {
  localStorage.setItem(LS, JSON.stringify(s));
  return s;
}

export function clearSession() {
  localStorage.removeItem(LS);
}

async function call<T>(s: Session, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/${path}/${s.id}`, {
    ...init,
    headers: { 'x-device-key': s.key, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status}`);
  }
  return (await res.json()) as T;
}

export const getConfig = (s: Session) => call<DeviceConfig>(s, 'config');

export const putConfig = (s: Session, cfg: Partial<DeviceConfig>) =>
  call<DeviceConfig>(s, 'config', { method: 'PUT', body: JSON.stringify(cfg) });

export const getPreview = (s: Session) => call<DevicePayload>(s, 'preview');

export const getRepos = (s: Session) =>
  call<{ login: string; repos: { name: string; stars: number; lang: string | null }[] }>(s, 'repos');

export const refresh = (s: Session) => call<{ ok: true }>(s, 'refresh', { method: 'POST' });

export interface FirmwareMeta {
  version: string;
  sha256: string;
  size: number;
  source: 'ci' | 'upload';
  uploadedAt: number;
}

export interface FirmwareIndex {
  latest: string;
  versions: FirmwareMeta[];
}

export const getStatus = (s: Session) =>
  call<{
    device: { fwVersion: string | null; lastSeen: number } | null;
    firmware: FirmwareIndex | null;
  }>(s, 'status');

/** Public firmware list — no session needed, so flashing never depends on one. */
export async function listFirmware(s?: Session | null): Promise<FirmwareIndex> {
  // With a session the list also carries that device's own uploads; without
  // one it is the published releases, which is all a stranger should see.
  const res = await fetch(
    s ? `/api/firmware/list?d=${encodeURIComponent(s.id)}` : '/api/firmware/list',
    s ? { headers: { 'x-device-key': s.key } } : {},
  );
  if (!res.ok) throw new Error(`could not list firmware (${res.status})`);
  return res.json() as Promise<FirmwareIndex>;
}

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Fetch a published image for flashing, checking it against the digest the
 * index recorded. The hash was stored from the first release and never read;
 * an image that does not match it does not go anywhere near the board.
 */
export async function fetchFirmware(version: string, sha256?: string): Promise<ArrayBuffer> {
  const res = await fetch(`/api/firmware/merged.bin?v=${encodeURIComponent(version)}`);
  if (!res.ok) throw new Error(`could not download ${version} (${res.status})`);
  const bin = await res.arrayBuffer();
  if (sha256) {
    const got = hex(await crypto.subtle.digest('SHA-256', bin));
    if (got !== sha256) {
      throw new Error(`${version} failed its checksum — refusing to flash it`);
    }
  }
  return bin;
}

/**
 * Upload a hand-supplied merged image. The body is the binary itself, so the
 * device id rides in the query string -- but the key goes in a header, since
 * query strings end up in request logs, history and Referer. The version is
 * derived server-side from the image's digest.
 */
export async function uploadFirmware(s: Session, file: File) {
  const res = await fetch(`/api/firmware/upload?d=${encodeURIComponent(s.id)}`, {
    method: 'POST',
    body: file,
    headers: { 'content-type': 'application/octet-stream', 'x-device-key': s.key },
  });
  const body = (await res.json().catch(() => null)) as
    | { error?: string; version?: string; sha256?: string }
    | null;
  if (!res.ok) throw new Error(body?.error ?? `${res.status}`);
  return body as { version: string; sha256: string; size: number };
}

export const tokenStatus = (s: Session) =>
  call<{ present: boolean; broken: boolean }>(s, 'token');

export const setToken = (s: Session, token: string) =>
  call<{ ok: true; login: string }>(s, 'token', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });

export const clearToken = (s: Session) => call<{ ok: true }>(s, 'token', { method: 'DELETE' });
