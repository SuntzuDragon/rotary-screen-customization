import type {
  DerivedEvent,
  DeviceConfig,
  DevicePayload,
  PayloadRepo,
  Snapshot,
} from './types';

/** GitHub event type -> short kind understood by the firmware. */
const FEED_KIND: Record<string, DerivedEvent['k']> = {
  WatchEvent: 'star',
  ForkEvent: 'fork',
  PullRequestEvent: 'pr',
  IssuesEvent: 'issue',
  PushEvent: 'push',
};

/**
 * Synthesise events by diffing consecutive snapshots.
 *
 * This is the primary source for the activity ticker. GitHub's public event
 * feed was measured near-empty for this user, and it only covers ~90 days, so
 * it cannot carry the ambient display on its own. Diffing our own 5-minute
 * snapshots always reflects reality and is what the LED pulse fires on.
 */
export function diffSnapshots(prev: Snapshot | null, next: Snapshot): DerivedEvent[] {
  if (!prev) return [];
  const before = new Map(prev.repos.map((r) => [r.name, r]));
  const out: DerivedEvent[] = [];
  const at = next.fetchedAt;

  for (const r of next.repos) {
    const p = before.get(r.name);
    if (!p) continue;
    const bump = (k: DerivedEvent['k'], d: number) => {
      if (d !== 0) out.push({ k, r: r.name, d, at });
    };
    bump('star', r.stars - p.stars);
    bump('fork', r.forks - p.forks);
    bump('pr', r.openPRs - p.openPRs);
    bump('issue', r.openIssues - p.openIssues);
    if (r.lastCommitAt && r.lastCommitAt !== p.lastCommitAt) {
      out.push({ k: 'push', r: r.name, d: 1, at: r.lastCommitAt });
    }
  }
  return out;
}

/** Newest-first merge of synthesised events and the raw public feed. */
function mergeEvents(derived: DerivedEvent[], snap: Snapshot, limit = 10) {
  const fromFeed = snap.feed
    .filter((e) => FEED_KIND[e.type])
    .map((e) => ({ k: FEED_KIND[e.type]!, r: e.repo, d: 0, at: e.at }));

  return [...derived, ...fromFeed]
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((e) => ({ k: e.k, r: e.r, d: e.d, at: e.at }));
}

export function buildPayload(
  config: DeviceConfig,
  snap: Snapshot,
  derived: DerivedEvent[],
): DevicePayload {
  let repos = snap.repos;
  if (config.repos?.length) {
    const order = config.repos;
    const wanted = new Set(order);
    repos = repos
      .filter((r) => wanted.has(r.name))
      .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }

  const payloadRepos: PayloadRepo[] = repos.map((r) => ({
    n: r.name,
    s: r.stars,
    f: r.forks,
    pr: r.openPRs,
    i: r.openIssues,
    lang: r.lang,
    col: r.langColor,
    c: r.lastCommitAt,
    msg: r.lastCommitMsg,
  }));

  return {
    ttl: 60,
    theme: config.theme,
    decks: config.decks,
    p: {
      login: snap.login,
      name: snap.name,
      followers: snap.followers,
      // Sum across displayed repos so the dial matches what the cards show.
      stars: payloadRepos.reduce((n, r) => n + r.s, 0),
      contrib: snap.contributions,
    },
    repos: payloadRepos,
    ev: mergeEvents(derived, snap),
  };
}
