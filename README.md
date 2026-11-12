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

## Sources

### Discovery

| id | Endpoint | Filter |
| --- | --- | --- |
| `hn_show` | HN Algolia, `tags=show_hn` | points ≥ 30 |
| `hn_top` | HN Algolia, `tags=story` | points ≥ 100 |
| `lobsters_*` | `lobste.rs/{hottest,newest,t/…}.json` | score ≥ 5 |
| `github_*` | GitHub Search, one query per topic | stars ≥ 20, created within 30 days, top 30 |
| `reddit_*` | `oauth.reddit.com/r/{sub}/top?t=week` (falls back to `top.rss` without credentials) | top 15, stickied posts removed |
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
- **Reddit** without OAuth returns HTTP 429 for most subreddits from GitHub
  Actions IPs. See [Reddit credentials](#reddit-credentials).
- Releases include pre-releases (e.g. `-rc` tags).

## Workflow

`.github/workflows/fetch.yml` runs on manual dispatch (`gh workflow run fetch`).
The schedule is commented out until the pipeline is verified. It commits
`data/` and `state/` as `github-actions[bot]` only when something changed.

## Reddit credentials

Reddit is read through application-only OAuth (`client_credentials`), which
needs no Reddit password.

1. Create an app at <https://www.reddit.com/prefs/apps>, type **script**
   (redirect URI is required but unused, e.g. `http://localhost`).
2. Add two repository secrets:
   ```sh
   gh secret set REDDIT_CLIENT_ID      # the id under the app name
   gh secret set REDDIT_CLIENT_SECRET  # "secret"
   ```

Without the secrets the adapter falls back to RSS.
