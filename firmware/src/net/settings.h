#pragma once
#include <Arduino.h>

/** Persistent device identity and credentials, in NVS. */
namespace settings {

void begin();

/** Stable per-device id, minted on first boot. */
const String& deviceId();
/** Shared secret proving ownership to the API. Also handed to the browser. */
const String& deviceSecret();

String ssid();
String password();
bool hasWifi();
void saveWifi(const String& ssid, const String& password);
void clearWifi();

/** API origin, e.g. "https://rotary-stats.example.workers.dev". */
String baseUrl();
void setBaseUrl(const String& url);

/** The URL handed back over Improv so the browser lands already authenticated. */
String configUrl();

/**
 * Wall-clock time this firmware version first ran, or 0 if it has not managed
 * to ask a clock yet. Recorded by noteVersion, shown on the long-press screen.
 */
uint32_t flashedAt();

/**
 * Stamp the running version. The first boot of a new version records the time;
 * later boots of the same one leave it alone, so it reads as "flashed at"
 * rather than "started at". Needs the clock, so call it after an NTP sync.
 */
void noteVersion(const char* version);

}  // namespace settings
