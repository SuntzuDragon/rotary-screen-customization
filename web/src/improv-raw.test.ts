import { afterEach, describe, expect, it } from 'vitest';
import { ImprovRaw, STATE_PROVISIONED } from './improv-raw';

// Frames are built here independently of the implementation, straight from
// the protocol: "IMPROV" | version | type | length | payload | checksum.
const HEADER = [...'IMPROV'].map((c) => c.charCodeAt(0));
const TYPE = { state: 0x01, error: 0x02, rpc: 0x03, result: 0x04 };
const CMD = { wifi: 0x01, state: 0x02, info: 0x03, refresh: 0x80 };

function frame(type: number, payload: number[], { corrupt = false } = {}): number[] {
  const body = [...HEADER, 0x01, type, payload.length, ...payload];
  const sum = body.reduce((a, b) => (a + b) & 0xff, 0);
  return [...body, corrupt ? (sum + 1) & 0xff : sum];
}

const str = (s: string) => {
  const bytes = [...new TextEncoder().encode(s)];
  return [bytes.length, ...bytes];
};

/** An RPC result: [command, total length, ...length-prefixed strings]. */
function result(command: number, ...strings: string[]): number[] {
  const data = strings.flatMap(str);
  return frame(TYPE.result, [command, data.length, ...data]);
}

/** A stand-in for a Web Serial port: bytes can be pushed in, and writes are kept. */
function fakePort() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start: (c) => void (controller = c),
  });
  const written: number[][] = [];
  const writable = new WritableStream<Uint8Array>({
    write: (chunk) => void written.push([...chunk]),
  });
  return {
    port: { readable, writable } as unknown as SerialPort,
    written,
    /** Deliver bytes one at a time, the worst case for framing. */
    push: (bytes: number[]) => bytes.forEach((b) => controller.enqueue(new Uint8Array([b]))),
    pushText: (s: string) => controller.enqueue(new TextEncoder().encode(s)),
  };
}

let open: ImprovRaw[] = [];
function connect() {
  const fake = fakePort();
  const improv = new ImprovRaw(fake.port);
  improv.start();
  open.push(improv);
  return { improv, ...fake };
}

afterEach(async () => {
  await Promise.all(open.map((i) => i.stop()));
  open = [];
});

describe('what the page sends', () => {
  it('frames a current-state request exactly as the protocol specifies', async () => {
    const { improv, written, push } = connect();
    const pending = improv.currentState(200);
    push(frame(TYPE.state, [STATE_PROVISIONED]));
    await pending;
    expect(written[0]).toEqual(frame(TYPE.rpc, [CMD.state, 0]));
  });

  it('encodes Wi-Fi credentials as length-prefixed UTF-8, including non-ASCII', async () => {
    const { improv, written, push } = connect();
    const pending = improv.provision('Café', 'p@ss', 500);
    push(result(CMD.wifi, 'https://hdog.test/#d=abc'));
    await pending;
    expect(written[0]).toEqual(frame(TYPE.rpc, [CMD.wifi, 11, ...str('Café'), ...str('p@ss')]));
  });
});

describe('reading frames from the port', () => {
  it('finds frames inside the device log output that shares the port', async () => {
    const { improv, push, pushText } = connect();
    const pending = improv.currentState(500);
    pushText('I (1234) boot: ESP-IDF v4.4\r\n[net] connecting IMPRO');
    push(frame(TYPE.state, [STATE_PROVISIONED]));
    pushText('\r\n[net] poll -> 304\r\n');
    push(result(CMD.wifi, 'https://hdog.test/#d=abc'));
    expect(await pending).toEqual({
      state: STATE_PROVISIONED,
      nextUrl: 'https://hdog.test/#d=abc',
    });
  });

  it('ignores a frame whose checksum is wrong', async () => {
    const { improv, push } = connect();
    const pending = improv.currentState(200);
    push(frame(TYPE.state, [STATE_PROVISIONED], { corrupt: true }));
    expect(await pending).toBeNull();
  });

  it('recovers after a corrupt frame and reads the next good one', async () => {
    const { improv, push } = connect();
    const pending = improv.currentState(500);
    push(frame(TYPE.state, [0x02], { corrupt: true }));
    push(frame(TYPE.state, [STATE_PROVISIONED]));
    expect((await pending)?.state).toBe(STATE_PROVISIONED);
  });

  it('decodes the device info strings', async () => {
    const { improv, push } = connect();
    const pending = improv.deviceInfo(500);
    push(result(CMD.info, 'rotary-stats', '0.3.2', 'ESP32-S3', 'dial'));
    expect(await pending).toEqual(['rotary-stats', '0.3.2', 'ESP32-S3', 'dial']);
  });
});

describe('refresh (the local 0x80 command)', () => {
  it('is true when the dial confirms it fetched its settings', async () => {
    const { improv, push } = connect();
    const pending = improv.refresh(500);
    push(result(CMD.refresh, 'OK'));
    expect(await pending).toBe(true);
  });

  it('is false when the dial is there but could not fetch', async () => {
    const { improv, push } = connect();
    const pending = improv.refresh(500);
    push(result(CMD.refresh, 'FAIL'));
    expect(await pending).toBe(false);
  });

  // Firmware older than v0.2.8 does not know 0x80 and answers with an error.
  it('is null when the firmware does not know the command', async () => {
    const { improv, push } = connect();
    const pending = improv.refresh(500);
    push(frame(TYPE.error, [0x02]));
    expect(await pending).toBeNull();
  });

  it('is null when the dial does not answer in time', async () => {
    const { improv } = connect();
    expect(await improv.refresh(100)).toBeNull();
  });
});

describe('provisioning', () => {
  it('returns the settings URL the dial hands back', async () => {
    const { improv, push } = connect();
    const pending = improv.provision('home', 'secret', 500);
    push(result(CMD.wifi, 'https://hdog.test/#d=abc'));
    expect(await pending).toBe('https://hdog.test/#d=abc');
  });

  it('keeps waiting through a "no error" status', async () => {
    const { improv, push } = connect();
    const pending = improv.provision('home', 'secret', 500);
    push(frame(TYPE.error, [0x00]));
    push(result(CMD.wifi, 'https://hdog.test/#d=abc'));
    expect(await pending).toBe('https://hdog.test/#d=abc');
  });

  it('reports a network the dial could not join in words', async () => {
    const { improv, push } = connect();
    const pending = improv.provision('home', 'wrong', 500);
    push(frame(TYPE.error, [0x03]));
    await expect(pending).rejects.toThrow('the device could not join that network');
  });

  it('throws if the dial never answers', async () => {
    const { improv } = connect();
    await expect(improv.provision('home', 'secret', 100)).rejects.toThrow('did not answer');
  });
});
