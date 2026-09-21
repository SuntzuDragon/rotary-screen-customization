/**
 * Which parts of the merged image actually get written.
 *
 * The image is flat: esptool's merge-bin pads the gaps between segments with
 * 0xFF. NVS lives at 0x9000-0xe000, inside one of those gaps, so writing the
 * image in one piece from 0x0 erases it -- taking the Wi-Fi credentials and the
 * device's identity with it, and silently re-provisioning the device on every
 * flash. Writing the regions around it leaves NVS untouched.
 *
 * Kept apart from flash.ts, which drives esptool, so it can be tested without
 * a serial port: a mistake here wipes every dial it touches.
 */
export const NVS_START = 0x9000;
export const NVS_END = 0xe000;

const REGIONS: { name: string; start: number; end: number }[] = [
  { name: 'bootloader', start: 0x0, end: 0x8000 },
  { name: 'partitions', start: 0x8000, end: NVS_START },
  // 0x9000-0xe000 (NVS) deliberately skipped.
  { name: 'otadata', start: NVS_END, end: 0x10000 },
  { name: 'app', start: 0x10000, end: -1 },
];

export interface Write {
  data: Uint8Array;
  address: number;
}

/**
 * The writes that flash `image`. A factory reset is simply not skipping NVS:
 * the merged image has 0xFF there, so writing it erases the partition.
 */
export function planWrites(image: Uint8Array, eraseNvs: boolean): Write[] {
  const regions = eraseNvs ? [{ name: 'everything', start: 0x0, end: -1 }] : REGIONS;
  return regions
    .filter((r) => r.start < image.length)
    .map((r) => {
      const end = r.end < 0 ? image.length : Math.min(r.end, image.length);
      return { data: image.subarray(r.start, end), address: r.start };
    });
}
