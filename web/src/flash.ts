import { ESPLoader, Transport } from 'esptool-js';

export interface FlashHooks {
  log: (line: string) => void;
  progress: (fraction: number) => void;
}

/**
 * Which parts of the merged image actually get written.
 *
 * The image is flat: esptool's merge-bin pads the gaps between segments with
 * 0xFF. NVS lives at 0x9000-0xe000, inside one of those gaps, so writing the
 * image in one piece from 0x0 erases it -- taking the Wi-Fi credentials and the
 * device's identity with it, and silently re-provisioning the device on every
 * flash. Writing the regions around it leaves NVS untouched.
 */
const NVS_START = 0x9000;
const NVS_END = 0xe000;

const REGIONS: { name: string; start: number; end: number }[] = [
  { name: 'bootloader', start: 0x0, end: 0x8000 },
  { name: 'partitions', start: 0x8000, end: NVS_START },
  // 0x9000-0xe000 (NVS) deliberately skipped.
  { name: 'otadata', start: NVS_END, end: 0x10000 },
  { name: 'app', start: 0x10000, end: -1 },
];

/**
 * Flash a merged image over Web Serial, in-page.
 *
 * Deliberately not esp-web-tools: that ships its own light-themed modal which
 * re-asks for the port and repeats the Wi-Fi steps this page already handles.
 * Driving esptool-js directly keeps the whole flow on one screen and lets the
 * caller render progress and logs however it likes.
 */
export async function flashFirmware(
  image: ArrayBuffer,
  hooks: FlashHooks,
): Promise<void> {
  if (!('serial' in navigator)) {
    throw new Error('This browser has no Web Serial. Use desktop Chrome, Edge, or Opera.');
  }

  const port = await navigator.serial.requestPort();
  const transport = new Transport(port, true);

  const terminal = {
    clean: () => {},
    // writeLine is a complete line; write is a raw fragment. Treating both as
    // fragments ran the whole log together on one line.
    writeLine: (data: string) => hooks.log(`${data}\n`),
    write: (data: string) => hooks.log(data),
  };

  const loader = new ESPLoader({ transport, baudrate: 460800, terminal });

  try {
    const chip = await loader.main();
    hooks.log(`detected ${chip}`);

    const bytes = new Uint8Array(image);
    const fileArray = REGIONS.filter((r) => r.start < bytes.length).map((r) => {
      const end = r.end < 0 ? bytes.length : Math.min(r.end, bytes.length);
      return { data: bytes.subarray(r.start, end), address: r.start };
    });
    for (const r of fileArray) {
      hooks.log(`region 0x${r.address.toString(16)} (${r.data.length} bytes)\n`);
    }
    hooks.log(`skipping NVS 0x${NVS_START.toString(16)}-0x${NVS_END.toString(16)} ` +
      `to preserve Wi-Fi and device identity\n`);

    // Progress is reported per file, so weight each region by its size to get a
    // single monotonic bar across the whole write.
    const total = fileArray.reduce((n, f) => n + f.data.length, 0);
    const offsets = fileArray.map((_, i) =>
      fileArray.slice(0, i).reduce((n, f) => n + f.data.length, 0),
    );

    await loader.writeFlash({
      fileArray,
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex: number, written: number) => {
        const done = (offsets[fileIndex] ?? 0) + written;
        hooks.progress(total > 0 ? Math.min(1, done / total) : 0);
      },
    });

    hooks.log('write complete, resetting');
    await loader.after();
  } finally {
    // Always hand the port back, or the next attempt cannot open it.
    await transport.disconnect().catch(() => {});
  }
}
