#pragma once
#include <Arduino.h>
#include <functional>

/**
 * Device side of the Improv Wi-Fi Serial protocol (improv-wifi.com/serial).
 *
 * Implemented directly rather than pulled in as a library because the whole
 * point of this build is the redirect URL: after a successful connection we
 * hand the browser a URL containing this device's id and secret, which is what
 * removes the pairing step. `setNextUrl` supplies it.
 *
 * Runs on the USB CDC port, and must be pumped every loop() -- the port is
 * re-enumerated whenever the browser opens or closes it, so there is no
 * boot-time window to gate this behind.
 */
class ImprovSerial {
 public:
  enum State : uint8_t {
    STATE_STOPPED = 0x00,
    STATE_AWAITING_AUTH = 0x01,
    STATE_AUTHORIZED = 0x02,
    STATE_PROVISIONING = 0x03,
    STATE_PROVISIONED = 0x04,
  };

  enum Error : uint8_t {
    ERR_NONE = 0x00,
    ERR_INVALID_PACKET = 0x01,
    ERR_UNKNOWN_CMD = 0x02,
    ERR_CANNOT_CONNECT = 0x03,
    ERR_UNKNOWN = 0xFF,
  };

  /** Attempt a connection. Return true once the device is on the network. */
  using ConnectFn = std::function<bool(const String& ssid, const String& password)>;
  /** URL the browser should open next; empty to send none. */
  using UrlFn = std::function<String()>;
  /** True when a USB host has the port open. */
  using HostFn = std::function<bool()>;

  void begin(Stream& io, const char* deviceName, const char* firmware, const char* version,
             const char* chip);
  void setConnectHandler(ConnectFn fn) { _connect = fn; }
  void setNextUrl(UrlFn fn) { _nextUrl = fn; }
  /**
   * Lets the sender flush only when a host is present. flush() waits for the
   * USB TX buffer to drain and never returns with nothing attached -- that
   * froze the whole device at boot. But when the browser *is* talking to us,
   * flushing matters: without it the reply can sit in the buffer long enough
   * for the client to give up.
   */
  void setHostAttached(HostFn fn) { _hostAttached = fn; }
  void setState(State s);
  void loop();

 private:
  void handlePacket(uint8_t type, const uint8_t* data, uint8_t len);
  void handleRpc(const uint8_t* data, uint8_t len);
  void sendPacket(uint8_t type, const uint8_t* data, size_t len);
  void sendCurrentState();
  void sendError(Error e);
  void sendRpcResult(uint8_t cmd, const String* strings, size_t count);
  void sendDeviceInfo();
  void sendScanResults();

  Stream* _io = nullptr;
  const char* _name = "";
  const char* _firmware = "";
  const char* _version = "";
  const char* _chip = "";

  ConnectFn _connect;
  UrlFn _nextUrl;
  HostFn _hostAttached;
  State _state = STATE_AUTHORIZED;

  static constexpr size_t kMaxPacket = 256;
  uint8_t _buf[kMaxPacket];
  size_t _len = 0;
};
