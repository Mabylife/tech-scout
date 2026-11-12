// Fetch Reddit from a home connection and write inbox/reddit.json.
//
// GitHub Actions IPs are rate-limited by Reddit (HTTP 429 on most subreddits),
// so this runs on an always-on home machine (scheduled on ROG Windows via
// scripts/rog/run-reddit.ps1) shortly before the Actions run. fetch.js then
// reads the file when the reddit source has `via: "inbox"`.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setUserAgent } from './lib/http.js';
import { REDDIT_INBOX, redditDirect } from './lib/adapters/discovery.js';
import { toIso } from './lib/util.js';

const config = JSON.parse(await readFile(new URL('../sources.json', import.meta.url), 'utf8'));
setUserAgent(config.user_agent);

const src = config.discovery.find((s) => s.type === 'reddit');
if (!src) {
  console.error('No reddit source in sources.json');
  process.exit(1);
}

const parts = await redditDirect(src);
const out = { fetched_at: toIso(new Date()), parts };

const file = fileURLToPath(REDDIT_INBOX);
await mkdir(dirname(file), { recursive: true });
await writeFile(file, `${JSON.stringify(out, null, 2)}\n`);

const failed = parts.filter((p) => p.error);
console.log(`reddit: ${parts.length - failed.length}/${parts.length} subreddits ok, ${parts.reduce((n, p) => n + p.items.length, 0)} items`);
for (const p of failed) console.log(`  ${p.key}: ${p.error}`);
// Non-zero exit only when everything failed, so the scheduler log flags it.
process.exit(failed.length === parts.length ? 1 : 0);
