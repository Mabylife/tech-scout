// Entry point: fetch every enabled source -> normalize -> merge duplicates
// -> drop items already emitted in earlier runs -> write data/latest.json.
//
// A failing source never fails the run; its error is recorded in `stats`.

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setUserAgent } from './lib/http.js';
import { idForUrl, toIso } from './lib/util.js';
import * as discoveryAdapters from './lib/adapters/discovery.js';
import * as trackingAdapters from './lib/adapters/tracking.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = (...p) => join(ROOT, ...p);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file, data) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

// Snapshots live in state/snapshots/{id}.json. Loaded lazily, written at the end.
function createSnapshotStore() {
  const loaded = new Map();
  const dirty = new Set();
  return {
    async preload(ids) {
      for (const id of ids) loaded.set(id, await readJson(path('state/snapshots', `${id}.json`), null));
    },
    get: (id) => loaded.get(id) ?? null,
    set(id, value) {
      loaded.set(id, value);
      dirty.add(id);
    },
    async save() {
      for (const id of dirty) await writeJson(path('state/snapshots', `${id}.json`), loaded.get(id));
    },
  };
}

async function runSection(entries, adapters, ctx) {
  const results = await Promise.all(
    entries
      .filter((src) => src.enabled !== false)
      .map(async (src) => {
        const adapter = adapters[src.type];
        if (!adapter) return [{ key: src.id, fetched: 0, items: [], error: `unknown type "${src.type}"` }];
        try {
          return await adapter(src, ctx);
        } catch (err) {
          return [{ key: src.id, fetched: 0, items: [], error: `adapter crashed: ${err.message}` }];
        }
      }),
  );
  return results.flat();
}

function mergeDiscovery(parts) {
  const byId = new Map();
  for (const p of parts) {
    for (const item of p.items) {
      if (!item.url) continue;
      const id = idForUrl(item.url);
      const existing = byId.get(id);
      if (!existing) {
        byId.set(id, {
          id,
          title: item.title,
          url: item.url,
          sources: [item.source],
          description: item.description,
          published_at: item.published_at,
          tags: [...new Set(item.tags)],
        });
        continue;
      }
      if (!existing.sources.some((s) => s.name === item.source.name)) existing.sources.push(item.source);
      if ((item.description?.length ?? 0) > (existing.description?.length ?? 0)) existing.description = item.description;
      if (item.published_at && (!existing.published_at || item.published_at < existing.published_at)) {
        existing.published_at = item.published_at;
      }
      existing.tags = [...new Set([...existing.tags, ...item.tags])];
    }
  }
  return [...byId.values()];
}

function mergeTracking(parts) {
  const byId = new Map();
  for (const p of parts) {
    for (const item of p.items) {
      const id = idForUrl(item.url);
      if (!byId.has(id)) byId.set(id, { id, source: p.key, ...item });
    }
  }
  return [...byId.values()];
}

function buildStats(parts, newIds, itemIdsByPart) {
  const stats = {};
  for (const p of parts) {
    const ids = itemIdsByPart.get(p.key) ?? [];
    stats[p.key] = {
      fetched: p.fetched,
      kept: p.items.length,
      new: ids.filter((id) => newIds.has(id)).length,
      error: p.error ?? null,
      ...(p.note ? { note: p.note } : {}),
    };
  }
  return stats;
}

// Compact view of latest.json for a first pass: titles and signals only,
// one item per line. Full details are looked up in latest.json by `id`.
function buildIndex(output) {
  const src = (s) => (s.score != null ? `${s.name}:${s.score}` : s.name);
  const discovery = output.discovery.map((d) => ({ id: d.id, title: d.title, src: d.sources.map(src).join(' ') }));
  const tracking = output.tracking.map((t) => ({ id: t.id, project: t.project, version: t.version }));
  const errors = Object.entries(output.stats)
    .filter(([, s]) => s.error)
    .map(([k, s]) => `${k}: ${s.error}`);
  const lines = (arr) => (arr.length ? `[\n${arr.map((x) => `    ${JSON.stringify(x)}`).join(',\n')}\n  ]` : '[]');
  return (
    '{\n' +
    `  "generated_at": ${JSON.stringify(output.generated_at)},\n` +
    `  "since": ${JSON.stringify(output.since)},\n` +
    `  "errors": ${JSON.stringify(errors)},\n` +
    `  "discovery": ${lines(discovery)},\n` +
    `  "tracking": ${lines(tracking)}\n` +
    '}\n'
  );
}

async function pruneRuns(keep) {
  const dir = path('data/runs');
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) await rm(join(dir, f));
}

async function main() {
  const config = await readJson(path('sources.json'));
  setUserAgent(config.user_agent);

  const now = new Date();
  const nowIso = toIso(now);
  const meta = await readJson(path('state/meta.json'), {});
  const since =
    meta.last_success_at ?? toIso(new Date(now.getTime() - config.first_run_lookback_days * 86400_000));

  const snapshots = createSnapshotStore();
  await snapshots.preload([...config.discovery, ...config.tracking].map((s) => s.id));
  const ctx = { since, now, snapshots };

  const [dParts, tParts] = await Promise.all([
    runSection(config.discovery, discoveryAdapters, ctx),
    runSection(config.tracking, trackingAdapters, ctx),
  ]);

  // Cross-run dedup.
  const seen = await readJson(path('state/seen.json'), {});
  const discovery = mergeDiscovery(dParts).filter((i) => !seen[i.id]);
  const tracking = mergeTracking(tParts).filter((i) => !seen[i.id]);
  const newIds = new Set([...discovery, ...tracking].map((i) => i.id));

  const itemIdsByPart = new Map();
  for (const p of [...dParts, ...tParts]) {
    itemIdsByPart.set(p.key, p.items.filter((i) => i.url).map((i) => idForUrl(i.url)));
  }

  // Items found by more sources first, then newest.
  discovery.sort(
    (a, b) => b.sources.length - a.sources.length || (b.published_at ?? '').localeCompare(a.published_at ?? ''),
  );
  tracking.sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''));
  for (const t of tracking) delete t.source;

  const output = {
    generated_at: nowIso,
    since,
    stats: buildStats([...dParts, ...tParts], newIds, itemIdsByPart),
    discovery,
    tracking,
  };

  await writeJson(path('data/latest.json'), output);
  await writeFile(path('data/index.json'), buildIndex(output));
  await writeJson(path('data/runs', `${nowIso.replace(/:/g, '')}.json`), output);
  await pruneRuns(config.runs_to_keep);

  // Update state. Only advance `since` if at least one source worked,
  // so a total outage (e.g. no network) does not create a gap.
  const cutoff = toIso(new Date(now.getTime() - config.seen_retention_days * 86400_000));
  const nextSeen = Object.fromEntries(Object.entries(seen).filter(([, t]) => t >= cutoff));
  for (const id of newIds) nextSeen[id] = nowIso;
  await writeJson(path('state/seen.json'), nextSeen);
  await snapshots.save();

  const allParts = [...dParts, ...tParts];
  const failed = allParts.filter((p) => p.error);
  if (failed.length < allParts.length) await writeJson(path('state/meta.json'), { ...meta, last_success_at: nowIso });

  console.log(`since ${since}`);
  console.log(`discovery: ${discovery.length}, tracking: ${tracking.length}`);
  console.log(`sources: ${allParts.length}, failed: ${failed.length}`);
  for (const p of failed) console.log(`  ${p.key}: ${p.error}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
