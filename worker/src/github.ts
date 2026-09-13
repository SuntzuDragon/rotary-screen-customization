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
/** The fields the dial shows for any repository, owned or granted through an org. */
const REPO_FIELDS = `
fragment RepoFields on Repository {
  name
  nameWithOwner
  primaryLanguage{ name color }
  stargazerCount
  forkCount
  pullRequests(states:OPEN){ totalCount }
  issues(states:OPEN){ totalCount }
  defaultBranchRef{
    target{ ... on Commit { history(first:1){ nodes{ committedDate messageHeadline } } } }
  }
}`;

const PROFILE_QUERY = `
query($login:String!, $n:Int!, $privacy:RepositoryPrivacy){
  viewer{ login }
  user(login:$login){
    name login
    followers{ totalCount }
    contributionsCollection{ contributionCalendar{ totalContributions } }
    repositories(first:$n, ownerAffiliations:OWNER, isFork:false, privacy:$privacy,
                 orderBy:{field:STARGAZERS, direction:DESC}){
      nodes{ ...RepoFields }
    }
  }
  rateLimit{ cost remaining }
}
${REPO_FIELDS}`;

interface GqlRepoNode {
  name: string;
  nameWithOwner: string;
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

function toRepoSnapshot(r: GqlRepoNode, name: string): RepoSnapshot {
  const commit = r.defaultBranchRef?.target?.history.nodes[0] ?? null;
  return {
    name,
    lang: r.primaryLanguage?.name ?? null,
    langColor: r.primaryLanguage?.color ?? null,
    stars: r.stargazerCount,
    forks: r.forkCount,
    openPRs: r.pullRequests.totalCount,
    openIssues: r.issues.totalCount,
    lastCommitAt: epoch(commit?.committedDate),
    lastCommitMsg: commit?.messageHeadline ?? null,
  };
}

/** Profile + repo stats in a single GraphQL call (cost: 1 point). */
export async function fetchProfile(
  token: string,
  login: string,
  /** Shared token: public repositories only. Own PAT: whatever it can see. */
  publicOnly = true,
  max = 20,
): Promise<{ profile: Omit<Snapshot, 'fetchedAt' | 'feed'>; viewer: string | null }> {
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
    data?: { user: unknown; viewer?: { login: string }; rateLimit?: { remaining: number } };
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

  const repos: RepoSnapshot[] = user.repositories.nodes.map((r) => toRepoSnapshot(r, r.name));

  return {
    profile: {
      login: user.login,
      name: user.name,
      followers: user.followers.totalCount,
      contributions: user.contributionsCollection.contributionCalendar.totalContributions,
      repos,
    },
    viewer: body.data?.viewer?.login ?? null,
  };
}

/** Org repos taken per sign-in. The dial holds eight; the picker can offer more. */
const MAX_ORG_REPOS = 20;

/**
 * Repositories an organization has explicitly granted to the app, for the
 * signed-in person.
 *
 * Deliberately not `ownerAffiliations: ORGANIZATION_MEMBER`. That returns every
 * public repo of every org the account belongs to without anyone granting
 * anything, and a big open-source org's 40k-star repos would push the person's
 * own work out of the top eight. Installations are the explicit list: an org
 * owner chose these.
 *
 * Needs a GitHub App user token (`ghu_`) -- a pasted PAT cannot list app
 * installations, so callers skip it for those.
 */
export async function fetchInstalledOrgRepos(token: string): Promise<RepoSnapshot[]> {
  const list = await fetch(`${API}/user/installations?per_page=100`, { headers: headers(token) });
  if (!list.ok) return [];
  const { installations = [] } = (await list.json()) as {
    installations?: { id: number; account?: { type?: string } | null }[];
  };

  const fullNames: string[] = [];
  for (const inst of installations) {
    if (inst.account?.type !== 'Organization') continue;
    const res = await fetch(`${API}/user/installations/${inst.id}/repositories?per_page=100`, {
      headers: headers(token),
    });
    if (!res.ok) continue;
    const { repositories = [] } = (await res.json()) as {
      repositories?: { full_name: string; fork: boolean; archived?: boolean }[];
    };
    for (const r of repositories) {
      // Same rule as owned repos: no forks. Archived repos are frozen, not worth a card.
      if (!r.fork && !r.archived) fullNames.push(r.full_name);
    }
  }
  const wanted = fullNames.slice(0, MAX_ORG_REPOS);
  if (wanted.length === 0) return [];

  // One GraphQL call for all of them, aliased r0..rN, variables rather than
  // names spliced into the query text.
  const variables: Record<string, string> = {};
  const decls: string[] = [];
  const picks: string[] = [];
  wanted.forEach((full, i) => {
    const [owner = '', name = ''] = full.split('/');
    variables[`o${i}`] = owner;
    variables[`n${i}`] = name;
    decls.push(`$o${i}:String!`, `$n${i}:String!`);
    picks.push(`r${i}: repository(owner:$o${i}, name:$n${i}){ ...RepoFields }`);
  });
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { ...headers(token), 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query(${decls.join(', ')}){\n${picks.join('\n')}\n}\n${REPO_FIELDS}`,
      variables,
    }),
  });
  if (!res.ok) return [];
  // A repo removed since it was listed comes back null, with an error beside it.
  // The rest are still good, so `errors` is not treated as failure here.
  const body = (await res.json()) as { data?: Record<string, GqlRepoNode | null> };
  return Object.values(body.data ?? {})
    .filter((r): r is GqlRepoNode => Boolean(r))
    .map((r) => toRepoSnapshot(r, r.nameWithOwner));
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
  const [{ profile, viewer }, feed] = await Promise.all([
    fetchProfile(token, login, publicOnly),
    fetchFeed(token, login),
  ]);

  // Org repos only for an app sign-in looking at its own account. On someone
  // else's dial they would be the connected person's orgs, not the shown
  // person's -- and a PAT, which is not `ghu_`, cannot list installations.
  let repos = profile.repos;
  if (!publicOnly && token.startsWith('ghu_') && viewer?.toLowerCase() === login.toLowerCase()) {
    const org = await fetchInstalledOrgRepos(token).catch((): RepoSnapshot[] => []);
    // Stable sort: on equal stars an owned repo stays ahead of an org one.
    repos = [...repos, ...org].sort((a, b) => b.stars - a.stars);
  }

  return { ...profile, repos, feed, fetchedAt: Math.floor(Date.now() / 1000) };
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
