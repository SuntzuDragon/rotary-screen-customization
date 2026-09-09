import { ImprovSerial } from 'improv-wifi-serial-sdk/dist/serial';
import type { Ssid } from 'improv-wifi-serial-sdk/dist/serial';

export type { Ssid };

export const serialSupported = () => 'serial' in navigator;

const quiet = { log: () => {}, error: () => {}, debug: () => {} };

export interface Connection {
  improv: ImprovSerial;
  info: NonNullable<ImprovSerial['info']>;
  close: () => Promise<void>;
}

/**
 * Prompt for a port and bring up Improv on it.
 *
 * Must be called from a user gesture -- the port picker is a browser-native
 * dialog and Chrome will reject requestPort() otherwise.
 */
export async function connect(onStatus: (msg: string) => void = () => {}): Promise<Connection> {
  if (!serialSupported()) {
    throw new Error('This browser has no Web Serial. Use desktop Chrome, Edge, or Opera.');
  }
  const port = await navigator.serial.requestPort();
  onStatus('Opening the port…');
  await port.open({ baudRate: 115200 });

  // Clear DTR and RTS immediately.
  //
  // On this board RTS drives EN and DTR drives IO0. Chrome asserts both when it
  // opens a port, which holds the chip in reset -- the device then receives
  // nothing and answers nothing, and Improv times out against a board that is
  // working perfectly. Sending the same request from a script that clears these
  // first gets a full, correct response.
  try {
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    // Opening may still have bounced the board; give it a moment to come back.
    await new Promise((r) => setTimeout(r, 1500));
  } catch {
    // Not fatal: some platforms disallow setSignals, and the probe retries anyway.
  }

  const improv = new ImprovSerial(port, quiet);
  let info: Connection['info'];
  try {
    // Opening the port resets the board, so the device is mid-boot the moment we
    // start probing -- and it spends several seconds in blocking HTTPS calls
    // where it cannot answer. The SDK's 1s default expires long before it is
    // listening, so allow for a full boot and retry across it.
    let got: Connection['info'] | undefined;
    for (let attempt = 1; attempt <= 3 && !got; attempt++) {
      onStatus(
        attempt === 1
          ? 'Opening the port restarted the device — waiting for it to boot…'
          : `Still waiting for the device… (attempt ${attempt} of 3)`,
      );
      got = await improv.initialize(10000).catch(() => undefined);
    }
    if (!got) throw new Error('no device info');
    info = got;
  } catch (err) {
    await port.close().catch(() => {});
    throw new Error(
      'No Improv device answered on that port. Opening the port restarts the ' +
        'device, so give it a few seconds and try again — or check the stats ' +
        `firmware is flashed. (${err instanceof Error ? err.message : err})`,
    );
  }

  return {
    improv,
    info,
    close: async () => {
      await improv.close().catch(() => {});
      await port.close().catch(() => {});
    },
  };
}

/**
 * Send credentials and return the URL the device wants the browser to open.
 * That URL carries the device id and secret, which is what removes the pairing
 * step entirely.
 */
export async function provision(
  conn: Connection,
  ssid: string,
  password: string,
): Promise<string | undefined> {
  await conn.improv.provision(ssid, password, 30000);
  return conn.improv.nextUrl;
}
