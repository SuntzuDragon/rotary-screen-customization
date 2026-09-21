import { ImprovRaw, STATE_PROVISIONED, type Ssid } from './improv-raw';

export type { Ssid };

export const serialSupported = () => 'serial' in navigator;

export interface Connection {
  improv: ImprovRaw;
  /** The underlying port, so a disconnect event can be matched to it. */
  port: SerialPort;
  /**
   * Whether the dial answered Improv. False still means an open port -- enough
   * to flash, not enough to provision or push.
   */
  responsive: boolean;
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
    onStatus(
      attempt === 1 ? 'Looking for the device…' : `Still looking… (attempt ${attempt} of 4)`,
    );
    state = await improv.currentState(4000);
  }

  /*
   * A dial that will not answer still gets a connection.
   *
   * Flashing needs the port and nothing else, and the dial most in need of
   * reflashing is precisely the one that has stopped talking. Failing here
   * would put the only connect button on the page out of reach at exactly the
   * wrong moment. So report the silence and hand back the open port; the cards
   * that need a conversation check `responsive` themselves.
   */
  if (!state) {
    return {
      improv,
      port,
      responsive: false,
      info: {
        firmware: 'unknown',
        version: '?',
        chipFamily: 'ESP32-S3',
        name: 'Unresponsive device',
      },
      close: async () => {
        await improv.stop();
        await port.close().catch(() => {});
      },
    };
  }

  const info = await improv.deviceInfo();
  return {
    improv,
    port,
    responsive: true,
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

/**
 * One shared connection for the page.
 *
 * Opening the port resets the board -- Chrome asserts DTR/RTS, which are BOOT
 * and EN here -- so every open costs a reboot. Holding a single connection
 * open means that cost is paid once, when the user asks for it, and everything
 * afterwards (pushing settings, in particular) is immediate.
 */
let live: Connection | null = null;
let livePort: SerialPort | null = null;

/**
 * Everything that cares about the cable subscribes here rather than keeping its
 * own idea of the state.
 *
 * There used to be three buttons on the page that each opened or closed this
 * one connection, and none of them told the others. Connecting from the Wi-Fi
 * card left the push card still saying "not connected"; flashing closed the
 * port and neither noticed. One value, one event.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

export function onConnectionChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce() {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* a listener throwing must not stop the others hearing about it */
    }
  }
}

export const liveConnection = () => live;

export async function openShared(onStatus: (msg: string) => void = () => {}): Promise<Connection> {
  if (live) return live;
  const conn = await connect(onStatus);
  const inner = conn.close;
  livePort = conn.port;
  live = {
    ...conn,
    close: async () => {
      live = null;
      livePort = null;
      announce();
      await inner();
    },
  };
  announce();
  return live;
}

/**
 * Hand the open port over to something else -- in practice the flasher, which
 * drives it with esptool and needs it exclusively at a different baud rate.
 *
 * Returns the port so the caller can go on using the one the user already
 * picked. Closing and re-prompting would make the page ask for a device it is
 * currently telling you it is connected to.
 */
export async function takePort(): Promise<SerialPort | null> {
  const conn = live;
  const port = livePort;
  live = null;
  livePort = null;
  if (conn) {
    announce();
    // Stop reading, then close: esptool opens it again at its own baud rate.
    await conn.improv.stop().catch(() => {});
    await port?.close().catch(() => {});
  }
  return port;
}

/** Release the port. The flasher needs it exclusively, so it calls this first. */
export async function closeShared() {
  const conn = live;
  live = null;
  livePort = null;
  if (conn) announce();
  await conn?.close().catch(() => {});
}

// Pulling the cable is the most likely way this connection ends, and it happens
// without anyone calling close(). Without this the page would go on offering a
// Disconnect button for a device that is no longer there.
if (typeof navigator !== 'undefined' && 'serial' in navigator) {
  navigator.serial.addEventListener('disconnect', (event) => {
    if (livePort && (event as unknown as { target: SerialPort }).target === livePort) {
      live = null;
      livePort = null;
      announce();
    }
  });
}

export async function provision(
  conn: Connection,
  ssid: string,
  password: string,
): Promise<string | undefined> {
  return conn.improv.provision(ssid, password);
}
