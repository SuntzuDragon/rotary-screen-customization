import { buildSnapshot, lastRateRemaining, verifyToken } from './github';
import { buildPayload, diffSnapshots } from './payload';
import {
  clearUserToken,
  getFirmwareBin,
  getFirmwareMeta,
  putFirmwareBin,
  putFirmwareMeta,
  getStatus,
  putStatus,
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
  const key =
    req.headers.get('x-device-key') ?? new URL(req.url).searchParams.get('k') ?? '';
  if (!key) return false;
  return safeEqual(auth.secretHash, await sha256Hex(key));
}

/** Refresh one login and fold the diff into its event ring. */
export async function refreshLogin(env: Env, login: string, token: string): Promise<void> {
  const prev = await getSnapshot(env, login);
  const next = await buildSnapshot(token, login);
  const fresh = diffSnapshots(prev, next);
  if (fresh.length) {
    const ring = await getEvents(env, login);
    await putEvents(env, login, [...fresh, ...ring]);
  }
  await putSnapshot(env, login, next);
}

async function tokenFor(env: Env, id: string): Promise<string> {
  const stored = await getUserToken(env, id);
  if (stored) {
    const pat = await decryptSecret(env.ENC_KEY, stored);
    if (pat) return pat;
  }
  return env.GH_TOKEN;
}

async function payloadFor(env: Env, id: string) {
  const config = await ensureConfig(env, id);
  const snap = await getSnapshot(env, config.login);
  if (!snap) return { config, payload: null };
  const events = await getEvents(env, config.login);
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
   * Firmware endpoints are unauthenticated on purpose: esp-web-tools fetches
   * the manifest and image straight from the browser before any device exists
   * to authenticate as. The image is a build artefact, not a secret.
   */
  if (resource === 'firmware') {
    const meta = await getFirmwareMeta(env);

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
              parts: [{ path: `${url.origin}/api/firmware/merged.bin`, offset: 0 }],
            },
          ],
        },
        { headers: { 'access-control-allow-origin': '*' } },
      );
    }

    if (id === 'merged.bin') {
      const bin = await getFirmwareBin(env);
      if (!bin) return fail(404, 'no firmware published yet');
      return new Response(bin, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bin.byteLength),
          'access-control-allow-origin': '*',
          'cache-control': 'no-cache',
        },
      });
    }

    if (id === 'meta') {
      return meta
        ? json(meta, { headers: { 'access-control-allow-origin': '*' } })
        : fail(404, 'no firmware published yet');
    }

    // Hand-supplied image from the settings page. Authenticated with a device's
    // own key, passed as query params since the body is the binary.
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

      await putFirmwareBin(env, bin);
      await putFirmwareMeta(env, {
        version: (url.searchParams.get('v') || 'custom').slice(0, 32),
        sha256,
        size: bin.byteLength,
        source: 'upload',
        uploadedAt: Math.floor(Date.now() / 1000),
      });
      return json({ ok: true, sha256, size: bin.byteLength },
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
    const now = Math.floor(Date.now() / 1000);
    await putAuth(env, id, {
      secretHash: hash,
      registeredAt: existing?.registeredAt ?? now,
      lastSeen: now,
    });
    const config = await ensureConfig(env, id);

    // Warm the cache immediately so the first poll has data to show.
    if (!(await getSnapshot(env, config.login))) {
      ctx.waitUntil(refreshLogin(env, config.login, await tokenFor(env, id)).catch(() => {}));
    }
    return json({ ok: true, id });
  }

  if (!(await authorised(env, id, req))) return fail(401, 'unauthorised');

  /* Device poll. */
  if (resource === 'device' && !sub && req.method === 'GET') {
    const reported = req.headers.get('x-fw-version');
    ctx.waitUntil(
      putStatus(env, id, {
        fwVersion: reported ? reported.slice(0, 32) : null,
        lastSeen: Math.floor(Date.now() / 1000),
      }),
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

  if (resource === 'status' && req.method === 'GET') {
    const [status, fw] = await Promise.all([getStatus(env, id), getFirmwareMeta(env)]);
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
      if (next.login !== current.login && !(await getSnapshot(env, next.login))) {
        ctx.waitUntil(refreshLogin(env, next.login, await tokenFor(env, id)).catch(() => {}));
      }
      return json(next, { headers: { 'access-control-allow-origin': '*' } });
    }
  }

  /* The repo picker needs the full list, not the filtered one. */
  if (resource === 'repos' && req.method === 'GET') {
    const config = await ensureConfig(env, id);
    const snap = await getSnapshot(env, config.login);
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
      return json(
        { present: Boolean(stored) },
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
      ctx.waitUntil(refreshLogin(env, config.login, body.token).catch(() => {}));
      return json({ ok: true, login }, { headers: { 'access-control-allow-origin': '*' } });
    }
    if (req.method === 'DELETE') {
      await clearUserToken(env, id);
      return json({ ok: true }, { headers: { 'access-control-allow-origin': '*' } });
    }
  }

  if (resource === 'refresh' && req.method === 'POST') {
    const config = await ensureConfig(env, id);
    await refreshLogin(env, config.login, await tokenFor(env, id));
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
        console.error('api error', err);
        return fail(500, err instanceof Error ? err.message : 'internal error');
      }
    }
    return env.ASSETS.fetch(req);
  },

  /**
   * Fixed-schedule refresh. This is what bounds GitHub API usage: devices poll
   * warm KV and never trigger an upstream request themselves.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const ids = await listDeviceIds(env);
        const byLogin = new Map<string, string>(); // login -> token to use
        for (const id of ids) {
          const config = await getConfig(env, id);
          if (!config) continue;
          if (!byLogin.has(config.login)) byLogin.set(config.login, await tokenFor(env, id));
        }
        for (const [login, token] of byLogin) {
          try {
            await refreshLogin(env, login, token);
          } catch (err) {
            console.error(`refresh failed for ${login}`, err);
          }
        }
        console.log(`refreshed ${byLogin.size} login(s); rate remaining=${lastRateRemaining}`);
      })(),
    );
  },
};
