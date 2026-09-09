export interface Env {
  DEVICES: KVNamespace;
  DB: D1Database;
  ASSETS: Fetcher;
  GH_TOKEN: string;
  ENC_KEY: string;
  DEFAULT_LOGIN: string;
}

export type DeckId = 'summary' | 'repos' | 'activity';

export const ALL_DECKS: DeckId[] = ['summary', 'repos', 'activity'];

export interface Theme {
  accent: string;
  bg: string;
  bright: number; // 5..100, backlight duty
  rotSec: number; // 0 = manual only, else auto-advance seconds
}

export interface DeviceConfig {
  login: string;
  /** Explicit repo selection and display order. null = every non-fork repo. */
  repos: string[] | null;
  decks: DeckId[];
  theme: Theme;
  updatedAt: number;
}

export const DEFAULT_THEME: Theme = {
  accent: '#F74C00',
  bg: '#0B0D10',
  bright: 80,
  rotSec: 8,
};

export function defaultConfig(login: string): DeviceConfig {
  return {
    login,
    repos: null,
    decks: [...ALL_DECKS],
    theme: { ...DEFAULT_THEME },
    updatedAt: 0,
  };
}

/* ---------- snapshots (server-side, verbose) ---------- */

export interface RepoSnapshot {
  name: string;
  lang: string | null;
  langColor: string | null;
  stars: number;
  forks: number;
  openPRs: number;
  openIssues: number;
  /** Newest commit on the default branch. Not pushedAt -- see docs/research-findings.md */
  lastCommitAt: number | null;
  lastCommitMsg: string | null;
}

export interface FeedEvent {
  type: string;
  repo: string;
  at: number;
}

export interface Snapshot {
  fetchedAt: number;
  login: string;
  name: string | null;
  followers: number;
  contributions: number;
  repos: RepoSnapshot[];
  feed: FeedEvent[];
}

/** Worker-synthesised event from diffing two snapshots. */
export interface DerivedEvent {
  k: 'star' | 'fork' | 'pr' | 'issue' | 'push';
  r: string;
  d: number; // signed delta
  at: number;
}

/* ---------- firmware / OTA ---------- */

/**
 * Firmware is flashed over USB from the browser (esp-web-tools), not over the
 * air. A merged image covering 0x0 onward means the manifest has a single part
 * and there is no partition arithmetic in the browser.
 */
export interface FirmwareMeta {
  version: string;
  sha256: string;
  size: number;
  /** 'ci' for a tagged build, 'upload' for a hand-supplied binary. */
  source: 'ci' | 'upload';
  uploadedAt: number;
}

/** Every published build, so the settings page can offer a choice. */
export interface FirmwareIndex {
  latest: string;
  versions: FirmwareMeta[];
}

export interface DeviceStatus {
  fwVersion: string | null;
  lastSeen: number;
}

/* ---------- device payload (short keys, ~3KB budget) ---------- */

export interface PayloadRepo {
  n: string;
  s: number;
  f: number;
  pr: number;
  i: number;
  lang: string | null;
  col: string | null;
  /** epoch seconds of last default-branch commit */
  c: number | null;
  msg: string | null;
}

export interface DevicePayload {
  ttl: number;
  theme: Theme;
  decks: DeckId[];
  p: {
    login: string;
    name: string | null;
    followers: number;
    stars: number;
    contrib: number;
  };
  repos: PayloadRepo[];
  /** merged derived + feed events, newest first */
  ev: { k: string; r: string; d: number; at: number }[];
}
