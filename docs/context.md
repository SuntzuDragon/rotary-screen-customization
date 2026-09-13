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

- **The device id changes whenever NVS is erased** — it is minted on first boot
  and stored there, so an app-only flash at `0x10000` keeps it and a factory
  reset does not. `SELECT id, last_seen FROM devices` is the way to find the
  current one; it has been `jak7hkb9`, `ph7fshy7` and `km35vycf` so far. Don't
  hard-code it anywhere.
- `last_seen` is written at most every 15 minutes, so a device that looks stale
  by that column may be perfectly healthy — `device_logs` ships far more often
  and is the better liveness check.
- Secrets: `GITHUB_CLIENT_SECRET` (the GitHub App's) and `ENC_KEY` (base64 32
  bytes, AES-GCM for stored GitHub tokens). `GITHUB_CLIENT_ID` and
  `GITHUB_APP_SLUG` are plain vars in `wrangler.toml`. There is no `GH_TOKEN`;
  if one is ever added back it must be fine-grained, public-repo read-only —
  never a `gh` CLI `gho_` token, which carries `repo`. `ENC_KEY` was rotated on 2026-09-10; rotating it makes every stored
  user PAT undecryptable, which `GET /api/token` now reports as `broken`. GitHub Actions needs `CLOUDFLARE_API_TOKEN`
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

The newest tag is **v0.2.7**, and `main` is ahead of it: the 10s poll interval
and the entropy fix below are both unreleased. Tag a `v0.2.8` to ship them.

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

- Nothing outstanding on the config path — see *Instant push over USB* below.

### Connect GitHub, with pasted tokens as the fallback

Goal: stop shipping the owner's PAT as `GH_TOKEN`, and stop asking each person
to generate one.

**GitHub App, not OAuth App.** A classic OAuth App's only route to private repos
is the `repo` scope — full read/write to every private repository, the exact
over-privilege the security audit flagged. A GitHub App declares read-only
permissions that cannot be over-granted, the person installing it picks which
repos it sees, and its tokens are short-lived.

**Why not simply require a PAT.** People paste classic tokens with `repo`, and
the worker can check a token works but not that it is minimal. A PAT also either
expires — and the dial silently stops updating — or never expires and is a
permanent credential. App tokens renew themselves every eight hours while the
dial is in use. The paste box survives as a collapsed "use a personal access
token instead" for anyone who would rather not authorize an app.

**Flag.** Everything is off until `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`
are set (`GITHUB_APP_SLUG` adds the private-repos install link). Until then the
button is hidden, the start route answers 404, and the paste box is shown open.

**Flow.** `POST /api/github/:id` (device key) writes a one-use `oauth_states` row
and sets an `HttpOnly; SameSite=Lax` binder cookie → github.com/login/oauth/authorize
→ `GET /api/github/callback` checks state *and* cookie, swaps the code, stores the
pair encrypted → redirects to `/?github=<outcome>`. The cookie is not optional:
without it anyone could start a sign-in for their own dial and have someone else
finish it, and because GitHub skips the consent screen for an app you have
already approved, one click on a crafted link would land the victim's token on
the attacker's dial.

**Renewal.** Access tokens last 8h; refresh tokens last six months and are
**single-use** — spending one kills it. Two requests renewing at once would each
spend the same token and the second would mark a good sign-in broken. So renewal
takes a lease (a conditional `UPDATE ... WHERE version = ?` only one caller can
win), starts 15 minutes before expiry so a caller that loses the race keeps using
the still-valid token, and backs off 15 minutes after a failure instead of
retrying every poll. The token endpoint answers **200 with an `error` field**
when it refuses, so a status check alone would store an error string as a token.
The app must keep "Expire user authorization tokens" switched on; the code
refuses a non-expiring token rather than store one it cannot renew.

**Disconnect** also revokes the grant (`DELETE /applications/{client_id}/grant`)
so it leaves the person's GitHub Applications list — best effort; the local copy
is deleted either way.

**`GH_TOKEN` is gone (2026-09-12).** Every dial fetches with its own
connection. A dial with none gets HTTP **428** from its poll, and v0.3.1
firmware shows *Connect GitHub — at hdog.imcb.dev* instead of sitting on
"Registering". Two things had to change for that to be true:

- The worker must **never serve a cached snapshot to a dial with no access.** The
  shared-scope snapshots written while the shared token existed can no longer be
  refreshed, so serving them showed frozen stats that looked live and hid the
  Connect GitHub screen. A freshly registered dial for PlasticRocket got exactly
  that — HTTP 200 with day-old data — until this was fixed and those rows were
  deleted.
- Everything that fetched with the shared token (cron, registration warm-up,
  username check, manual refresh) now skips when there is no token at all.

Exercised end to end with the registered app `rotary-stats`.

**Org repos come from installations, not membership.** `ownerAffiliations:
ORGANIZATION_MEMBER` would return every public repo of every org the account
belongs to, with nobody granting anything, and a large open-source org's repos
would push the person's own out of the top eight. Instead the worker lists the
app's installations (`/user/installations`), takes the repos each organization
granted, and fetches their stats through the same GraphQL fragment as owned
repos, capped at 20. They are named `org/repo`, so they cannot collide with an
owned repo of the same name. This only runs for an app sign-in (`ghu_` tokens —
a PAT cannot list installations) viewing its own account: on a dial showing
someone else, they would be the connected person's orgs. No opt-in setting is
needed, because the grant is the opt-in.

**One connection per dial — the newest wins.** A pasted PAT and an app sign-in
are not combined. The app already reaches everything a PAT can, read-only and
self-renewing; combining would mean two credentials to renew and two sources for
the same repo's stats. Pasting a PAT over an app sign-in also withdraws that
authorization on GitHub, as Disconnect does.

**Known limit:** the owned-repo query takes the first 20 by stars. An account
with more than that — including private repos made visible by installing the
app — loses the rest from the picker, arbitrarily among ties.

### The poll interval is the scaling lever

Free-tier Workers allow **100,000 requests/day, account-wide**. One dial at the
old 10s poll was 8,640 of them — about **eleven devices** before the account
stops answering. D1 rows read (~125 devices), rows written (~260) and storage
(~16 million) are all 10–25x further out. Storage was never the constraint.

The 10s existed only to make a pushed setting appear quickly, and the USB
request does that properly now. Upstream data cannot be fresher than the cron
that fetches it (every 5 minutes), so anything under that only re-reads a cache.
**60s** gives roughly seventy devices and loses nothing real.

The cost is that an untethered push can take a minute, and the settings page
says so — **that copy has to change with this number**, since nothing links
them.

### Stats survive a power cut

`Stats` lived only in RAM, so a power cut left the dial blank until it had
Wi-Fi, a clock, TLS and a round trip — with a router also rebooting, minutes of
nothing. The last good payload is now a blob in NVS, restored before the network
is even asked, and `serviceUi`'s existing rule (status cards never replace live
data) means the dial comes back showing what it knew instead of walking through
Connecting / Syncing clock / Registering every time.

Written only when a poll returns `Updated`, so flash wear tracks how often the
stats actually move. `loadBlob` requires an exact length match — bump the
`kStatsKey` string when the `Stats` layout changes, because two layouts of the
same size would otherwise be read into each other.

### "Live on the dial" is now a fact

The push confirmation used to re-read the service's own payload: proof the write
landed, dressed up as proof the device had it. The payload carries `cfg`
(`config.updatedAt`), the dial echoes it back as `x-config-applied` on its next
poll, and the worker stores it on the device row. The settings page waits for
`configApplied >= config.updatedAt` — a statement about the dial.

That write is deliberately **not** gated on the 15-minute status cadence, unlike
`last_seen`: it is what the page is waiting on, so it has to land as soon as the
dial reports it.

### One page, and one answer about the cable

The site was three views — landing, provisioning, settings — and the split cost
more than it saved. You could not see what the product did until after setting
one up, and **three separate cards each owned their own connect button** for the
same serial port without telling each other: connecting from the Wi-Fi card left
the push card still saying "not connected", and flashing closed the port behind
both. The page also never showed *which* dial it was editing — the id lived in
`localStorage` and was never displayed.

Now:

- **`improv.ts` owns the connection** and emits a change event. Nothing else
  opens or closes the port except the bar and the flasher. `onConnectionChange`
  is the single source of truth for the cable; D1 remains the single source of
  truth for config. Pulling the cable fires `navigator.serial`'s `disconnect`,
  so a yanked lead stops the page claiming a link that is gone.
- **A sticky device bar** names the linked dial, its account, when it was last
  seen and which network it is on — and warns when the cable is in a *different*
  dial than the page is editing, offering to switch.
- **Settings live in a `<fieldset disabled>`** until a dial is linked. A
  fieldset rather than a dimmed div: opacity alone is a lie, since you can still
  tab into a greyed-out input and type.
- **Unlinked renders a sample dial** (`demo.ts`), so the page demonstrates
  itself instead of showing an empty circle.
- **Provisioning is just the Wi-Fi card** in setup mode. First-time setup and
  changing networks were the same three fields on two screens; that duplication
  is what made a network change feel destructive.

Watch out for one trap that cost a debugging round: `.bar` was already the
flashing progress track (`height: 6px`), so the new device bar collapsed until
it was renamed `.devbar`.

### Holding the knob names the dial

A short press advances a section; holding for 700ms shows device id, firmware
version and flash date. The action moved to *release*, because the two gestures
are only distinguishable once you know how long the button was down — and a long
press must not also advance the section on the way out.

Auto-advance and rotation are frozen while the badge is up (`gAboutActive`), and
the dwell timer restarts on release — otherwise the badge scrolled itself off
the screen mid-read, and letting go immediately advanced a card that was already
most of the way through its interval.

The flash date is recorded by `settings::noteVersion()`, called after the NTP
sync rather than in `begin()`: the first boot of a new version stamps the time,
later boots of the same one leave it alone, so it reads as "flashed at" rather
than "started at".

### The dial's limits are in the UI, not a silent truncation

`kMaxRepos = 8` in `firmware/src/model/stats.h` is a fixed array. The worker was
happily sending up to twenty repos and the device kept the first eight, so
choosing twelve silently showed eight with no way to say *which* eight.

`MAX_DEVICE_REPOS` now mirrors that constant in `worker/src/types.ts` and
`web/src/types.ts`, caps the payload and the config, and is visible in the
picker ("4 of 8"). Chosen repos are drag-reorderable, since order is what the
dial paints. `repos: null` still means "the top ones, kept up to date as repos
come and go" — the first deliberate reorder or untick materialises the list,
so the auto behaviour is the default rather than a thing you lose by touching
anything.

### One connect button, including for a brick

Flashing is gated on the bar's connection: the port is picked once, at the top,
and the flash button is disabled until then. Two ways to open the same port was
the confusion worth removing.

That would have rebuilt the dead end where a dial too broken to answer could not
be reflashed — so `connect()` no longer throws when Improv stays silent. It
returns a `Connection` with `responsive: false` and an open port, which is all
esptool needs. The bar says "Cable attached — no answer", the Wi-Fi card
explains it cannot provision, and flashing works, which is the thing that fixes
it. `takePort()` hands the open port to esptool instead of closing it and
prompting again for a device the page is already showing as connected.

### Wi-Fi is editable, not re-setup

Changing networks used to mean a factory reset and starting over, because Wi-Fi
only existed in the provisioning flow. It is now a card on the settings page.

Credentials still travel **only over USB**, deliberately: pushing them through
the service would mean a wrong password leaves the device off the network and
out of reach of the one channel that could fix it. But nothing else is
destroyed — the device keeps its id, secret, settings and history, so the
browser session survives a network change.

Two supporting changes:

- The device reports `x-wifi-ssid` / `x-wifi-rssi` on each poll, stored on the
  `devices` row, so the card can say which network it is on **with no cable
  attached**. The password never leaves the device.
- A failed network change used to strand the device: `bringUpNetwork` had
  already dropped the old association, credentials are only saved on success so
  nothing was persisted, and `gRegistered` was still true so the retry loop
  never fired — leaving it dark until someone power-cycled it. It now falls
  back to the saved network.

### Instant push over USB

Settings live in the service and the dial notices them at its next poll, so a
push was always up to ~10s behind. When the browser has the port open it can
say so directly: Improv command **`0x80`**, deliberately outside the `0x01–0x04`
the specification assigns, meaning "fetch your settings now". The device hands
the request to the network task, waits (pumping LVGL, exactly as the Wi-Fi
connect handler does), and replies `OK` or `FAIL` **after** the fetch finishes —
so the browser's "Live on the dial" is a statement from the device, not a guess
about propagation.

The design choice worth remembering: the RPC carries **no settings**. It is a
nudge, not a transfer. D1 stays the single source of truth, the device applies
exactly the payload the service rendered, and there is no second code path to
keep in sync. The cost is one HTTPS round trip (~1s) instead of nothing, which
is not worth a duplicate config format.

**Opening the port resets the board** (Chrome asserts DTR/RTS = BOOT/EN), so the
page holds *one* shared connection (`openShared`/`closeShared` in `improv.ts`)
rather than opening per push. Provisioning no longer closes the port on its way
to the settings view, so the first push after setup is already instant. The
flasher calls `closeShared()` first — esptool needs the port exclusively.

Every failure falls back to the poll: no cable, no Web Serial, cable pulled
mid-push, or firmware older than v0.2.8 (which answers `ERR_UNKNOWN_CMD`, and
the UI says to flash a newer build).

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
