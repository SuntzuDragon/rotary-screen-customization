import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubError, buildSnapshot, fetchFeed, fetchProfile } from '../src/github';
import { refreshLogin } from '../src/index';
import { getSnapshot, snapshotScope } from '../src/store';
import { resetDatabase } from './reset';

// GitHub is replaced at the fetch boundary: every test sees exactly what the
// Worker would have sent, and decides what comes back. Nothing leaves the
// runtime.

interface Sent {
  url: string;
  body: { query?: string; variables?: Record<string, unknown> } | null;
}

let sent: Sent[];

const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
let respond: (url: string, body: Sent['body']) => Response;

beforeEach(async () => {
  await resetDatabase();
  sent = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = urlOf(input);
    const raw = init?.body ?? (input instanceof Request ? await input.text() : null);
    const body = typeof raw === 'string' && raw ? (JSON.parse(raw) as Sent['body']) : null;
    sent.push({ url, body });
    return respond(url, body);
  });
});

afterEach(() => vi.restoreAllMocks());

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** A GraphQL repository node, the shape GitHub returns. */
const gqlRepo = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  nameWithOwner: `octocat/${name}`,
  primaryLanguage: { name: 'TypeScript', color: '#3178c6' },
  stargazerCount: 10,
  forkCount: 2,
  pullRequests: { totalCount: 1 },
  issues: { totalCount: 4 },
  defaultBranchRef: {
    target: {
      history: {
        nodes: [{ committedDate: '2026-09-01T12:00:00Z', messageHeadline: 'Fix the thing' }],
      },
    },
  },
  ...over,
});

const profile = (repos: unknown[], viewer = 'octocat') =>
  json({
    data: {
      viewer: { login: viewer },
      user: {
        name: 'The Octocat',
        login: 'octocat',
        followers: { totalCount: 42 },
        contributionsCollection: { contributionCalendar: { totalContributions: 365 } },
        repositories: { nodes: repos },
      },
      rateLimit: { cost: 1, remaining: 4999 },
    },
  });

/** Route by URL: GraphQL gets the profile, the REST feed gets `feed`. */
const github =
  (repos: unknown[], feed: unknown[] = []) =>
  (url: string) =>
    url.endsWith('/graphql') ? profile(repos) : json(feed);

describe('what is asked of GitHub', () => {
  // The shared token serves every dial watching a username. If it were ever
  // broader than intended, asking for everything would pull private repo names
  // and commit messages into a cache other people's dials read from.
  it('asks for public repositories only by default, as the shared token does', async () => {
    respond = github([]);
    await fetchProfile('tok', 'octocat');
    expect(sent[0]!.body!.variables!.privacy).toBe('PUBLIC');
  });

  it("asks for everything with a device's own token", async () => {
    respond = github([]);
    await fetchProfile('tok', 'octocat', false);
    expect(sent[0]!.body!.variables!.privacy).toBeNull();
  });

  it('sends the token as a bearer header, never in the URL', async () => {
    let auth: string | null = null;
    vi.mocked(globalThis.fetch).mockImplementation((input, init) => {
      auth = new Headers(init?.headers).get('authorization');
      expect(urlOf(input)).not.toContain('tok_secret');
      return Promise.resolve(profile([]));
    });
    await fetchProfile('tok_secret', 'octocat');
    expect(auth).toBe('Bearer tok_secret');
  });
});

describe('reading the profile', () => {
  it('maps a repository to what the dial shows', async () => {
    respond = github([gqlRepo('hello')]);
    const { profile: p } = await fetchProfile('tok', 'octocat');
    expect(p).toMatchObject({
      login: 'octocat',
      name: 'The Octocat',
      followers: 42,
      contributions: 365,
    });
    expect(p.repos).toEqual([
      {
        name: 'hello',
        lang: 'TypeScript',
        langColor: '#3178c6',
        stars: 10,
        forks: 2,
        openPRs: 1,
        openIssues: 4,
        lastCommitAt: Date.parse('2026-09-01T12:00:00Z') / 1000,
        lastCommitMsg: 'Fix the thing',
      },
    ]);
  });

  it('copes with an empty repository, which has no default branch yet', async () => {
    respond = github([gqlRepo('empty', { defaultBranchRef: null, primaryLanguage: null })]);
    const { profile: p } = await fetchProfile('tok', 'octocat');
    expect(p.repos[0]).toMatchObject({
      lang: null,
      langColor: null,
      lastCommitAt: null,
      lastCommitMsg: null,
    });
  });

  // A typo in a username has to be distinguishable from GitHub being down, or
  // the settings page cannot tell the user which one happened.
  it('reports a user that does not exist as a 404', async () => {
    respond = () =>
      json({ data: { user: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] });
    await expect(fetchProfile('tok', 'nobody')).rejects.toMatchObject({
      name: 'Error',
      status: 404,
    });
  });

  it('reports GitHub itself failing with its status', async () => {
    respond = () => json({ message: 'Bad credentials' }, 401);
    const err = await fetchProfile('tok', 'octocat').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(401);
  });
});

describe('the activity feed', () => {
  it('maps events and keeps the newest twelve', async () => {
    const events = Array.from({ length: 20 }, (_, i) => ({
      type: 'PushEvent',
      repo: { name: `octocat/r${i}` },
      created_at: '2026-09-01T12:00:00Z',
    }));
    respond = () => json(events);
    const feed = await fetchFeed('tok', 'octocat');
    expect(feed).toHaveLength(12);
    expect(feed[0]).toEqual({
      type: 'PushEvent',
      repo: 'octocat/r0',
      at: Date.parse('2026-09-01T12:00:00Z') / 1000,
    });
  });

  it('is empty rather than an error when GitHub refuses', async () => {
    respond = () => json({ message: 'rate limited' }, 403);
    expect(await fetchFeed('tok', 'octocat')).toEqual([]);
  });
});

describe('organisation repositories', () => {
  // Org repos are the *signed-in* person's grants. On someone else's dial, or
  // with a pasted PAT (which cannot list app installations), they do not apply.
  it('are not requested for the shared token', async () => {
    respond = github([gqlRepo('mine')]);
    await buildSnapshot('ghu_app_token', 'octocat', true);
    expect(sent.some((s) => s.url.includes('/user/installations'))).toBe(false);
  });

  it('are not requested with a pasted PAT, which cannot list them', async () => {
    respond = github([gqlRepo('mine')]);
    await buildSnapshot('github_pat_x', 'octocat', false);
    expect(sent.some((s) => s.url.includes('/user/installations'))).toBe(false);
  });
});

describe('where a refresh is cached', () => {
  // The split that keeps one person's private repositories off everybody
  // else's dial: a device's own token writes to a cache only that device reads.
  it("keeps a device's own-token results out of the shared cache", async () => {
    respond = github([gqlRepo('secret-project')]);
    await refreshLogin(env, 'Octocat', 'tok', 'dial0001');

    expect(sent.find((s) => s.url.endsWith('/graphql'))!.body!.variables!.privacy).toBeNull();
    expect(await getSnapshot(env, snapshotScope('Octocat', null))).toBeNull();
    const own = await getSnapshot(env, snapshotScope('Octocat', 'dial0001'));
    expect(own?.repos.map((r) => r.name)).toEqual(['secret-project']);
  });

  it('writes shared-token results to the shared cache, public repositories only', async () => {
    respond = github([gqlRepo('public-project')]);
    await refreshLogin(env, 'Octocat', 'tok', null);

    expect(sent.find((s) => s.url.endsWith('/graphql'))!.body!.variables!.privacy).toBe('PUBLIC');
    const shared = await getSnapshot(env, snapshotScope('Octocat', null));
    expect(shared?.repos.map((r) => r.name)).toEqual(['public-project']);
  });

  it('scopes the shared cache by username regardless of case', () => {
    expect(snapshotScope('OctoCat', null)).toBe(snapshotScope('octocat', null));
    expect(snapshotScope('octocat', 'dial0001')).not.toBe(snapshotScope('octocat', null));
  });
});
