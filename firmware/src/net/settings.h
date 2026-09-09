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

}  // namespace settings
