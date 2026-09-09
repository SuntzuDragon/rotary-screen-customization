#include "devlog.h"

#include <esp_log.h>
#include <stdarg.h>

namespace {
constexpr size_t kLines = 48;
constexpr size_t kLineLen = 160;

char gRing[kLines][kLineLen];
volatile size_t gHead = 0;   // next write slot
volatile size_t gTail = 0;   // next unsent slot
portMUX_TYPE gMux = portMUX_INITIALIZER_UNLOCKED;
}  // namespace

namespace {

/** Feed IDF log output into the ring; never touch stdout. */
int idfVprintf(const char* fmt, va_list args) {
  char line[kLineLen];
  const int n = vsnprintf(line, sizeof(line), fmt, args);
  devlog::logf("%s", line);
  return n;
}

}  // namespace

namespace devlog {

void captureIdfLogs() { esp_log_set_vprintf(idfVprintf); }

void logf(const char* fmt, ...) {
  char body[kLineLen];
  va_list args;
  va_start(args, fmt);
  vsnprintf(body, sizeof(body), fmt, args);
  va_end(args);

  // Stamp every line with uptime. Without this the ring records order but not
  // timing, and the whole question here is *when* each step happened -- a gap
  // between two adjacent lines is the entire finding.
  char line[kLineLen];
  snprintf(line, sizeof(line), "%8lu %s", static_cast<unsigned long>(millis()), body);

  // Only write to the cable when something is actually listening.
  //
  // On the USB-Serial/JTAG peripheral, Serial.write blocks when no host has the
  // port open -- so with a non-zero TX timeout every log line costs the full
  // timeout. The ESP-IDF Wi-Fi driver logs heavily during association, which
  // dragged a 3-second connect out to 80-100 seconds. Attaching a serial
  // monitor "fixed" it, which is exactly how the symptom was found.
  //
  // The ring buffer is always written, so nothing is lost: it ships over Wi-Fi.
  if (Serial) Serial.print(line);

  // Strip the trailing newline: the transport stores one string per line.
  size_t len = strlen(line);
  while (len && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = '\0';
  if (len == 0) return;

  portENTER_CRITICAL(&gMux);
  strncpy(gRing[gHead % kLines], line, kLineLen - 1);
  gRing[gHead % kLines][kLineLen - 1] = '\0';
  gHead++;
  // Oldest lines are dropped rather than blocking a logger on a full buffer.
  if (gHead - gTail > kLines) gTail = gHead - kLines;
  portEXIT_CRITICAL(&gMux);
}

bool hasPending() { return gHead > 0; }

size_t snapshot(String* out, size_t max) {
  size_t n = 0;
  portENTER_CRITICAL(&gMux);
  const size_t first = (gHead > kLines) ? gHead - kLines : 0;
  for (size_t i = first; i < gHead && n < max; i++) out[n++] = String(gRing[i % kLines]);
  portEXIT_CRITICAL(&gMux);
  return n;
}

}  // namespace devlog
