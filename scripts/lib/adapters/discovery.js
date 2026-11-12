// Discovery adapters. Each returns an array of "parts":
//   { key, fetched, items, error?, note? }
// One config entry may produce several parts (e.g. one per subreddit) so
// that stats show exactly which endpoint failed.
//
// Discovery item shape (before cross-source merging):
//   { title, url, description, published_at, tags, source: { name, score, comments, discussion_url } }

import { getJson, getText, sleep } from '../http.js';
import { fetchFeed, parseFeed } from '../feed.js';
import { isAfter, stripHtml, toIso, truncate } from '../util.js';

const DESC_MAX = 500;

export async function part(key, fn) {
  try {
    return { key, ...(await fn()) };
  } catch (err) {
    // Node's fetch reports network failures as "fetch failed"; the cause has the real reason.
    const cause = err.cause?.code ?? err.cause?.message;
    return { key, fetched: 0, items: [], error: cause ? `${err.message} (${cause})` : err.message };
  }
}

export async function hn(src, { since }) {
  const sinceSec = Math.floor(new Date(since).getTime() / 1000);
  return [
    await part(src.id, async () => {
      const url =
        `https://hn.algolia.com/api/v1/search_by_date?tags=${src.tags}` +
        `&numericFilters=created_at_i>${sinceSec},points>=${src.min_points}&hitsPerPage=1000`;
      const { hits } = await getJson(url);
      const items = hits.map((h) => {
        const discussion = `https://news.ycombinator.com/item?id=${h.objectID}`;
        return {
          title: h.title,
          url: h.url || discussion,
          description: truncate(stripHtml(h.story_text), DESC_MAX),
          published_at: toIso(h.created_at),
          tags: [],
          source: { name: src.id, score: h.points, comments: h.num_comments, discussion_url: discussion },
        };
      });
      // The points filter is applied server-side, so fetched == kept here.
      return { fetched: hits.length, items };
    }),
  ];
}

export async function lobsters(src) {
  const parts = [];
  for (const list of src.lists) {
    const key = `${src.id}_${list.replace(/^t\//, '')}`;
    parts.push(
      await part(key, async () => {
        const stories = await getJson(`https://lobste.rs/${list}.json`);
        const items = stories
          .filter((s) => s.score >= src.min_score)
          .map((s) => ({
            title: s.title,
            url: s.url || s.comments_url,
            description: truncate(stripHtml(s.description), DESC_MAX),
            published_at: toIso(s.created_at),
            tags: s.tags.map((t) => `lobsters:${t}`),
            source: { name: key, score: s.score, comments: s.comment_count, discussion_url: s.comments_url },
          }));
        return { fetched: stories.length, items };
      }),
    );
  }
  return parts;
}

export async function github_search(src, { now }) {
  const token = process.env.GITHUB_TOKEN;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const createdAfter = new Date(now.getTime() - src.max_age_days * 86400_000).toISOString().slice(0, 10);

  const parts = [];
  for (const [i, topic] of src.topics.entries()) {
    // Search API allows 10 req/min unauthenticated, 30/min with a token.
    if (i > 0) await sleep(token ? 2500 : 7000);
    const key = `${src.id}_${topic}`;
    parts.push(
      await part(key, async () => {
        const q = `topic:${topic} created:>${createdAfter} stars:>=${src.min_stars}`;
        const url =
          `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}` +
          `&sort=stars&order=desc&per_page=${src.per_topic}`;
        const { items: repos } = await getJson(url, { headers });
        const items = repos.map((r) => ({
          title: r.full_name,
          url: r.html_url,
          description: truncate(r.description ?? '', DESC_MAX),
          published_at: toIso(r.created_at),
          tags: [`github-topic:${topic}`, ...(r.language ? [`lang:${r.language}`] : [])],
          source: { name: key, score: r.stargazers_count, comments: null, discussion_url: null },
        }));
        return { fetched: repos.length, items };
      }),
    );
  }
  return parts;
}

// Reddit RSS entries link to the comments page; link posts carry the
// external URL in a "[link]" anchor inside the content.
function redditExternalUrl(html) {
  const m = /<a href="([^"]+)">\[link\]<\/a>/.exec(html ?? '');
  if (!m) return null;
  const url = m[1].replace(/&amp;/g, '&');
  return /^https?:\/\/(www\.|old\.)?reddit\.com\//.test(url) ? null : url;
}

export async function reddit(src) {
  const parts = [];
  for (const [i, sub] of src.subs.entries()) {
    // Reddit rate-limits bursts of unauthenticated requests (HTTP 429).
    if (i > 0) await sleep(src.delay_ms ?? 3000);
    const key = `${src.id}_${sub}`;
    parts.push(
      await part(key, async () => {
        const entries = parseFeed(await getText(`https://www.reddit.com/r/${sub}/top.rss?t=week&limit=${src.top_n}`));
        const items = entries.slice(0, src.top_n).map((e) => {
          const external = redditExternalUrl(e.content);
          return {
            title: e.title,
            url: external ?? e.url,
            description: truncate(stripHtml(e.content).replace(/submitted by .*$/s, '').trim(), DESC_MAX),
            published_at: e.published_at,
            tags: [`reddit:${sub}`],
            // RSS exposes neither score nor comment count; order is the signal.
            source: { name: key, score: null, comments: null, discussion_url: e.url },
          };
        });
        return { fetched: entries.length, items };
      }),
    );
  }
  return parts;
}

// Generic RSS/Atom discovery feed. Optional `keywords` narrows noisy feeds.
export async function feed(src, { since }) {
  return [
    await part(src.id, async () => {
      const entries = await fetchFeed(src.url);
      const kw = (src.keywords ?? []).map((k) => k.toLowerCase());
      const items = entries
        .filter((e) => isAfter(e.published_at, since))
        .filter((e) => !kw.length || kw.some((k) => `${e.title} ${e.content}`.toLowerCase().includes(k)))
        .map((e) => ({
          title: e.title,
          url: e.url,
          description: truncate(stripHtml(e.content), DESC_MAX),
          published_at: e.published_at,
          tags: e.categories.slice(0, 5).map((c) => `category:${c}`),
          source: { name: src.id, score: null, comments: null, discussion_url: null },
        }));
      return { fetched: entries.length, items };
    }),
  ];
}

// Official MCP registry. ~30k servers and a lot of churn, so we only look at
// servers updated since the last run whose name we have never seen.
export async function mcp_registry(src, { since, snapshots }) {
  return [
    await part(src.id, async () => {
      const known = new Set(snapshots.get(src.id) ?? []);
      const baseline = known.size === 0;
      const fresh = new Map();
      let cursor;
      let fetched = 0;
      let pages = 0;
      do {
        const u = new URL('https://registry.modelcontextprotocol.io/v0/servers');
        u.searchParams.set('updated_since', since);
        u.searchParams.set('version', 'latest');
        u.searchParams.set('limit', '100');
        if (cursor) u.searchParams.set('cursor', cursor);
        const j = await getJson(u.toString());
        for (const { server } of j.servers) {
          fetched++;
          if (!known.has(server.name)) fresh.set(server.name, server);
        }
        cursor = j.metadata?.nextCursor;
      } while (cursor && ++pages < 50);

      snapshots.set(src.id, [...known, ...fresh.keys()].sort());
      if (baseline) return { fetched, items: [], note: 'baseline snapshot created; nothing emitted' };

      const items = [...fresh.values()].slice(0, src.max_items).map((s) => ({
        title: s.title || s.name,
        url: s.repository?.url || s.websiteUrl || `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(s.name)}`,
        description: truncate(s.description ?? '', DESC_MAX),
        published_at: null,
        tags: ['mcp-server'],
        source: { name: src.id, score: null, comments: null, discussion_url: null },
      }));
      return { fetched, items };
    }),
  ];
}
