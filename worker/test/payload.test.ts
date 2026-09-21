import { describe, expect, it } from 'vitest';
import { buildPayload, diffSnapshots } from '../src/payload';
import {
  MAX_DEVICE_REPOS,
  defaultConfig,
  type DerivedEvent,
  type RepoSnapshot,
  type Snapshot,
} from '../src/types';

const repo = (name: string, over: Partial<RepoSnapshot> = {}): RepoSnapshot => ({
  name,
  lang: 'TypeScript',
  langColor: '#3178c6',
  stars: 10,
  forks: 2,
  openPRs: 1,
  openIssues: 3,
  lastCommitAt: 1_000,
  lastCommitMsg: 'initial',
  ...over,
});

const snapshot = (repos: RepoSnapshot[], over: Partial<Snapshot> = {}): Snapshot => ({
  fetchedAt: 5_000,
  login: 'octocat',
  name: 'The Octocat',
  followers: 42,
  contributions: 365,
  repos,
  feed: [],
  ...over,
});

describe('diffSnapshots', () => {
  it('reports nothing on the first snapshot, so a restart never replays history', () => {
    expect(diffSnapshots(null, snapshot([repo('a')]))).toEqual([]);
  });

  it('reports each counter that moved, with a signed delta, at the fetch time', () => {
    const before = snapshot([repo('a')]);
    const after = snapshot([repo('a', { stars: 13, forks: 1, openPRs: 1, openIssues: 5 })], {
      fetchedAt: 6_000,
    });
    expect(diffSnapshots(before, after)).toEqual([
      { k: 'star', r: 'a', d: 3, at: 6_000 },
      { k: 'fork', r: 'a', d: -1, at: 6_000 },
      { k: 'issue', r: 'a', d: 2, at: 6_000 },
    ]);
  });

  it('reports a push at the commit time when the newest commit changes', () => {
    const before = snapshot([repo('a', { lastCommitAt: 1_000 })]);
    const after = snapshot([repo('a', { lastCommitAt: 4_500 })]);
    expect(diffSnapshots(before, after)).toEqual([{ k: 'push', r: 'a', d: 1, at: 4_500 }]);
  });

  it('ignores a repo that was not in the previous snapshot', () => {
    const before = snapshot([repo('a')]);
    const after = snapshot([repo('a'), repo('new', { stars: 99 })]);
    expect(diffSnapshots(before, after)).toEqual([]);
  });
});

describe('buildPayload', () => {
  it('carries the config version, so the dial can report which settings it shows', () => {
    const config = { ...defaultConfig('octocat'), updatedAt: 1234 };
    expect(buildPayload(config, snapshot([]), []).cfg).toBe(1234);
  });

  // The firmware holds a fixed array of kMaxRepos cards. Anything past it used
  // to be dropped silently on the device; the cut is made here instead so the
  // page's preview shows exactly what the dial will.
  it(`sends at most ${MAX_DEVICE_REPOS} repos, the number the firmware can hold`, () => {
    const repos = Array.from({ length: MAX_DEVICE_REPOS + 4 }, (_, i) => repo(`r${i}`));
    const payload = buildPayload(defaultConfig('octocat'), snapshot(repos), []);
    expect(payload.repos).toHaveLength(MAX_DEVICE_REPOS);
    expect(payload.repos.map((r) => r.n)).toEqual(
      repos.slice(0, MAX_DEVICE_REPOS).map((r) => r.name),
    );
  });

  it('shows only the chosen repos, in the chosen order', () => {
    const config = { ...defaultConfig('octocat'), repos: ['c', 'a'] };
    const payload = buildPayload(config, snapshot([repo('a'), repo('b'), repo('c')]), []);
    expect(payload.repos.map((r) => r.n)).toEqual(['c', 'a']);
  });

  it('totals stars across the repos on the dial, not the whole account', () => {
    const config = { ...defaultConfig('octocat'), repos: ['a'] };
    const snap = snapshot([repo('a', { stars: 5 }), repo('b', { stars: 100 })]);
    expect(buildPayload(config, snap, []).p.stars).toBe(5);
  });

  it('merges derived and feed events newest first, drops unknown feed types, caps at ten', () => {
    const derived: DerivedEvent[] = Array.from({ length: 8 }, (_, i) => ({
      k: 'star',
      r: 'a',
      d: 1,
      at: 100 + i,
    }));
    const snap = snapshot([], {
      feed: [
        { type: 'PushEvent', repo: 'a', at: 500 },
        { type: 'GollumEvent', repo: 'a', at: 900 }, // not something the dial shows
        { type: 'ForkEvent', repo: 'b', at: 50 },
        { type: 'WatchEvent', repo: 'c', at: 400 },
      ],
    });
    const ev = buildPayload(defaultConfig('octocat'), snap, derived).ev;

    expect(ev).toHaveLength(10);
    expect(ev.map((e) => e.at)).toEqual([...ev.map((e) => e.at)].sort((a, b) => b - a));
    expect(ev[0]).toEqual({ k: 'push', r: 'a', d: 0, at: 500 });
    expect(ev.some((e) => e.at === 900)).toBe(false);
    // Eleven candidates, ten slots: the oldest (the fork at 50) falls off.
    expect(ev.some((e) => e.k === 'fork')).toBe(false);
  });
});
