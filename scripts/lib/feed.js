// Parse RSS 2.0 and Atom into one flat entry shape.
import { XMLParser } from 'fast-xml-parser';
import { getText } from './http.js';
import { toIso } from './util.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) => name === 'item' || name === 'entry' || name === 'link' || name === 'category',
});

const text = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') return String(v['#text'] ?? '');
  return String(v);
};

function atomLink(links) {
  if (!links) return '';
  const alt = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
  return alt['@_href'] ?? text(alt);
}

/** @returns {{ id, title, url, published_at, content, categories }[]} */
export function parseFeed(xml) {
  const doc = parser.parse(xml);
  if (doc.feed) {
    return (doc.feed.entry ?? []).map((e) => ({
      id: text(e.id),
      title: text(e.title),
      url: atomLink(e.link),
      published_at: toIso(text(e.published) || text(e.updated)),
      content: text(e.content) || text(e.summary),
      categories: (e.category ?? []).map((c) => c['@_term'] ?? text(c)),
    }));
  }
  if (doc.rss) {
    return (doc.rss.channel?.item ?? []).map((i) => ({
      id: text(i.guid) || text(i.link?.[0]),
      title: text(i.title),
      url: text(i.link?.[0]),
      published_at: toIso(text(i.pubDate) || text(i['dc:date'])),
      content: text(i['content:encoded']) || text(i.description),
      categories: (i.category ?? []).map(text),
    }));
  }
  throw new Error('Unrecognized feed format');
}

export async function fetchFeed(url) {
  return parseFeed(await getText(url));
}
