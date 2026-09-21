import {
  GitHubError,
  buildSnapshot,
  exchangeCode,
  lastRateRemaining,
  refreshUserToken,
  revokeGrant,
  verifyToken,
} from './github';
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
  listDeviceIds,
  putAuth,
  putConfig,
  putEvents,
  putSnapshot,
  putUserToken,
  getGithubAuth,
  putAppToken,
  claimRefresh,
  storeRefreshed,
  setRefreshLease,
  putOAuthState,
  takeOAuthState,
  type GithubAuthRow,
} from './store';
import { decryptSecret, encryptSecret, safeEqual, sha256Hex } from './crypto';
import { ALL_DECKS, MAX_DEVICE_REPOS } from './types';
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
 * A stored token that will not work falls back to the shared one, which keeps
 * the display going -- but it is silent, and it also moves the device out of
 * its private cache scope. `broken` is how GET /api/token tells "you never
 * connected" apart from "yours stopped working".
 */
async function tokenFor(
  env: Env,
  id: string,
): Promise<{ token: string | null; personal: boolean; broken: boolean }> {
  const row = await getGithubAuth(env, id);
  if (!row) return { token: env.GH_TOKEN ?? null, personal: false, broken: false };

  const token =
    row.kind === 'app'
      ? await appAccessToken(env, id, row)
      : await decryptSecret(env.ENC_KEY, row.encrypted);
  if (token) return { token, personal: true, broken: false };

  console.error(`stored ${row.kind} token for ${id} is unusable`);
  return { token: env.GH_TOKEN ?? null, personal: false, broken: true };
}

/** Renew this long before expiry, so whoever loses the lease still holds a valid token. */
const REFRESH_AHEAD = 15 * 60;
/** After a failed renewal, wait this long before trying again rather than every poll. */
const REFRESH_BACKOFF = 15 * 60;

/**
 * The current access token for an app sign-in, renewed first if it is close to
 * expiry.
 *
 * Refresh tokens are single-use: spending one returns a new pair and kills the
 * old. Two requests renewing at once would both spend the same token and the
 * second would find it gone, marking a good sign-in as broken. So renewal takes
 * a lease -- a conditional update only one caller can win -- and starts well
 * before expiry, so a caller that loses the race simply keeps using the current
 * token, which is still valid.
 */
async function appAccessToken(env: Env, id: string, row: GithubAuthRow): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  const current = await decryptSecret(env.ENC_KEY, row.encrypted);
  const expiresAt = row.expires_at ?? 0;
  if (current && expiresAt - now > REFRESH_AHEAD) return current;

  const stillValid = current && expiresAt > now + 30 ? current : null;
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return stillValid;
  if ((row.refresh_expires_at ?? 0) <= now) return stillValid; // needs a fresh sign-in
  if (!(await claimRefresh(env, id, row.version, now))) return stillValid;

  try {
    const refresh = row.refresh_enc ? await decryptSecret(env.ENC_KEY, row.refresh_enc) : null;
    if (!refresh) throw new Error('refresh token would not decrypt');
    const pair = await refreshUserToken(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET, refresh);
    await storeRefreshed(env, id, row.version, {
      access: await encryptSecret(env.ENC_KEY, pair.accessToken),
      refresh: await encryptSecret(env.ENC_KEY, pair.refreshToken),
      expiresAt: now + pair.expiresIn,
      refreshExpiresAt: now + pair.refreshExpiresIn,
    });
    return pair.accessToken;
  } catch (err) {
    // Usually a withdrawn authorization. Back off rather than retrying on every
    // poll; the page reports it as broken once the current token runs out.
    console.error(`token renewal failed for ${id}`, err);
    await setRefreshLease(env, id, row.version, now + REFRESH_BACKOFF);
    return stillValid;
  }
}

async function payloadFor(env: Env, id: string) {
  const config = await ensureConfig(env, id);
  const { token, personal } = await tokenFor(env, id);
  // No connection of its own and no shared token: nothing will ever fill the cache.
  const hasAccess = Boolean(token);
  // Without access, never serve a cached snapshot. One left in the shared scope
  // from when a shared token existed can no longer be refreshed, so serving it
  // shows frozen stats that look live -- and hides the "Connect GitHub" screen
  // the dial should be showing instead.
  if (!hasAccess) return { config, payload: null, hasAccess };
  const scope = snapshotScope(config.login, personal ? id : null);
  const snap = await getSnapshot(env, scope);
  if (!snap) return { config, payload: null, hasAccess };
  const events = await getEvents(env, scope);
  return { config, payload: buildPayload(config, snap, events), hasAccess };
}

/* ---------- config validation ---------- */

const HEX = /^#[0-9a-fA-F]{6}$/;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function sanitiseConfig(body: unknown, current: DeviceConfig): DeviceConfig | string {
  if (typeof body !== 'object' || body === null) return 'body must be an object';
  const b = body as Record<string, unknown>;

  const login =
    typeof b.login === 'string' && /^[\w-]{1,39}$/.test(b.login) ? b.login : current.login;

  let repos = current.repos;
  if (b.repos === null) repos = null;
  else if (Array.isArray(b.repos)) {
    if (!b.repos.every((r) => typeof r === 'string')) return 'repos must be strings';
    // GitHub caps repository names at 100 characters; anything longer is
    // padding aimed at the D1 row this gets stringified into.
    if (b.repos.some((r) => r.length > 100)) return 'repo name too long';
    repos = b.repos.slice(0, MAX_DEVICE_REPOS);
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
    bright:
      typeof t.bright === 'number' ? clamp(Math.round(t.bright), 5, 100) : current.theme.bright,
    rotSec:
      typeof t.rotSec === 'number' ? clamp(Math.round(t.rotSec), 0, 120) : current.theme.rotSec,
  };

  return { login, repos, decks, theme, updatedAt: Math.floor(Date.now() / 1000) };
}

/* ---------- GitHub App sign-in ---------- */

const BINDER_COOKIE = 'gh_oauth';

const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/**
 * GitHub's redirect back after someone approves the app.
 *
 * No device key arrives here -- it is a top-level navigation from github.com --
 * so the `state` row says which dial the sign-in is for, and the binder cookie
 * says it is the same browser that started it. The cookie is not optional:
 * without it anyone could start a sign-in for their own dial and get somebody
 * else to finish it, and since GitHub skips the consent screen for an app you
 * have already approved, one click on a crafted link would put the victim's
 * token on the attacker's dial.
 */
async function githubCallback(req: Request, env: Env, url: URL): Promise<Response> {
  const back = (outcome: string) =>
    new Response(null, {
      status: 302,
      headers: {
        location: `${url.origin}/?github=${outcome}`,
        // One use: clear it whatever happened.
        'set-cookie': `${BINDER_COOKIE}=; Path=/api/github; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      },
    });

  const state = url.searchParams.get('state') ?? '';
  const flow = state ? await takeOAuthState(env, state) : null;
  const binder = readCookie(req, BINDER_COOKIE);
  if (!flow || !binder || !safeEqual(flow.binderHash, await sha256Hex(binder))) {
    return back('expired');
  }
  if (url.searchParams.get('error')) return back('denied');
  const code = url.searchParams.get('code');
  if (!code || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return back('failed');

  try {
    const pair = await exchangeCode(
      env.GITHUB_CLIENT_ID,
      env.GITHUB_CLIENT_SECRET,
      code,
      `${url.origin}/api/github/callback`,
    );
    const login = await verifyToken(pair.accessToken);
    if (!login) return back('failed');

    const now = Math.floor(Date.now() / 1000);
    await putAppToken(env, flow.deviceId, {
      access: await encryptSecret(env.ENC_KEY, pair.accessToken),
      refresh: await encryptSecret(env.ENC_KEY, pair.refreshToken),
      expiresAt: now + pair.expiresIn,
      refreshExpiresAt: now + pair.refreshExpiresIn,
      login,
    });
    // Fetch with the new access *before* sending the browser back. Connecting
    // moves the dial into its own private cache scope, which is empty until
    // this runs. Done in the background, the page arrived first, found
    // nothing, and showed "Could not load repos" until a manual reload.
    const config = await ensureConfig(env, flow.deviceId);
    await refreshLogin(env, config.login, pair.accessToken, flow.deviceId).catch((err) =>
      console.error('first fetch after sign-in failed', err),
    );
    return back('connected');
  } catch (err) {
    console.error('github sign-in failed', err);
    return back('failed');
  }
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

  if (resource === 'github' && id === 'callback' && !sub && req.method === 'GET') {
    return githubCallback(req, env, url);
  }

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
    // `||`, not `??`: an empty `?v=` must fall through to the latest build.
    // `??` would keep the empty string, match no version, and 404 the image.
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
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
      return json(
        { ok: true, version, sha256, size: bin.byteLength },
        { headers: { 'access-control-allow-origin': '*' } },
      );
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
    if (token && !(await getSnapshot(env, snapshotScope(config.login, personal ? id : null)))) {
      ctx.waitUntil(refreshLogin(env, config.login, token, personal ? id : null).catch(() => {}));
    }
    return json({ ok: true, id });
  }

  if (!(await authorised(env, id, req))) return fail(401, 'unauthorised');

  /* Start a GitHub App sign-in for this dial; the browser is sent to the URL returned. */
  if (resource === 'github' && !sub && req.method === 'POST') {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      return fail(404, 'GitHub sign-in is not set up on this server');
    }
    const state = randomHex(32);
    const binder = randomHex(32);
    await putOAuthState(env, state, id, await sha256Hex(binder));

    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
    authorize.searchParams.set('redirect_uri', `${url.origin}/api/github/callback`);
    authorize.searchParams.set('state', state);
    return json(
      { url: authorize.toString() },
      {
        headers: {
          'set-cookie': `${BINDER_COOKIE}=${binder}; Path=/api/github; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
          'cache-control': 'no-store',
        },
      },
    );
  }

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

    // What the dial says it is currently showing, echoed from the payload's cfg.
    const appliedHeader = Number(req.headers.get('x-config-applied'));
    const configApplied =
      Number.isFinite(appliedHeader) && appliedHeader > 0 ? Math.floor(appliedHeader) : null;

    const now = Math.floor(Date.now() / 1000);
    ctx.waitUntil(
      (async () => {
        const prev = await getStatus(env, id);
        const versionChanged = prev?.fwVersion !== fwVersion;
        const networkChanged = (prev?.wifiSsid ?? null) !== wifiSsid;
        // Not gated on the 15-minute cadence: this is what the settings page
        // waits on, so it has to land as soon as the dial reports it.
        const appliedChanged = (prev?.configApplied ?? null) !== configApplied;
        const stale = !prev || now - prev.lastSeen > 900;
        if (versionChanged || networkChanged || appliedChanged || stale) {
          await putStatus(env, id, {
            fwVersion,
            lastSeen: now,
            wifiSsid,
            wifiRssi,
            configApplied,
          });
        }
      })(),
    );

    const { payload, hasAccess } = await payloadFor(env, id);
    // 428 tells the dial *why* it has nothing to show, so it can say "Connect
    // GitHub" instead of sitting on "Registering" -- which is where a newly set
    // up dial stayed once there was no shared token to fall back on. Older
    // firmware treats it as any other failed poll.
    if (!payload && !hasAccess) return fail(428, 'connect GitHub on the settings page');
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
        existing?.lines.length === lines.length && existing.lines.every((l, i) => l === lines[i]);
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
      // A new account is resolved before it is saved.
      //
      // A typo used to be accepted silently and surface only as a dial that
      // stopped updating. Fetching it here -- which is also the snapshot the
      // dial is about to ask for -- turns that into an error at the moment it
      // can still be fixed, and means the page can show the new account's
      // repos as soon as the push returns.
      if (next.login.toLowerCase() !== current.login.toLowerCase()) {
        const { token, personal } = await tokenFor(env, id);
        // With no GitHub access at all there is nothing to check the name
        // against; it is saved and resolves once the dial is connected.
        try {
          if (token) await refreshLogin(env, next.login, token, personal ? id : null);
        } catch (err) {
          if (err instanceof GitHubError && err.status === 404) {
            return fail(400, `There is no GitHub user called ${next.login}.`);
          }
          // GitHub being slow or rate-limited is no reason to refuse a
          // setting. Save it; the cron fills the cache.
          console.error('login refresh failed', err);
        }
      }
      await putConfig(env, id, next);
      return json(next, { headers: { 'access-control-allow-origin': '*' } });
    }
  }

  /* The repo picker needs the full list, not the filtered one. */
  if (resource === 'repos' && req.method === 'GET') {
    const config = await ensureConfig(env, id);
    // Through snapshotScope like every other read: a device with its own PAT
    // has its data in a private scope, and must not be handed the shared one.
    const { token, personal } = await tokenFor(env, id);
    // Same rule as the dial's own payload: no access, no cached data. A stale
    // snapshot would list repos this dial can never refresh.
    if (!token) return fail(409, "Connect GitHub to see this dial's repos.");
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
      const row = await getGithubAuth(env, id);
      const { broken } = await tokenFor(env, id);
      return json(
        {
          present: Boolean(row),
          broken,
          kind: row?.kind ?? null,
          login: row?.login ?? null,
          // What the page may offer: the button only appears once the app exists.
          app: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
          // Whether a dial with no connection still gets public data from a shared token.
          shared: Boolean(env.GH_TOKEN),
          installUrl: env.GITHUB_APP_SLUG
            ? `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`
            : null,
        },
        { headers: { 'access-control-allow-origin': '*' } },
      );
    }
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => null)) as { token?: string } | null;
      if (typeof body?.token !== 'string' || body.token.length < 20) return fail(400, 'bad token');

      const login = await verifyToken(body.token);
      if (!login) return fail(400, 'GitHub rejected that token');

      // A pasted token replaces an app sign-in. Withdraw that authorization too,
      // as Disconnect does, rather than leaving an unused grant behind on the
      // person's GitHub account.
      const previous = await getGithubAuth(env, id);
      if (previous?.kind === 'app' && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
        const access = await decryptSecret(env.ENC_KEY, previous.encrypted);
        if (access) {
          ctx.waitUntil(
            revokeGrant(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET, access).catch(() => false),
          );
        }
      }
      await putUserToken(env, id, await encryptSecret(env.ENC_KEY, body.token), login);
      // Fetch before answering, for the same reason as the app sign-in: the new
      // token moves this dial to its own cache scope, which is empty until then,
      // and the page asks for a preview the moment this returns.
      const config = await ensureConfig(env, id);
      await refreshLogin(env, config.login, body.token, id).catch((err) =>
        console.error('first fetch after token save failed', err),
      );
      return json({ ok: true, login }, { headers: { 'access-control-allow-origin': '*' } });
    }
    if (req.method === 'DELETE') {
      const row = await getGithubAuth(env, id);
      if (row?.kind === 'app' && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
        const access = await decryptSecret(env.ENC_KEY, row.encrypted);
        if (access) {
          ctx.waitUntil(
            revokeGrant(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET, access).catch(() => false),
          );
        }
      }
      await clearUserToken(env, id);
      return json({ ok: true }, { headers: { 'access-control-allow-origin': '*' } });
    }
  }

  if (resource === 'refresh' && req.method === 'POST') {
    const config = await ensureConfig(env, id);
    const { token, personal } = await tokenFor(env, id);
    if (!token) return fail(409, 'This dial has no GitHub access yet — connect GitHub first.');
    const scope = snapshotScope(config.login, personal ? id : null);

    // Throttled against the snapshot's own age. Unthrottled, a loop here spends
    // the account's whole GitHub rate limit -- and doubles as a way to scrape
    // GitHub through somebody else's token.
    const snap = await getSnapshot(env, scope);
    const age = snap ? Math.floor(Date.now() / 1000) - snap.fetchedAt : Infinity;
    if (age < 60) {
      return json(
        { ok: true, skipped: 'too soon', age },
        { headers: { 'access-control-allow-origin': '*' } },
      );
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
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): void {
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
          // No connection of its own and no shared token: nothing to fetch with.
          if (!token) continue;
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
