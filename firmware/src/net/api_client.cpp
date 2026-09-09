#include "api_client.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <time.h>

#include "certs.h"
#include "fw_version.h"
#include "settings.h"
#include "devlog.h"

namespace {

String gEtag;

// This module now runs entirely on the network task, so waiting is a plain
// delay -- nothing here needs to keep the UI alive any more.
void pump(uint32_t ms) { delay(ms); }

uint32_t parseHexColor(const char* s) {
  if (!s || *s != '#') return 0;
  return strtoul(s + 1, nullptr, 16);
}

void copyStr(char* dst, size_t cap, const char* src) {
  if (!src) {
    dst[0] = '\0';
    return;
  }
  strncpy(dst, src, cap - 1);
  dst[cap - 1] = '\0';
}

WiFiClientSecure makeClient() {
  WiFiClientSecure c;
#ifdef INSECURE_TLS
  // Bench escape hatch only. Never ship this: it disables certificate checking.
  c.setInsecure();
#else
  c.setCACert(ROOT_CA_BUNDLE);
#endif
  c.setTimeout(12);
  return c;
}

}  // namespace

namespace api {

bool connectWifi(const String& ssid, const String& password, uint32_t timeoutMs) {
  if (ssid.isEmpty()) return false;
  devlog::logf("[net] wifi connecting to \"%s\"\n", ssid.c_str());

  // Start from a clean radio state. After a reset the previous association can
  // linger in the driver and the next WiFi.begin() takes minutes to succeed
  // instead of seconds -- measured at ~105s on this board. Tearing the old
  // session down first makes association consistently quick.
  WiFi.persistent(false);
  WiFi.disconnect(true, true);
  delay(100);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // a desk display has no reason to power-save the radio
  WiFi.begin(ssid.c_str(), password.c_str());

  const uint32_t start = millis();
  while (millis() - start < timeoutMs) {
    if (WiFi.status() == WL_CONNECTED) {
      devlog::logf("[net] wifi ok, ip=%s rssi=%d\n", WiFi.localIP().toString().c_str(),
                    WiFi.RSSI());
      return true;
    }
    pump(200);
  }
  devlog::logf("[net] wifi FAILED, status=%d\n", static_cast<int>(WiFi.status()));
  return false;
}

bool syncClock(uint32_t timeoutMs) {
  devlog::logf("[net] ntp sync...\n");
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  const uint32_t start = millis();
  while (millis() - start < timeoutMs) {
    const time_t now = time(nullptr);
    if (now > 1700000000) {  // clearly past 2023, so NTP has landed
      devlog::logf("[net] ntp ok, epoch=%lld\n", static_cast<long long>(now));
      return true;
    }
    pump(250);
  }
  devlog::logf("[net] ntp FAILED - TLS will reject certs without a clock\n");
  return false;
}

bool registerDevice() {
  WiFiClientSecure client = makeClient();
  HTTPClient http;
  const String url = settings::baseUrl() + "/api/device/" + settings::deviceId() + "/register";
  if (!http.begin(client, url)) return false;

  http.addHeader("content-type", "application/json");
  const String body = String("{\"secret\":\"") + settings::deviceSecret() + "\"}";
  const int code = http.POST(body);
  http.end();
  devlog::logf("[net] register -> %d\n", code);
  return code == 200;
}

Result poll(Stats& out) {
  WiFiClientSecure client = makeClient();
  HTTPClient http;
  const String url = settings::baseUrl() + "/api/device/" + settings::deviceId();
  if (!http.begin(client, url)) return Result::Failed;

  http.addHeader("x-device-key", settings::deviceSecret());
  // Lets the settings page show running vs available firmware.
  http.addHeader("x-fw-version", FW_VERSION);
  if (gEtag.length()) http.addHeader("If-None-Match", gEtag);

  const char* collect[] = {"ETag"};
  http.collectHeaders(collect, 1);

  const int code = http.GET();
  devlog::logf("[net] poll -> %d\n", code);
  if (code == 304) {
    http.end();
    return Result::Unchanged;
  }
  if (code != 200) {
    devlog::logf("[net] poll failed: %s\n", HTTPClient::errorToString(code).c_str());
    http.end();
    return Result::Failed;
  }

  // Filter down to what the UI draws; the full document is small but the
  // filtered parse keeps the working set predictable.
  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, http.getStream());
  const String etag = http.header("ETag");
  http.end();
  if (err) {
    devlog::logf("[net] json parse failed: %s\n", err.c_str());
    return Result::Failed;
  }

  copyStr(out.login, sizeof(out.login), doc["p"]["login"] | "");
  copyStr(out.name, sizeof(out.name), doc["p"]["name"] | "");
  out.followers = doc["p"]["followers"] | 0;
  out.stars = doc["p"]["stars"] | 0;
  out.contrib = doc["p"]["contrib"] | 0;

  out.accent = parseHexColor(doc["theme"]["accent"] | "#F74C00");
  out.bg = parseHexColor(doc["theme"]["bg"] | "#0B0D10");
  out.brightness = doc["theme"]["bright"] | 80;
  out.rotSec = doc["theme"]["rotSec"] | 8;

  static const char* kDeckNames[3] = {"summary", "repos", "activity"};
  for (int i = 0; i < 3; i++) out.deckEnabled[i] = false;
  for (JsonVariant d : doc["decks"].as<JsonArray>()) {
    const char* s = d.as<const char*>();
    for (int i = 0; i < 3; i++) {
      if (s && strcmp(s, kDeckNames[i]) == 0) out.deckEnabled[i] = true;
    }
  }

  out.repoCount = 0;
  for (JsonObject r : doc["repos"].as<JsonArray>()) {
    if (out.repoCount >= kMaxRepos) break;
    RepoStat& d = out.repos[out.repoCount++];
    copyStr(d.name, sizeof(d.name), r["n"] | "");
    copyStr(d.lang, sizeof(d.lang), r["lang"] | "");
    copyStr(d.msg, sizeof(d.msg), r["msg"] | "");
    d.langColor = parseHexColor(r["col"] | "");
    d.stars = r["s"] | 0;
    d.forks = r["f"] | 0;
    d.openPRs = r["pr"] | 0;
    d.openIssues = r["i"] | 0;
    d.lastCommitAt = r["c"] | 0;
  }

  out.eventCount = 0;
  for (JsonObject e : doc["ev"].as<JsonArray>()) {
    if (out.eventCount >= kMaxEvents) break;
    EventStat& d = out.events[out.eventCount++];
    copyStr(d.kind, sizeof(d.kind), e["k"] | "");
    copyStr(d.repo, sizeof(d.repo), e["r"] | "");
    d.delta = e["d"] | 0;
    d.at = e["at"] | 0;
  }

  out.valid = true;
  gEtag = etag;
  devlog::logf("[net] parsed %u repos, %u events, accent=%06lX\n",
                static_cast<unsigned>(out.repoCount), static_cast<unsigned>(out.eventCount),
                static_cast<unsigned long>(out.accent));
  return Result::Updated;
}

}  // namespace api

namespace api {

/**
 * Best-effort log upload. Deliberately silent: logging about failing to send
 * logs would refill the buffer it is trying to drain.
 */
void shipLogs() {
  if (!devlog::hasPending() || WiFi.status() != WL_CONNECTED) return;

  String lines[24];
  const size_t n = devlog::drain(lines, 24);
  if (n == 0) return;

  String body = "{\"lines\":[";
  for (size_t i = 0; i < n; i++) {
    String esc = lines[i];
    esc.replace("\\", "\\\\");
    esc.replace("\"", "\\\"");
    body += (i ? ",\"" : "\"") + esc + "\"";
  }
  body += "]}";

  WiFiClientSecure client = makeClient();
  HTTPClient http;
  const String url = settings::baseUrl() + "/api/log/" + settings::deviceId();
  if (!http.begin(client, url)) return;
  http.addHeader("content-type", "application/json");
  http.addHeader("x-device-key", settings::deviceSecret());
  http.POST(body);
  http.end();
}

}  // namespace api
