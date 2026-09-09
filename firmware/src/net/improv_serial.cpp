#include "improv_serial.h"
#include "devlog.h"

#include <WiFi.h>

namespace {
constexpr uint8_t kHeader[6] = {'I', 'M', 'P', 'R', 'O', 'V'};
constexpr uint8_t kVersion = 0x01;

constexpr uint8_t TYPE_CURRENT_STATE = 0x01;
constexpr uint8_t TYPE_ERROR_STATE = 0x02;
constexpr uint8_t TYPE_RPC = 0x03;
constexpr uint8_t TYPE_RPC_RESULT = 0x04;

constexpr uint8_t CMD_WIFI_SETTINGS = 0x01;
constexpr uint8_t CMD_CURRENT_STATE = 0x02;
constexpr uint8_t CMD_DEVICE_INFO = 0x03;
constexpr uint8_t CMD_SCAN = 0x04;

/**
 * Local extension, deliberately outside the 0x01-0x04 the specification
 * assigns, so a future Improv command can never collide with it. A client that
 * does not know it is unaffected; a device that does not implement it answers
 * ERR_UNKNOWN_CMD, which is what the browser falls back on.
 */
constexpr uint8_t CMD_REFRESH = 0x80;
}  // namespace

void ImprovSerial::begin(Stream& io, const char* deviceName, const char* firmware,
                         const char* version, const char* chip) {
  _io = &io;
  _name = deviceName;
  _firmware = firmware;
  _version = version;
  _chip = chip;
}

void ImprovSerial::setState(State s) {
  _state = s;
  sendCurrentState();
}

void ImprovSerial::sendPacket(uint8_t type, const uint8_t* data, size_t len) {
  if (!_io) return;

  // Assemble the whole packet and write it once.
  //
  // Writing byte by byte was one timeout per byte: with a short (or zero) USB
  // TX timeout a momentarily full buffer silently drops part of the packet, and
  // the client sees a truncated frame it can never parse -- which looks exactly
  // like "no Improv device answered". One write is one timeout, and the packet
  // either goes out whole or not at all.
  uint8_t out[kMaxPacket + 16];
  size_t n = 0;
  for (uint8_t b : kHeader) out[n++] = b;
  out[n++] = kVersion;
  out[n++] = type;
  out[n++] = static_cast<uint8_t>(len);
  if (len > kMaxPacket) return;
  memcpy(out + n, data, len);
  n += len;

  uint8_t sum = 0;
  for (size_t i = 0; i < n; i++) sum += out[i];
  out[n++] = sum;

  _io->write(out, n);

  // Flush only when a host is attached.
  //
  // flush() waits for the USB TX buffer to drain and never returns with nothing
  // connected -- that single call froze the device at boot, since setState()
  // sends a packet during setup(). setTxTimeoutMs(0) makes write() safe but
  // does not govern flush(). Skipping it entirely is also wrong: the browser
  // can time out waiting for a reply still sitting in the buffer. So: flush
  // when someone is listening, never otherwise.
  if (!_hostAttached || _hostAttached()) _io->flush();
}

void ImprovSerial::sendCurrentState() {
  uint8_t s = _state;
  sendPacket(TYPE_CURRENT_STATE, &s, 1);
}

void ImprovSerial::sendError(Error e) {
  uint8_t v = e;
  sendPacket(TYPE_ERROR_STATE, &v, 1);
}

/** RPC result payload: [cmd, total_len, (len, bytes)...] */
void ImprovSerial::sendRpcResult(uint8_t cmd, const String* strings, size_t count) {
  uint8_t out[kMaxPacket];
  size_t n = 0;
  out[n++] = cmd;
  size_t lenIdx = n++;  // filled in below
  for (size_t i = 0; i < count; i++) {
    const String& s = strings[i];
    if (n + 1 + s.length() >= kMaxPacket) break;
    out[n++] = static_cast<uint8_t>(s.length());
    memcpy(out + n, s.c_str(), s.length());
    n += s.length();
  }
  out[lenIdx] = static_cast<uint8_t>(n - lenIdx - 1);
  sendPacket(TYPE_RPC_RESULT, out, n);
}

void ImprovSerial::sendDeviceInfo() {
  const String info[4] = {String(_firmware), String(_version), String(_chip), String(_name)};
  sendRpcResult(CMD_DEVICE_INFO, info, 4);
}

/**
 * Scan and report networks, one entry per SSID.
 *
 * A scan returns one result per radio, so a mesh network or an extender shows
 * the same name several times at different strengths. Reporting them all makes
 * the browser's picker show duplicates, and its de-duplication keeps whichever
 * arrived last -- which can be the weakest one. Collapse here instead, keeping
 * the strongest signal per name, and send them strongest first.
 */
void ImprovSerial::sendScanResults() {
  const int found = WiFi.scanNetworks();

  static constexpr int kMaxNetworks = 24;
  String names[kMaxNetworks];
  int32_t rssi[kMaxNetworks];
  bool secured[kMaxNetworks];
  int count = 0;

  for (int i = 0; i < found; i++) {
    const String ssid = WiFi.SSID(i);
    if (ssid.isEmpty()) continue;  // hidden network

    int slot = -1;
    for (int j = 0; j < count; j++) {
      if (names[j] == ssid) {
        slot = j;
        break;
      }
    }
    if (slot >= 0) {
      if (WiFi.RSSI(i) > rssi[slot]) rssi[slot] = WiFi.RSSI(i);
      continue;
    }
    if (count >= kMaxNetworks) continue;
    names[count] = ssid;
    rssi[count] = WiFi.RSSI(i);
    secured[count] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
    count++;
  }
  WiFi.scanDelete();

  // Strongest first: the network you are standing next to should be at the top.
  for (int i = 1; i < count; i++) {
    for (int j = i; j > 0 && rssi[j] > rssi[j - 1]; j--) {
      const String n = names[j]; names[j] = names[j - 1]; names[j - 1] = n;
      const int32_t r = rssi[j]; rssi[j] = rssi[j - 1]; rssi[j - 1] = r;
      const bool sec = secured[j]; secured[j] = secured[j - 1]; secured[j - 1] = sec;
    }
  }

  devlog::logf("[improv] %d radios -> %d unique networks\n", found, count);
  for (int i = 0; i < count; i++) {
    const String row[3] = {names[i], String(rssi[i]), secured[i] ? "YES" : "NO"};
    sendRpcResult(CMD_SCAN, row, 3);
  }
  sendRpcResult(CMD_SCAN, nullptr, 0);  // empty result terminates the list
}

void ImprovSerial::handleRpc(const uint8_t* data, uint8_t len) {
  if (len < 2) {
    sendError(ERR_INVALID_PACKET);
    return;
  }
  const uint8_t cmd = data[0];
  devlog::logf("[improv] rpc cmd=0x%02X len=%u\n", cmd, static_cast<unsigned>(len));
  const uint8_t dataLen = data[1];
  const uint8_t* body = data + 2;
  if (2 + dataLen > len) {
    sendError(ERR_INVALID_PACKET);
    return;
  }

  switch (cmd) {
    case CMD_CURRENT_STATE:
      sendCurrentState();
      // Already provisioned: repeat the success response so a reconnecting
      // browser is sent straight to this device's settings.
      if (_state == STATE_PROVISIONED && _nextUrl) {
        const String url = _nextUrl();
        if (url.length()) sendRpcResult(CMD_WIFI_SETTINGS, &url, 1);
      }
      break;

    case CMD_DEVICE_INFO:
      sendDeviceInfo();
      break;

    case CMD_SCAN:
      sendScanResults();
      break;

    case CMD_REFRESH: {
      if (!_refresh) {
        sendError(ERR_UNKNOWN_CMD);
        break;
      }
      // The handler blocks until the fetch finishes -- a couple of seconds --
      // and the browser is sitting on this RPC result, so there is nothing
      // else for Improv to answer meanwhile. Reporting the outcome rather than
      // just acknowledging is the point: "pushed" and "the dial has it" are
      // different claims, and only the second one is worth making.
      const bool ok = _refresh();
      String status = ok ? "OK" : "FAIL";
      sendRpcResult(CMD_REFRESH, &status, 1);
      break;
    }

    case CMD_WIFI_SETTINGS: {
      if (dataLen < 2) {
        sendError(ERR_INVALID_PACKET);
        return;
      }
      const uint8_t ssidLen = body[0];
      if (1u + ssidLen >= dataLen) {
        sendError(ERR_INVALID_PACKET);
        return;
      }
      String ssid;
      for (uint8_t i = 0; i < ssidLen; i++) ssid += static_cast<char>(body[1 + i]);

      const uint8_t passLen = body[1 + ssidLen];
      String pass;
      for (uint8_t i = 0; i < passLen; i++) pass += static_cast<char>(body[2 + ssidLen + i]);

      setState(STATE_PROVISIONING);
      if (_connect && _connect(ssid, pass)) {
        _state = STATE_PROVISIONED;
        sendCurrentState();
        const String url = _nextUrl ? _nextUrl() : String();
        if (url.length()) sendRpcResult(CMD_WIFI_SETTINGS, &url, 1);
        else sendRpcResult(CMD_WIFI_SETTINGS, nullptr, 0);
      } else {
        _state = STATE_AUTHORIZED;
        sendError(ERR_CANNOT_CONNECT);
        sendCurrentState();
      }
      break;
    }

    default:
      sendError(ERR_UNKNOWN_CMD);
      break;
  }
}

void ImprovSerial::handlePacket(uint8_t type, const uint8_t* data, uint8_t len) {
  if (type == TYPE_RPC) handleRpc(data, len);
}

void ImprovSerial::loop() {
  if (!_io) return;

  // Byte-level accounting. The question we cannot answer from the outside is
  // whether the browser's bytes reach the device at all, or arrive and fail to
  // parse -- and the browser owns the serial port at exactly that moment, so
  // this has to be recorded here and shipped over Wi-Fi.
  static uint32_t bytesSeen = 0;
  static uint32_t lastReport = 0;
  const bool had = _io->available() > 0;

  while (_io->available()) {
    bytesSeen++;
    const uint8_t b = static_cast<uint8_t>(_io->read());

    // Resynchronise on the magic rather than assuming packet alignment: the
    // same port also carries log output.
    if (_len < sizeof(kHeader)) {
      if (b == kHeader[_len]) {
        _buf[_len++] = b;
      } else {
        _len = (b == kHeader[0]) ? 1 : 0;
        if (_len) _buf[0] = b;
      }
      continue;
    }

    if (_len < kMaxPacket) _buf[_len++] = b;
    else _len = 0;

    // header(6) + version + type + length = 9 bytes before the body
    if (_len < 9) continue;

    const uint8_t type = _buf[7];
    const uint8_t dataLen = _buf[8];
    const size_t total = 9 + dataLen + 1;  // + checksum
    if (_len < total) continue;

    uint8_t sum = 0;
    for (size_t i = 0; i < total - 1; i++) sum += _buf[i];

    if (sum == _buf[total - 1] && _buf[6] == kVersion) {
      handlePacket(type, _buf + 9, dataLen);
    } else {
      sendError(ERR_INVALID_PACKET);
    }
    _len = 0;
  }

  if (had && millis() - lastReport > 1000) {
    lastReport = millis();
    devlog::logf("[improv] rx %lu bytes total, parser has %u buffered\n",
                 static_cast<unsigned long>(bytesSeen), static_cast<unsigned>(_len));
  }
}
