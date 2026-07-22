"""
news_feed — unified news + social fetching for a ticker.

Sources (all free, no API key):
  * yfinance Ticker.news        (Yahoo-curated, recent)
  * Yahoo Finance RSS headlines
  * Google News RSS search
  * Reddit trading subs         (r/FuturesTrading, r/Trading, r/Daytrading,
                                 r/StockMarket, r/SecurityAnalysis) as primary social signal
  * Reddit macro subs           (r/economics, r/Econ-talk) for macro context
  * Reddit sentiment sub        (r/wallstreetbets) tagged separately as 'sentiment'

Every item is normalised to:
    {title, source, url, ts (ISO), published (epoch), summary,
     kind: 'news' | 'social' | 'sentiment', score?}

Results are cached in-process with a short TTL so the dashboard endpoints and the
event engine can call freely without hammering the sources.
"""
from __future__ import annotations

import time
import urllib.parse
from datetime import datetime, timezone

import feedparser  # type: ignore
import requests

_UA = "hermes-daytrading/1.0 (personal dashboard)"
_CACHE: dict[str, tuple[float, list]] = {}
_TTL = 600  # seconds

# Company-name hints improve RSS/Reddit relevance for well-known tickers.
_NAME_HINTS = {
    "SPY": "S&P 500", "QQQ": "Nasdaq 100", "AAPL": "Apple", "MSFT": "Microsoft",
    "NVDA": "Nvidia", "TSLA": "Tesla", "AMZN": "Amazon", "META": "Meta",
    "GOOGL": "Google", "BTC-USD": "Bitcoin", "ETH-USD": "Ethereum",
}


def _now_epoch() -> float:
    return time.time()


def _iso(epoch: float | None) -> str:
    if not epoch:
        return ""
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat()


def _dedupe(items: list[dict]) -> list[dict]:
    seen, out = set(), []
    for it in items:
        key = (it.get("title") or "").strip().lower()[:80]
        if key and key not in seen:
            seen.add(key)
            out.append(it)
    return out


# ── Sources ────────────────────────────────────────────────────────────────

def fetch_yf_news(symbol: str) -> list[dict]:
    try:
        import yfinance as yf
        raw = yf.Ticker(symbol).news or []
    except Exception:
        return []
    out = []
    for entry in raw:
        c = entry.get("content", entry) if isinstance(entry, dict) else {}
        title = c.get("title")
        if not title:
            continue
        pub = c.get("pubDate") or c.get("displayTime")
        epoch = None
        if pub:
            try:
                epoch = datetime.fromisoformat(pub.replace("Z", "+00:00")).timestamp()
            except Exception:
                epoch = None
        url = ""
        for k in ("canonicalUrl", "clickThroughUrl"):
            v = c.get(k)
            if isinstance(v, dict) and v.get("url"):
                url = v["url"]; break
        prov = c.get("provider") or {}
        out.append({
            "title": title.strip(),
            "source": (prov.get("displayName") if isinstance(prov, dict) else None) or "Yahoo Finance",
            "url": url,
            "ts": _iso(epoch), "published": epoch,
            "summary": (c.get("summary") or c.get("description") or "")[:400],
            "kind": "news",
        })
    return out


def fetch_rss(symbol: str) -> list[dict]:
    q = _NAME_HINTS.get(symbol.upper(), symbol)
    feeds = [
        (f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={urllib.parse.quote(symbol)}&region=US&lang=en-US", "Yahoo RSS"),
        (f"https://news.google.com/rss/search?q={urllib.parse.quote(q + ' stock')}&hl=en-US&gl=US&ceid=US:en", "Google News"),
    ]
    out = []
    for url, src in feeds:
        try:
            parsed = feedparser.parse(url)
            for e in parsed.entries[:20]:
                epoch = None
                if getattr(e, "published_parsed", None):
                    epoch = time.mktime(e.published_parsed)
                out.append({
                    "title": (e.get("title") or "").strip(),
                    "source": src,
                    "url": e.get("link", ""),
                    "ts": _iso(epoch), "published": epoch,
                    "summary": (e.get("summary") or "")[:400],
                    "kind": "news",
                })
        except Exception:
            continue
    return [o for o in out if o["title"]]


# ── Reddit configs ────────────────────────────────────────────────────────

TRADING_SUBS = "FuturesTrading+Trading+Daytrading+StockMarket+SecurityAnalysis"
"""Serious trading subreddits — primary news signal."""

MACRO_SUBS = "economics+Econ-talk"
"""Macro / economics subreddits — general market context (ticker-agnostic)."""

SENTIMENT_SUBS = "wallstreetbets"
"""Retail sentiment indicator — tag as 'sentiment', not 'social'."""


def _extract_subreddit(url: str) -> str:
    """Extract subreddit name from a reddit URL like /r/StockMarket/comments/..."""
    try:
        path = url.split("reddit.com")[1] if "reddit.com" in url else url
        parts = [p for p in path.split("/") if p]
        if parts and parts[0] == "r" and len(parts) > 1:
            return f"r/{parts[1]}"
    except Exception:
        pass
    return "reddit"


def fetch_reddit(symbol: str) -> list[dict]:
    """Fetch trading-relevant Reddit posts via Google News RSS proxy.

    Uses 'site:reddit.com/r/<sub> <ticker>' queries per subreddit to get current
    content without hitting Reddit's rate limit / paywall.
    """
    q = _NAME_HINTS.get(symbol.upper(), symbol)
    tick = symbol.strip().upper()
    subs = TRADING_SUBS.split("+")
    out = []
    for sub in subs:
        try:
            query = f"site:reddit.com/r/{sub} {tick}"
            url = (f"https://news.google.com/rss/search?q={urllib.parse.quote(query)}"
                   f"&hl=en-US&gl=US&ceid=US:en")
            parsed = feedparser.parse(url)
            for e in parsed.entries[:8]:
                title = (e.get("title") or "").strip()
                if not title:
                    continue
                epoch = None
                if getattr(e, "published_parsed", None):
                    epoch = time.mktime(e.published_parsed)
                out.append({
                    "title": title,
                    "source": _extract_subreddit(e.get("link", "")),
                    "url": e.get("link", ""),
                    "ts": _iso(epoch), "published": epoch,
                    "summary": (e.get("summary") or "")[:400],
                    "kind": "social",
                })
        except Exception:
            continue
    return _dedupe(out)[:25]


MACRO_RSS_FEEDS = [
    ("https://feeds.a.dj.com/rss/RSSWorldNews.xml", "DJ World"),
    ("https://feeds.finance.yahoo.com/rss/2.0/headline?s=SPY%2CQQQ&region=US&lang=en-US", "Yahoo Macro"),
    ("https://www.ft.com/macro?format=rss", "FT Macro"),
]

def fetch_macro_rss() -> list[dict]:
    """Pull macro headlines from dedicated financial RSS feeds."""
    out = []
    for url, src in MACRO_RSS_FEEDS:
        try:
            parsed = feedparser.parse(url)
            for e in parsed.entries[:10]:
                title = (e.get("title") or "").strip()
                if not title:
                    continue
                epoch = None
                if getattr(e, "published_parsed", None):
                    epoch = time.mktime(e.published_parsed)
                out.append({
                    "title": title,
                    "source": src,
                    "url": e.get("link", ""),
                    "ts": _iso(epoch), "published": epoch,
                    "summary": (e.get("summary") or "")[:400],
                    "kind": "macro",
                })
        except Exception:
            continue
    return _dedupe(out)[:20]


def fetch_reddit_macro() -> list[dict]:
    """Fetch macro / economics news from Reddit + financial RSS feeds."""
    items = fetch_macro_rss()
    # Also try Reddit as fallback (often empty for niche subs)
    subs = MACRO_SUBS.split("+")
    out = []
    for sub in subs:
        try:
            query = f"site:reddit.com/r/{sub}"
            url = (f"https://news.google.com/rss/search?q={urllib.parse.quote(query)}&hl=en-US&gl=US&ceid=US:en")
            parsed = feedparser.parse(url)
            for e in parsed.entries[:10]:
                title = (e.get("title") or "").strip()
                if not title:
                    continue
                epoch = None
                if getattr(e, "published_parsed", None):
                    epoch = time.mktime(e.published_parsed)
                out.append({
                    "title": title,
                    "source": _extract_subreddit(e.get("link", "")),
                    "url": e.get("link", ""),
                    "ts": _iso(epoch), "published": epoch,
                    "summary": (e.get("summary") or "")[:400],
                    "kind": "macro",
                })
        except Exception:
            continue
    items.extend(out)
    return _dedupe(items)[:25]


def fetch_reddit_sentiment(symbol: str) -> list[dict]:
    """Fetch WSB posts for ticker via Google News — tagged as 'sentiment'."""
    q = _NAME_HINTS.get(symbol.upper(), symbol)
    tick = symbol.strip().upper()
    subs = SENTIMENT_SUBS.split("+")
    out = []
    for sub in subs:
        try:
            query = f"site:reddit.com/r/{sub} {tick}"
            url = (f"https://news.google.com/rss/search?q={urllib.parse.quote(query)}&hl=en-US&gl=US&ceid=US:en")
            parsed = feedparser.parse(url)
            for e in parsed.entries[:8]:
                title = (e.get("title") or "").strip()
                if not title:
                    continue
                epoch = None
                if getattr(e, "published_parsed", None):
                    epoch = time.mktime(e.published_parsed)
                out.append({
                    "title": title,
                    "source": _extract_subreddit(e.get("link", "")),
                    "url": e.get("link", ""),
                    "ts": _iso(epoch), "published": epoch,
                    "summary": (e.get("summary") or "")[:400],
                    "kind": "sentiment",
                })
        except Exception:
            continue
    return _dedupe(out)[:15]


# ── Public API ──────────────────────────────────────────────────────────────

def get_news(symbol: str, limit: int = 40, include_social: bool = True) -> list[dict]:
    """Merged, deduped, newest-first news + (optional) social + sentiment items."""
    symbol = symbol.strip().upper()
    ck = f"{symbol}:{include_social}"
    hit = _CACHE.get(ck)
    if hit and (_now_epoch() - hit[0]) < _TTL:
        return hit[1][:limit]

    items = fetch_yf_news(symbol) + fetch_rss(symbol)
    if include_social:
        items += fetch_reddit(symbol)  # trading subs → kind='social'
        items += fetch_reddit_sentiment(symbol)  # WSB → kind='sentiment'
    items = _dedupe(items)
    items.sort(key=lambda x: x.get("published") or 0, reverse=True)
    _CACHE[ck] = (_now_epoch(), items)
    return items[:limit]


def get_macro_news(limit: int = 25) -> list[dict]:
    """Ticker-agnostic macro / economics headlines from Reddit."""
    ck = "macro"
    hit = _CACHE.get(ck)
    if hit and (_now_epoch() - hit[0]) < _TTL:
        return hit[1][:limit]

    items = fetch_reddit_macro()
    _CACHE[ck] = (_now_epoch(), items)
    return items[:limit]


if __name__ == "__main__":
    import sys
    sym = sys.argv[1] if len(sys.argv) > 1 else "AAPL"

    # Ticker news
    news = get_news(sym, limit=15)
    print(f"\n{'='*60}")
    print(f"📰 {sym}: {len(news)} items (social+sens)")
    print(f"{'='*60}")
    for n in news[:12]:
        tag = {"news": "📄", "social": "💬", "sentiment": "🤝"}.get(n["kind"], "?")
        ups = f" ⬆️{n['ups']}" if n.get("ups") else ""
        print(f"  {tag} [{n['kind']:9}] {n['ts'][:10]} {n['source'][:20]:20} {n['title'][:65]}{ups}")

    # Macro
    macro = get_macro_news(limit=8)
    print(f"\n{'='*60}")
    print(f"🌐 Macro news: {len(macro)} items")
    print(f"{'='*60}")
    for m in macro[:8]:
        print(f"  💬 [{m['kind']:9}] {m['ts'][:10]} {m['source'][:20]:20} {m['title'][:65]}")
