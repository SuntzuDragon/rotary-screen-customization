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

/** Move pending lines out for upload. Returns how many were written. */
size_t drain(String* out, size_t max);

bool hasPending();

}  // namespace devlog

// Route the existing call sites through the tee without touching each one.
#define LOGF(...) devlog::logf(__VA_ARGS__)
