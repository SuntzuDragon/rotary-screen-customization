import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/crypto';
import { putSnapshot, putUserToken, snapshotScope } from '../src/store';
import type { DevicePayload, DeviceStatus, Snapshot } from '../src/types';
import { resetDatabase } from './reset';

// GET /api/device/:id is what every dial calls once a minute. It never talks
// to GitHub itself -- it serves the cache the cron fills -- so these tests put
// a snapshot in the cache and drive the route directly.

const BASE = 'https://hdog.test';
const ID = 'dial0001';
const KEY = '0123456789abcdef0123456789abcdef';
const LOGIN = 'PlasticRocket'; // DEFAULT_LOGIN, so a new dial starts on it

const snapshot: Snapshot = {
  fetchedAt: 1_000,
  login: LOGIN,
  name: 'Harnoor',
  followers: 7,
  contributions: 120,
  repos: [
    {
      name: 'rotary',
      lang: 'C++',
      langColor: '#f34b7d',
      stars: 3,
      forks: 0,
      openPRs: 1,
      openIssues: 2,
      lastCommitAt: 900,
      lastCommitMsg: 'Initial commit',
    },
  ],
  feed: [],
};

const poll = (headers: Record<string, string> = {}) =>
  SELF.fetch(`${BASE}/api/device/${ID}`, { headers: { 'x-device-key': KEY, ...headers } });

/** Give the dial its own GitHub token, as pasting one on the settings page does. */
async function connectGithub(encKey = env.ENC_KEY) {
  await putUserToken(env, ID, await encryptSecret(encKey, 'github_pat_test'), LOGIN);
}

beforeEach(async () => {
  await resetDatabase();
  const reg = await SELF.fetch(`${BASE}/api/device/${ID}/register`, {
    method: 'POST',
    body: JSON.stringify({ secret: KEY }),
  });
  expect(reg.status).toBe(200);
});

describe('a dial with no GitHub access', () => {
  it('is told to connect GitHub', async () => {
    expect((await poll()).status).toBe(428);
  });

  // A snapshot left in the cache from before can no longer be refreshed.
  // Serving it would show frozen numbers that look live, and hide the
  // "Connect GitHub" screen the dial ought to be showing.
  it('is not served stale cached data, even when some exists', async () => {
    await putSnapshot(env, snapshotScope(LOGIN, null), snapshot);
    expect((await poll()).status).toBe(428);
  });

  // What rotating ENC_KEY does to every stored token.
  it('is told to connect GitHub when its stored token can no longer be decrypted', async () => {
    await connectGithub('AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI='); // not the server's key
    await putSnapshot(env, snapshotScope(LOGIN, ID), snapshot);
    expect((await poll()).status).toBe(428);
  });
});

describe('a connected dial', () => {
  beforeEach(async () => {
    await connectGithub();
    await putSnapshot(env, snapshotScope(LOGIN, ID), snapshot);
  });

  it('gets its payload', async () => {
    const res = await poll();
    expect(res.status).toBe(200);
    const payload = await res.json<DevicePayload>();
    expect(payload.p).toMatchObject({ login: LOGIN, followers: 7, stars: 3 });
    expect(payload.repos.map((r) => r.n)).toEqual(['rotary']);
  });

  it('is still refused without its key', async () => {
    const res = await SELF.fetch(`${BASE}/api/device/${ID}`);
    expect(res.status).toBe(401);
  });

  // The dial polls every minute and the answer rarely changes, so it sends the
  // ETag it last saw and gets an empty 304 -- most polls cost almost nothing.
  it('gets an empty 304 when it already has the current payload', async () => {
    const first = await poll();
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);

    const again = await poll({ 'if-none-match': etag! });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
  });

  it('gets the full payload again once the content changes', async () => {
    const etag = (await poll()).headers.get('etag')!;
    await putSnapshot(env, snapshotScope(LOGIN, ID), { ...snapshot, followers: 8 });
    const res = await poll({ 'if-none-match': etag });
    expect(res.status).toBe(200);
    expect((await res.json<DevicePayload>()).p.followers).toBe(8);
  });

  // The settings page waits on this to say "Live on the dial" -- it has to be a
  // statement from the device, stored as soon as the device reports it.
  it('records the settings version the dial reports it is showing', async () => {
    await poll({ 'x-config-applied': '1234', 'x-fw-version': '0.3.2' });

    // The status write happens in waitUntil, after the response is sent.
    let device: DeviceStatus | null = null;
    for (let i = 0; i < 20 && device?.configApplied !== 1234; i++) {
      const res = await SELF.fetch(`${BASE}/api/status/${ID}`, {
        headers: { 'x-device-key': KEY },
      });
      device = (await res.json<{ device: DeviceStatus | null }>()).device;
      if (device?.configApplied !== 1234) await new Promise((r) => setTimeout(r, 25));
    }
    expect(device).toMatchObject({ configApplied: 1234, fwVersion: '0.3.2' });
  });
});
