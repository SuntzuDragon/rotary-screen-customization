#include "improv_serial.h"

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
  uint8_t sum = 0;
  auto put = [&](uint8_t b) {
    _io->write(b);
    sum += b;
  };
  for (uint8_t b : kHeader) put(b);
  put(kVersion);
  put(type);
  put(static_cast<uint8_t>(len));
  for (size_t i = 0; i < len; i++) put(data[i]);
  _io->write(sum);
  _io->flush();
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

void ImprovSerial::sendScanResults() {
  const int found = WiFi.scanNetworks();
  for (int i = 0; i < found; i++) {
    const String row[3] = {WiFi.SSID(i), String(WiFi.RSSI(i)),
                           WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "NO" : "YES"};
    sendRpcResult(CMD_SCAN, row, 3);
  }
  WiFi.scanDelete();
  sendRpcResult(CMD_SCAN, nullptr, 0);  // empty result terminates the list
}

void ImprovSerial::handleRpc(const uint8_t* data, uint8_t len) {
  if (len < 2) {
    sendError(ERR_INVALID_PACKET);
    return;
  }
  const uint8_t cmd = data[0];
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

  while (_io->available()) {
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
}
