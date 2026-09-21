import { describe, expect, it } from 'vitest';
import { NVS_END, NVS_START, planWrites, type Write } from './flash-plan';

/** A merged image of `size` bytes where every byte records its own position. */
function image(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 7 + 3) & 0xff;
  return bytes;
}

/**
 * What the chip holds after the writes, starting from flash that already has
 * something in it (0xAA) -- so a region the plan never touches stays visible.
 */
function flashAfter(writes: Write[], size: number): Uint8Array {
  const flash = new Uint8Array(size).fill(0xaa);
  for (const w of writes) flash.set(w.data, w.address);
  return flash;
}

const SIZE = 0x160000; // a realistic merged image, ~1.4MB

describe('an ordinary flash', () => {
  const img = image(SIZE);
  const writes = planWrites(img, false);
  const flash = flashAfter(writes, SIZE);

  it('never writes to NVS, so Wi-Fi and the dial identity survive', () => {
    for (const w of writes) {
      const end = w.address + w.data.length;
      expect(end <= NVS_START || w.address >= NVS_END, `write at 0x${w.address.toString(16)}`).toBe(
        true,
      );
    }
    expect(flash.subarray(NVS_START, NVS_END).every((b) => b === 0xaa)).toBe(true);
  });

  it('writes every other byte of the image, at its own address', () => {
    expect(flash.subarray(0, NVS_START)).toEqual(img.subarray(0, NVS_START));
    expect(flash.subarray(NVS_END)).toEqual(img.subarray(NVS_END));
  });

  it('never writes the same byte twice', () => {
    const sorted = [...writes].sort((a, b) => a.address - b.address);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      expect(sorted[i]!.address).toBeGreaterThanOrEqual(prev.address + prev.data.length);
    }
  });
});

describe('a factory reset', () => {
  it('writes the whole image in one piece, NVS included, which erases it', () => {
    const img = image(SIZE);
    const writes = planWrites(img, true);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.address).toBe(0);
    expect(flashAfter(writes, SIZE)).toEqual(img);
  });
});

describe('a short image', () => {
  it('writes no empty regions and nothing past the end of the image', () => {
    const img = image(0x9800); // ends inside NVS, before the app
    const writes = planWrites(img, false);
    expect(writes.every((w) => w.data.length > 0)).toBe(true);
    expect(Math.max(...writes.map((w) => w.address + w.data.length))).toBeLessThanOrEqual(
      img.length,
    );
  });
});
