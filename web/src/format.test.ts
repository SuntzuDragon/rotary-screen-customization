import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ago, compact } from './format';

describe('ago', () => {
  const now = 1_000_000;

  it('shows a placeholder when there is no time at all', () => {
    expect(ago(null, now)).toBe('--');
    expect(ago(0, now)).toBe('--');
  });

  it.each([
    [0, 'just now'],
    [59, 'just now'],
    [60, '1m ago'],
    [3599, '59m ago'],
    [3600, '1h ago'],
    [86_399, '23h ago'],
    [86_400, '1d ago'],
    [86_400 * 364, '364d ago'],
    [86_400 * 365, '1y ago'],
  ])('%is before now reads "%s"', (secondsAgo, expected) => {
    expect(ago(now - secondsAgo, now)).toBe(expected);
  });

  // A dial whose clock is slightly ahead of the server must not say "-5s ago".
  it('treats a time in the future as just now', () => {
    expect(ago(now + 30, now)).toBe('just now');
  });
});

describe('compact', () => {
  it.each([
    [0, '0'],
    [4548, '4548'],
    [9999, '9999'],
    [10_000, '10.0k'],
    [12_400, '12.4k'],
    [99_949, '99.9k'],
    [99_999, '100.0k'],
    [100_000, '100.0k'],
    [123_456, '123.5k'],
    [999_499, '999.5k'],
    [1_000_000, '1.0M'],
    [2_345_678, '2.3M'],
  ])('%i reads "%s"', (n, expected) => {
    expect(compact(n)).toBe(expected);
  });

  // An exact half rounds up. toFixed would agree here, but C's printf rounds a
  // half to even -- so the dial and the page rounded 12,250 differently.
  it.each([
    [12_250, '12.3k'],
    [12_750, '12.8k'],
    [123_450, '123.5k'],
  ])('%i rounds an exact half up, to "%s"', (n, expected) => {
    expect(compact(n)).toBe(expected);
  });

  // Where rounding would carry into the next unit. 999,950 used to read
  // "1000.0k" on both the page and the dial.
  it.each([
    [999_949, '999.9k'],
    [999_950, '1.0M'],
    [999_999, '1.0M'],
  ])('%i is shown as "%s"', (n, expected) => {
    expect(compact(n)).toBe(expected);
  });

  // Every value, not a sample: the ranges that broke were only 50 numbers wide,
  // and a stepped sweep jumps straight over them.
  it('never produces more than six characters, for every value below a million', () => {
    let widest = { text: '', n: 0 };
    for (let n = 10_000; n < 1_000_000; n++) {
      const text = compact(n);
      if (text.length > widest.text.length) widest = { text, n };
    }
    expect(widest.text.length, `compact(${widest.n}) = "${widest.text}"`).toBeLessThanOrEqual(6);
  });

  // The dial draws these numbers itself, from firmware/src/ui/compact.h, and the
  // page's preview must show exactly what the dial will. This compiles the
  // firmware's header natively and compares the two on every value below a
  // million, plus a spread of larger ones up to the 32-bit limit.
  it('agrees exactly with the firmware', () => {
    const values = Array.from({ length: 1_000_001 }, (_, n) => n);
    for (let n = 1_000_000; n < 2_147_483_647; n = Math.floor(n * 1.0003) + 7) values.push(n);
    values.push(2_147_483_647);

    const expected = runFirmwareCompact(values);
    const mismatches = values
      .map((n, i) => ({ n, page: compact(n), dial: expected[i] }))
      .filter((r) => r.page !== r.dial);
    expect(mismatches.slice(0, 5), `${mismatches.length} values differ`).toEqual([]);
  });
});

/** Compile firmware/src/ui/compact.h for this machine and run it over `values`. */
function runFirmwareCompact(values: number[]): string[] {
  const include = fileURLToPath(new URL('../../firmware/src/ui/', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'compact-'));
  try {
    const src = join(dir, 'harness.cpp');
    const bin = join(dir, 'harness');
    writeFileSync(
      src,
      `#include <cstdio>
#include "compact.h"
int main() {
  long long n;
  char buf[32];
  while (scanf("%lld", &n) == 1) {
    compact(static_cast<int32_t>(n), buf, sizeof buf);
    puts(buf);
  }
}
`,
    );
    try {
      execFileSync('g++', ['-std=c++17', '-O2', '-Wall', '-Werror', '-I', include, src, '-o', bin]);
    } catch (err) {
      throw new Error(
        'could not compile firmware/src/ui/compact.h with g++ -- install a C++ compiler to run this test',
        { cause: err },
      );
    }
    const out = execFileSync(bin, { input: values.join('\n'), maxBuffer: 64 * 1024 * 1024 });
    return out.toString('utf8').trimEnd().split('\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
