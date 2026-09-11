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
    errors?: { message: string; type?: string }[];
  };
  if (body.errors?.length) {
    // A login that does not exist comes back as a NOT_FOUND error, not as an
    // empty user -- so without this it read as a generic failure, and a typo
    // was indistinguishable from GitHub being down.
    const missing = body.errors.some((e) => e.type === 'NOT_FOUND');
    throw new GitHubError(body.errors.map((e) => e.message).join('; '), missing ? 404 : 200);
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

/* ---------- GitHub App sign-in ---------- */

export interface UserTokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds. */
  expiresIn: number;
  refreshExpiresIn: number;
}

/**
 * GitHub's OAuth token endpoint answers 200 even when it refuses, with the
 * reason in an `error` field -- so a status check alone would happily store
 * "bad_verification_code" as if it were a token.
 */
async function tokenEndpoint(params: Record<string, string>): Promise<UserTokenPair> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': UA,
    },
    body: new URLSearchParams(params),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || body.error || !body.access_token) {
    throw new GitHubError(
      body.error_description ?? body.error ?? `token endpoint ${res.status}`,
      res.ok ? 400 : res.status,
    );
  }
  if (!body.refresh_token || !body.expires_in) {
    // The app was registered with expiring tokens switched off. Everything here
    // assumes they expire and renews them; a token that never does would be
    // stored without a refresh token and break on the first renewal.
    throw new GitHubError(
      'the GitHub App needs "Expire user authorization tokens" switched on',
      400,
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in,
    refreshExpiresIn: body.refresh_token_expires_in ?? 15_897_600, // six months
  };
}

/** Swap the one-time code from the callback for a token pair. */
export const exchangeCode = (
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
) =>
  tokenEndpoint({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

/** Spend a refresh token. It stops working the moment this succeeds. */
export const refreshUserToken = (clientId: string, clientSecret: string, refreshToken: string) =>
  tokenEndpoint({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

/**
 * Withdraw the app's authorization entirely, so "Disconnect" here also removes
 * it from the person's GitHub Applications page instead of leaving behind a
 * grant nothing uses. Best effort: an expired token makes it fail, and the
 * local copy is deleted either way.
 */
export async function revokeGrant(
  clientId: string,
  clientSecret: string,
  accessToken: string,
): Promise<boolean> {
  const res = await fetch(`${API}/applications/${clientId}/grant`, {
    method: 'DELETE',
    headers: {
      authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      accept: 'application/vnd.github+json',
      'user-agent': UA,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ access_token: accessToken }),
  });
  return res.status === 204;
}
