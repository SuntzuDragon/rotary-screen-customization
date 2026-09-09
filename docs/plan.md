# Harnoor's GitHub Stats Knob — CrowPanel 1.28" Rotary Display

## Context

This is a gift build. The hardware is an **Elecrow CrowPanel 1.28" HMI Rotary Display**: ESP32-S3R8 (dual-core LX7 @240MHz, 512KB SRAM + **8MB PSRAM**, **16MB flash**), a 240×240 round IPS panel on **GC9A01**, **CST816D** capacitive touch, a rotary encoder with push, an RGB LED, WiFi 2.4GHz + BLE 5.0, powered/flashed over USB-5V-IN using the **ESP32-S3's native USB** (not a bridge chip).

The recipient is **Harnoor Lal (@PlasticRocket)** — a Rust developer with 5 public repos: `atomic-rollback` (9★, Fedora Btrfs rollback), `chainsaw` (4★), `piano` (3★), `cargo-avail` (3★), and a `workerd` fork. Stats are small numbers, which matters for the design: a dashboard that renders "9" in a huge font and animates when it becomes 10 is far better here than one built for four-digit counts.

**Goal:** he plugs it in, provisions it from a web page in his browser, and gets an ambient desk object that shows his repo stats — spin the knob to move between repos, touch to switch views.

**Feasibility: high.** No part of this is novel; the work is integration and UI polish. Budget ~2 focused weekends. Running cost is $0 (comfortably inside Cloudflare's free tier).

### The one design decision worth highlighting

You asked whether the browser could do WiFi setup over USB instead of a phone captive portal. **Yes — and it's strictly better.** The open [Improv Wi-Fi Serial](https://www.improv-wifi.com/serial/) protocol does exactly this over the Web Serial API. The board's native USB CDC appears as a serial port; the config page opens it, scans networks *from the device*, sends SSID+password, and — critically — Improv's `WIFI_SETTINGS` RPC result returns a **redirect URL**, which the firmware fills in with its own device ID and secret. The browser then navigates straight to that device's config page.

That means **no pairing code, no typing, no phone**:

```
1. Plug into laptop, open https://<worker>.workers.dev
2. Click "Connect device" -> native port picker -> pick the board
3. Page lists WiFi networks the DEVICE can see -> pick one, type password
4. Device connects, replies with https://<worker>.workers.dev/#d=<id>&k=<secret>
5. Browser follows it -> already-authenticated config page for HIS device
```

Same page can also flash firmware updates over Web Serial later. Caveats are in Risks.

---

## Architecture

Three deliverables in one repo. The device never talks to GitHub directly — a Cloudflare Worker aggregates and caches, so the device does exactly one small HTTPS GET per minute and the GitHub token never leaves the server.

```
Browser (Web Serial + config UI)          Cloudflare Worker
        |                                   |  KV: config, secrets, cached stats
        | Improv over USB CDC               |  Cron */5: refresh from GitHub
        v                                   |
   [ CrowPanel ] ---- HTTPS GET /api/device/:id ----> [ Worker ] --> GitHub API
```

```
firmware/          PlatformIO, Arduino core, LVGL 8.3.11
worker/            TypeScript, serves BOTH the API and the static config UI
web/               config UI source, built into the Worker's assets
```

One `wrangler deploy`. (Agreed on skipping Pages.)

---

## 1. Worker — `worker/`

`wrangler.toml`: KV namespace `DEVICES`, secret `GH_TOKEN` (your fine-grained read-only public-repo PAT), secret `ENC_KEY` (AES-GCM key for encrypting user PATs), cron trigger `*/5 * * * *`, and `[assets]` pointing at the built `web/` output.

### Endpoints

| Route | Caller | Notes |
|---|---|---|
| `GET /api/device/:id` | ESP32, every 60s | Returns cached payload. Honors `If-None-Match: "<v>"` → **304** when nothing changed, so the device usually transfers ~0 bytes and skips a redraw. |
| `POST /api/device/:id/register` | ESP32, first boot | Trust-on-first-use: device posts its self-generated secret; Worker stores a SHA-256 of it. |
| `GET/PUT /api/config/:id` | Config UI | Auth via the same secret (from the URL fragment). Repo selection, deck order, theme, brightness, rotation interval. |
| `POST /api/token/:id` | Config UI | Optional user PAT, AES-GCM encrypted at rest. Its presence upgrades the GitHub queries to include private repos + notifications. |
| `GET /api/preview/:id` | Config UI | Same payload as the device sees, so the browser preview is truthful. |

### GitHub data (`src/github.ts`)

Per refresh, ~7 requests — 84/hr against a 5000/hr budget:

- **1× GraphQL** (cost: 1 point) — profile, followers, contribution calendar, and per-repo `stargazerCount`, `forkCount`, `pullRequests(states:OPEN){totalCount}`, `issues(states:OPEN){totalCount}`, `pushedAt`, `primaryLanguage`, latest commit headline. Note: the contribution calendar is **GraphQL-only and requires auth** — this is the main reason for the token.
- **1× REST** `/users/:login/events/public` — activity ticker (`WatchEvent` = new star, `PushEvent`, `PullRequestEvent`, `ReleaseEvent`).
- **5× REST** `/repos/:o/:r/stats/commit_activity` — 52-week sparkline data.

If a user PAT is stored, run the same queries with it instead (unlocks private repos and `/notifications`), falling back to `GH_TOKEN` on 401.

### Device payload (short keys — ~3KB for 5 repos)

```jsonc
{
  "v": 41,                    // version; device compares against its ETag
  "ttl": 60,
  "theme": { "accent": "#F74C00", "bg": "#0B0D10", "bright": 80, "rotSec": 8 },
  "profile": { "login": "PlasticRocket", "name": "Harnoor Lal",
               "followers": 3, "stars": 20, "contrib": 1234 },
  "repos": [
    { "n": "atomic-rollback", "s": 9, "f": 1, "pr": 2, "i": 5,
      "push": 259200, "lang": "Rust", "col": "#DEA584",
      "spark": [0,2,5,1, /* 30 ints, commits/day */] }
  ],
  "events": [ { "t": "star", "r": "chainsaw", "age": 7200 } ]
}
```

Deltas are sent as **seconds-ago integers, not formatted strings** — the device renders "3d ago" itself, so a stale cache never shows a stale relative time.

The **cron trigger is what makes this robust**: GitHub is polled on a fixed 5-minute schedule regardless of how many devices exist or how often they poll, so device requests always hit warm KV and can never blow a rate limit.

---

## 2. Firmware — `firmware/`

PlatformIO, pinned to the vendor's known-good stack. Elecrow's examples target **Arduino-ESP32 core 2.0.14 and LVGL 8.3.11** — pin both; LVGL 9 is a breaking API change and the vendor glue will not compile against it.

```ini
[env:crowpanel128]
platform      = espressif32@6.5.0        ; -> Arduino core 2.0.14
board         = esp32-s3-devkitc-1
board_build.partitions = partitions.csv
board_build.flash_mode = qio
build_flags   = -DBOARD_HAS_PSRAM -DARDUINO_USB_CDC_ON_BOOT=1 -DLV_CONF_PATH=...
lib_deps      = lvgl/lvgl@8.3.11
                lovyan03/LovyanGFX@^1.1.12
                adafruit/Adafruit NeoPixel@^1.12.0
                bblanchon/ArduinoJson@^7
```

Vendor docs say the stock "Huge APP (3MB, no OTA)" scheme is needed because the factory app is large. Ours is much smaller, so use a **custom `partitions.csv` with dual 4MB OTA slots** across the 16MB flash — that buys WiFi OTA updates, which matters for a gift you can't easily get back on the bench.

### Pin map (from the wiki — put in `include/board_pins.h`)

| | GPIO | | | GPIO |
|---|---|---|---|---|
| SPI SCLK | 10 | | Touch SDA | 6 |
| SPI MOSI | 11 | | Touch SCL | 7 |
| SPI DC | 3 | | Touch INT | 5 |
| SPI CS | 9 | | Touch RST | 13 |
| SPI RST | 14 | | Backlight | 46 (PWM → brightness) |
| Encoder A | 45 | | RGB LED | 48 |
| Encoder B | 42 | | Power ind. | 40 |
| Encoder SW | 41 | | | |

### Layout

```
src/main.cpp                  boot, task setup
src/net/improv.cpp            Improv Serial state machine on USB CDC
src/net/wifi_store.cpp        credentials + device id/secret in NVS (Preferences)
src/net/api_client.cpp        HTTPS poll, ETag handling, ArduinoJson parse
src/model/stats.h             parsed structs (fixed-size, no heap churn)
src/ui/ui_root.cpp            deck manager, encoder indev, touch gestures
src/ui/screen_summary.cpp     profile dial
src/ui/screen_repo.cpp        per-repo cards
src/ui/screen_activity.cpp    event ticker
src/ui/widget_radial.cpp      radial bar chart around the bezel
src/ui/theme.cpp              palette from server config
lib/CST816D/                  vendored from Elecrow's repo
lib/Display/                  LovyanGFX panel config for GC9A01
```

### Input model

Register the encoder as a native **`LV_INDEV_TYPE_ENCODER`** indev bound to an `lv_group_t`. LVGL then handles focus traversal for free — don't hand-roll navigation.

- **Rotate** → move between cards in the current deck
- **Press** → enter/exit repo detail
- **Swipe up/down (touch)** → change deck: Summary ⇄ Repos ⇄ Activity
- **Long press** → status screen: device ID, WiFi/IP, last sync, firmware version

### The four screens (all four confirmed)

1. **Profile summary dial** — total stars as the hero number, dead center, huge. Followers and yearly contributions as arcs sweeping the bezel. This is the home screen and the one that most justifies a round display.
2. **Per-repo cards** — one repo per card: name, language dot, then stars / forks / open PRs / open issues in a 2×2 grid, with "pushed 3d ago" at the bottom. Knob scrolls; a small position dot ring around the edge shows where you are in the list.
3. **Activity ticker** — recent events scrolling in; **pulse the RGB LED green on a newly-seen star**. This is what turns it from a dashboard into an ambient object, and with his star counts a new star is a genuine event.
4. **Commit sparkline** — 30-day commit activity as radial bars around the bezel with the repo name in the middle. Draw with an `lv_canvas` in PSRAM (a 240×240 ARGB canvas is ~230KB — irrelevant against 8MB) rather than fighting `lv_chart` into a circle.

Fonts: enable Montserrat 14/20/28 in `lv_conf.h` (the hero numbers want 28+).

### Networking details that will otherwise bite

- **Call `configTime()` for NTP before the first HTTPS request.** TLS certificate validity checking fails on a device that thinks it's 1970 — this is the classic first-boot HTTPS failure.
- Use `WiFiClientSecure` with an **embedded root CA** (ISRG Root X1 + Google Trust Services roots cover Cloudflare's chain). Keep a `-DINSECURE_TLS` build flag as an escape hatch for bench debugging, but don't ship it.
- A `DEMO_MODE` build flag that renders a baked-in fake payload with no WiFi. UI iteration then takes a 20-second flash cycle instead of depending on the network — worth building on day one.

---

## 3. Config UI — `web/`

Plain TypeScript + Vite, built into the Worker's static assets. No framework needed for this surface.

- `src/improv.ts` — Web Serial + Improv client: `GET_DEVICE_INFO`, `GET_WIFI_NETWORKS` (device-side scan, so the list is what the *device* can actually reach — a real advantage over typing an SSID), `WIFI_SETTINGS`, then follow the returned redirect URL.
- `src/config.ts` — repo checkboxes (auto-populated from his GitHub), deck order, accent colour, brightness slider, rotation interval, optional PAT field.
- `src/preview.ts` — **a live 240×240 round preview** rendering the real `/api/preview/:id` payload, so you can tune the design in the browser instead of reflashing. Highest-leverage piece of the whole UI.
- `?mock=1` swaps the Web Serial transport for a fake — makes the provisioning flow testable without hardware attached.

---

## Build order

Each step ends somewhere you can stop and still have something working.

1. **Bring-up.** Flash a stock Elecrow example. Confirm display, touch, encoder, LED, and that the board enumerates as a serial port. Establishes the toolchain before any of our code exists.
2. **Worker first, no hardware.** Real endpoints against his real GitHub. `curl` the device payload; check it's under ~4KB. This can be fully finished and deployed before the firmware does anything.
3. **Firmware net layer.** Hardcoded WiFi creds → poll the Worker → `Serial.print` the parsed stats. Proves TLS, NTP, and JSON parsing with zero UI in the way.
4. **UI decks**, built against `DEMO_MODE`, then wired to live data.
5. **Improv + config UI.** Remove the hardcoded creds. This is the step that makes it giftable.
6. **Polish.** OTA, brightness PWM, boot animation, a first-run screen that says "plug me into a computer and open <url>".

---

## Verification

- **Worker:** `wrangler dev`; `curl -H 'If-None-Match: "41"'` must return 304; assert payload size and that no token appears in any response body. `wrangler tail` on the deployed cron to confirm the 5-minute refresh fires.
- **Rate limits:** log `x-ratelimit-remaining` from GitHub on every refresh; it should sit near 5000.
- **Config UI:** drive with `cdt` per your global setup (device plugged into the Windows side so Chrome sees the COM port). Web Serial's port picker is a native dialog automation can't click — so **automate everything via `?mock=1` and test the real serial handshake by hand once.**
- **Firmware:** `pio run -t upload && pio device monitor`. Check: cold boot with no credentials lands in Improv-ready state; boot with credentials syncs within ~10s; pulling the WiFi shows a disconnected indicator and recovers without a reboot; leave it running overnight for heap-leak checking (`ESP.getFreeHeap()` logged each poll).
- **End-to-end:** factory-reset NVS, then do the full flow — plug in, provision from the browser, change the accent colour in the UI, and watch the device pick it up on its next poll.

---

## Risks & gotchas

| Risk | Handling |
|---|---|
| **Web Serial is Chromium-desktop only.** Not Firefox, not Safari, not mobile. | He's a Fedora user (per `atomic-rollback`) — Chrome/Chromium on Linux is fine. Detect and show a clear message otherwise. |
| **Linux serial permissions.** `/dev/ttyACM0` is group `dialout`; Chrome can't open it otherwise. | Call it out in the README with `sudo usermod -aG dialout $USER`. Very likely to be his first stumble. |
| **Plugged into a wall charger** → no serial host, no way to reconfigure. | Build the SoftAP captive-portal path as a **fallback** anyway (~150 lines). Reachable from the long-press status screen. |
| LVGL 8 vs 9 API divergence | Pin `lvgl@8.3.11`. Ignore LVGL 9 tutorials entirely. |
| `commit_activity` returns **202 + empty body** while GitHub computes stats | Expected on first call for a repo. Retry on the next cron tick; render the sparkline empty until then. Do not treat as an error. |
| Native USB CDC re-enumerates when the port is opened/closed | Improv handler must run every loop iteration and survive re-enumeration — don't gate it behind a boot-time window. |
| Device secret is trust-on-first-use | Acceptable here. The blast radius is "someone changes which repos display." Never expose the GitHub token through any device-facing route. |
| Small star counts make some layouts look empty | Lean into it: huge type, animate transitions, make a single new star feel like an event. Design for 9, not for 9,000. |

## Cost

$0. Device polling at 60s = 1,440 requests/day against Workers' 100k/day free tier; cron writes 288 KV entries/day against a 1,000/day free write limit.

---

### Sources

- [CrowPanel 1.28" HMI Rotary Display wiki](https://www.elecrow.com/wiki/CrowPanel_1.28inch-HMI_ESP32_Rotary_Display.html)
- [Elecrow Arduino lesson 1 — board settings & libraries](https://www.elecrow.com/wiki/CrowPanel_1.28inch-HMI_ESP32_Rotary_Display_Arduino_lesson1.html)
- [Elecrow hardware/example repo](https://github.com/Elecrow-RD/CrowPanel-1.28inch-HMI-ESP32-Rotary-Display-240-240-IPS-Round-Touch-Knob-Screen)
- [Improv Wi-Fi Serial protocol](https://www.improv-wifi.com/serial/) · [ESP Web Tools](https://esphome.github.io/esp-web-tools/)
- [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) · [GraphQL rate limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)
- [crowpanel-esphome — reference for this exact board](https://github.com/flavio-fernandes/crowpanel-esphome)
