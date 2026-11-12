// Tracking adapters: report only what is new since the last run.
// Tracking item shape:
//   { project, kind, version, url, published_at, notes_excerpt }
//
// Snapshot-based adapters (OpenRouter, Telegram, Anthropic) create a
// baseline on first run and emit nothing, otherwise everything would be "new".

import { getJson, getText } from '../http.js';
import { fetchFeed } from '../feed.js';
import { decodeEntities, isAfter, stripHtml, truncate } from '../util.js';
import { part } from './discovery.js';

const NOTES_MAX = 1500;

export async function github_releases(src, { since }) {
  const parts = [];
  for (const repo of src.repos) {
    const key = `${src.id}_${repo.split('/')[1].toLowerCase()}`;
    parts.push(
      await part(key, async () => {
        const entries = await fetchFeed(`https://github.com/${repo}/releases.atom`);
        const items = entries
          .filter((e) => isAfter(e.published_at, since))
          .map((e) => ({
            project: repo,
            kind: 'release',
            version: e.title || e.url.split('/').pop(),
            url: e.url,
            published_at: e.published_at,
            notes_excerpt: truncate(stripHtml(e.content), NOTES_MAX),
          }));
        return { fetched: entries.length, items };
      }),
    );
  }
  return parts;
}

export async function feed(src, { since }) {
  return [
    await part(src.id, async () => {
      const entries = await fetchFeed(src.url);
      const items = entries
        .filter((e) => isAfter(e.published_at, since))
        .map((e) => ({
          project: src.project ?? src.id,
          kind: 'post',
          version: e.title,
          url: e.url,
          published_at: e.published_at,
          notes_excerpt: truncate(stripHtml(e.content), NOTES_MAX),
        }));
      return { fetched: entries.length, items };
    }),
  ];
}

// Generic "list of keys -> diff against snapshot" helper.
async function snapshotDiff(src, snapshots, current, toItem) {
  const prev = snapshots.get(src.id);
  snapshots.set(src.id, [...current.keys()].sort());
  if (!prev) return { fetched: current.size, items: [], note: 'baseline snapshot created; nothing emitted' };
  const known = new Set(prev);
  const items = [...current].filter(([k]) => !known.has(k)).map(([k, v]) => toItem(k, v));
  return { fetched: current.size, items };
}

export async function openrouter(src, { snapshots }) {
  return [
    await part(src.id, async () => {
      const { data } = await getJson('https://openrouter.ai/api/v1/models');
      const current = new Map(data.map((m) => [m.id, m]));
      return snapshotDiff(src, snapshots, current, (id, m) => ({
        project: 'OpenRouter',
        kind: 'new_model',
        version: id,
        url: `https://openrouter.ai/${id}`,
        published_at: m.created ? new Date(m.created * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
        notes_excerpt: truncate(
          [
            m.name,
            m.context_length ? `context: ${m.context_length}` : '',
            m.pricing ? `pricing (USD/token): prompt ${m.pricing.prompt}, completion ${m.pricing.completion}` : '',
            m.description,
          ]
            .filter(Boolean)
            .join('\n'),
          NOTES_MAX,
        ),
      }));
    }),
  ];
}

// No feed exists; the changelog page is a sequence of <h4> date headings.
export async function telegram_changelog(src, { snapshots }) {
  return [
    await part(src.id, async () => {
      const pageUrl = 'https://core.telegram.org/bots/api-changelog';
      const html = await getText(pageUrl);
      const re = /<h4><a class="anchor" name="([^"]+)"[^>]*>.*?<\/a>(.*?)<\/h4>/g;
      const heads = [...html.matchAll(re)];
      if (!heads.length) throw new Error('page structure changed: no <h4> anchors found');
      const current = new Map(
        heads.map((m, i) => {
          const end = heads[i + 1]?.index ?? html.indexOf('</div>', m.index);
          return [m[1], { title: stripHtml(m[2]), body: html.slice(m.index + m[0].length, end) }];
        }),
      );
      return snapshotDiff(src, snapshots, current, (anchor, v) => ({
        project: 'Telegram Bot API',
        kind: 'changelog',
        version: v.title,
        url: `${pageUrl}#${anchor}`,
        published_at: null,
        notes_excerpt: truncate(stripHtml(v.body), NOTES_MAX),
      }));
    }),
  ];
}

// No official RSS; diff the article links on /news.
export async function anthropic_news(src, { snapshots }) {
  return [
    await part(src.id, async () => {
      const html = await getText('https://www.anthropic.com/news');
      const current = new Map();
      for (const m of html.matchAll(/<a[^>]*href="\/news\/([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
        const slug = m[1];
        if (current.has(slug)) continue;
        // Card markup: first text node is the title, second the summary.
        const texts = m[2]
          .split(/<[^>]+>/)
          .map((t) => decodeEntities(t).trim())
          .filter(Boolean);
        current.set(slug, { title: texts[0] ?? slug, summary: texts[1] ?? '' });
      }
      if (current.size < 5) throw new Error(`page structure changed: only ${current.size} /news links found`);
      return snapshotDiff(src, snapshots, current, (slug, v) => ({
        project: 'Anthropic news',
        kind: 'post',
        version: v.title,
        url: `https://www.anthropic.com/news/${slug}`,
        published_at: null,
        notes_excerpt: truncate(v.summary, NOTES_MAX),
      }));
    }),
  ];
}
