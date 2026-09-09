# Project context and decisions

Everything needed to pick this up cold. `research-findings.md` holds the
measured hardware and API behaviour; this file holds the *why* — the decisions,
the reasoning behind them, and the things that cost hours to learn.

---

## What this is

A birthday gift. An **Elecrow CrowPanel 1.28" HMI ESP32 Rotary Display**
(ESP32-S3R8, 240×240 round IPS on GC9A01, rotary encoder, capacitive touch)
that shows GitHub stats for **Harnoor Lal / @PlasticRocket**. Turn the knob to
page through repos; press to jump between sections.

Recipient is a Rust developer, Fedora user (inferred from his `atomic-rollback`
repo — relevant because Chrome on Linux needs `dialout` group membership for
Web Serial).

Live at **https://hdog.imcb.dev**. Repo is **private** until after the gift.

---

## Architecture

```
Browser (Web Serial: provisioning + flashing)        Cloudflare Worker
      |                                                |  D1: device state, stats cache
      | Improv Wi-Fi Serial over USB CDC               |  KV: firmware images
      v                                                |  Cron */5: refresh from GitHub
 [ CrowPanel ] --- HTTPS GET /api/device/:id --------->|--> GitHub GraphQL + REST
```

| Path | Contents |
|---|---|
| `worker/` | Cloudflare Worker (TypeScript). API + serves the built web UI. |
| `web/` | Config UI (TypeScript/Vite). Provisioning, flashing, settings. |
| `firmware/` | PlatformIO / Arduino-ESP32 2.0.14 / LVGL 8.3.11. |
| `docs/` | This file, `research-findings.md`, screenshots. |

The device **never talks to GitHub**. A cron job aggregates into a cache; the
device makes one small HTTPS request every 10s (usually answered `304`), and no
GitHub token ever reaches it.

---

## Key decisions, and why

### Storage: D1 for state, KV for firmware images

Started all-KV. That was wrong and caused two separate user-visible bugs.

**KV is eventually consistent** (reads lag 15–30s, minimum edge TTL 60s) and
caps writes at **1,000/day account-wide**. Config lived there, so changing a
checkbox appeared to do nothing — the write landed instantly but reads served
stale data. The same lag made a freshly published firmware version invisible in
the dropdown.

Per-poll status and log writes were also burning ~3,170 writes/day against that
1,000 cap, which triggered a Cloudflare quota warning email.

Now:

| Store | Holds | Why |
|---|---|---|
| **D1** | config, auth, status, logs, GitHub snapshots, events, firmware metadata | strongly consistent; 100k writes/day |
| **KV** | firmware images (~13MB) | large immutable blobs, written twice per release |

**R2 was rejected deliberately.** It fits the blobs better, but it has **no hard
spend cap** (an open Cloudflare feature request), and enabling it attaches a
billing subscription. KV and D1 on the free plan **fail closed** — they return
errors past the limit and can never bill. For a personal gift project that is
the correct trade. Do not "tidy up" by moving images to R2 without revisiting
this.

**Firmware images can't move to D1**: a 1.29MB image fits under D1's 2MB row
cap, but the 100KB SQL statement limit means `wrangler d1 execute` can't carry
it — it would need a Worker upload endpoint plus a new CI secret, while sitting
at 65% of a hard ceiling the binary keeps approaching.

### Multi-tenancy: cache scoped by token ownership

Config is **per device** (`devices` table, each row with its own `login`), so
two people watching different accounts never share settings.

Snapshots are cached per *scope*, not per login:

```ts
snapshotScope(login, privateForDevice) =>
  privateForDevice ? `${login}#${deviceId}` : login
```

Public data fetched with the shared `GH_TOKEN` pools per username (ten devices
watching one account cost one set of API calls). Data fetched with somebody's
**own PAT** is cached per device. Without that split, one user adding a PAT
would publish their private repos to every other device watching the same
username. The cron groups by scope for the same reason.

### Firmware delivery: USB, not OTA

The partition table reserves dual 4MB OTA slots, but there is no OTA code and
that was deliberate — flashing over USB from the browser can't brick the device
over a flaky network, and it reuses the Web Serial permission already needed for
provisioning.

Flashing is **not gated behind Improv or a session**: the Firmware card renders
on the landing page too. Gating it created a dead end where a device that
couldn't provision also couldn't be reflashed.

### Improv: own client, not the SDK

`improv-wifi-serial-sdk` was replaced with `web/src/improv-raw.ts` (~200 lines).
Not because the SDK is bad — because it timed out against a device that
provably answered, and owning the bytes made the exchange inspectable. The
protocol is small: `"IMPROV" | version | type | length | payload | checksum`.

`esp-web-tools` was likewise dropped for `esptool-js` directly: it shipped a
light-mode Material modal that re-asked for the port and repeated steps the page
already handled, and it pinned `@material/web` internals that broke on a minor
bump.

---

## Hard-won findings

These each cost significant time. `research-findings.md` has the full detail.

### The boot freeze — one line, every symptom

`ImprovSerial::sendPacket()` ended with `_io->flush()`. `setTxTimeoutMs(0)`
makes `write()` non-blocking but **does not govern `flush()`**, which waits for
the USB TX buffer to drain and never returns with no host attached. The first
Improv packet, sent during `setup()`, froze the entire device.

Symptoms it produced, all of which looked like separate bugs:

- frozen on the splash screen
- "Wi-Fi takes 80–230 seconds" (it takes **199ms** once reached)
- a `delay(100)` apparently taking 126s (it took exactly 100ms; it was never reached)
- the device springing to life whenever anyone attached a serial monitor

**Result: 228s → 7s to online, unattended.**

Four confident theories preceded it — Wi-Fi timing, serial write timeouts, IDF
logging, task starvation — all wrong, each "fix" only moving where the block
landed. What settled it was **timestamping the log ring**: once every line
carried an uptime, the data showed nothing ran before t=228s and everything ran
at correct speed after. That is a hard block, not a slow subsystem.

The user's observation — *"it always switches to registering after you start
investigating"* — was the key input. **When a symptom vanishes under
observation, the observation is part of the system.**

### Observability is the reason anything got solved

Two pieces of infrastructure earned their keep and must not be removed:

1. **Logs shipped over Wi-Fi** (`firmware/src/net/devlog.*` → `POST /api/log/:id`).
   The browser owns the serial port during provisioning — the single most
   failure-prone moment is the one where no monitor can attach.
2. **Uptime stamps on every line.** Without them the ring records order but not
   timing, and a gap is the entire finding.

Both were themselves buggy at first and needed the same scrutiny as product
code: the log store did a read-modify-write against KV and **deleted the boot
sequence it was meant to capture**; the CI readiness gate was **circular**,
polling an endpoint gated on the very index row it was waiting to write.

### Hardware traps not in the vendor wiki

- **GPIO1 and GPIO2 are power enables.** Must be driven HIGH first or the panel
  is completely dead — and misleadingly so: `gLcd.init()` still returns `true`
  and the backlight pin does nothing in *either* state.
- **Touch I2C is 6/7**, not the 38/39 the wiki's table claims (those are the
  external connector).
- **The backlight is not a LovyanGFX `Light_PWM`** — it needs raw `ledc` on
  GPIO46.
- **Opening the serial port resets the board** (DTR/RTS). Clear both *before*
  opening for passive observation. This is also why the browser's port open
  restarts the device.
- **Release BOOT before EN.** After flashing, if IO0 is still low when EN rises
  the chip boots into *download mode* — a dead board with a flawless flash log.
- **`--flash-mode qio` rewrites the bootloader header.** The toolchain stamps
  DIO; forcing QIO gives a `TG0WDT_SYS_RST` boot loop with no app output.
- **The merged image is flat**: `merge_bin` pads gaps with `0xFF`, and NVS sits
  at `0x9000–0xe000` inside one. Writing it whole **erases Wi-Fi credentials and
  the device identity**. The flasher skips that region; not skipping it is the
  factory-reset checkbox.

### TLS

`workers.dev` and `imcb.dev` both chain to **GTS Root R4** (Google Trust
Services), not Let's Encrypt. `firmware/include/certs.h` embeds R4 plus R1.
`api::syncClock()` must run before the first HTTPS request — certificate
validity is checked against the clock, and a device that thinks it is 1970 fails
every handshake.

### CI caching

Actions caches are **scoped per ref**. Firmware built only on tag pushes, and
every tag is its own ref, so no release could ever reuse another's cache — cold
by construction, ~1.1GB of quota each. Firmware now also builds on `main`
(without publishing) to keep a warm cache tag runs can inherit, which doubles as
a compile check on every change.

**230s → 87s**, with the Build step itself 176s → 13s.

Trimming unused LVGL widgets did **not** help build time (LVGL guards each file
internally, so all 192 still compile) but shrank the binary by **63KB**.

---

## Operational notes

- **Device id: `ph7fshy7`** (the physical unit). Ids are minted on first boot
  and stored in NVS; an app-only flash at `0x10000` preserves them, a full
  merged-image flash does not.
- **`multitest1`** is a throwaway device row used to verify multi-account
  isolation. Safe to delete.
- Secrets: `GH_TOKEN` (fine-grained, public-repo read), `ENC_KEY` (base64 32
  bytes, AES-GCM for user PATs). GitHub Actions needs `CLOUDFLARE_API_TOKEN`
  with **Workers + KV + D1 Edit** — D1 was missing initially and failed the
  publish step.
- Releases: `git tag -a v0.2.8 -m "…" && git push origin v0.2.8`. Pushing to
  `main` builds but does not publish.
- **Committing is deploying** — pushing `worker/**` or `web/**` to main triggers
  CI deploy. A manual `wrangler deploy` is only for deliberately transient
  tests, and should be announced as such.
- Bench scripts live in `C:\Users\imcb0\rotary-flash\` (Windows side):
  `cap.py` (passive read, no reset), `rescap.py` (reset then read),
  `resetonly.py` (reset and detach), `improvping.py` (raw Improv probe),
  `portcheck.py`. The device is on **COM3**; WSL cannot see it, so flashing goes
  through `cmd.exe`.
- The site footer shows the git SHA it was built from — use it to confirm a hard
  reload actually took.

---

## State

**Working and verified on real hardware:** display, backlight, power rails,
PSRAM, encoder (both directions), knob press, capacitive touch, Wi-Fi, NTP, TLS,
provisioning over USB, live GitHub stats, config push, firmware release
pipeline, browser flashing with progress and live log, factory reset.

**Not yet verified:**

- **Improv connect from the browser** with the new raw client. The device
  provably answers a raw probe (returns `state=PROVISIONED` plus its settings
  URL); the browser path has not been retried since the SDK was replaced. Chrome
  asserts DTR/RTS on open, so `connect()` releases BOOT then pulses EN.
- **The knob in normal use** — six cards, press to jump sections. It has never
  been in a stable enough state to exercise properly.
- **The LED star pulse.** Fires only on a genuinely new star, and the first poll
  after boot is deliberately suppressed so a restart doesn't replay the backlog.
  Untestable on demand.
- The **`privacy: PUBLIC`** change to the profile query, the registration rate
  limit, and the firmware digest check (all below) are logic changes that have
  not been exercised against real traffic yet.

**Known open questions:**

- Config reaches the device by polling (~10s). A USB fast path would be instant
  while plugged in; the cloud path is kept because it works from a phone and
  when untethered.

---

## Security

An audit covered auth, secret handling, tenant isolation, input validation, the
firmware supply chain and the browser session. Two findings were critical.

### Anyone could publish the default firmware

The upload endpoint checked a *device* key — but device keys are self-minted:
registration is trust-on-first-use and unauthenticated, by necessity (a board on
first boot has nothing to authenticate with). So "authenticated" meant "anyone
willing to make one extra request", and the version string came from the caller.
An upload could therefore overwrite a real release's bytes in place, become
`fw_latest`, and sit preselected in the dropdown of anyone who opened the site.
Ten junk uploads also evicted every genuine build through the prune.

That it *preserves NVS* made it worse: the flasher deliberately skips
`0x9000–0xe000`, so a hostile image would inherit the victim's Wi-Fi credentials
and device identity.

Fixed by making ownership explicit rather than by adding another secret:
`firmware.owner` is `NULL` for CI and the device id for an upload; an upload's
version is **derived from its digest** (`custom-<device>-<sha8>`) so it cannot
name an existing release; only `NULL`-owner rows can be `fw_latest` or appear in
the public list; and pruning happens within an owner's own bucket. The browser
now also verifies the downloaded image against the index digest before flashing
— that hash had been recorded since the first release and never once read.

### The dev token was an account-wide OAuth token

`worker/.dev.vars` held a live `gho_` token with `repo`, `read:org`, `gist` and
`admin:public_key` — full read/write to every private repository on the account,
where the design (and the README) assumed a fine-grained public-read PAT.

The file is gitignored and clean in history, so nothing leaked; the risk was
what the Worker would have done with that scope. `fetchProfile` asks for
`ownerAffiliations: OWNER` with no privacy filter, so a broad token returns
private repositories — names, counts and latest commit subjects — into the
snapshot cached under the **shared** scope and served to every device watching
that username. Production was checked and its snapshot contains public repos
only, so the deployed secret is a different, correct token.

The query now passes `privacy: PUBLIC` whenever the shared token is used, so a
token being broader than intended stops being a leak. A device using **its own**
PAT still gets private data, and `snapshotScope()` keeps that in a private
cache. Rotate the `.dev.vars` token regardless.

### Also fixed

| | |
|---|---|
| Unbounded registration → GitHub quota exhaustion | 20 new ids/hour account-wide (re-registering an id you hold is always allowed); cron refreshes only devices seen in the last 7 days, oldest first, capped at 200 |
| `/api/refresh` was an unthrottled GitHub proxy | no-op if the snapshot is under 60s old |
| `/api/repos` read the **unscoped** snapshot | routed through `snapshotScope()` like every other read |
| `location.href = <device-supplied URL>` | a `javascript:` URL has origin `"null"`, so it failed the same-origin check and then *executed* in the fallback. Now an error |
| Device key accepted in `?k=` | header only; query strings reach request logs, history and `Referer` |
| Tag name interpolated into production SQL | validated to `[A-Za-z0-9._-]{1,32}` at the top of the job; `${{ }}` expressions moved out of `run:` bodies into `env:` |
| `esp_random()` unseeded when minting identity | wrapped in `bootloader_random_enable()` — it runs long before the RF subsystem, where it is only a weakly seeded PRNG |
| Internal error strings returned to callers | generic 500; detail to `console.error` |
| Private cache rows outlived the token | `clearUserToken` drops the `login#device` snapshot and event rows |
| Silent fallback when a stored PAT won't decrypt | `GET /api/token` reports `broken`, and the UI says so — otherwise rotating `ENC_KEY` degrades every PAT user invisibly |
| No security headers on the page | CSP, `nosniff`, `DENY`, `no-referrer`. The page holds the device secret in `localStorage`, so same-origin isolation is the thing protecting it |

### Checked and sound

Every D1 call in `worker/src` is parameterised — the only string-built SQL was
the CI workflow. `safeEqual` is constant-time and only ever compares
fixed-length hashes. AES-GCM uses a fresh random IV per encryption. There is no
`innerHTML`, `eval` or `new Function` anywhere in `web/src`. Cross-device
isolation holds: every route derives the id from the path and authorises before
acting, and no route takes a device id from a body. Device ids are 2^40 with
128-bit secrets, and a mismatched secret on a claimed id gets a 409 — the
weakness was *creating* identities cheaply, never stealing one. Firmware TLS is
properly pinned with NTP before the first request. `access-control-allow-origin:
*` exposes nothing: auth is a header, not a cookie, and the wildcard forbids
credentialed requests.
