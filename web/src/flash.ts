import { ESPLoader, Transport } from 'esptool-js';

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

    await loader.writeFlash({
      fileArray: [{ data: new Uint8Array(image), address: 0 }],
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (_i: number, written: number, total: number) => {
        hooks.progress(total > 0 ? written / total : 0);
      },
    });

    hooks.log('write complete, resetting');
    await loader.after();
  } finally {
    // Always hand the port back, or the next attempt cannot open it.
    await transport.disconnect().catch(() => {});
  }
}
