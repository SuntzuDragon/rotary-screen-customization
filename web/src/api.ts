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

/** Fetch a published image for flashing. */
export async function fetchFirmware(version: string): Promise<ArrayBuffer> {
  const res = await fetch(`/api/firmware/merged.bin?v=${encodeURIComponent(version)}`);
  if (!res.ok) throw new Error(`could not download ${version} (${res.status})`);
  return res.arrayBuffer();
}

/** Upload a hand-supplied merged image. The body is the binary itself. */
export async function uploadFirmware(s: Session, file: File, version: string) {
  const res = await fetch(
    `/api/firmware/upload?d=${encodeURIComponent(s.id)}&k=${encodeURIComponent(s.key)}` +
      `&v=${encodeURIComponent(version)}`,
    { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' } },
  );
  const body = (await res.json().catch(() => null)) as { error?: string; sha256?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? `${res.status}`);
  return body as { sha256: string; size: number };
}

export const tokenStatus = (s: Session) => call<{ present: boolean }>(s, 'token');

export const setToken = (s: Session, token: string) =>
  call<{ ok: true; login: string }>(s, 'token', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });

export const clearToken = (s: Session) => call<{ ok: true }>(s, 'token', { method: 'DELETE' });
