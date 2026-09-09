#include <Arduino.h>
#include <Adafruit_NeoPixel.h>
#include <lvgl.h>

#include "board_pins.h"
#include "fw_version.h"
#include "backlight.h"
#include "display.h"
#include "model/stats.h"
#include "net/api_client.h"
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
    Serial.println("[led] new star -> pulse");
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
    Serial.println("PSRAM unavailable - falling back to internal RAM");
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

uint32_t gLastPoll = 0;
bool gRegistered = false;

/**
 * Keep the device responsive while the network blocks.
 *
 * Improv matters as much as the screen here: opening the serial port resets the
 * board, so the browser starts probing for Improv exactly while setup() is busy
 * joining Wi-Fi and registering. Without pumping it from here the device stays
 * silent for several seconds and the page reports "no Improv device answered".
 */
void uiYield() {
  lv_timer_handler();
  gImprov.loop();
}

bool bringUpNetwork(const String& ssid, const String& pass) {
  ui::showStatus("Connecting", ssid.c_str());
  lv_timer_handler();  // get that on the glass before we block

  if (!api::connectWifi(ssid, pass)) {
    ui::showStatus("Wi-Fi failed", "Could not join that network");
    return false;
  }
  ui::showStatus("Syncing clock", "NTP");
  lv_timer_handler();

  // Certificates are validated against the clock, so NTP must land first.
  if (!api::syncClock()) {
    ui::showStatus("Clock failed", "NTP unreachable; TLS cannot verify");
    return false;
  }
  ui::showStatus("Registering", settings::deviceId().c_str());
  lv_timer_handler();

  gRegistered = api::registerDevice();
  Serial.printf("[net] registered=%d\n", gRegistered ? 1 : 0);
  return true;
}

void pollNow() {
  Serial.println("[net] polling...");
  const api::Result r = api::poll(gStats);
  if (r == api::Result::Updated) {
    backlight::set(gStats.brightness);
    checkForNewStars(gStats);
    ui::setStats(gStats);
  } else if (r == api::Result::Failed && !gStats.valid) {
    ui::showStatus("No data yet", "Could not reach the stats service");
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
  // Non-blocking TX. On the USB-Serial/JTAG peripheral a host that holds the
  // port open without reading (a browser that opened it for Improv and then
  // gave up) stalls Serial.write indefinitely, which freezes the whole device
  // mid-boot. Dropping log bytes is always preferable to hanging.
#if ARDUINO_USB_MODE
  Serial.setTxTimeoutMs(0);
#endif
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
    Serial.printf("[color] showing %s (r=%u g=%u b=%u)\n", s.name, s.r, s.g, s.b);
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
  // Non-blocking TX. On the USB-Serial/JTAG peripheral a host that holds the
  // port open without reading (a browser that opened it for Improv and then
  // gave up) stalls Serial.write indefinitely, which freezes the whole device
  // mid-boot. Dropping log bytes is always preferable to hanging.
#if ARDUINO_USB_MODE
  Serial.setTxTimeoutMs(0);
#endif
  delay(300);
  Serial.println("[diag] backlight-only build: GPIO46 1s on / 1s off, forever");
  // Board power rails must come up before anything else -- see board_pins.h.
  pinMode(PIN_PWR_EN1, OUTPUT);
  digitalWrite(PIN_PWR_EN1, HIGH);
  pinMode(PIN_PWR_EN2, OUTPUT);
  digitalWrite(PIN_PWR_EN2, HIGH);
  pinMode(PIN_PWR_IND, OUTPUT);
  digitalWrite(PIN_PWR_IND, LOW);  // active low: lights the power indicator
  Serial.println("[diag] power rails GPIO1/GPIO2 HIGH");
  pinMode(PIN_LCD_BL, OUTPUT);
}

void loop() {
  digitalWrite(PIN_LCD_BL, HIGH);
  Serial.println("[diag] GPIO46 HIGH  <- backlight should be ON now");
  delay(1000);
  digitalWrite(PIN_LCD_BL, LOW);
  Serial.println("[diag] GPIO46 LOW   <- backlight should be OFF now");
  delay(1000);
}
#else

void setup() {
  Serial.begin(115200);
  // Non-blocking TX. On the USB-Serial/JTAG peripheral a host that holds the
  // port open without reading (a browser that opened it for Improv and then
  // gave up) stalls Serial.write indefinitely, which freezes the whole device
  // mid-boot. Dropping log bytes is always preferable to hanging.
#if ARDUINO_USB_MODE
  Serial.setTxTimeoutMs(0);
#endif
  delay(300);  // let the USB CDC host attach before the first line
  Serial.printf("\n[boot] rotary-stats %s  reset=%d\n", FW_VERSION,
                static_cast<int>(esp_reset_reason()));
  Serial.printf("[boot] psram=%u bytes free, heap=%u bytes free\n",
                static_cast<unsigned>(ESP.getFreePsram()),
                static_cast<unsigned>(ESP.getFreeHeap()));
  settings::begin();

  // Board power rails must come up before anything else -- see board_pins.h.
  pinMode(PIN_PWR_EN1, OUTPUT);
  digitalWrite(PIN_PWR_EN1, HIGH);
  pinMode(PIN_PWR_EN2, OUTPUT);
  digitalWrite(PIN_PWR_EN2, HIGH);
  pinMode(PIN_PWR_IND, OUTPUT);
  digitalWrite(PIN_PWR_IND, LOW);  // active low: lights the power indicator
  Serial.println("[boot] power rails GPIO1/GPIO2 HIGH");

  Serial.println("[boot] display init");
  const bool lcdOk = gLcd.init();
  Serial.printf("[boot] gLcd.init() -> %s\n", lcdOk ? "true" : "false");
  gLcd.setRotation(0);
  gLcd.initDMA();

  // The NeoPixel ring powers up in an undefined state and glows random
  // colours. Explicitly clear it.
  gLeds.begin();
  gLeds.clear();
  gLeds.show();
  backlight::begin(80);
  Serial.println("[boot] backlight on (GPIO46 ledc ch0)");

  // Panel self-test: a solid fill before LVGL exists. If this flashes, the SPI
  // bus and backlight are both good and any later blankness is a UI bug.
  gLcd.fillScreen(0xF800);  // red
  delay(250);
  gLcd.fillScreen(0x07E0);  // green
  delay(250);
  gLcd.fillScreen(0x0000);
  Serial.println("[boot] panel self-test done");

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
  Serial.println("[boot] DEMO_MODE - rendering baked-in stats, no Wi-Fi");
  loadDemoStats();
  ui::setStats(gStats);
  return;
#endif

  api::setYield(uiYield);
  gImprov.begin(Serial, "Rotary Stats", "rotary-stats", FW_VERSION, "ESP32-S3");
  gImprov.setNextUrl([]() { return settings::configUrl(); });
  gImprov.setConnectHandler([](const String& ssid, const String& pass) {
    if (!bringUpNetwork(ssid, pass)) {
      ui::showStatus("Wi-Fi failed", "Check the password and try again");
      return false;
    }
    settings::saveWifi(ssid, pass);
    pollNow();
    return true;
  });

  if (settings::hasWifi() && bringUpNetwork(settings::ssid(), settings::password())) {
    gImprov.setState(ImprovSerial::STATE_PROVISIONED);
    pollNow();
  } else {
    gImprov.setState(ImprovSerial::STATE_AUTHORIZED);
    String host = settings::baseUrl();
    host.replace("https://", "");
    host.replace("http://", "");
    ui::showSetup(host.c_str());
  }
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

  // Heartbeat + input echo, so the demo build can be diagnosed over serial
  // without being able to see the panel.
  static uint32_t lastBeat = 0;
  if (millis() - lastBeat > 5000) {
    lastBeat = millis();
    Serial.printf("[alive] %lus heap=%u enc=%ld\n", millis() / 1000,
                  static_cast<unsigned>(ESP.getFreeHeap()),
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
  const uint32_t now = millis();
  if (gStats.valid || gRegistered) {
    if (now - gLastPoll > 60000UL) {
      gLastPoll = now;
      pollNow();
    }
  }
  ui::tick(now);
#endif

  delay(4);
}
#endif  // DIAG_BACKLIGHT
