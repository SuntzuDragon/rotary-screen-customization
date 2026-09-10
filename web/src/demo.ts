/**
 * What the page shows before it is linked to a dial.
 *
 * The setup step used to be its own screen, so you could not see what the
 * product actually did until after you had provisioned one. With a single page
 * the preview needs something to draw, and invented-but-plausible data is a
 * better answer than an empty circle: it makes the controls demonstrate
 * themselves. Every control is disabled in this state, so nothing here can be
 * mistaken for a real device's settings.
 */

import { DEFAULT_ACCENT, type DeviceConfig, type DevicePayload } from './types';

const HOUR = 3600;

export const DEMO_CONFIG: DeviceConfig = {
  login: 'octocat',
  repos: null,
  decks: ['summary', 'repos', 'activity'],
  theme: { accent: DEFAULT_ACCENT, bg: '#0B0D10', bright: 80, rotSec: 8 },
  updatedAt: 0,
};

/** Timestamps are relative so the activity ticker never reads as stale. */
export function demoPayload(): DevicePayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    ttl: 300,
    theme: { ...DEMO_CONFIG.theme },
    decks: [...DEMO_CONFIG.decks],
    p: {
      login: 'octocat',
      name: 'Sample Dial',
      followers: 128,
      stars: 74,
      contrib: 1204,
    },
    repos: [
      {
        n: 'weather-station',
        s: 41,
        f: 6,
        pr: 2,
        i: 3,
        lang: 'Rust',
        col: '#dea584',
        c: now - 5 * HOUR,
        msg: 'Debounce the wind sensor',
      },
      {
        n: 'tiny-http',
        s: 22,
        f: 3,
        pr: 0,
        i: 1,
        lang: 'C',
        col: '#555555',
        c: now - 31 * HOUR,
        msg: 'Handle chunked bodies',
      },
      {
        n: 'dotfiles',
        s: 11,
        f: 1,
        pr: 1,
        i: 0,
        lang: 'Shell',
        col: '#89e051',
        c: now - 96 * HOUR,
        msg: 'Split the shell aliases out',
      },
    ],
    ev: [
      { k: 'star', r: 'weather-station', d: 2, at: now - 2 * HOUR },
      { k: 'pr', r: 'tiny-http', d: 1, at: now - 20 * HOUR },
      { k: 'star', r: 'dotfiles', d: 1, at: now - 50 * HOUR },
    ],
  };
}
