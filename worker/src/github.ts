import type { Snapshot, RepoSnapshot, FeedEvent } from './types';

const API = 'https://api.github.com';
const UA = 'rotary-stats-worker (+github.com/SuntzuDragon/rotary-screen-customization)';

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Last seen x-ratelimit-remaining, surfaced for cron logging. */
export let lastRateRemaining: string | null = null;

function headers(token: string, accept = 'application/vnd.github+json'): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    accept,
    'user-agent': UA,
    'x-github-api-version': '2022-11-28',
  };
}

/**
 * $privacy is PUBLIC for the shared token and null (everything) for somebody's
 * own PAT.
 *
 * Without it the query returns whatever the token can see, so a shared token
 * that turned out to be broader than intended would quietly publish private
 * repository names and commit subjects into the shared cache. Asking for
 * public data explicitly means the scope of the token stops mattering.
 */
const PROFILE_QUERY = `
query($login:String!, $n:Int!, $privacy:RepositoryPrivacy){
  user(login:$login){
    name login
    followers{ totalCount }
    contributionsCollection{ contributionCalendar{ totalContributions } }
    repositories(first:$n, ownerAffiliations:OWNER, isFork:false, privacy:$privacy,
                 orderBy:{field:STARGAZERS, direction:DESC}){
      nodes{
        name
        primaryLanguage{ name color }
        stargazerCount
        forkCount
        pullRequests(states:OPEN){ totalCount }
        issues(states:OPEN){ totalCount }
        defaultBranchRef{
          target{ ... on Commit { history(first:1){ nodes{ committedDate messageHeadline } } } }
        }
      }
    }
  }
  rateLimit{ cost remaining }
}`;

interface GqlRepoNode {
  name: string;
  primaryLanguage: { name: string; color: string | null } | null;
  stargazerCount: number;
  forkCount: number;
  pullRequests: { totalCount: number };
  issues: { totalCount: number };
  defaultBranchRef: {
    target: { history: { nodes: { committedDate: string; messageHeadline: string }[] } } | null;
  } | null;
}

const epoch = (iso: string | null | undefined): number | null =>
  iso ? Math.floor(Date.parse(iso) / 1000) : null;

/** Profile + repo stats in a single GraphQL call (cost: 1 point). */
export async function fetchProfile(
  token: string,
  login: string,
  /** Shared token: public repositories only. Own PAT: whatever it can see. */
  publicOnly = true,
  max = 20,
): Promise<Omit<Snapshot, 'fetchedAt' | 'feed'>> {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { ...headers(token), 'content-type': 'application/json' },
    body: JSON.stringify({
      query: PROFILE_QUERY,
      variables: { login, n: max, privacy: publicOnly ? 'PUBLIC' : null },
    }),
  });
  if (!res.ok) throw new GitHubError(`graphql ${res.status}`, res.status);

  const body = (await res.json()) as {
    data?: { user: unknown; rateLimit?: { remaining: number } };
    errors?: { message: string }[];
  };
  if (body.errors?.length) {
    throw new GitHubError(body.errors.map((e) => e.message).join('; '), 200);
  }
  const user = body.data?.user as
    | {
        name: string | null;
        login: string;
        followers: { totalCount: number };
        contributionsCollection: { contributionCalendar: { totalContributions: number } };
        repositories: { nodes: GqlRepoNode[] };
      }
    | null
    | undefined;
  if (!user) throw new GitHubError(`no such user: ${login}`, 404);

  if (body.data?.rateLimit) lastRateRemaining = String(body.data.rateLimit.remaining);

  const repos: RepoSnapshot[] = user.repositories.nodes.map((r) => {
    const commit = r.defaultBranchRef?.target?.history.nodes[0] ?? null;
    return {
      name: r.name,
      lang: r.primaryLanguage?.name ?? null,
      langColor: r.primaryLanguage?.color ?? null,
      stars: r.stargazerCount,
      forks: r.forkCount,
      openPRs: r.pullRequests.totalCount,
      openIssues: r.issues.totalCount,
      lastCommitAt: epoch(commit?.committedDate),
      lastCommitMsg: commit?.messageHeadline ?? null,
    };
  });

  return {
    login: user.login,
    name: user.name,
    followers: user.followers.totalCount,
    contributions: user.contributionsCollection.contributionCalendar.totalContributions,
    repos,
  };
}

/**
 * Public activity feed. Deliberately NOT filtered to the user's own repos --
 * measured live, this feed is mostly PRs against other people's projects, and
 * filtering it leaves the ticker empty. See docs/research-findings.md.
 */
export async function fetchFeed(token: string, login: string, limit = 12): Promise<FeedEvent[]> {
  const res = await fetch(`${API}/users/${encodeURIComponent(login)}/events/public?per_page=30`, {
    headers: headers(token),
  });
  const rem = res.headers.get('x-ratelimit-remaining');
  if (rem) lastRateRemaining = rem;
  if (!res.ok) return [];

  const raw = (await res.json()) as { type: string; repo: { name: string }; created_at: string }[];
  return raw
    .map((e) => ({ type: e.type, repo: e.repo.name, at: epoch(e.created_at) ?? 0 }))
    .slice(0, limit);
}

/**
 * Full refresh for one login: a single GraphQL call plus the public event feed.
 * Deliberately fetches every non-fork repo rather than only the configured
 * subset, so one snapshot can serve several devices watching the same account;
 * the per-device filter happens at payload build time instead.
 */
export async function buildSnapshot(
  token: string,
  login: string,
  publicOnly = true,
): Promise<Snapshot> {
  const [profile, feed] = await Promise.all([
    fetchProfile(token, login, publicOnly),
    fetchFeed(token, login),
  ]);
  return { ...profile, feed, fetchedAt: Math.floor(Date.now() / 1000) };
}

/**
 * Confirm a user-supplied PAT before storing it. A typo'd or revoked token
 * would otherwise be accepted silently and only show up later as a blank
 * display, so this is checked at the point the user can still fix it.
 * Returns the authenticated login, or null if the token is not usable.
 */
export async function verifyToken(token: string): Promise<string | null> {
  try {
    const res = await fetch(`${API}/graphql`, {
      method: 'POST',
      headers: { ...headers(token), 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ viewer { login } }' }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { viewer?: { login?: string } } };
    return body.data?.viewer?.login ?? null;
  } catch {
    return null;
  }
}
