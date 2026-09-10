/** Mirrors worker/src/types.ts DevicePayload. Keep the two in step. */

/**
 * How many repo cards the dial can hold. Mirrors MAX_DEVICE_REPOS in
 * worker/src/types.ts and kMaxRepos in firmware/src/model/stats.h.
 */
export const MAX_DEVICE_REPOS = 8;

/** Matches DEFAULT_THEME.accent in worker/src/types.ts. */
export const DEFAULT_ACCENT = '#F74C00';

export interface Theme {
  accent: string;
  bg: string;
  bright: number;
  rotSec: number;
}

export type DeckId = 'summary' | 'repos' | 'activity';

export interface PayloadRepo {
  n: string;
  s: number;
  f: number;
  pr: number;
  i: number;
  lang: string | null;
  col: string | null;
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
  ev: { k: string; r: string; d: number; at: number }[];
}

export interface DeviceConfig {
  login: string;
  repos: string[] | null;
  decks: DeckId[];
  theme: Theme;
  updatedAt: number;
}
