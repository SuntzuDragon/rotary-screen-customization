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
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const EVENT_LABEL: Record<string, string> = {
  star: 'star',
  fork: 'fork',
  pr: 'PR',
  issue: 'issue',
  push: 'push',
};
