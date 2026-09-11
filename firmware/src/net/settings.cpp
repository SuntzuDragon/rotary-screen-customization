#include "settings.h"

#include <Preferences.h>
#include <time.h>
#include <esp_random.h>
#include <bootloader_random.h>

#ifndef DEFAULT_BASE_URL
#define DEFAULT_BASE_URL "https://hdog.imcb.dev"
#endif

namespace {
Preferences prefs;
String gId, gSecret;
uint32_t gFlashedAt = 0;

/** Anything earlier than this is an unset clock, not a real timestamp. */
constexpr uint32_t kPlausibleEpoch = 1700000000;  // Nov 2023

/**
 * esp_random() is only a true RNG while the RF subsystem is running, and this
 * runs long before WiFi.begin(). Before then it is a thinly seeded PRNG, which
 * for a value that is the *only* thing protecting a device's config and its
 * stored GitHub token is not good enough -- a batch of boards could otherwise
 * come up with related secrets. The bootloader entropy source covers the gap.
 */
struct EntropyGuard {
  EntropyGuard() { bootloader_random_enable(); }
  ~EntropyGuard() { bootloader_random_disable(); }
};

String randomHex(size_t bytes) {
  String out;
  out.reserve(bytes * 2);
  for (size_t i = 0; i < bytes; i++) {
    char buf[3];
    snprintf(buf, sizeof(buf), "%02x", static_cast<unsigned>(esp_random() & 0xFF));
    out += buf;
  }
  return out;
}

/** Device ids avoid look-alike characters so they survive being read aloud. */
String randomId(size_t n) {
  static const char kAlphabet[] = "abcdefghijkmnpqrstuvwxyz23456789";
  String out;
  out.reserve(n);
  for (size_t i = 0; i < n; i++) out += kAlphabet[esp_random() % (sizeof(kAlphabet) - 1)];
  return out;
}
}  // namespace

namespace settings {

void begin() {
  prefs.begin("rstats", false);

  gId = prefs.getString("id", "");
  gSecret = prefs.getString("secret", "");
  gFlashedAt = prefs.getUInt("fwat", 0);
  if (gId.isEmpty() || gSecret.isEmpty()) {
    EntropyGuard entropy;
    if (gId.isEmpty()) {
      gId = randomId(8);
      prefs.putString("id", gId);
    }
    if (gSecret.isEmpty()) {
      gSecret = randomHex(16);
      prefs.putString("secret", gSecret);
    }
  }
}

bool saveBlob(const char* key, const void* data, size_t len) {
  return prefs.putBytes(key, data, len) == len;
}

bool loadBlob(const char* key, void* out, size_t len) {
  if (!prefs.isKey(key)) return false;
  // A size mismatch means the layout moved under the cache. Treat it as empty:
  // half-reading a struct is worse than not having one.
  if (prefs.getBytesLength(key) != len) return false;
  return prefs.getBytes(key, out, len) == len;
}

uint32_t flashedAt() { return gFlashedAt; }

void noteVersion(const char* version) {
  const uint32_t now = static_cast<uint32_t>(time(nullptr));
  if (now < kPlausibleEpoch) return;  // clock not set yet; a later call will do it

  const String stored = prefs.getString("fwver", "");
  if (stored == version && gFlashedAt != 0) return;

  gFlashedAt = now;
  prefs.putString("fwver", version);
  prefs.putUInt("fwat", gFlashedAt);
}

const String& deviceId() { return gId; }
const String& deviceSecret() { return gSecret; }

String ssid() { return prefs.isKey("ssid") ? prefs.getString("ssid", "") : String(); }
String password() { return prefs.isKey("pass") ? prefs.getString("pass", "") : String(); }
bool hasWifi() { return ssid().length() > 0; }

void saveWifi(const String& s, const String& p) {
  prefs.putString("ssid", s);
  prefs.putString("pass", p);
}

void clearWifi() {
  prefs.remove("ssid");
  prefs.remove("pass");
}

String baseUrl() {
  return prefs.isKey("base") ? prefs.getString("base", DEFAULT_BASE_URL) : String(DEFAULT_BASE_URL);
}
void setBaseUrl(const String& url) { prefs.putString("base", url); }

String configUrl() { return baseUrl() + "/#d=" + gId + "&k=" + gSecret; }

}  // namespace settings
