/**
 * News-Feeds — Port von reference/scripts/news_feed.py.
 * Gratis-Quellen ohne Key: Yahoo-Finance-RSS + Google-News-RSS (Ticker)
 * sowie Reddit-Trading-Subs über den Google-News-Proxy. Dependency-freier
 * Mini-RSS-Parser (die Feeds sind wohlgeformt; kein feedparser nötig).
 * Cache-Disziplin: Aufrufer ist der 5-min-Scan — schneller fragt niemand.
 */

import { resolveName, scoreText, type SentimentScore } from '../../../shared/src/index.js';

export interface NewsItem {
  title: string;
  source: string;
  url: string;
  ts: string; // ISO oder ''
  published: number; // Epoch-Sekunden oder 0
  summary: string;
  kind: 'news' | 'social' | 'sentiment';
  sent: SentimentScore;
}

const TRADING_SUBS = ['Daytrading', 'StockMarket', 'Trading'];

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

async function fetchFeed(url: string, source: string, kind: NewsItem['kind'], max: number): Promise<NewsItem[]> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'autotrd/1.0 (dashboard)' } });
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
          summary,
          kind,
          sent: scoreText(`${i.title} . ${summary}`),
        };
      });
  } catch {
    return [];
  }
}

function dedupe(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const it of items) {
    const key = it.title.trim().toLowerCase().slice(0, 80);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

/** Ticker-News + Social, dedupliziert, neueste zuerst, fertig ge-scored. */
export async function fetchNews(symbol: string, limit = 30): Promise<NewsItem[]> {
  const hint = resolveName(symbol);
  const q = hint !== symbol ? hint : symbol;
  const enc = encodeURIComponent;

  const feeds: Array<Promise<NewsItem[]>> = [
    fetchFeed(
      `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${enc(symbol)}&region=US&lang=en-US`,
      'Yahoo RSS',
      'news',
      20,
    ),
    fetchFeed(
      `https://news.google.com/rss/search?q=${enc(q + ' stock')}&hl=en-US&gl=US&ceid=US:en`,
      'Google News',
      'news',
      20,
    ),
    ...TRADING_SUBS.map((sub) =>
      fetchFeed(
        `https://news.google.com/rss/search?q=${enc(`site:reddit.com/r/${sub} ${symbol.toUpperCase()}`)}&hl=en-US&gl=US&ceid=US:en`,
        `r/${sub}`,
        'social',
        6,
      ),
    ),
    fetchFeed(
      `https://news.google.com/rss/search?q=${enc(`site:reddit.com/r/wallstreetbets ${symbol.toUpperCase()}`)}&hl=en-US&gl=US&ceid=US:en`,
      'r/wallstreetbets',
      'sentiment',
      6,
    ),
  ];

  const all = (await Promise.all(feeds)).flat();
  return dedupe(all)
    .sort((a, b) => b.published - a.published)
    .slice(0, limit);
}

/** Stabile Doc-ID je News-Item (Titel-Hash) — idempotente Writes. */
export function newsDocId(item: NewsItem): string {
  const key = item.title.trim().toLowerCase().slice(0, 80);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  const day = item.ts ? item.ts.slice(0, 10) : 'undated';
  return `${day}_${(h >>> 0).toString(36)}`;
}
