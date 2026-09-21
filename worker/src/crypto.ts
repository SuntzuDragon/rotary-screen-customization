const enc = new TextEncoder();
const dec = new TextDecoder();

const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

/** Length-independent constant-time compare for hex digests. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Exactly 32 symbols, with no look-alikes (l/1/o/0). The count matters: each
 * random byte keeps its low 5 bits, so every symbol is equally likely only
 * because 32 divides 256. A 31- or 33-symbol set would bias every id.
 */
const B32 = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Short, unambiguous device id -- also readable off the screen if ever needed. */
export function newDeviceId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return [...b].map((x) => B32[x & 0x1f]).join('');
}

export function newSecret(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
}

/* ---------- AES-GCM for user-supplied PATs ---------- */

const b64d = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64e = (b: Uint8Array) => btoa(String.fromCharCode(...b));

async function key(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64d(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(encKey: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await key(encKey),
    enc.encode(plain),
  );
  return `${b64e(iv)}.${b64e(new Uint8Array(ct))}`;
}

export async function decryptSecret(encKey: string, blob: string): Promise<string | null> {
  const [ivPart, ctPart] = blob.split('.');
  if (!ivPart || !ctPart) return null;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64d(ivPart) },
      await key(encKey),
      b64d(ctPart),
    );
    return dec.decode(pt);
  } catch {
    return null;
  }
}
