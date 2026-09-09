# Validated API behaviour

Everything below was measured against the live GitHub API on 2026-09-08 using
`gh api`, not assumed. Two findings changed the design.

## 1. GraphQL profile+repos query — works, costs 1 point

One query returns profile, followers, contribution total, and per-repo stars /
forks / open PRs / open issues / pushedAt / last commit. `rateLimit.cost` = **1**
against a 5000/hr budget. `isFork:false` correctly drops the `workerd` fork.

Live values:

| repo | stars | forks | open PRs | open issues |
|---|---|---|---|---|
| atomic-rollback | 9 | 1 | 0 | 6 |
| chainsaw | 4 | 0 | 2 | 44 |
| cargo-avail | 3 | 0 | 1 | 2 |
| piano | 3 | 0 | 1 | 31 |

Profile: Harnoor Lal, 3 followers, **4548 contributions** this year.

**Design note:** stars are small (19 total) but issues (44, 31) and contributions
(4548) are not. The hero number on the summary dial should be *contributions*,
not stars — it is the number that actually reflects how active he is.

**Gotcha:** `pushedAt` != last commit on the default branch. `chainsaw` reports
`pushedAt` 2026-05-16 but its newest default-branch commit is 2026-04-25 —
`pushedAt` counts pushes to any branch. Display `committedDate` instead.

## 2. `/stats/commit_activity` returns 202 on a cold cache — confirmed

First call: `HTTP/2.0 202 Accepted` with an empty body while GitHub computes the
stats. Second call ~3s later: `200` with 52 weeks of data. The Worker must treat
202 as "not ready", not as an error, and retry on the next cron tick.

**Design change — 30-day sparkline will not work.** For `atomic-rollback`, only
**5 of 52 weeks are non-zero** and the **last 8 weeks are all zero** (his last
push was April 2026). A 30-day window renders flat for every repo.

Use the **full 52-week series** instead, drawn as 52 radial bars — one per week,
~6.9 degrees each, exactly one full revolution of the round display. That maps
the data to the hardware better than a 30-day window *and* it is the only window
where his activity is visible at all. Peak week was 57 commits, so bars need a
per-repo normalised scale.

## 3. The public events feed is nearly empty — the activity ticker needs rethinking

`/users/PlasticRocket/events/public` returned only **2 events**, both
`PullRequestEvent` against `Homebrew/homebrew-cask` — not his own repos. The feed
only covers ~90 days and he has not been publicly active on his own projects
recently.

So a ticker driven purely off this feed would usually be blank. Two fixes, both
worth doing:

1. **Keep the feed but do not filter to his own repos.** "opened a PR on
   Homebrew/homebrew-cask" is genuinely interesting and is what is actually there.
2. **Synthesise events in the Worker.** The cron already snapshots every repo
   every 5 minutes, so it can diff consecutive snapshots and emit its own events
   — `+1 star on chainsaw`, `issue closed on piano`. This is strictly better than
   the GitHub feed for the ambient use case: it is what the LED pulse should fire
   on, it never goes stale, and it works even when he is quiet on GitHub.

The synthesised-event store is the reason the KV schema keeps a `prev` snapshot
alongside the current one.

## 4. Rate-limit budget

Per 5-minute refresh: 1 GraphQL + 1 events + N `commit_activity` (N = repo count,
currently 4). ~72 requests/hour against 5000. Non-issue.

## 5. End-to-end Worker verification (local, real data)

Measured against `wrangler dev` with the live GitHub API:

- `POST /api/device/:id/register` -> 200, trust-on-first-use accepted
- poll with no key -> **401**; poll with a wrong key -> **401**
- poll with the right key -> **200, 1398 bytes** including all four 52-week
  sparklines. Budget was 4KB, so there is ample headroom.
- repeat poll with `If-None-Match` -> **304, 0 bytes downloaded**

The 202 retry behaviour reproduced exactly as predicted: the first refresh
returned `w: []` for every repo, the second returned all 52 weeks.

Weekly commit peaks: piano 228, chainsaw 177, atomic-rollback 57, cargo-avail 18
— across only 3-8 non-zero weeks each. Bars must be normalised per repo, and the
52-week window is the only one where anything is visible.

## 6. TLS root CA — the plan's assumption was wrong

The plan assumed a Let's Encrypt / ISRG Root X1 chain. Measured:

```
$ echo | openssl s_client -connect workers.dev:443 -servername workers.dev
depth=2 C = US, O = Google Trust Services LLC, CN = GTS Root R4
depth=1 C = US, O = Google Trust Services,     CN = WE1
depth=0 CN = workers.dev
```

Cloudflare's `workers.dev` chains to **GTS Root R4** via Google Trust Services
`WE1`. Embedding ISRG Root X1 would have failed every handshake in the field
with no useful error. `firmware/include/certs.h` embeds GTS Root R4 plus GTS
Root R1 (as a hedge against rotation within Google's roots) and documents the
re-check command.

This is also why `api::syncClock()` runs before the first request: certificate
validity is checked against the system clock, and a device that thinks it is
1970 fails the handshake regardless of which root is embedded.
