/** Mirrors worker/src/types.ts DevicePayload. Keep the two in step. */
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
