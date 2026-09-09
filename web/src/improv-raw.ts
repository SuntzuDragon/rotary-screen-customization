/**
 * Minimal Improv Wi-Fi Serial client, written directly against Web Serial.
 *
 * Replaces improv-wifi-serial-sdk here. Not because the SDK is bad, but because
 * it timed out against a device that provably answers: sending the very same
 * REQUEST_CURRENT_STATE from a Python script returns a complete, correct
 * response including the settings URL. Owning the bytes makes the exchange
 * inspectable, and the framing is small enough that the SDK was mostly costing
 * us visibility.
 *
 * Protocol: improv-wifi.com/serial
 *   "IMPROV" | version(1) | type | length | payload | checksum
 */

const HEADER = [0x49, 0x4d, 0x50, 0x52, 0x4f, 0x56]; // "IMPROV"
const VERSION = 0x01;

const TYPE_CURRENT_STATE = 0x01;
const TYPE_ERROR_STATE = 0x02;
const TYPE_RPC = 0x03;
const TYPE_RPC_RESULT = 0x04;

const CMD_WIFI_SETTINGS = 0x01;
const CMD_CURRENT_STATE = 0x02;
const CMD_DEVICE_INFO = 0x03;
const CMD_SCAN = 0x04;

/**
 * Local extension, outside the range the specification assigns: "fetch your
 * settings from the service now". A device that predates it answers
 * ERR_UNKNOWN_CMD rather than going quiet, which is what `refresh` reports.
 */
const CMD_REFRESH = 0x80;

export const STATE_PROVISIONED = 0x04;

export interface Frame {
  type: number;
  payload: Uint8Array;
}

export interface Ssid {
  name: string;
  rssi: number;
  secured: boolean;
}

function build(type: number, payload: number[]): Uint8Array {
  const body = [...HEADER, VERSION, type, payload.length, ...payload];
  const checksum = body.reduce((a, b) => (a + b) & 0xff, 0);
  return new Uint8Array([...body, checksum]);
}

/** RPC payload: [command, length, ...data] */
const rpc = (command: number, data: number[] = []) =>
  build(TYPE_RPC, [command, data.length, ...data]);

const encodeString = (s: string) => {
  const bytes = [...new TextEncoder().encode(s)];
  return [bytes.length, ...bytes];
};

/** Split length-prefixed strings out of an RPC result payload. */
function decodeStrings(payload: Uint8Array): string[] {
  const out: string[] = [];
  let i = 2; // skip command + total length
  while (i < payload.length) {
    const len = payload[i]!;
    if (i + 1 + len > payload.length) break;
    out.push(new TextDecoder().decode(payload.subarray(i + 1, i + 1 + len)));
    i += 1 + len;
  }
  return out;
}

export class ImprovRaw {
  private buffer: number[] = [];
  private frames: Frame[] = [];
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private pump?: Promise<void>;
  private closed = false;

  constructor(
    private port: SerialPort,
    private log: (msg: string) => void = () => {},
  ) {}

  /** Start consuming the port. Frames accumulate; stray log output is ignored. */
  start() {
    const readable = this.port.readable;
    if (!readable) throw new Error('port has no readable stream');
    this.reader = readable.getReader();

    this.pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await this.reader!.read();
          if (done) break;
          if (value) this.feed(value);
        }
      } catch {
        // Reader cancelled or the port went away; nothing to do.
      }
    })();
  }

  async stop() {
    this.closed = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* already gone */
    }
    try {
      this.reader?.releaseLock();
    } catch {
      /* already released */
    }
    await this.pump?.catch(() => {});
  }

  /**
   * Resynchronise on the magic every byte: the same port carries the device's
   * own log output, so frames are embedded in arbitrary text.
   */
  private feed(chunk: Uint8Array) {
    for (const byte of chunk) {
      this.buffer.push(byte);

      // Keep only a plausible tail while hunting for the header.
      if (this.buffer.length > 512) this.buffer.splice(0, this.buffer.length - 512);

      const start = this.findHeader();
      if (start < 0) continue;

      const frame = this.buffer.slice(start);
      if (frame.length < 9) continue;
      const length = frame[8]!;
      const total = 9 + length + 1;
      if (frame.length < total) continue;

      const sum = frame.slice(0, total - 1).reduce((a, b) => (a + b) & 0xff, 0);
      if (sum === frame[total - 1]) {
        this.frames.push({
          type: frame[7]!,
          payload: new Uint8Array(frame.slice(9, 9 + length)),
        });
      }
      this.buffer = frame.slice(total);
    }
  }

  private findHeader(): number {
    for (let i = 0; i + HEADER.length <= this.buffer.length; i++) {
      if (HEADER.every((h, k) => this.buffer[i + k] === h)) return i;
    }
    return -1;
  }

  private async write(bytes: Uint8Array) {
    const writer = this.port.writable!.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
  }

  /** Wait for a frame matching `want`, or resolve null on timeout. */
  private async awaitFrame(
    want: (f: Frame) => boolean,
    timeoutMs: number,
  ): Promise<Frame | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.frames.findIndex(want);
      if (idx >= 0) return this.frames.splice(idx, 1)[0]!;
      if (this.closed || Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Ask for the current state. Returns null if the device does not answer. */
  async currentState(timeoutMs = 4000): Promise<{ state: number; nextUrl?: string } | null> {
    this.frames = [];
    await this.write(rpc(CMD_CURRENT_STATE));
    const state = await this.awaitFrame((f) => f.type === TYPE_CURRENT_STATE, timeoutMs);
    if (!state) return null;

    // A provisioned device also replies with its settings URL.
    const result = await this.awaitFrame(
      (f) => f.type === TYPE_RPC_RESULT && f.payload[0] === CMD_WIFI_SETTINGS,
      600,
    );
    const urls = result ? decodeStrings(result.payload) : [];
    this.log(`state=0x${state.payload[0]!.toString(16)}${urls[0] ? ` url=${urls[0]}` : ''}`);
    return { state: state.payload[0]!, nextUrl: urls[0] };
  }

  async deviceInfo(timeoutMs = 3000): Promise<string[]> {
    this.frames = [];
    await this.write(rpc(CMD_DEVICE_INFO));
    const f = await this.awaitFrame(
      (x) => x.type === TYPE_RPC_RESULT && x.payload[0] === CMD_DEVICE_INFO,
      timeoutMs,
    );
    return f ? decodeStrings(f.payload) : [];
  }

  /** Networks the device itself can see, strongest first. */
  async scan(timeoutMs = 12000): Promise<Ssid[]> {
    this.frames = [];
    await this.write(rpc(CMD_SCAN));

    const found: Ssid[] = [];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const f = await this.awaitFrame(
        (x) => x.type === TYPE_RPC_RESULT && x.payload[0] === CMD_SCAN,
        Math.max(0, deadline - Date.now()),
      );
      if (!f) break;
      const parts = decodeStrings(f.payload);
      if (parts.length === 0) break; // empty result terminates the list
      found.push({
        name: parts[0] ?? '',
        rssi: Number(parts[1] ?? '0'),
        secured: (parts[2] ?? 'YES') === 'YES',
      });
    }
    return found;
  }

  /**
   * Tell the device to fetch its settings now instead of at its next poll.
   *
   * Resolves true once the device confirms it has them -- it holds the reply
   * until its request finishes, so this is an answer about the dial, not an
   * acknowledgement that the message was received. False means the device is
   * there but could not fetch (usually no Wi-Fi); null means it does not know
   * the command, and the caller should fall back to waiting for the poll.
   */
  async refresh(timeoutMs = 25000): Promise<boolean | null> {
    this.frames = [];
    await this.write(rpc(CMD_REFRESH));

    const f = await this.awaitFrame(
      (x) =>
        (x.type === TYPE_RPC_RESULT && x.payload[0] === CMD_REFRESH) ||
        x.type === TYPE_ERROR_STATE,
      timeoutMs,
    );
    if (!f) return null;
    if (f.type === TYPE_ERROR_STATE) return null; // unknown command on this build
    return decodeStrings(f.payload)[0] === 'OK';
  }

  /** Send credentials. Returns the URL the device wants opened, if any. */
  async provision(ssid: string, password: string, timeoutMs = 60000): Promise<string | undefined> {
    this.frames = [];
    await this.write(rpc(CMD_WIFI_SETTINGS, [...encodeString(ssid), ...encodeString(password)]));

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const f = await this.awaitFrame(
        (x) =>
          (x.type === TYPE_RPC_RESULT && x.payload[0] === CMD_WIFI_SETTINGS) ||
          x.type === TYPE_ERROR_STATE,
        Math.max(0, deadline - Date.now()),
      );
      if (!f) throw new Error('the device did not answer while connecting');
      if (f.type === TYPE_ERROR_STATE) {
        const code = f.payload[0]!;
        if (code === 0) continue; // "no error" status, keep waiting
        throw new Error(
          code === 0x03 ? 'the device could not join that network' : `device error 0x${code.toString(16)}`,
        );
      }
      return decodeStrings(f.payload)[0];
    }
  }
}
