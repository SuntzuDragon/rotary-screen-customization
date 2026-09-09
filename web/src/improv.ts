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
export async function connect(): Promise<Connection> {
  if (!serialSupported()) {
    throw new Error('This browser has no Web Serial. Use desktop Chrome, Edge, or Opera.');
  }
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: 115200 });

  const improv = new ImprovSerial(port, quiet);
  let info: Connection['info'];
  try {
    const got = await improv.initialize();
    if (!got) throw new Error('no device info');
    info = got;
  } catch (err) {
    await port.close().catch(() => {});
    throw new Error(
      `No Improv device answered on that port. Is the stats firmware flashed? (${
        err instanceof Error ? err.message : err
      })`,
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
