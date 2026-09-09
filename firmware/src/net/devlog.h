#pragma once
#include <Arduino.h>

/**
 * Log tee: everything also goes into a small ring buffer that the network task
 * ships to the stats service.
 *
 * Serial alone is not enough to debug this device. The moments most worth
 * observing -- provisioning, and the reboot that opening the port causes -- are
 * exactly the moments the browser owns the serial port, so no monitor can be
 * attached. Shipping a bounded tail over Wi-Fi makes those visible after the
 * fact.
 */
namespace devlog {

/** Printf to Serial and to the ring buffer. */
void logf(const char* fmt, ...) __attribute__((format(printf, 1, 2)));

/**
 * Route ESP-IDF's own logging into the ring buffer instead of stdout.
 *
 * IDF logs via vprintf -> stdout -> USB CDC, which Arduino's
 * Serial.setTxTimeoutMs() does not govern. Those writes block whenever the host
 * is not draining the port, and the Wi-Fi driver is chatty enough during
 * association to stall startup for over a minute. Capturing them here removes
 * the dependency on anything being attached.
 */
void captureIdfLogs();

/** Move pending lines out for upload. Returns how many were written. */
size_t drain(String* out, size_t max);

bool hasPending();

}  // namespace devlog

// Route the existing call sites through the tee without touching each one.
#define LOGF(...) devlog::logf(__VA_ARGS__)
