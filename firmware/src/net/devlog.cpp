#include "devlog.h"

#include <stdarg.h>

namespace {
constexpr size_t kLines = 48;
constexpr size_t kLineLen = 160;

char gRing[kLines][kLineLen];
volatile size_t gHead = 0;   // next write slot
volatile size_t gTail = 0;   // next unsent slot
portMUX_TYPE gMux = portMUX_INITIALIZER_UNLOCKED;
}  // namespace

namespace devlog {

void logf(const char* fmt, ...) {
  char line[kLineLen];
  va_list args;
  va_start(args, fmt);
  vsnprintf(line, sizeof(line), fmt, args);
  va_end(args);

  Serial.print(line);

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

bool hasPending() { return gHead != gTail; }

size_t drain(String* out, size_t max) {
  size_t n = 0;
  portENTER_CRITICAL(&gMux);
  while (gTail != gHead && n < max) {
    out[n++] = String(gRing[gTail % kLines]);
    gTail++;
  }
  portEXIT_CRITICAL(&gMux);
  return n;
}

}  // namespace devlog
