import { createHash } from 'node:crypto';

const TRACKING_PARAMS = /^(utm_.*|fbclid|gclid|ref|ref_src|source|si)$/i;

// Normalize a URL so the same page from different sources hashes the same.
export function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  let path = u.pathname.replace(/\/+$/, '');
  // GitHub owner/repo names are case-insensitive.
  if (u.hostname === 'github.com') path = path.toLowerCase();
  return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}${path}${u.search}`;
}

export function sha1(s) {
  return createHash('sha1').update(s).digest('hex');
}

export function idForUrl(url) {
  return sha1(normalizeUrl(url));
}

export function toIso(value) {
  if (value == null || value === '') return null;
  const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isNaN(code) ? m : String.fromCodePoint(code);
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function stripHtml(html) {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>|<\/(p|li|h\d|div)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export function truncate(s, max) {
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export function isAfter(iso, sinceIso) {
  return !iso || iso >= sinceIso;
}
