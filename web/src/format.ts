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

/** Keep big numbers inside the circle: 4548 -> 4548, 12400 -> 12.4k */
export function compact(n: number): string {
  if (n < 10000) return String(n);
  // The unit is chosen at the point where rounding would carry into the next
  // one, not at the round number: deciding before rounding turned 99,999 into
  // "100.0k" and 999,999 into "1000k" -- both wider than the circle allows.
  if (n < 99_950) return `${(n / 1000).toFixed(1)}k`;
  if (n < 999_500) return `${(n / 1000).toFixed(0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const EVENT_LABEL: Record<string, string> = {
  star: 'star',
  fork: 'fork',
  pr: 'PR',
  issue: 'issue',
  push: 'push',
};
