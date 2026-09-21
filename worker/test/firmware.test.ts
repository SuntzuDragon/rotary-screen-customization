import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/crypto';
import { MAX_FIRMWARE_UPLOADS, publishFirmware } from '../src/store';
import type { FirmwareIndex } from '../src/types';
import { resetDatabase } from './reset';

// Registration is open, so a device key proves nothing about who is uploading.
// An upload must therefore never replace a release, become the default, or be
// offered to anyone but the device that made it -- the default image is what
// people flash onto their dials, and the flasher keeps Wi-Fi credentials.

const BASE = 'https://hdog.test';
const KEY_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const RELEASE = '0.3.2';

/** A plausible merged ESP32 image: 0xE9 magic, then content unique to `seed`. */
function firmware(seed: number, size = 64 * 1024): Uint8Array<ArrayBuffer> {
  const bin = new Uint8Array(size);
  bin[0] = 0xe9;
  for (let i = 1; i < size; i++) bin[i] = (i * 31 + seed) & 0xff;
  return bin;
}

const hex = async (bin: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bin))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const register = (id: string, secret: string) =>
  SELF.fetch(`${BASE}/api/device/${id}/register`, {
    method: 'POST',
    body: JSON.stringify({ secret }),
  });

const upload = (id: string, key: string, bin: Uint8Array) =>
  SELF.fetch(`${BASE}/api/firmware/upload?d=${id}`, {
    method: 'POST',
    headers: { 'x-device-key': key },
    body: bin,
  });

const list = async (asker?: { id: string; key: string }) => {
  const res = await SELF.fetch(
    `${BASE}/api/firmware/list${asker ? `?d=${asker.id}` : ''}`,
    asker ? { headers: { 'x-device-key': asker.key } } : {},
  );
  return res.json<FirmwareIndex>();
};

const releaseBin = firmware(1);

beforeEach(async () => {
  await resetDatabase();
  // What CI publishes on a tag: owner null.
  await publishFirmware(
    env,
    {
      version: RELEASE,
      sha256: await hex(releaseBin),
      size: releaseBin.byteLength,
      source: 'ci',
      uploadedAt: 1_000,
      owner: null,
    },
    releaseBin.buffer,
  );
  expect((await register('dialaaaa', KEY_A)).status).toBe(200);
  expect((await register('dialbbbb', KEY_B)).status).toBe(200);
});

describe('an uploaded image', () => {
  it('gets a version derived from its owner and digest, not one the caller chooses', async () => {
    const bin = firmware(2);
    const res = await upload('dialaaaa', KEY_A, bin);
    expect(res.status).toBe(200);
    const body = await res.json<{ version: string; sha256: string }>();
    const sha = await hex(bin);
    expect(body).toMatchObject({ version: `custom-dialaaaa-${sha.slice(0, 8)}`, sha256: sha });
  });

  it('never becomes the default firmware', async () => {
    await upload('dialaaaa', KEY_A, firmware(2));
    expect((await list()).latest).toBe(RELEASE);
    expect((await list({ id: 'dialaaaa', key: KEY_A })).latest).toBe(RELEASE);
  });

  it('never replaces the bytes of a release', async () => {
    await upload('dialaaaa', KEY_A, firmware(2));
    const res = await SELF.fetch(`${BASE}/api/firmware/merged.bin?v=${RELEASE}`);
    expect(await hex(new Uint8Array(await res.arrayBuffer()))).toBe(await hex(releaseBin));
  });

  it('is offered only to the device that uploaded it', async () => {
    const { version } = await (
      await upload('dialaaaa', KEY_A, firmware(2))
    ).json<{
      version: string;
    }>();
    const versions = async (asker?: { id: string; key: string }) =>
      (await list(asker)).versions.map((v) => v.version);

    expect(await versions({ id: 'dialaaaa', key: KEY_A })).toContain(version);
    expect(await versions()).not.toContain(version);
    expect(await versions({ id: 'dialbbbb', key: KEY_B })).not.toContain(version);
    // Naming the owner without its key is the same as asking anonymously.
    expect(await versions({ id: 'dialaaaa', key: KEY_B })).not.toContain(version);
  });

  it(`is kept to the newest ${MAX_FIRMWARE_UPLOADS} per device, without touching releases`, async () => {
    for (let seed = 2; seed < 2 + MAX_FIRMWARE_UPLOADS + 2; seed++) {
      expect((await upload('dialaaaa', KEY_A, firmware(seed))).status).toBe(200);
    }
    const mine = (await list({ id: 'dialaaaa', key: KEY_A })).versions;
    expect(mine.filter((v) => v.owner === 'dialaaaa')).toHaveLength(MAX_FIRMWARE_UPLOADS);
    expect(mine.some((v) => v.version === RELEASE)).toBe(true);
  });
});

describe('the store itself', () => {
  // Defence in depth under the route: even a caller that reached publishFirmware
  // with a release's version string could not take it over.
  it('refuses to let a device claim a version that is not its own', async () => {
    const bin = firmware(9);
    await expect(
      publishFirmware(
        env,
        {
          version: RELEASE,
          sha256: await sha256Hex('x'),
          size: bin.byteLength,
          source: 'upload',
          uploadedAt: 2_000,
          owner: 'dialaaaa',
        },
        bin.buffer,
      ),
    ).rejects.toThrow('already belongs to someone else');
    const row = await env.DB.prepare('SELECT owner FROM firmware WHERE version = ?')
      .bind(RELEASE)
      .first<{ owner: string | null }>();
    expect(row?.owner).toBeNull();
  });
});

describe('uploads that are refused', () => {
  it('without the right device key', async () => {
    expect((await upload('dialaaaa', KEY_B, firmware(2))).status).toBe(401);
  });

  it('with a malformed device id', async () => {
    expect((await upload('NOT_VALID', KEY_A, firmware(2))).status).toBe(400);
  });

  it('too small to be firmware', async () => {
    expect((await upload('dialaaaa', KEY_A, firmware(2, 1024))).status).toBe(400);
  });

  it('too large to be firmware', async () => {
    expect((await upload('dialaaaa', KEY_A, firmware(2, 8 * 1024 * 1024 + 1))).status).toBe(400);
  });

  it('without the ESP32 image magic byte', async () => {
    const bin = firmware(2);
    bin[0] = 0x00;
    expect((await upload('dialaaaa', KEY_A, bin)).status).toBe(400);
  });
});
