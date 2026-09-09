#pragma once
#include "../model/stats.h"

namespace api {

enum class Result { Updated, Unchanged, Failed };


/**
 * NTP. Must succeed before the first HTTPS request: certificate validity is
 * checked against the system clock, and a device that thinks it is 1970 fails
 * every TLS handshake.
 */
bool syncClock(uint32_t timeoutMs = 15000);

bool connectWifi(const String& ssid, const String& password, uint32_t timeoutMs = 20000);

/** Trust-on-first-use registration of this device's secret. */
bool registerDevice();

/** Poll for stats. Returns Unchanged when the server answers 304. */
Result poll(Stats& out);

}  // namespace api
