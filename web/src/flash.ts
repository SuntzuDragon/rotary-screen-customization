import { ESPLoader, Transport } from 'esptool-js';
import { NVS_END, NVS_START, planWrites } from './flash-plan';

export interface FlashHooks {
  log: (line: string) => void;
  progress: (fraction: number) => void;
}

/**
 * Flash a merged image over Web Serial, in-page.
 *
 * Deliberately not esp-web-tools: that ships its own light-themed modal which
 * re-asks for the port and repeats the Wi-Fi steps this page already handles.
 * Driving esptool-js directly keeps the whole flow on one screen and lets the
 * caller render progress and logs however it likes.
 */
export interface FlashOpts {
  /**
   * Write the NVS region too, wiping saved Wi-Fi and the device's identity.
   *
   * This is the factory reset. It works with nothing but a USB cable, so it
   * recovers a device that is offline, mis-provisioned, or refusing to talk --
   * the cases where a software reset button cannot reach it.
   */
  eraseNvs?: boolean;
}

export async function flashFirmware(
  image: ArrayBuffer,
  hooks: FlashHooks,
  opts: FlashOpts = {},
  /**
   * Port to use instead of asking. The page usually already has one the user
   * picked, and prompting again for the device it is showing as connected is
   * a confusing way to start something destructive.
   */
  existing?: SerialPort | null,
): Promise<void> {
  if (!('serial' in navigator)) {
    throw new Error('This browser has no Web Serial. Use desktop Chrome, Edge, or Opera.');
  }

  const port = existing ?? (await navigator.serial.requestPort());
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

    // NVS is skipped unless this is a factory reset -- see flash-plan.ts.
    const fileArray = planWrites(new Uint8Array(image), Boolean(opts.eraseNvs));
    for (const r of fileArray) {
      hooks.log(`region 0x${r.address.toString(16)} (${r.data.length} bytes)\n`);
    }
    hooks.log(
      opts.eraseNvs
        ? 'FACTORY RESET: writing NVS too — Wi-Fi and device identity will be erased\n'
        : `skipping NVS 0x${NVS_START.toString(16)}-0x${NVS_END.toString(16)} ` +
            'to preserve Wi-Fi and device identity\n',
    );

    // Progress is reported per file. Weight each region's *fraction* by its
    // share of the whole write rather than summing raw byte counts: esptool
    // reports compressed bytes against an uncompressed total, so adding the
    // numbers directly made the bar run ahead and finish around 60-70%.
    const sizes = fileArray.map((f) => f.data.length);
    const totalBytes = sizes.reduce((n, v) => n + v, 0);
    const before = sizes.map((_, i) => sizes.slice(0, i).reduce((n, v) => n + v, 0));

    await loader.writeFlash({
      fileArray,
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex: number, written: number, fileTotal: number) => {
        const fraction = fileTotal > 0 ? Math.min(1, written / fileTotal) : 0;
        const done = (before[fileIndex] ?? 0) + fraction * (sizes[fileIndex] ?? 0);
        hooks.progress(totalBytes > 0 ? Math.min(1, done / totalBytes) : 0);
      },
    });

    hooks.log('write complete, resetting\n');

    // Explicit reset, in this exact order.
    //
    // DTR drives IO0 (BOOT) and RTS drives EN. After flashing, the stub leaves
    // BOOT asserted; if it is still low when EN is released the chip reboots
    // straight back into *download mode* rather than running the app -- which
    // presents as a completely dead board with a flawless flash log. Releasing
    // BOOT first, then pulsing EN, is the sequence that reliably revives it
    // (it is what the bench reset script does, every time).
    await transport.setDTR(false); // BOOT high -> boot the application
    await transport.setRTS(true); // EN low  -> hold in reset
    await new Promise((r) => setTimeout(r, 120));
    await transport.setRTS(false); // EN high -> run
    hooks.log('reset: BOOT released, EN pulsed — device should boot now\n');
  } finally {
    // Always hand the port back, or the next attempt cannot open it.
    await transport.disconnect().catch(() => {});
  }
}
