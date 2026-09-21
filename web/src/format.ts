/**
 * Relative time from an absolute epoch. The device does this itself from its
 * NTP clock, which is why the payload carries absolute seconds -- a cached
 * payload can never show a stale "3d ago".
 */
export function ago(epochSec: number | null, nowSec = Date.now() / 1000): string {
  if (!epochSec) return '--';
  const d = Math.max(0, nowSec - epochSec);
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 365) return `${Math.floor(d / 86400)}d ago`;
  return `${Math.floor(d / (86400 * 365))}y ago`;
}

/**
 * Keep big numbers inside the circle: 4548 -> "4548", 12400 -> "12.4k",
 * 123456 -> "123.5k", 1234567 -> "1.2M".
 *
 * Must match the dial exactly -- compact() in firmware/src/ui/compact.h, which
 * format.test.ts compiles and compares against this. Rounding is done in whole
 * numbers, half up, because toFixed and C's printf round an exact half
 * differently: 12250 would read "12.3k" here and "12.2k" on the dial.
 *
 * The unit switches where rounding would carry into the next one, so 999,950
 * reads "1.0M", not "1000.0k".
 */
export function compact(n: number): string {
  if (n < 10000) return String(n);
  const k = Math.floor((n + 50) / 100); // thousands, in tenths
  if (k < 10000) return `${Math.floor(k / 10)}.${k % 10}k`;
  const m = Math.floor((n + 50_000) / 100_000); // millions, in tenths
  return `${Math.floor(m / 10)}.${m % 10}M`;
}

export const EVENT_LABEL: Record<string, string> = {
  star: 'star',
  fork: 'fork',
  pr: 'PR',
  issue: 'issue',
  push: 'push',
};
