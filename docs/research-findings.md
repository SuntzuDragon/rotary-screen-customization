# Validated API behaviour

Everything below was measured against the live GitHub API on 2026-09-08 using
`gh api`, not assumed. Two findings changed the design.

## 1. GraphQL profile+repos query — works, costs 1 point

One query returns profile, followers, contribution total, and per-repo stars /
forks / open PRs / open issues / pushedAt / last commit. `rateLimit.cost` = **1**
against a 5000/hr budget. `isFork:false` correctly drops the `workerd` fork.

Live values:

| repo | stars | forks | open PRs | open issues |
|---|---|---|---|---|
| atomic-rollback | 9 | 1 | 0 | 6 |
| chainsaw | 4 | 0 | 2 | 44 |
| cargo-avail | 3 | 0 | 1 | 2 |
| piano | 3 | 0 | 1 | 31 |

Profile: Harnoor Lal, 3 followers, **4548 contributions** this year.

**Design note:** stars are small (19 total) but issues (44, 31) and contributions
(4548) are not. The hero number on the summary dial should be *contributions*,
not stars — it is the number that actually reflects how active he is.

**Gotcha:** `pushedAt` != last commit on the default branch. `chainsaw` reports
`pushedAt` 2026-05-16 but its newest default-branch commit is 2026-04-25 —
`pushedAt` counts pushes to any branch. Display `committedDate` instead.

## 2. `/stats/commit_activity` returns 202 on a cold cache — confirmed

First call: `HTTP/2.0 202 Accepted` with an empty body while GitHub computes the
stats. Second call ~3s later: `200` with 52 weeks of data. The Worker must treat
202 as "not ready", not as an error, and retry on the next cron tick.

**Design change — 30-day sparkline will not work.** For `atomic-rollback`, only
**5 of 52 weeks are non-zero** and the **last 8 weeks are all zero** (his last
push was April 2026). A 30-day window renders flat for every repo.

Use the **full 52-week series** instead, drawn as 52 radial bars — one per week,
~6.9 degrees each, exactly one full revolution of the round display. That maps
the data to the hardware better than a 30-day window *and* it is the only window
where his activity is visible at all. Peak week was 57 commits, so bars need a
per-repo normalised scale.

## 3. The public events feed is nearly empty — the activity ticker needs rethinking

`/users/PlasticRocket/events/public` returned only **2 events**, both
`PullRequestEvent` against `Homebrew/homebrew-cask` — not his own repos. The feed
only covers ~90 days and he has not been publicly active on his own projects
recently.

So a ticker driven purely off this feed would usually be blank. Two fixes, both
worth doing:

1. **Keep the feed but do not filter to his own repos.** "opened a PR on
   Homebrew/homebrew-cask" is genuinely interesting and is what is actually there.
2. **Synthesise events in the Worker.** The cron already snapshots every repo
   every 5 minutes, so it can diff consecutive snapshots and emit its own events
   — `+1 star on chainsaw`, `issue closed on piano`. This is strictly better than
   the GitHub feed for the ambient use case: it is what the LED pulse should fire
   on, it never goes stale, and it works even when he is quiet on GitHub.

The synthesised-event store is the reason the KV schema keeps a `prev` snapshot
alongside the current one.

## 4. Rate-limit budget

Per 5-minute refresh: 1 GraphQL + 1 events + N `commit_activity` (N = repo count,
currently 4). ~72 requests/hour against 5000. Non-issue.

## 5. End-to-end Worker verification (local, real data)

Measured against `wrangler dev` with the live GitHub API:

- `POST /api/device/:id/register` -> 200, trust-on-first-use accepted
- poll with no key -> **401**; poll with a wrong key -> **401**
- poll with the right key -> **200, 1398 bytes** including all four 52-week
  sparklines. Budget was 4KB, so there is ample headroom.
- repeat poll with `If-None-Match` -> **304, 0 bytes downloaded**

The 202 retry behaviour reproduced exactly as predicted: the first refresh
returned `w: []` for every repo, the second returned all 52 weeks.

Weekly commit peaks: piano 228, chainsaw 177, atomic-rollback 57, cargo-avail 18
— across only 3-8 non-zero weeks each. Bars must be normalised per repo, and the
52-week window is the only one where anything is visible.

## 6. TLS root CA — the plan's assumption was wrong

The plan assumed a Let's Encrypt / ISRG Root X1 chain. Measured:

```
$ echo | openssl s_client -connect workers.dev:443 -servername workers.dev
depth=2 C = US, O = Google Trust Services LLC, CN = GTS Root R4
depth=1 C = US, O = Google Trust Services,     CN = WE1
depth=0 CN = workers.dev
```

Cloudflare's `workers.dev` chains to **GTS Root R4** via Google Trust Services
`WE1`. Embedding ISRG Root X1 would have failed every handshake in the field
with no useful error. `firmware/include/certs.h` embeds GTS Root R4 plus GTS
Root R1 (as a hedge against rotation within Google's roots) and documents the
re-check command.

This is also why `api::syncClock()` runs before the first request: certificate
validity is checked against the system clock, and a device that thinks it is
1970 fails the handshake regardless of which root is embedded.

## 7. Event synthesis verified by fault injection

The snapshot-diff path had no natural test (the real numbers do not move on
demand), so the cached snapshot in KV was rewound and the cron re-run:

| Rewound by | Event produced |
|---|---|
| `atomic-rollback` stars -2 | `star +2` |
| `chainsaw` openPRs -1 | `pr +1` |
| `chainsaw` openIssues +1 | `issue -1` |
| `piano` forks +3 | `fork -3` |

All four appeared with correct signs and reached the device payload ahead of the
GitHub feed events. This is the mechanism the ambient LED pulse fires on.

## 8. Firmware builds

`pio run -e crowpanel128` against `espressif32@6.5.0` (Arduino-ESP32 2.0.14),
LVGL 8.3.11, LovyanGFX 1.1.12:

```
RAM:   35.6% (116544 / 327680 bytes)
Flash: 32.1% (1347477 / 4194304 bytes)   [4MB OTA slot, dual-slot partition table]
```

Ample headroom in both. Not yet flashed — see the open items in the README.

## 9. Deployment domain

Target is `hdog.imcb.dev`. Checked on 2026-09-08: `imcb.dev` is already behind
Cloudflare and presents a Google Trust Services `WE1` leaf chaining to **GTS
Root R4** — the same root as `workers.dev`, so the embedded CA bundle needs no
change for the custom domain.

## 10. Board identification, and an OPI PSRAM trap

`esptool flash-id` against the real board (non-destructive):

```
Chip type:   ESP32-S3 (QFN56) (revision v0.2)
Features:    Wi-Fi, BT 5 (LE), Dual Core + LP Core, 240MHz, Embedded PSRAM 8MB
Flash:       16MB, manufacturer ba device 4018
Flash type set in eFuse: quad (4 data lines)
USB mode:    USB-Serial/JTAG        MAC: 68:ee:8f:5d:c5:48
```

Confirms 8MB PSRAM, 16MB flash (matching `partitions.csv`), and native USB.

**The trap:** flash is *quad*, PSRAM is *octal*. The `esp32-s3-devkitc-1` board
definition defaults to `memory_type = qio_qspi`, under which the octal PSRAM is
never initialised and **every `heap_caps_malloc(..., MALLOC_CAP_SPIRAM)` returns
null**. The LVGL draw buffers and the sparkline canvas all allocate from PSRAM,
so the symptom would have been a blank or crashing screen with nothing in the
build log to point at it.

Fixed with `board_build.arduino.memory_type = qio_opi` in `platformio.ini`. The
allocations now also fall back to internal RAM and log a line, so a future
misconfiguration degrades to a slow screen rather than a silent blank one.

## 11. First flash: two traps, both found by bisection

**Trap 1 — flash mode override caused a silent boot loop.** Flashing with
`--flash-mode qio` produced:

```
rst:0x7 (TG0WDT_SYS_RST),boot:0x18 (SPI_FAST_FLASH_BOOT)
mode:QIO, clock div:1
load:0x3fce3808,len:0x44c
ets_loader.c 78
      ... repeating forever, no app output
```

The toolchain stamps **DIO** into the bootloader header (`bootloader.bin` byte 2
= `0x02`), and esptool's `--flash-mode` *rewrites that byte*. The ROM then read
flash in the wrong mode and watchdogged before reaching the app.

Found by bisection rather than inspection: flashing Elecrow's published factory
firmware booted cleanly, which proved the hardware and the flashing procedure
were fine and isolated the fault to our build. `pio run -t upload -v` then showed
PlatformIO's own arguments — `--flash_mode dio`. `platformio.ini` now says `dio`
so config and reality agree.

**Trap 2 — TinyUSB broke reflashing.** With `ARDUINO_USB_MODE=0` the app takes
over USB, the port re-enumerates (COM3 -> COM4), and esptool can no longer
auto-reset: `Failed to connect: No serial data received`.

Switched to `ARDUINO_USB_MODE=1` (the hardware USB-Serial/JTAG peripheral). It is
still a CDC port, so Web Serial and Improv work exactly the same, but the port
stays put and auto-reset keeps working. If a build ever does take over USB again,
a **1200-baud touch with DTR low** reboots it into the ROM bootloader without
touching the BOOT button — `rotary-flash/touch1200.py`.

**Confirmed working on hardware:**

```
[boot] rotary-stats 0.1.0  reset=0
[boot] psram=8386295 bytes free, heap=305668 bytes free
[boot] display init
[boot] DEMO_MODE - rendering baked-in stats, no Wi-Fi
[alive] 5s heap=300188 enc=0
```

PSRAM initialises (vindicating `qio_opi`), display init returns, LVGL runs, and
the heap is stable across heartbeats. The firmware now logs a boot banner,
a 5-second heartbeat, and every encoder/press/swipe event -- added after
debugging the boot loop blind through a build that printed nothing.

**Recovery:** Elecrow publishes the complete factory image set. It is staged
locally with a restore command in `rotary-flash/factory-restore/RESTORE.txt`.
(A full 16MB `read-flash` backup was attempted first and failed with "Packet
content transfer stopped" — long reads over USB-Serial/JTAG stall. The vendor
image is the better recovery path anyway.)

## 12. Hardware bring-up: what the wiki got wrong

The wiki pin table is not sufficient to bring this board up. Two corrections,
both found only by reading Elecrow's factory source:

**GPIO1 and GPIO2 are power enables.** They must be driven HIGH before anything
else. They appear nowhere in the wiki. Without them the panel is completely
dead -- and misleadingly so: `gLcd.init()` still returns `true`, and driving the
backlight pin does nothing in *either* state, which looks like a dead pin or a
dead panel rather than a missing rail.

**The touch I2C pins are 6/7, not 38/39.** The wiki's table lists 38/39 as the
touch bus; the factory source shows those are the external 4P I2C connector
(`I2C_SDA_PIN`/`I2C_SCL_PIN`) and touch is on `TP_I2C_SDA_PIN 6` / `TP_I2C_SCL_PIN 7`.

**The backlight is not a LovyanGFX `Light_PWM`.** Elecrow drive GPIO46 with
`ledc` directly (channel 0, 5kHz, 8-bit) and attach no light to the panel.
Configuring `Light_PWM` produced a working panel with a permanently dark
backlight.

**Colour format.** `LV_COLOR_16_SWAP 1` *plus* `writePixels(..., swap=true)`
swaps twice: the accent orange `#F74C00` rendered as blue (`R` and `B`
exchanged, while white text looked fine because R=G=B), with diagonal moiré
across the panel. Fixed by matching the factory flush exactly -- `LV_COLOR_16_SWAP 0`
and `pushImageDMA` with an explicit `lgfx::rgb565_t` source.

**The CST816D gesture register is sticky.** It holds the last gesture instead of
clearing on read, so polling re-fires it: one physical swipe produced seven
events and would have skipped several decks. Now edge-detected on the
transition from "no gesture".

### Verified on hardware

```
[boot] rotary-stats 0.1.0  reset=0
[boot] psram=8386295 bytes free, heap=305444 bytes free
[boot] power rails GPIO1/GPIO2 HIGH
[boot] display init          [boot] gLcd.init() -> true
[boot] backlight on (GPIO46 ledc ch0)
[input] rotate +1 / -1       (both directions, net position tracked)
[input] swipe gesture=3 / 4  (left and right)
[input] press
```

Display, backlight, power rails, PSRAM, encoder, knob press and capacitive touch
all confirmed working on the real board.

## 13. Opening the serial port resets the board

Every diagnostic capture was rebooting the device. pyserial (and esptool, and a
browser opening the port for Improv) asserts DTR/RTS on open, which on this
board pulls the ESP32-S3 into reset. The device would replay its whole boot
sequence -- Connecting, Syncing clock, Registering -- and look like it was stuck
or crash-looping when it was simply starting over.

For **passive** observation, clear both lines before opening:

```python
s = serial.Serial()
s.port, s.baudrate, s.timeout = port, 115200, 0.2
s.dtr = False
s.rts = False
s.open()          # no reset
```

Proof: consecutive captures showed uptime continuing (67s -> 82s -> 92s) with no
boot banner, where previously every capture restarted the count.

The same applies to the browser: clicking "Connect device over USB" resets the
board, so the screen returning to the boot sequence at that moment is expected
behaviour, not a failure. It is also why Improv must be answered from inside the
blocking network path (see `uiYield`) -- the browser starts probing while the
device is still booting from the reset that the probe itself caused.

## 14. Networking belongs on core 0, not in loop()

Doing Wi-Fi association, NTP and TLS inside `setup()`/`loop()` caused three
separate symptoms that all looked like different bugs:

- the panel froze on whatever was last flushed (no LVGL pump during the wait),
- Improv went unanswered for seconds, so the browser reported "no Improv device
  answered" — while itself having *caused* the reboot it was probing across,
- the device looked stuck on "Registering", because that was simply the last
  screen drawn before a multi-second blocking HTTPS call.

`HTTPClient` offers no way to yield from inside a request, so no amount of
pumping fixes it from the outside. The fix is structural: all networking runs on
a task pinned to **core 0**, and core 1 runs only LVGL, Improv and the encoder.
State crosses between them through a mutex-guarded snapshot, and the Improv
connect handler hands credentials to the task and waits while pumping LVGL only
(re-entering `gImprov.loop()` from inside its own callback would be reentrant).

Proof it works: `[alive]` heartbeats now interleave with `[net]` lines during
boot, where before they only began once every network step had finished.

Two details worth keeping:

- A `304` response must not blank the display. The task seeds each poll from the
  previous snapshot, so an unchanged response leaves the stats intact.
- Once stats are on screen, a later phase change must never replace them with a
  status card — otherwise a transient reconnect wipes a working display.

## 15. Debugging infrastructure

Too much of this bring-up was guesswork, because the moments worth observing
were the ones where no monitor could be attached. Three things now make the
device observable:

**Device logs over Wi-Fi.** A 48-line ring buffer is tee'd from every `logf()`
call and shipped to `POST /api/log/:id`, readable back with `GET /api/log/:id`.
This matters because the browser *owns the serial port* during provisioning —
the single most failure-prone moment is the one where a serial monitor cannot be
connected. The heartbeat and input echo stay on the cable only, or they flush
the interesting boot lines out of the ring.

Shipping is piggybacked on the poll cycle. On its own 10-second timer it opened
a fresh TLS connection each time, visible as the heap sawtoothing between 155KB
and 208KB — not a leak, but a lot of handshakes for log lines.

**Browser console.** `cdt list_console_messages <pageId>` reads the page's
console, so the browser half of a failed provisioning attempt is inspectable
too.

**Passive serial.** `cap.py` clears DTR/RTS before opening so watching the device
does not reset it (see section 13).

Reading the log without any hardware attached:

```bash
curl -s https://hdog.imcb.dev/api/log/<deviceId> -H "x-device-key: <secret>" | jq -r '.lines[]'
```

## 16. Flashing needs the USB-JTAG reset sequence, not the classic one

After a browser flash the log ended with `Hard resetting via RTS pin...` and the
device stayed dark. The flash itself was perfect — every region written and
verified — but the chip never restarted.

The tell was in the diagnosis order: a *passive* serial read (one that does not
assert DTR/RTS) returned **nothing at all**, and the device only came back once
a reset was asserted manually. So it was halted, not crashing and not
boot-looping.

Cause: this board uses the ESP32-S3's built-in **USB-Serial/JTAG** peripheral.
esptool-js's default hard reset toggles RTS the way an external USB-UART bridge
(CH340, CP2102) expects, and that sequence does nothing here. esptool-js exports
`UsbJtagSerialReset` for exactly this case; the flasher now uses it and falls
back to `loader.after()` if it throws.

This also explains an earlier "black screen after flashing" that was originally
attributed to the NVS wipe. The NVS wipe was real and separate (section 11) —
the dark screen after it was this.
