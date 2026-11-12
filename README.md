# tech-scout

Fetches tech news, new projects and release notes from public sources, applies
cheap rule-based filtering, and commits the result to `data/latest.json`.

A separate scheduled Claude task reads that file (via `raw.githubusercontent.com`)
and decides what is actually worth recommending. This repo contains **no AI**:
it only gathers and trims.

```
GitHub Actions (this repo)               Scheduled Claude task
fetch -> merge -> dedup -> filter  --->  read data/latest.json, judge relevance,
commit data/latest.json                  write recommendations
```

Why the split: the Claude cloud workspace can only reach GitHub, so fetching
has to happen somewhere else. Doing it here without an LLM keeps it free and
easy to debug.

## Run locally

```sh
npm ci
node scripts/fetch.js
```

Set `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` to use the Reddit API (see below).
Set `GITHUB_TOKEN` to raise the GitHub Search rate limit (otherwise the script
waits 7 s between topic queries).

## Layout

| Path | Purpose |
| --- | --- |
| `sources.json` | Source list and filter thresholds. Edit this to tune. |
| `scripts/fetch.js` | Entry point. |
| `scripts/lib/adapters/discovery.js` | Discovery sources (HN, lobste.rs, GitHub, Reddit, feeds, MCP registry). |
| `scripts/lib/adapters/tracking.js` | Tracking sources (releases, news feeds, snapshot diffs). |
| `scripts/lib/{http,feed,util}.js` | Fetch wrapper, RSS/Atom parser, URL normalization. |
| `state/meta.json` | `last_success_at`, used as `since` for the next run. |
| `state/seen.json` | IDs already emitted, with first-seen time. Pruned after `seen_retention_days`. |
| `state/snapshots/` | Previous lists for snapshot-diff sources. |
| `data/latest.json` | Output of the latest run. |
| `data/index.json` | Compact view of `latest.json` (id, title, sources with scores), one item per line. Read this first, then look up details by `id`. |
| `data/runs/` | Output archive, last `runs_to_keep` runs. |

## How it works

1. **Window.** `since` is the time of the last successful run (first run: 7 days back).
   A run counts as successful if at least one source worked.
2. **Fetch.** Each entry in `sources.json` maps to an adapter by `type`. Sources
   with several endpoints (one per subreddit, topic, repo…) report stats per endpoint.
   A failing endpoint is recorded in `stats` and never fails the run.
3. **Filter.** Per-source thresholds (`min_points`, `min_score`, `min_stars`,
   `top_n`, optional `keywords`). Deliberately loose: the Claude task does the real filtering.
4. **Merge.** Items are keyed by SHA-1 of the normalized URL (lowercased host,
   no `www.`, no tracking params, no trailing slash). The same URL from several
   sources becomes one item listing all sources; multi-source items sort first.
5. **Dedup across runs.** Anything already in `state/seen.json` is dropped.

Snapshot-diff sources (OpenRouter, Telegram changelog, Anthropic news, MCP
registry) create a baseline on the first run and emit nothing; later runs emit
only new entries.

## Output format

```jsonc
{
  "generated_at": "2026-11-16T12:03:11Z",
  "since": "2026-11-12T12:00:00Z",
  "stats": {
    // fetched = raw count, kept = after thresholds, new = not emitted before
    "hn_show": { "fetched": 27, "kept": 27, "new": 27, "error": null },
    "openrouter_models": { "fetched": 468, "kept": 0, "new": 0, "error": null, "note": "baseline snapshot created; nothing emitted" }
  },
  "discovery": [
    {
      "id": "<sha1 of normalized url>",
      "title": "...",
      "url": "...",
      "sources": [{ "name": "hn_show", "score": 142, "comments": 37, "discussion_url": "..." }],
      "description": "...",
      "published_at": "...",
      "tags": ["github-topic:wayland"]
    }
  ],
  "tracking": [
    {
      "id": "...",
      "project": "hyprwm/Hyprland",
      "kind": "release",          // release | post | changelog | new_model
      "version": "v0.58.0",
      "url": "...",
      "published_at": "...",      // null for snapshot-diff sources
      "notes_excerpt": "first 1500 chars"
    }
  ]
}
```

All times are ISO 8601 UTC.

`data/index.json` holds the same items with only `id`, `title` and `src`
(e.g. `"hn_top:264 lobsters_hottest:30"`) for discovery, `id`, `project` and
`version` for tracking, plus a list of source errors. It is about a quarter of
the size of `latest.json`, so a reader can scan everything cheaply and fetch
details only for the items it cares about:

```sh
jq '.discovery[] | select(.id == "<id>")' data/latest.json
```

## Sources

### Discovery

| id | Endpoint | Filter |
| --- | --- | --- |
| `hn_show` | HN Algolia, `tags=show_hn` | points ≥ 30 |
| `hn_top` | HN Algolia, `tags=story` | points ≥ 100 |
| `lobsters_*` | `lobste.rs/{hottest,newest,t/…}.json` | score ≥ 5 |
| `github_*` | GitHub Search, one query per topic | stars ≥ 20, created within 30 days, top 30 |
| `reddit_*` | Read from `inbox/reddit.json` (see [Reddit](#reddit)) | top 15 per subreddit |
| `aur_new` | `aur.archlinux.org/rss/` | none (feed holds only the latest 100) |
| `simonw` | `simonwillison.net/atom/everything/` | none |
| `mcp_registry` | `registry.modelcontextprotocol.io/v0/servers` | **disabled**, see below |

### Tracking

| id | Endpoint | Method |
| --- | --- | --- |
| `releases_*` | `github.com/{repo}/releases.atom` | published since last run |
| `arch_news`, `vue_blog`, `figma_releases` | RSS / Atom | published since last run |
| `openrouter_models` | `openrouter.ai/api/v1/models` | snapshot diff of model ids |
| `telegram_bot_api` | `core.telegram.org/bots/api-changelog` (HTML) | snapshot diff of date headings |
| `anthropic_news` | `anthropic.com/news` (HTML) | snapshot diff of article links |

### Known limitations

- **MCP registry** is disabled: it holds ~30k servers and over 100 change every
  week, mostly low-signal. Popular MCP servers already show up through the
  `mcp-server` GitHub topic. If enabled, its "new" detection is approximate
  (servers first seen after the baseline).
- **Telegram** and **Anthropic** are HTML scrapes and will break if the page
  markup changes; the adapter then reports a `page structure changed` error.
- **Reddit** is fetched from a home machine, not from Actions. If that machine
  misses a run, `stats.reddit` reports `inbox not updated`.
- Releases include pre-releases (e.g. `-rc` tags).

## Workflow

`.github/workflows/fetch.yml` runs Mon/Thu 06:00 Asia/Taipei (`0 22 * * 0,3` UTC)
and on manual dispatch (`gh workflow run fetch`). It commits
`data/` and `state/` as `github-actions[bot]` only when something changed.

## Reddit

GitHub Actions IPs get HTTP 429 from Reddit on most subreddits, and Reddit
declined API access for this project. So the `reddit` source has
`"via": "inbox"`: Actions only reads `inbox/reddit.json`, and an always-on
home machine writes it.

```
home machine, Mon/Thu 05:30 Asia/Taipei
  git pull -> node scripts/fetch-reddit.js -> commit inbox/reddit.json -> push
GitHub Actions, 06:00
  fetch.js reads inbox/reddit.json if it is newer than the previous run
```

`scripts/fetch-reddit.js` uses the public `top.rss` feeds with 3 s between
subreddits. If `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` are set it uses
application-only OAuth instead.

### Windows setup (once)

Requires PowerShell 7, Node 24 and git.

```powershell
git clone https://github.com/Mabylife/tech-scout.git D:\GitHub\tech-scout
cd D:\GitHub\tech-scout
npm ci
pwsh -File scripts/rog/setup-task.ps1
Start-ScheduledTask -TaskName 'tech-scout reddit'
```

`setup-task.ps1` asks for a fine-grained token limited to this repository
(Contents: read and write) and stores it under a separate git username, then
registers the scheduled task with "wake to run". The log is
`inbox/rog-run.log`. Wake timers must be allowed in the Windows power plan.
