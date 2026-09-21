import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_DEVICE_REPOS } from './types';

// The number of repo cards is written down in three places that cannot import
// from one another: the firmware's fixed array, the Worker that trims the
// payload, and this page's picker. Nothing else ties them together, so if one
// changes alone the dial silently drops cards or the page offers slots the dial
// does not have. This reads the other two from source and fails on any drift.
const read = (fromRepoRoot: string) =>
  readFileSync(new URL(`../../${fromRepoRoot}`, import.meta.url), 'utf8');

function constant(source: string, pattern: RegExp, where: string): number {
  const m = pattern.exec(source);
  if (!m) throw new Error(`could not find the repo limit in ${where}; update this test`);
  return Number(m[1]);
}

describe('the repo card limit', () => {
  it('is the same in the firmware, the Worker and the page', () => {
    const firmware = constant(
      read('firmware/src/model/stats.h'),
      /kMaxRepos\s*=\s*(\d+)/,
      'firmware/src/model/stats.h',
    );
    const worker = constant(
      read('worker/src/types.ts'),
      /MAX_DEVICE_REPOS\s*=\s*(\d+)/,
      'worker/src/types.ts',
    );
    expect({ firmware, worker, page: MAX_DEVICE_REPOS }).toEqual({
      firmware,
      worker: firmware,
      page: firmware,
    });
  });
});
