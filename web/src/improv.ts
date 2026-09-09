import { ImprovRaw, STATE_PROVISIONED, type Ssid } from './improv-raw';

export type { Ssid };

export const serialSupported = () => 'serial' in navigator;

export interface Connection {
  improv: ImprovRaw;
  info: { name: string; firmware: string; version: string; chipFamily: string };
  nextUrl?: string;
  close: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Open the port and get the board into a state where it will actually talk.
 *
 * Chrome asserts DTR and RTS when it opens a serial port. On this board those
 * are IO0 (BOOT) and EN (reset), so a plain open holds the chip in reset -- and
 * releasing both at once races: if BOOT is still low when EN rises the chip
 * comes up in download mode and answers nothing. Release BOOT, pulse EN, wait
 * for the application to reach its Improv loop.
 */
async function resetIntoApp(port: SerialPort, onStatus: (m: string) => void) {
  try {
    await port.setSignals({ dataTerminalReady: false });
    await sleep(50);
    await port.setSignals({ requestToSend: true });
    await sleep(120);
    await port.setSignals({ requestToSend: false });
  } catch {
    // Some platforms disallow setSignals; the probe below still retries.
  }
  onStatus('Restarted the device — waiting for it to boot…');
  await sleep(2500);
}

export async function connect(onStatus: (msg: string) => void = () => {}): Promise<Connection> {
  if (!serialSupported()) {
    throw new Error('This browser has no Web Serial. Use desktop Chrome, Edge, or Opera.');
  }

  const port = await navigator.serial.requestPort();
  onStatus('Opening the port…');
  await port.open({ baudRate: 115200 });

  const improv = new ImprovRaw(port, (m) => console.debug('[improv]', m));
  improv.start();

  await resetIntoApp(port, onStatus);

  let state: { state: number; nextUrl?: string } | null = null;
  for (let attempt = 1; attempt <= 4 && !state; attempt++) {
    onStatus(attempt === 1 ? 'Looking for the device…' : `Still looking… (attempt ${attempt} of 4)`);
    state = await improv.currentState(4000);
  }

  if (!state) {
    await improv.stop();
    await port.close().catch(() => {});
    throw new Error(
      'The device did not answer. Unplug it, plug it back in, wait for the screen, ' +
        'then try again — and make sure no other tab or serial monitor has the port.',
    );
  }

  const info = await improv.deviceInfo();
  return {
    improv,
    info: {
      firmware: info[0] ?? 'rotary-stats',
      version: info[1] ?? '?',
      chipFamily: info[2] ?? 'ESP32-S3',
      name: info[3] ?? 'Rotary Stats',
    },
    // A provisioned device hands back its settings URL straight away.
    nextUrl: state.state === STATE_PROVISIONED ? state.nextUrl : undefined,
    close: async () => {
      await improv.stop();
      await port.close().catch(() => {});
    },
  };
}

export async function provision(
  conn: Connection,
  ssid: string,
  password: string,
): Promise<string | undefined> {
  return conn.improv.provision(ssid, password);
}
