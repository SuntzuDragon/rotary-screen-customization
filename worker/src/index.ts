import { buildSnapshot, lastRateRemaining, verifyToken } from './github';
import { buildPayload, diffSnapshots } from './payload';
import {
  clearUserToken,
  getFirmwareBin,
  getFirmwareIndex,
  recentRegistrations,
  publishFirmware,
  putDeviceLog,
  getDeviceLog,
  getStatus,
  putStatus,
  snapshotScope,
  ensureConfig,
  getAuth,
  getConfig,
  getEvents,
  getSnapshot,
  getUserToken,
  listDeviceIds,
  putAuth,
  putConfig,
  putEvents,
  putSnapshot,
  putUserToken,
} from './store';
import { decryptSecret, encryptSecret, safeEqual, sha256Hex } from './crypto';
import { ALL_DECKS, defaultConfig } from './types';
import type { DeckId, DeviceConfig, Env, Theme } from './types';

/** New identities per hour, account-wide. A real device registers once. */
const MAX_NEW_DEVICES_PER_HOUR = 20;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers ?? {}) },
  });

const fail = (status: number, msg: string) => json({ error: msg }, { status });

/** Shared secret check. The device sends its own key; the UI reuses the same one. */
async function authorised(env: Env, id: string, req: Request): Promise<boolean> {
  const auth = await getAuth(env, id);
  if (!auth) return false;
  // Header only. A key in the query string is copied into request logs,
  // analytics, browser history and any Referer the page emits.
  const key = req.headers.get('x-device-key') ?? '';
  if (!key) return false;
  return safeEqual(auth.secretHash, await sha256Hex(key));
}

/** Refresh one login and fold the diff into its event ring. */
export async function refreshLogin(
  env: Env,
  login: string,
  token: string,
  /** Device whose personal token was used, if any -- see snapshotScope. */
  privateForDevice: string | null = null,
): Promise<void> {
  const scope = snapshotScope(login, privateForDevice);
  const prev = await getSnapshot(env, scope);
  // Only a device's own PAT may pull in private repositories -- and when it
  // does, snapshotScope keeps the result out of the shared cache.
  const next = await buildSnapshot(token, login, privateForDevice === null);
  const fresh = diffSnapshots(prev, next);
  if (fresh.length) {
    const ring = await getEvents(env, scope);
    await putEvents(env, scope, [...fresh, ...ring]);
  }

  // Only persist when something actually changed. fetchedAt moves every run, so
  // compare everything else -- on a quiet day this turns 288 writes into none.
  const sameContent =
    prev !== null &&
    JSON.stringify({ ...prev, fetchedAt: 0 }) === JSON.stringify({ ...next, fetchedAt: 0 });
  if (!sameContent) await putSnapshot(env, scope, next);
}

/**
 * The token to use for a device, and whether it belongs to that device.
 *
 * A stored PAT that will not decrypt falls back to the shared token, which is
 * the right behaviour -- the display keeps working -- but it is silent, and it
 * also moves the device out of its private cache scope. `broken` is how
 * GET /api/token tells "you never added one" apart from "yours stopped
 * working", which is what rotating ENC_KEY does to everybody at once.
 */
async function tokenFor(
  env: Env,
  id: string,
): Promise<{ token: string; personal: boolean; broken: boolean }> {
  const stored = await getUserToken(env, id);
  if (stored) {
    const pat = await decryptSecret(env.ENC_KEY, stored);
    if (pat) return { token: pat, personal: true, broken: false };
    console.error(`stored token for ${id} would not decrypt`);
    return { token: env.GH_TOKEN, personal: false, broken: true };
  }
  return { token: env.GH_TOKEN, personal: false, broken: false };
}

async function payloadFor(env: Env, id: string) {
  const config = await ensureConfig(env, id);
  const { personal } = await tokenFor(env, id);
  const scope = snapshotScope(config.login, personal ? id : null);
  const snap = await getSnapshot(env, scope);
  if (!snap) return { config, payload: null };
  const events = await getEvents(env, scope);
  return { config, payload: buildPayload(config, snap, events) };
}

/* ---------- config validation ---------- */

const HEX = /^#[0-9a-fA-F]{6}$/;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function sanitiseConfig(body: unknown, current: DeviceConfig): DeviceConfig | string {
  if (typeof body !== 'object' || body === null) return 'body must be an object';
  const b = body as Record<string, unknown>;

  const login = typeof b.login === 'string' && /^[\w-]{1,39}$/.test(b.login) ? b.login : current.login;

  let repos = current.repos;
  if (b.repos === null) repos = null;
  else if (Array.isArray(b.repos)) {
    if (!b.repos.every((r) => typeof r === 'string')) return 'repos must be strings';
    // GitHub caps repository names at 100 characters; anything longer is
    // padding aimed at the D1 row this gets stringified into.
    if ((b.repos as string[]).some((r) => r.length > 100)) return 'repo name too long';
    repos = (b.repos as string[]).slice(0, 20);
  }

  let decks = current.decks;
  if (Array.isArray(b.decks)) {
    const picked = (b.decks as unknown[]).filter(
      (d): d is DeckId => typeof d === 'string' && (ALL_DECKS as string[]).includes(d),
    );
    if (picked.length === 0) return 'at least one deck is required';
    decks = [...new Set(picked)];
  }

  const t = (b.theme ?? {}) as Record<string, unknown>;
  const theme: Theme = {
    accent: typeof t.accent === 'string' && HEX.test(t.accent) ? t.accent : current.theme.accent,
    bg: typeof t.bg === 'string' && HEX.test(t.bg) ? t.bg : current.theme.bg,
    bright: typeof t.bright === 'number' ? clamp(Math.round(t.bright), 5, 100) : current.theme.bright,
    rotSec: typeof t.rotSec === 'number' ? clamp(Math.round(t.rotSec), 0, 120) : current.theme.rotSec,
  };

  return { login, repos, decks, theme, updatedAt: Math.floor(Date.now() / 1000) };
}

/* ---------- routes ---------- */

async function handleApi(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean); // ['api', resource, id, ...]
  const [, resource, id, sub] = parts;

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, x-device-key, if-none-match',
        'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
      },
    });
  }

  if (!resource) return fail(404, 'not found');
  if (resource === 'health') return json({ ok: true, rate: lastRateRemaining });

  /*
   * Firmware endpoints are unauthenticated on purpose: the flasher fetches the
   * manifest and image straight from the browser before any device exists to
   * authenticate as. The image is a build artefact, not a secret.
   *
   * A caller that *does* present a device key additionally sees its own
   * uploads -- see getFirmwareIndex.
   */
  if (resource === 'firmware') {
    const asker = url.searchParams.get('d') ?? '';
    const viewer =
      /^[a-z0-9]{4,32}$/.test(asker) && (await authorised(env, asker, req)) ? asker : null;
    const index = await getFirmwareIndex(env, viewer);
    const wanted = url.searchParams.get('v') || index?.latest || '';
    const meta = index?.versions.find((v) => v.version === wanted) ?? null;

    if (id === 'list') {
      return json(index ?? { latest: '', versions: [] }, {
        headers: { 'access-control-allow-origin': '*' },
      });
    }

    if (id === 'manifest.json') {
      if (!meta) return fail(404, 'no firmware published yet');
      return json(
        {
          name: 'Rotary Stats',
          version: meta.version,
          new_install_prompt_erase: false,
          builds: [
            {
              chipFamily: 'ESP32-S3',
              parts: [
                {
                  path: `${url.origin}/api/firmware/merged.bin?v=${encodeURIComponent(meta.version)}`,
                  offset: 0,
                },
              ],
            },
          ],
        },
        { headers: { 'access-control-allow-origin': '*' } },
      );
    }

    if (id === 'merged.bin') {
      // Serve by blob presence, not by index membership.
      //
      // The index decides what the dropdown *offers*; it should not gate what
      // can be fetched. Coupling them made the publish readiness check
      // circular: CI asked this endpoint whether the image was downloadable
      // yet, but the endpoint answered 404 because the index row it was
      // waiting to write did not exist.
      const version = meta?.version ?? wanted;
      if (!version) return fail(404, 'no firmware published yet');
      const bin = await getFirmwareBin(env, version);
      if (!bin) return fail(404, 'image not available for that version');
      return new Response(bin, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bin.byteLength),
          'x-fw-version': version,
          'x-fw-sha256': meta?.sha256 ?? '',
          'access-control-allow-origin': '*',
          'access-control-expose-headers': 'x-fw-version, x-fw-sha256',
          'cache-control': 'no-cache',
        },
      });
    }

    // Hand-supplied image from the settings page. Authenticated with a device's
    // own key; the id travels as a query param since the body is the binary,
    // but the key itself goes in a header -- query strings end up in request
    // logs, browser history and Referer.
    if (id === 'upload' && req.method === 'POST') {
      const owner = url.searchParams.get('d') ?? '';
      if (!/^[a-z0-9]{4,32}$/.test(owner)) return fail(400, 'bad device id');
      if (!(await authorised(env, owner, req))) return fail(401, 'unauthorised');

      const bin = await req.arrayBuffer();
      if (bin.byteLength < 64 * 1024) return fail(400, 'that file is too small to be firmware');
      if (bin.byteLength > 8 * 1024 * 1024) return fail(400, 'that file is too large');

      // A merged ESP32 image starts with the 0xE9 magic byte.
      if (new Uint8Array(bin)[0] !== 0xe9) {
        return fail(400, 'not an ESP32 image (missing 0xE9 magic byte)');
      }

      const digest = await crypto.subtle.digest('SHA-256', bin);
      const sha256 = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      // The version is derived, not supplied. A caller-chosen string could name
      // an existing release and replace its bytes in place.
      const version = `custom-${owner}-${sha256.slice(0, 8)}`;

      await publishFirmware(
        env,
        {
          version,
          sha256,
          size: bin.byteLength,
          source: 'upload',
          uploadedAt: Math.floor(Date.now() / 1000),
          owner,
        },
        bin,
      );
      return json({ ok: true, version, sha256, size: bin.byteLength },
        { headers: { 'access-control-allow-origin': '*' } });
    }
  }

  if (!id || !/^[a-z0-9]{4,32}$/.test(id)) return fail(400, 'bad device id');

  /* Trust-on-first-use registration: the device mints its own id + secret. */
  if (resource === 'device' && sub === 'register' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { secret?: string } | null;
    const secret = body?.secret;
    if (typeof secret !== 'string' || secret.length < 16) return fail(400, 'bad secret');

    const hash = await sha256Hex(secret);
    const existing = await getAuth(env, id);
    if (existing && !safeEqual(existing.secretHash, hash)) {
      return fail(409, 'device id already claimed');
    }
    // Anyone can mint an id, so cap how fast new ones appear. Re-registering an
    // id you already hold is always allowed -- that is what a reflashed device
    // does, and it must never be refused because a stranger filled the bucket.
    if (!existing && (await recentRegistrations(env)) >= MAX_NEW_DEVICES_PER_HOUR) {
      return fail(429, 'too many new devices right now, try again later');
    }
    const now = Math.floor(Date.now() / 1000);
    await putAuth(env, id, {
      secretHash: hash,
      registeredAt: existing?.registeredAt ?? now,
      lastSeen: now,
    });
    const config = await ensureConfig(env, id);

    // Warm the cache immediately so the first poll has data to show.
    const { token, personal } = await tokenFor(env, id);
    if (!(await getSnapshot(env, snapshotScope(config.login, personal ? id : null)))) {
      ctx.waitUntil(
        refreshLogin(env, config.login, token, personal ? id : null).catch(() => {}),
      );
    }
    return json({ ok: true, id });
  }

  if (!(await authorised(env, id, req))) return fail(401, 'unauthorised');

  /* Device poll. */
  if (resource === 'device' && !sub && req.method === 'GET') {
    // Status is written sparingly. Recording it on every 60s poll cost ~1440 KV
    // writes a day against a 1000/day free-tier cap -- the debugging niceties
    // were the whole budget. Once every 15 minutes, or immediately if the
    // firmware version changed, keeps "last seen" useful for a fraction of it.
    const reported = req.headers.get('x-fw-version');
    const fwVersion = reported ? reported.slice(0, 32) : null;
    // SSIDs are capped at 32 bytes by the standard; RSSI is a small negative
    // number. Both come off the wire, so neither is trusted for length.
    const ssidHeader = req.headers.get('x-wifi-ssid');
    const wifiSsid = ssidHeader ? ssidHeader.slice(0, 64) : null;
    const rssiHeader = Number(req.headers.get('x-wifi-rssi'));
    const wifiRssi = Number.isFinite(rssiHeader) ? clamp(rssiHeader, -120, 0) : null;

    const now = Math.floor(Date.now() / 1000);
    ctx.waitUntil(
      (async () => {
        const prev = await getStatus(env, id);
        const versionChanged = prev?.fwVersion !== fwVersion;
        const networkChanged = (prev?.wifiSsid ?? null) !== wifiSsid;
        const stale = !prev || now - prev.lastSeen > 900;
        if (versionChanged || networkChanged || stale) {
          await putStatus(env, id, { fwVersion, lastSeen: now, wifiSsid, wifiRssi });
        }
      })(),
    );

    const { payload } = await payloadFor(env, id);
    if (!payload) return fail(503, 'no data yet');

    const body = JSON.stringify(payload);
    const etag = `"${(await sha256Hex(body)).slice(0, 16)}"`;
    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return new Response(body, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        etag,
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*',
      },
    });
  }

  /* Same payload for the browser preview, so what you tune is what renders. */
  if (resource === 'preview' && req.method === 'GET') {
    const { payload } = await payloadFor(env, id);
    return payload
      ? json(payload, { headers: { 'access-control-allow-origin': '*' } })
      : fail(503, 'no data yet');
  }

  /* Device log tail: POSTed by the device, read back for debugging. */
  if (resource === 'log') {
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => null)) as { lines?: unknown } | null;
      if (!Array.isArray(body?.lines)) return fail(400, 'expected {lines: string[]}');
      const lines = (body.lines as unknown[])
        .filter((l): l is string => typeof l === 'string')
        .map((l) => l.slice(0, 240))
        .slice(-200);
      // Only write when the content changed. The device ships a snapshot of its
      // whole ring on every poll, so most uploads are byte-identical to what is
      // already stored and a blind put would burn a write for nothing.
      const existing = await getDeviceLog(env, id);
      const unchanged =
        existing?.lines.length === lines.length &&
        existing.lines.every((l, i) => l === lines[i]);
      if (lines.length && !unchanged) await putDeviceLog(env, id, lines);
      return json({ ok: true, stored: unchanged ? 0 : lines.length });
    }
    if (req.method === 'GET') {
      const log = await getDeviceLog(env, id);
      return json(log ?? { at: 0, lines: [] }, {
        headers: { 'access-control-allow-origin': '*' },
      });
    }
  }

  if (resource === 'status' && req.method === 'GET') {
    const [status, fw] = await Promise.all([getStatus(env, id), getFirmwareIndex(env, id)]);
    return json(
      { device: status, firmware: fw },
      { headers: { 'access-control-allow-origin': '*' } },
    );
  }

  if (resource === 'config') {
    if (req.method === 'GET') {
      return json(await ensureConfig(env, id), {
        headers: { 'access-control-allow-origin': '*' },
      });
    }
    if (req.method === 'PUT') {
      const current = await ensureConfig(env, id);
      const body = await req.json().catch(() => null);
      const next = sanitiseConfig(body, current);
      if (typeof next === 'string') return fail(400, next);
      await putConfig(env, id, next);
      // A changed login has no cached snapshot yet -- fetch it now.
      // A changed username has no cached snapshot yet -- fetch it now.
      const { token, personal } = await tokenFor(env, id);
      const scope = snapshotScope(next.login, personal ? id : null);
      if (next.login !== current.login && !(await getSnapshot(env, scope))) {
        ctx.waitUntil(
          refreshLogin(env, next.login, token, personal ? id : null).catch(() => {}),
        );
      }
      return json(next, { headers: { 'access-control-allow-origin': '*' } });
    }
  }

  /* The repo picker needs the full list, not the filtered one. */
  if (resource === 'repos' && req.method === 'GET') {
    const config = await ensureConfig(env, id);
    // Through snapshotScope like every other read: a device with its own PAT
    // has its data in a private scope, and must not be handed the shared one.
    const { personal } = await tokenFor(env, id);
    const snap = await getSnapshot(env, snapshotScope(config.login, personal ? id : null));
    if (!snap) return fail(503, 'no data yet');
    return json(
      {
        login: snap.login,
        repos: snap.repos.map((r) => ({ name: r.name, stars: r.stars, lang: r.lang })),
      },
      { headers: { 'access-control-allow-origin': '*' } },
    );
  }

  if (resource === 'token') {
    if (req.method === 'GET') {
      const stored = await getUserToken(env, id);
      const { broken } = await tokenFor(env, id);
      return json(
        { present: Boolean(stored), broken },
        { headers: { 'access-control-allow-origin': '*' } },
      );
    }
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => null)) as { token?: string } | null;
      if (typeof body?.token !== 'string' || body.token.length < 20) return fail(400, 'bad token');

      const login = await verifyToken(body.token);
      if (!login) return fail(400, 'GitHub rejected that token');

      await putUserToken(env, id, await encryptSecret(env.ENC_KEY, body.token));
      // Re-fetch straight away so the display reflects the new access.
      const config = await ensureConfig(env, id);
      ctx.waitUntil(refreshLogin(env, config.login, body.token, id).catch(() => {}));
      return json({ ok: true, login }, { headers: { 'access-control-allow-origin': '*' } });
    }
    if (req.method === 'DELETE') {
      await clearUserToken(env, id);
      return json({ ok: true }, { headers: { 'access-control-allow-origin': '*' } });
    }
  }

  if (resource === 'refresh' && req.method === 'POST') {
    const config = await ensureConfig(env, id);
    const { token, personal } = await tokenFor(env, id);
    const scope = snapshotScope(config.login, personal ? id : null);

    // Throttled against the snapshot's own age. Unthrottled, a loop here spends
    // the account's whole GitHub rate limit -- and doubles as a way to scrape
    // GitHub through somebody else's token.
    const snap = await getSnapshot(env, scope);
    const age = snap ? Math.floor(Date.now() / 1000) - snap.fetchedAt : Infinity;
    if (age < 60) {
      return json({ ok: true, skipped: 'too soon', age },
        { headers: { 'access-control-allow-origin': '*' } });
    }

    await refreshLogin(env, config.login, token, personal ? id : null);
    return json({ ok: true }, { headers: { 'access-control-allow-origin': '*' } });
  }

  return fail(404, 'not found');
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(req, env, ctx);
      } catch (err) {
        // The detail goes to the log, not to the caller: these strings come
        // from GitHub and WebCrypto and are not written with an audience in
        // mind.
        console.error('api error', err);
        return fail(500, 'internal error');
      }
    }
    const res = await env.ASSETS.fetch(req);
    const out = new Response(res.body, res);
    // The page holds the device secret in localStorage, so same-origin
    // isolation is what protects it. These make that harder to lose.
    out.headers.set('x-content-type-options', 'nosniff');
    out.headers.set('x-frame-options', 'DENY');
    out.headers.set('referrer-policy', 'no-referrer');
    out.headers.set(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; " +
        // The stylesheet @imports Montserrat from Google Fonts.
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; " +
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; " +
        "base-uri 'none'; form-action 'none'",
    );
    return out;
  },

  /**
   * Fixed-schedule refresh. This is what bounds GitHub API usage: devices poll
   * warm KV and never trigger an upstream request themselves.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const ids = await listDeviceIds(env);

        // Group by cache scope, not by login: devices using the shared token
        // pool into one refresh per username, while a device with its own PAT
        // gets its own, so private repositories never land in a shared cache.
        const jobs = new Map<string, { login: string; token: string; device: string | null }>();
        for (const id of ids) {
          const config = await getConfig(env, id);
          if (!config) continue;
          const { token, personal } = await tokenFor(env, id);
          const device = personal ? id : null;
          const key = snapshotScope(config.login, device);
          if (!jobs.has(key)) jobs.set(key, { login: config.login, token, device });
        }

        for (const [key, job] of jobs) {
          try {
            await refreshLogin(env, job.login, job.token, job.device);
          } catch (err) {
            console.error(`refresh failed for ${key}`, err);
          }
        }
        console.log(`refreshed ${jobs.size} scope(s); rate remaining=${lastRateRemaining}`);
      })(),
    );
  },
};
