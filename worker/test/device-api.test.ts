import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_DEVICE_REPOS, type DeviceConfig } from '../src/types';
import { resetDatabase } from './reset';

// These drive the deployed Worker's own fetch handler against a local D1, so
// they cover routing, authorisation and storage together. Each test starts
// from an empty, fully migrated database (see reset.ts for why that is done
// here rather than left to the test pool).
beforeEach(resetDatabase);

const BASE = 'https://hdog.test';
const SECRET = '0123456789abcdef0123456789abcdef';

const register = (id: string, secret = SECRET) =>
  SELF.fetch(`${BASE}/api/device/${id}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret }),
  });

const getConfig = (id: string, key?: string) =>
  SELF.fetch(`${BASE}/api/config/${id}`, key ? { headers: { 'x-device-key': key } } : {});

const putConfig = (id: string, body: unknown, key = SECRET) =>
  SELF.fetch(`${BASE}/api/config/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-device-key': key },
    body: JSON.stringify(body),
  });

describe('device registration (trust on first use)', () => {
  it('registers a new device', async () => {
    const res = await register('dial0001');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: 'dial0001' });
  });

  // What a reflashed device does: same id, same secret from NVS.
  it('lets a device re-register with its own secret', async () => {
    await register('dial0001');
    expect((await register('dial0001')).status).toBe(200);
  });

  it('refuses a different secret for an id that is already claimed', async () => {
    await register('dial0001');
    const res = await register('dial0001', 'ffffffffffffffffffffffffffffffff');
    expect(res.status).toBe(409);
  });

  it('rejects a secret shorter than 16 characters', async () => {
    expect((await register('dial0001', 'short')).status).toBe(400);
  });

  it('rejects an id that fails the route guard', async () => {
    expect((await register('NOT_VALID')).status).toBe(400);
    expect((await register('abc')).status).toBe(400); // under 4 characters
  });
});

describe('the new-device rate limit', () => {
  // Registration is unauthenticated by necessity, so new ids are capped per
  // hour to stop anyone minting devices fast enough to exhaust GitHub quota.
  it('refuses the 21st new device in an hour', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await register(`dial${String(i).padStart(4, '0')}`)).status).toBe(200);
    }
    expect((await register('dial0020')).status).toBe(429);
  });

  // A stranger filling the bucket must never lock out a real dial coming back
  // from a reflash.
  it('still lets an existing device re-register when the limit is reached', async () => {
    for (let i = 0; i < 20; i++) await register(`dial${String(i).padStart(4, '0')}`);
    expect((await register('dial0000')).status).toBe(200);
  });
});

describe('authorisation', () => {
  it('refuses a request with no device key', async () => {
    await register('dial0001');
    expect((await getConfig('dial0001')).status).toBe(401);
  });

  it('refuses a wrong device key', async () => {
    await register('dial0001');
    expect((await getConfig('dial0001', 'ffffffffffffffffffffffffffffffff')).status).toBe(401);
  });

  it('refuses a device key sent in the query string instead of the header', async () => {
    await register('dial0001');
    const res = await SELF.fetch(`${BASE}/api/config/dial0001?k=${SECRET}`);
    expect(res.status).toBe(401);
  });

  it("never lets one device's key read another device", async () => {
    expect((await register('dial0001', SECRET)).status).toBe(200);
    expect((await register('dial0002', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).status).toBe(200);
    // Each key opens its own device and nothing else.
    expect((await getConfig('dial0001', SECRET)).status).toBe(200);
    expect((await getConfig('dial0002', SECRET)).status).toBe(401);
    expect((await getConfig('dial0002', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).status).toBe(200);
  });

  it('refuses an unregistered id', async () => {
    expect((await getConfig('dial9999', SECRET)).status).toBe(401);
  });
});

describe('device config', () => {
  it('starts a new device on the default account with every deck', async () => {
    await register('dial0001');
    const config = await (await getConfig('dial0001', SECRET)).json<DeviceConfig>();
    expect(config.login).toBe('PlasticRocket'); // DEFAULT_LOGIN in wrangler.toml
    expect(config.decks).toEqual(['summary', 'repos', 'activity']);
    expect(config.repos).toBeNull();
  });

  it('saves a valid change and stamps it with a new version', async () => {
    await register('dial0001');
    const res = await putConfig('dial0001', { decks: ['repos'], theme: { bright: 40 } });
    expect(res.status).toBe(200);
    const saved = await (await getConfig('dial0001', SECRET)).json<DeviceConfig>();
    expect(saved.decks).toEqual(['repos']);
    expect(saved.theme.bright).toBe(40);
    expect(saved.updatedAt).toBeGreaterThan(0);
  });

  it('refuses a change that would leave the dial with no decks', async () => {
    await register('dial0001');
    expect((await putConfig('dial0001', { decks: ['not-a-deck'] })).status).toBe(400);
  });

  it('clamps brightness into the range the backlight accepts', async () => {
    await register('dial0001');
    const low = await (await putConfig('dial0001', { theme: { bright: 0 } })).json<DeviceConfig>();
    const high = await (
      await putConfig('dial0001', { theme: { bright: 900 } })
    ).json<DeviceConfig>();
    expect(low.theme.bright).toBe(5);
    expect(high.theme.bright).toBe(100);
  });

  it(`keeps at most ${MAX_DEVICE_REPOS} chosen repos`, async () => {
    await register('dial0001');
    const repos = Array.from({ length: MAX_DEVICE_REPOS + 3 }, (_, i) => `repo${i}`);
    const saved = await (await putConfig('dial0001', { repos })).json<DeviceConfig>();
    expect(saved.repos).toEqual(repos.slice(0, MAX_DEVICE_REPOS));
  });

  it('refuses a repo name longer than GitHub allows', async () => {
    await register('dial0001');
    expect((await putConfig('dial0001', { repos: ['x'.repeat(101)] })).status).toBe(400);
  });
});
