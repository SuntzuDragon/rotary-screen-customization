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
    [100_000, '100k'],
    [123_456, '123k'],
    [999_499, '999k'],
    [1_000_000, '1.0M'],
    [2_345_678, '2.3M'],
  ])('%i reads "%s"', (n, expected) => {
    expect(compact(n)).toBe(expected);
  });
});
