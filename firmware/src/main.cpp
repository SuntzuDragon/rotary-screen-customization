#include <Arduino.h>
#include <Adafruit_NeoPixel.h>
#include <WiFi.h>
#include <esp_log.h>
#include <lvgl.h>

#include "board_pins.h"
#include "fw_version.h"
#include "backlight.h"
#include "display.h"
#include "model/stats.h"
#include "net/api_client.h"
#include "net/devlog.h"
#include "net/improv_serial.h"
#include "net/settings.h"
#include "ui/ui.h"

namespace {

CrowPanelDisplay gLcd;
constexpr uint16_t kLedCount = 5;
Adafruit_NeoPixel gLeds(kLedCount, PIN_RGB_LED, NEO_GRB + NEO_KHZ800);

/* ------------------------------ LED pulse ------------------------------ */

// A new star is the one event worth looking up for, so it gets a slow green
// breath rather than a blink. Non-blocking: driven from loop().
uint32_t gPulseStart = 0;
bool gPulsing = false;
int64_t gNewestSeenEvent = 0;

void pulseLeds() {
  gPulseStart = millis();
  gPulsing = true;
}

void serviceLeds(uint32_t now) {
  if (!gPulsing) return;
  constexpr uint32_t kDuration = 2600;
  const uint32_t elapsed = now - gPulseStart;
  if (elapsed >= kDuration) {
    gPulsing = false;
    gLeds.clear();
    gLeds.show();
    return;
  }
  // Two breaths: sin^2 gives a soft rise and fall with no hard edges.
  const float phase = (elapsed / static_cast<float>(kDuration)) * 2.0f * PI * 2.0f;
  const float s = sinf(phase / 2.0f);
  const uint8_t level = static_cast<uint8_t>(s * s * 170.0f);
  for (uint16_t i = 0; i < kLedCount; i++) gLeds.setPixelColor(i, gLeds.Color(0, level, level / 5));
  gLeds.show();
}

/** Fire the pulse when the payload carries a star event we have not seen. */
void checkForNewStars(const Stats& s) {
  int64_t newest = gNewestSeenEvent;
  bool star = false;
  for (uint8_t i = 0; i < s.eventCount; i++) {
    const EventStat& e = s.events[i];
    if (e.at > gNewestSeenEvent && strcmp(e.kind, "star") == 0 && e.delta > 0) star = true;
    if (e.at > newest) newest = e.at;
  }
  // First poll after boot only establishes the baseline -- otherwise every
  // restart would replay the whole event backlog as "new".
  const bool firstRun = gNewestSeenEvent == 0;
  gNewestSeenEvent = newest;
  if (star && !firstRun) {
    devlog::logf("[led] new star -> pulse\n");
    pulseLeds();
  }
}
ImprovSerial gImprov;
Stats gStats{};

// Full-screen double buffers, as the factory firmware uses. 240*240*2 = 115KB
// each; irrelevant against 8MB of PSRAM, and it keeps DMA from racing a partial
// buffer that LVGL is already redrawing.
constexpr size_t kDrawLines = SCREEN_H;
lv_disp_draw_buf_t gDrawBuf;
lv_color_t* gBuf1 = nullptr;
lv_color_t* gBuf2 = nullptr;

/* ------------------------------ encoder ------------------------------ */

volatile int32_t gEncoderSteps = 0;
volatile uint8_t gEncoderPrev = 0;

// Quadrature transition table: index [prev<<2 | now] -> -1, 0 or +1.
const int8_t kQuadrature[16] = {0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0};

void IRAM_ATTR onEncoderEdge() {
  const uint8_t now = (digitalRead(PIN_ENC_A) << 1) | digitalRead(PIN_ENC_B);
  gEncoderSteps += kQuadrature[(gEncoderPrev << 2) | now];
  gEncoderPrev = now;
}

/* ------------------------------ LVGL glue ------------------------------ */

void flushCb(lv_disp_drv_t* drv, const lv_area_t* area, lv_color_t* px) {
  // Mirrors Elecrow's factory flush. pushImageDMA with an explicit rgb565_t
  // source lets LovyanGFX handle the address window and byte order itself.
  if (gLcd.getStartCount() > 0) gLcd.endWrite();
  gLcd.pushImageDMA(area->x1, area->y1, area->x2 - area->x1 + 1, area->y2 - area->y1 + 1,
                    reinterpret_cast<lgfx::rgb565_t*>(&px->full));
  lv_disp_flush_ready(drv);
}

void initLvgl() {
  lv_init();
  // Draw buffers in PSRAM; two of them so DMA can overlap with rendering.
  // Falls back to internal RAM with a smaller buffer if PSRAM is missing or
  // misconfigured, so a wrong memory_type shows a slow screen rather than a
  // blank one that is hard to diagnose.
  size_t px = SCREEN_W * kDrawLines;
  gBuf1 = static_cast<lv_color_t*>(heap_caps_malloc(px * sizeof(lv_color_t), MALLOC_CAP_SPIRAM));
  gBuf2 = static_cast<lv_color_t*>(heap_caps_malloc(px * sizeof(lv_color_t), MALLOC_CAP_SPIRAM));
  if (!gBuf1 || !gBuf2) {
    devlog::logf("PSRAM unavailable - falling back to internal RAM\n");
    free(gBuf1);
    free(gBuf2);
    px = SCREEN_W * 10;
    gBuf1 = static_cast<lv_color_t*>(malloc(px * sizeof(lv_color_t)));
    gBuf2 = nullptr;
  }
  lv_disp_draw_buf_init(&gDrawBuf, gBuf1, gBuf2, px);

  static lv_disp_drv_t drv;
  lv_disp_drv_init(&drv);
  drv.hor_res = SCREEN_W;
  drv.ver_res = SCREEN_H;
  drv.flush_cb = flushCb;
  drv.draw_buf = &gDrawBuf;
  lv_disp_drv_register(&drv);
}

/* ----------------------------- networking ----------------------------- */

/* --------------------------- network task ---------------------------- */

/**
 * All networking runs on core 0, away from the UI.
 *
 * Wi-Fi association, NTP and TLS each block for seconds, and HTTPClient offers
 * no way to yield from inside a request. Doing that work in setup()/loop() left
 * the panel frozen and, worse, left Improv unanswered -- so the browser's probe
 * (which itself resets the board) timed out against a device busy booting.
 * Core 1 now only ever runs LVGL, Improv and the encoder, so the device stays
 * responsive no matter what the network is doing.
 */
enum class NetPhase : uint8_t { Idle, Connecting, Clock, Registering, Ready, Failed };

SemaphoreHandle_t gStateMutex = nullptr;

// Written by the network task, read by the UI. Guarded by gStateMutex.
NetPhase gPhase = NetPhase::Idle;
char gPhaseDetail[48] = "";
Stats gShared{};
bool gStatsDirty = false;

// Connection request handed from the Improv handler to the network task.
volatile bool gConnectRequested = false;
volatile int8_t gConnectResult = -1;  // -1 pending, 0 failed, 1 ok
String gReqSsid, gReqPass;

// Same shape, for "fetch settings now" arriving over USB while the browser
// holds the port. Networking belongs to the net task, so the Improv handler
// asks rather than fetching itself.
volatile bool gPollRequested = false;
volatile int8_t gPollResult = -1;
bool gRegistered = false;

void setPhase(NetPhase phase, const char* detail = "") {
  xSemaphoreTake(gStateMutex, portMAX_DELAY);
  gPhase = phase;
  strncpy(gPhaseDetail, detail, sizeof(gPhaseDetail) - 1);
  gPhaseDetail[sizeof(gPhaseDetail) - 1] = '\0';
  xSemaphoreGive(gStateMutex);
}

bool bringUpNetwork(const String& ssid, const String& pass) {
  setPhase(NetPhase::Connecting, ssid.c_str());
  if (!api::connectWifi(ssid, pass)) {
    setPhase(NetPhase::Failed, "wifi");
    return false;
  }
  setPhase(NetPhase::Clock);
  if (!api::syncClock()) {
    setPhase(NetPhase::Failed, "clock");
    return false;
  }
  setPhase(NetPhase::Registering, settings::deviceId().c_str());
  gRegistered = api::registerDevice();
  devlog::logf("[net] registered=%d\n", gRegistered ? 1 : 0);
  return true;
}

/** True if the service answered, whether or not anything had changed. */
bool pollOnce() {
  devlog::logf("[net] polling...\n");
  Stats fresh{};
  xSemaphoreTake(gStateMutex, portMAX_DELAY);
  fresh = gShared;  // keep prior values so a 304 never blanks the UI
  xSemaphoreGive(gStateMutex);

  const api::Result r = api::poll(fresh);

  // Ship logs every fifth poll (~5 minutes), not every one. Uploading on each
  // poll meant a TLS handshake and a KV round trip a minute purely for
  // diagnostics, which is most of a free-tier write budget for data nobody
  // reads unless something is wrong.
  static uint8_t sinceShip = 0;
  if (++sinceShip >= 30) {  // ~5 minutes at a 10s poll
    sinceShip = 0;
    api::shipLogs();
  }
  if (r == api::Result::Updated) {
    xSemaphoreTake(gStateMutex, portMAX_DELAY);
    gShared = fresh;
    gStatsDirty = true;
    xSemaphoreGive(gStateMutex);
  }
  if (r != api::Result::Failed) setPhase(NetPhase::Ready);
  return r != api::Result::Failed;
}

void netTask(void*) {
  devlog::logf("[net] task started on core %d\n", xPortGetCoreID());
  if (settings::hasWifi()) {
    if (bringUpNetwork(settings::ssid(), settings::password())) {
      pollOnce();
    } else {
      devlog::logf("[net] initial bring-up FAILED\n");
    }
  }

  uint32_t lastPoll = millis();
  for (;;) {
    if (gConnectRequested) {
      const bool ok = bringUpNetwork(gReqSsid, gReqPass);
      if (ok) {
        settings::saveWifi(gReqSsid, gReqPass);
        pollOnce();
        lastPoll = millis();
      } else if (settings::hasWifi() && settings::ssid() != gReqSsid) {
        // Changing networks from the settings page, and the new one did not
        // take. Credentials are only saved on success, so a reboot would
        // recover -- but nothing here reboots, and gRegistered is still true
        // so the retry below never fires. Go back to the known-good network
        // rather than leaving the dial dark until someone power-cycles it.
        devlog::logf("[net] new network failed, returning to %s\n", settings::ssid().c_str());
        bringUpNetwork(settings::ssid(), settings::password());
      }
      gConnectResult = ok ? 1 : 0;
      gConnectRequested = false;
    }

    // Asked over USB to fetch now. This is the whole point of the serial
    // connection staying open on the settings page: the browser has just
    // written the new settings, and rather than waiting out a poll interval it
    // says so directly.
    if (gPollRequested) {
      gPollRequested = false;
      if (gRegistered && WiFi.status() == WL_CONNECTED) {
        gPollResult = pollOnce() ? 1 : 0;
        lastPoll = millis();
      } else {
        devlog::logf("[net] refresh asked for while offline\n");
        gPollResult = 0;
      }
    }

    // 10s. Config now updates server-side instantly (D1 is strongly
    // consistent), so the poll interval is the *entire* remaining delay
    // between pushing a setting and seeing it on the dial -- unless the
    // browser is on the other end of the cable, in which case the request
    // above removes even that. Unchanged polls answer 304 with an empty body,
    // and even at this rate the device uses under 9% of the request budget and
    // 0.2% of the database read budget.
    if (gRegistered && WiFi.status() == WL_CONNECTED && millis() - lastPoll > 10000UL) {
      lastPoll = millis();
      pollOnce();
    }

    // Retry a failed bring-up. Without this a single missed association at boot
    // left the device idle forever with no way back except a power cycle.
    static uint32_t lastRetry = 0;
    if (!gRegistered && settings::hasWifi() && !gConnectRequested &&
        millis() - lastRetry > 30000UL) {
      lastRetry = millis();
      devlog::logf("[net] retrying bring-up\n");
      if (bringUpNetwork(settings::ssid(), settings::password())) {
        pollOnce();
        lastPoll = millis();
      }
    }

    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

/** Called from loop(): reflects network state on screen. Owns all LVGL calls. */
void serviceUi() {
  static NetPhase shown = NetPhase::Idle;
  static bool haveStats = false;

  NetPhase phase;
  char detail[48];
  bool dirty;
  xSemaphoreTake(gStateMutex, portMAX_DELAY);
  phase = gPhase;
  memcpy(detail, gPhaseDetail, sizeof(detail));
  dirty = gStatsDirty;
  if (dirty) {
    gStats = gShared;
    gStatsDirty = false;
  }
  xSemaphoreGive(gStateMutex);

  if (dirty) {
    backlight::set(gStats.brightness);
    checkForNewStars(gStats);
    ui::setStats(gStats);
    haveStats = true;
    shown = NetPhase::Ready;
    return;
  }

  // Once stats are on screen they stay there; a later phase change must never
  // replace live data with a status card.
  if (haveStats || phase == shown) {
    shown = phase;
    return;
  }
  shown = phase;
  devlog::logf("[ui] phase -> %d (%s)\n", static_cast<int>(phase), detail);

  const bool wifiFailed = strcmp(detail, "wifi") == 0;
  switch (phase) {
    case NetPhase::Connecting: ui::showStatus("Connecting", detail); break;
    case NetPhase::Clock: ui::showStatus("Syncing clock", "NTP"); break;
    case NetPhase::Registering: ui::showStatus("Registering", detail); break;
    case NetPhase::Failed:
      ui::showStatus(wifiFailed ? "Wi-Fi failed" : "Clock failed",
                     wifiFailed ? "Check the password and try again"
                                : "NTP unreachable; TLS cannot verify");
      break;
    default: break;
  }
}

#ifdef DEMO_MODE
/** Baked-in payload so UI work does not need Wi-Fi or a server. */
void loadDemoStats() {
  strcpy(gStats.login, "PlasticRocket");
  strcpy(gStats.name, "Harnoor Lal");
  gStats.followers = 3;
  gStats.stars = 19;
  gStats.contrib = 4548;
  gStats.accent = 0xF74C00;
  gStats.bg = 0x0B0D10;
  gStats.brightness = 80;
  gStats.rotSec = 8;
  for (bool& d : gStats.deckEnabled) d = true;

  const char* names[4] = {"atomic-rollback", "chainsaw", "cargo-avail", "piano"};
  const int32_t stars[4] = {9, 4, 3, 3};
  const int32_t issues[4] = {6, 44, 2, 31};
  const int32_t prs[4] = {0, 2, 1, 1};
  gStats.repoCount = 4;
  for (int i = 0; i < 4; i++) {
    RepoStat& r = gStats.repos[i];
    strncpy(r.name, names[i], sizeof(r.name) - 1);
    strcpy(r.lang, "Rust");
    r.langColor = 0xDEA584;
    r.stars = stars[i];
    r.forks = i == 0 ? 1 : 0;
    r.openPRs = prs[i];
    r.openIssues = issues[i];
    r.lastCommitAt = 1777000000;
  }
  gStats.eventCount = 0;
  gStats.valid = true;
}
#endif

}  // namespace

#ifdef DIAG_COLOR
/**
 * Colour ground-truth build. Draws with LovyanGFX directly -- no LVGL, no
 * framebuffer -- so it isolates the panel configuration from how LVGL's buffer
 * is being interpreted. `color888` asks LovyanGFX for a colour by name; if
 * these come out wrong, the panel config is wrong. If they come out right,
 * the panel is fine and the fault is purely in the LVGL pixel format.
 */
void setup() {
  Serial.begin(115200);
  // Never block on the cable. Improv packets are written in a single buffered
  // call into an empty buffer, so they survive a zero timeout; ordinary logging
  // is gated on `if (Serial)` in devlog, and the ring buffer keeps everything
  // for the Wi-Fi shipment regardless.
#if ARDUINO_USB_MODE
  Serial.setTxTimeoutMs(0);
#endif

  // Take IDF's logging off stdout/USB entirely -- it is the remaining path that
  // can block on an undrained port. Its output still reaches the ring buffer.
  devlog::captureIdfLogs();
  esp_log_level_set("*", ESP_LOG_WARN);
  delay(300);
  pinMode(PIN_PWR_EN1, OUTPUT); digitalWrite(PIN_PWR_EN1, HIGH);
  pinMode(PIN_PWR_EN2, OUTPUT); digitalWrite(PIN_PWR_EN2, HIGH);
  gLcd.init();
  gLcd.setRotation(0);
  backlight::begin(90);
  gLcd.setTextSize(2);
}

struct Swatch { const char* name; uint8_t r, g, b; };
static const Swatch kSwatches[] = {
    {"RED",   255, 0,   0},
    {"GREEN", 0,   255, 0},
    {"BLUE",  0,   0,   255},
    {"WHITE", 255, 255, 255},
    {"BG",    0x0B, 0x0D, 0x10},   // the UI background: should look near-black
    {"ORANGE",0xF7, 0x4C, 0x00},   // the UI accent
};

void loop() {
  for (const auto& s : kSwatches) {
    gLcd.fillScreen(gLcd.color888(s.r, s.g, s.b));
    // Label in a contrasting colour so the swatch name is readable.
    gLcd.setTextColor(gLcd.color888(128, 128, 128));
    gLcd.setCursor(70, 110);
    gLcd.print(s.name);
    devlog::logf("[color] showing %s (r=%u g=%u b=%u)\n", s.name, s.r, s.g, s.b);
    delay(2500);
  }
}
#elif defined(DIAG_BACKLIGHT)
/**
 * Backlight-only bring-up build. Blinks GPIO46 forever with nothing else
 * running, so the panel can be observed at leisure instead of during a 2.7s
 * window at boot.
 */
void setup() {
  Serial.begin(115200);
  // Never block on the cable. Improv packets are written in a single buffered
  // call into an empty buffer, so they survive a zero timeout; ordinary logging
  // is gated on `if (Serial)` in devlog, and the ring buffer keeps everything
  // for the Wi-Fi shipment regardless.
#if ARDUINO_USB_MODE
  Serial.setTxTimeoutMs(0);
#endif

  // Take IDF's logging off stdout/USB entirely -- it is the remaining path that
  // can block on an undrained port. Its output still reaches the ring buffer.
  devlog::captureIdfLogs();
  esp_log_level_set("*", ESP_LOG_WARN);
  delay(300);
  devlog::logf("[diag] backlight-only build: GPIO46 1s on / 1s off, forever\n");
  // Board power rails must come up before anything else -- see board_pins.h.
  pinMode(PIN_PWR_EN1, OUTPUT);
  digitalWrite(PIN_PWR_EN1, HIGH);
  pinMode(PIN_PWR_EN2, OUTPUT);
  digitalWrite(PIN_PWR_EN2, HIGH);
  pinMode(PIN_PWR_IND, OUTPUT);
  digitalWrite(PIN_PWR_IND, LOW);  // active low: lights the power indicator
  devlog::logf("[diag] power rails GPIO1/GPIO2 HIGH\n");
  pinMode(PIN_LCD_BL, OUTPUT);
}

void loop() {
  digitalWrite(PIN_LCD_BL, HIGH);
  devlog::logf("[diag] GPIO46 HIGH  <- backlight should be ON now\n");
  delay(1000);
  digitalWrite(PIN_LCD_BL, LOW);
  devlog::logf("[diag] GPIO46 LOW   <- backlight should be OFF now\n");
  delay(1000);
}
#else

void setup() {
  Serial.begin(115200);
  // Never block on the cable. Improv packets are written in a single buffered
  // call into an empty buffer, so they survive a zero timeout; ordinary logging
  // is gated on `if (Serial)` in devlog, and the ring buffer keeps everything
  // for the Wi-Fi shipment regardless.
#if ARDUINO_USB_MODE
  Serial.setTxTimeoutMs(0);
#endif

  // Take IDF's logging off stdout/USB entirely -- it is the remaining path that
  // can block on an undrained port. Its output still reaches the ring buffer.
  devlog::captureIdfLogs();
  esp_log_level_set("*", ESP_LOG_WARN);
  delay(300);  // let the USB CDC host attach before the first line
  devlog::logf("\n[boot] rotary-stats %s  reset=%d\n", FW_VERSION,
                static_cast<int>(esp_reset_reason()));
  devlog::logf("[boot] psram=%u bytes free, heap=%u bytes free\n",
                static_cast<unsigned>(ESP.getFreePsram()),
                static_cast<unsigned>(ESP.getFreeHeap()));
  settings::begin();
  devlog::logf("[boot] device=%s provisioned=%d url=%s\n", settings::deviceId().c_str(),
                settings::hasWifi() ? 1 : 0, settings::baseUrl().c_str());

  // Board power rails must come up before anything else -- see board_pins.h.
  pinMode(PIN_PWR_EN1, OUTPUT);
  digitalWrite(PIN_PWR_EN1, HIGH);
  pinMode(PIN_PWR_EN2, OUTPUT);
  digitalWrite(PIN_PWR_EN2, HIGH);
  pinMode(PIN_PWR_IND, OUTPUT);
  digitalWrite(PIN_PWR_IND, LOW);  // active low: lights the power indicator
  devlog::logf("[boot] power rails GPIO1/GPIO2 HIGH\n");

  devlog::logf("[boot] display init\n");
  const bool lcdOk = gLcd.init();
  devlog::logf("[boot] gLcd.init() -> %s\n", lcdOk ? "true" : "false");
  gLcd.setRotation(0);
  gLcd.initDMA();

  // The NeoPixel ring powers up in an undefined state and glows random
  // colours. Explicitly clear it.
  gLeds.begin();
  gLeds.clear();
  gLeds.show();
  backlight::begin(80);
  devlog::logf("[boot] backlight on (GPIO46 ledc ch0)\n");

  // Panel self-test: a solid fill before LVGL exists. If this flashes, the SPI
  // bus and backlight are both good and any later blankness is a UI bug.
  gLcd.fillScreen(0xF800);  // red
  delay(250);
  gLcd.fillScreen(0x07E0);  // green
  delay(250);
  gLcd.fillScreen(0x0000);
  devlog::logf("[boot] panel self-test done\n");

  initLvgl();
  ui::init(0xF74C00);
  ui::showSplash();
  // Pump LVGL so the splash is actually on the glass before Wi-Fi blocks.
  for (uint32_t t = millis(); millis() - t < 900;) {
    lv_timer_handler();
    delay(5);
  }

  pinMode(PIN_ENC_A, INPUT_PULLUP);
  pinMode(PIN_ENC_B, INPUT_PULLUP);
  pinMode(PIN_ENC_SW, INPUT_PULLUP);
  gEncoderPrev = (digitalRead(PIN_ENC_A) << 1) | digitalRead(PIN_ENC_B);
  attachInterrupt(digitalPinToInterrupt(PIN_ENC_A), onEncoderEdge, CHANGE);
  attachInterrupt(digitalPinToInterrupt(PIN_ENC_B), onEncoderEdge, CHANGE);

#ifdef DEMO_MODE
  devlog::logf("[boot] DEMO_MODE - rendering baked-in stats, no Wi-Fi\n");
  loadDemoStats();
  ui::setStats(gStats);
  return;
#endif

  gStateMutex = xSemaphoreCreateMutex();
  gImprov.begin(Serial, "Rotary Stats", "rotary-stats", FW_VERSION, "ESP32-S3");
  gImprov.setNextUrl([]() { return settings::configUrl(); });
  gImprov.setHostAttached([]() { return static_cast<bool>(Serial); });
  gImprov.setRefreshHandler([]() {
    // Same hand-off as the connect handler below: the work belongs to the net
    // task, and this waits here pumping only LVGL, since the browser is
    // blocked on the reply and Improv has nothing else to answer.
    gPollResult = -1;
    gPollRequested = true;

    const uint32_t deadline = millis() + 20000UL;
    while (gPollResult < 0 && static_cast<int32_t>(deadline - millis()) > 0) {
      serviceUi();
      lv_timer_handler();
      delay(10);
    }
    return gPollResult == 1;
  });
  gImprov.setConnectHandler([](const String& ssid, const String& pass) {
    // Hand the work to the network task and wait here. Only LVGL is pumped:
    // the browser is blocked on this RPC result so Improv has nothing to
    // answer, and re-entering gImprov.loop() from its own callback would be
    // reentrant.
    gReqSsid = ssid;
    gReqPass = pass;
    gConnectResult = -1;
    gConnectRequested = true;

    const uint32_t deadline = millis() + 60000UL;
    while (gConnectResult < 0 && static_cast<int32_t>(deadline - millis()) > 0) {
      serviceUi();
      lv_timer_handler();
      delay(10);
    }
    return gConnectResult == 1;
  });

  if (settings::hasWifi()) {
    gImprov.setState(ImprovSerial::STATE_PROVISIONED);
    // Move off the splash immediately. Waiting for the network task to report
    // its first phase means any slow start leaves the wordmark on screen with
    // no indication anything is happening -- which reads as a hang.
    setPhase(NetPhase::Connecting, settings::ssid().c_str());
  } else {
    gImprov.setState(ImprovSerial::STATE_AUTHORIZED);
    String host = settings::baseUrl();
    host.replace("https://", "");
    host.replace("http://", "");
    devlog::logf("[ui] setup screen: %s\n", host.c_str());
    ui::showSetup(host.c_str());
  }

  // Networking lives on core 0 so core 1 never stalls on it.
  xTaskCreatePinnedToCore(netTask, "net", 8192, nullptr, 1, nullptr, 0);
}

void loop() {
  lv_timer_handler();

#ifndef DEMO_MODE
  // Pumped every iteration: the USB port re-enumerates whenever a browser opens
  // or closes it, so there is no boot-time window to gate this behind.
  gImprov.loop();
#endif

  // Encoder detents. The hardware emits four transitions per click.
  static int32_t consumed = 0;
  const int32_t steps = gEncoderSteps;
  const int32_t detents = (steps - consumed) / 4;
  if (detents != 0) {
    consumed += detents * 4;
    Serial.printf("[input] rotate %+ld\n", static_cast<long>(detents));
    ui::onRotate(detents > 0 ? 1 : -1);
  }

  serviceLeds(millis());
  serviceUi();

  // Heartbeat + input echo, so the demo build can be diagnosed over serial
  // without being able to see the panel.
  static uint32_t lastBeat = 0;
  if (millis() - lastBeat > 5000) {
    lastBeat = millis();
    // In the ring, not just on the cable: a gap between heartbeats is how a
    // stalled task shows up when nothing is attached to watch it.
    devlog::logf("[alive] heap=%u enc=%ld\n", static_cast<unsigned>(ESP.getFreeHeap()),
                 static_cast<long>(gEncoderSteps));
  }

  static uint32_t lastSwitch = 0;
  static bool switchWas = true;
  const bool switchNow = digitalRead(PIN_ENC_SW);
  if (switchWas && !switchNow && millis() - lastSwitch > 220) {
    lastSwitch = millis();
    Serial.println("[input] press");
    ui::onPress();
  }
  switchWas = switchNow;

#ifndef DEMO_MODE
  ui::tick(millis());
#endif

  delay(4);
}
#endif  // DIAG_BACKLIGHT
