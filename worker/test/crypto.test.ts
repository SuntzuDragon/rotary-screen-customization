import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  newDeviceId,
  newSecret,
  safeEqual,
  sha256Hex,
} from '../src/crypto';

const KEY = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='; // 32 x 0x01
const OTHER_KEY = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI='; // 32 x 0x02

describe('sha256Hex', () => {
  it('matches the standard test vector', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('safeEqual', () => {
  it('accepts identical strings', () => {
    expect(safeEqual('a1b2c3', 'a1b2c3')).toBe(true);
  });

  it('rejects a single differing character', () => {
    expect(safeEqual('a1b2c3', 'a1b2c4')).toBe(false);
  });

  it('rejects strings of different lengths', () => {
    expect(safeEqual('a1b2c3', 'a1b2c')).toBe(false);
  });
});

describe('newDeviceId', () => {
  it('passes the route guard that every device URL is checked against', () => {
    for (let i = 0; i < 200; i++) expect(newDeviceId()).toMatch(/^[a-z0-9]{4,32}$/);
  });

  it('never uses the look-alike characters l, 1, o or 0', () => {
    const ids = Array.from({ length: 500 }, newDeviceId).join('');
    expect(ids).not.toMatch(/[l1o0]/);
  });
});

describe('newSecret', () => {
  it('is long enough for registration, which rejects secrets under 16 chars', () => {
    expect(newSecret()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a token', async () => {
    const blob = await encryptSecret(KEY, 'github_pat_example');
    expect(await decryptSecret(KEY, blob)).toBe('github_pat_example');
  });

  it('uses a fresh IV every time, so the same token never encrypts the same way twice', async () => {
    const [a, b] = await Promise.all([encryptSecret(KEY, 'same'), encryptSecret(KEY, 'same')]);
    expect(a).not.toBe(b);
  });

  // This is what a rotated ENC_KEY does to every stored token. It must come
  // back null -- which GET /api/token reports as "broken" -- rather than throw.
  it('returns null under a different key', async () => {
    const blob = await encryptSecret(KEY, 'github_pat_example');
    expect(await decryptSecret(OTHER_KEY, blob)).toBeNull();
  });

  it('returns null for tampered ciphertext', async () => {
    const blob = await encryptSecret(KEY, 'github_pat_example');
    const [iv, ct] = blob.split('.') as [string, string];
    const flipped = (ct.startsWith('A') ? 'B' : 'A') + ct.slice(1);
    expect(await decryptSecret(KEY, `${iv}.${flipped}`)).toBeNull();
  });

  it('returns null for a malformed blob', async () => {
    expect(await decryptSecret(KEY, 'not-a-blob')).toBeNull();
    expect(await decryptSecret(KEY, '')).toBeNull();
  });
});
