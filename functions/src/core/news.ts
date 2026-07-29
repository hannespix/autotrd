/**
 * News-Feeds — zurück seit 29.07., aber mit umgekehrter Rolle: Die Feeds
 * speisen das Einstiegs-VETO und den Sentiment-Schatten (shared/newsGate.ts),
 * keine Anzeige-Maschinerie und keinen Prognose-Tilt.
 *
 * Gegenüber der ersten Fassung (bis d84a855) bewusst getrimmt:
 * - nur Yahoo-Finance-RSS + Google-News-RSS — die Reddit-Feeds sind für ein
 *   Hard-Event-Veto Rauschen und kosteten 4 weitere Abrufe je Symbol;
 * - harte 8-s-Timeouts je Feed — der Aufrufer ist der 5-min-Scan, und ein
 *   hängender Feed darf dessen 180-s-Budget nicht anfressen;
 * - Ausgabe ist der kompakte NewsSnapshot fürs market-Doc, nicht eine
 *   Item-Collection.
 *
 * Kostenbilanz unverändert: Gratis-Quellen ohne Key, Lexikon statt LLM —
 * es fließt kein einziger KI-Token.
 */

import { buildNewsSnapshot, resolveName, scoreText, type NewsSnapshot, type ScoredNewsItem } from '../../../shared/src/index.js';

const FETCH_TIMEOUT_MS = 8000;

/** Sehr kleiner RSS-Item-Parser (title/link/pubDate/description). */
export function parseRssItems(xml: string): Array<{
  title: string;
  link: string;
  pubDate: string;
  description: string;
}> {
  const items: Array<{ title: string; link: string; pubDate: string; description: string }> = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];
  const field = (block: string, tag: string): string => {
    const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    if (!m) return '';
    return m[1]!
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .trim();
  };
  for (const b of blocks) {
    items.push({
      title: field(b, 'title'),
      link: field(b, 'link'),
      pubDate: field(b, 'pubDate'),
      description: field(b, 'description'),
    });
  }
  return items;
}

function toEpoch(pubDate: string): number {
  const t = Date.parse(pubDate);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

async function fetchFeed(url: string, source: string, max: number): Promise<ScoredNewsItem[]> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'autotrd/1.0 (news-gate)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRssItems(xml)
      .filter((i) => i.title)
      .slice(0, max)
      .map((i) => {
        const published = toEpoch(i.pubDate);
        const summary = i.description.slice(0, 400);
        return {
          title: i.title,
          source,
          url: i.link,
          ts: published ? new Date(published * 1000).toISOString() : '',
          published,
          sent: scoreText(`${i.title} . ${summary}`),
          // Hard-Events zählen nur aus der Schlagzeile (siehe ScoredNewsItem)
          titleEvents: scoreText(i.title).eventTypes,
        };
      });
  } catch {
    return []; // Feed-Ausfall = keine Items; das Veto fails open (newsGate)
  }
}

function dedupe(items: ScoredNewsItem[]): ScoredNewsItem[] {
  const seen = new Set<string>();
  const out: ScoredNewsItem[] = [];
  for (const it of items) {
    const key = it.title.trim().toLowerCase().slice(0, 80);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

/** Beide Feeds eines Symbols abrufen, scoren, deduplizieren. */
export async function fetchScoredNews(symbol: string): Promise<ScoredNewsItem[]> {
  const hint = resolveName(symbol);
  const q = hint !== symbol ? hint : symbol;
  const enc = encodeURIComponent;
  const feeds = await Promise.all([
    fetchFeed(
      `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${enc(symbol)}&region=US&lang=en-US`,
      'Yahoo RSS',
      20,
    ),
    fetchFeed(
      `https://news.google.com/rss/search?q=${enc(q + ' stock')}&hl=en-US&gl=US&ceid=US:en`,
      'Google News',
      20,
    ),
  ]);
  return dedupe(feeds.flat());
}

/** Abruf + Aggregation zur gespeicherten News-Lage (market/{sym}.news). */
export async function fetchNewsSnapshot(symbol: string, nowSec: number): Promise<NewsSnapshot> {
  return buildNewsSnapshot(await fetchScoredNews(symbol), nowSec);
}
