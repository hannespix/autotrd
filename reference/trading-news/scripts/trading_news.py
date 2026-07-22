#!/usr/bin/env python3
"""
Trading News & Sentiment Module
===============================
Fetch financial news from RSS feeds and Yahoo Finance (yfinance).
Score sentiment with a lightweight VADER-like lexicon (-1.0 to +1.0).

Dependencies: feedparser, yfinance, requests, beautifulsoup4
"""

from __future__ import annotations

import math
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import feedparser
import requests
import yfinance as yf

# ---------------------------------------------------------------------------
# RSS Feed sources — free, no API key required
# ---------------------------------------------------------------------------
RSS_FEEDS: list[str] = [
    "https://feeds.finance.yahoo.com/rss/2.0/topstories.xml",       # Yahoo Finance top stories
    "https://markets.businessinsider.com/google_AMP_feeds/stock-market-news",  # Business Insider markets
    "https://www.reutersagency.com/feed/?best-topics=3&post-type=article",    # Reuters Business
]

# ---------------------------------------------------------------------------
# Sentiment lexicon — compact VADER-like positive / negative word sets
# Scores mirror common financial-sentiment benchmarks.
# ---------------------------------------------------------------------------

_POSITIVE_WORDS: dict[str, float] = {
    # Strongly positive  (~1.0)
    "surge": 1.0, "skyrocket": 1.0, "rally": 1.0, "bullish": 1.0,
    "boom": 1.0, "breakthrough": 1.0, "landmark": 1.0, "outperform": 1.0,
    "soar": 1.0, "thrive": 1.0, "profitable": 1.0, "recovery": 0.95,
    # Moderately positive (~0.7)
    "growth": 0.7, "gains": 0.7, "gain": 0.7, "winning": 0.75,
    "upgrade": 0.8, "upgraded": 0.8, "strong": 0.7, "robust": 0.75,
    "momentum": 0.7, "confidence": 0.6, "optimistic": 0.75,
    "bullishness": 0.75, "improve": 0.6, "improved": 0.6,
    "improvement": 0.6, "expansion": 0.65, "expanding": 0.65,
    "rebound": 0.7, "recoup": 0.7, "recovering": 0.65,
    "beat": 0.7, "beats": 0.7, "raising": 0.65, "raise": 0.65,
    # Mildly positive (~0.4)
    "positive": 0.4, "up": 0.3, "higher": 0.4, "stronger": 0.5,
    "better": 0.4, "rising": 0.5, "gainable": 0.45,
    "solid": 0.45, "steady": 0.35, "stable": 0.3,
    "supportive": 0.5, "promising": 0.55, "favorable": 0.5,
    "upside": 0.55, "encouraging": 0.55, "exceed": 0.6,
    "exceeded": 0.6, "exceeding": 0.6,
    # Financial terms with positive connotation
    "dividend": 0.3, "buyback": 0.4, "buybacks": 0.4,
    "acquisition": 0.2, "acquisitions": 0.2,
    "earnings_beat": 0.7, "guidance_raise": 0.65,
}

_NEGATIVE_WORDS: dict[str, float] = {
    # Strongly negative (~-1.0)
    "crash": -1.0, "collapse": -1.0, "bankruptcy": -1.0, "fraudulent": -1.0,
    "scandal": -0.95, "catastrophic": -1.0, "devastating": -1.0,
    "downgrade": -0.85, "downgraded": -0.85,
    # Moderately negative (~-0.7)
    "bearish": -0.75, "sell-off": -0.7, "sell_off": -0.7,
    "losses": -0.7, "loss": -0.7, "decline": -0.65,
    "declining": -0.65, "deteriorating": -0.7, "weakness": -0.6,
    "slump": -0.8, "recession": -0.75, "contraction": -0.6,
    "warning": -0.65, "warned": -0.65, "risk": -0.4,
    # Mildly negative (~-0.4)
    "negative": -0.4, "down": -0.3, "lower": -0.3, "weak": -0.45,
    "struggle": -0.55, "struggling": -0.55, "trouble": -0.6,
    "volatile": -0.3, "volatility": -0.25,
    "miss": -0.5, "missed": -0.5, "shortfall": -0.55,
    "uncertainty": -0.35, "concerns": -0.4, "concerning": -0.45,
    "degrade": -0.6, "deteriorate": -0.6,
    # Financial negative terms
    "layoff": -0.5, "layoffs": -0.5,
    "write-down": -0.6, "write_down": -0.6, "write-off": -0.6,
    "fined": -0.55, "penalty": -0.5, "investigation": -0.45,
}

# Intensifiers and dampeners (multiply the next sentiment token)
_INTENSIFIERS: dict[str, float] = {
    "very": 1.3, "extremely": 1.5, "highly": 1.4, "incredibly": 1.6,
    "significantly": 1.35, "substantially": 1.3, "massively": 1.5,
    "severely": 1.45, "deeply": 1.4, "remarkably": 1.3,
}

_DAMPENERS: dict[str, float] = {
    "slightly": 0.6, "moderately": 0.7, "somewhat": 0.65,
    "mildly": 0.6, "barely": 0.4, "hardly": 0.3,
    "marginally": 0.5, "slight": 0.6,
}

_NEGATORS: set[str] = {
    "not", "no", "neither", "nor", "never", "without",
    "doesn't", "don't", "didn't", "isn't", "aren't",
    "wasn't", "weren't", "won't", "wouldn't", "couldn't",
    "shouldn't", "cannot", "can't", "hardly",
}

_TOKEN_RE = re.compile(r"[a-z]+|[^\s\w]", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------
@dataclass
class NewsItem:
    """Single financial news article."""
    title: str
    summary: str = ""
    source: str = ""
    url: str = ""
    published: Optional[str] = None       # ISO-8601 timestamp
    ticker: Optional[str] = None

    def sentiment(self) -> float:
        """Return combined sentiment from title + summary."""
        text = f"{self.title} {self.summary}".strip()
        if not text:
            return 0.0
        return sentiment_score(text)

    def brief(self) -> str:
        """One-liner for console/print output."""
        sgn = "+" if self.sentiment() >= 0 else ""
        emoji = "🟢" if self.sentiment() >= 0.3 else "🔴" if self.sentiment() <= -0.3 else "⚪"
        ts = self.published or "N/A"
        return f"[{ts}] {emoji} ({sgn}{self.sentiment():.2f}) {self.title}"


@dataclass
class SentimentOverview:
    """Aggregate market sentiment snapshot."""
    overall_score: float = 0.0                 # -1.0 … +1.0
    article_count: int = 0
    positive_count: int = 0
    negative_count: int = 0
    neutral_count: int = 0
    top_sources: dict[str, float] = field(default_factory=dict)
    headlines: list[NewsItem] = field(default_factory=list)
    timestamp: str = ""


# ===================================================================
# Core functions
# ===================================================================

def sentiment_score(text: str, /) -> float:
    """
    Score a piece of text on -1.0 … +1.0 using a lightweight
    lexicon-based approach (VADER-like).

    Algorithm
    ---------
    1. Tokenize into lowercase words.
    2. For each token, look up in positive / negative lexicons.
    3. Apply intensifiers, dampeners, and negation flipping for the
       immediately preceding word-score modifier within a ±3 window.
    4. Sum all scored tokens, then compress via tanh(scaled_sum) to
       bound the output in [-1, +1].

    Parameters
    ----------
    text : str
        Free-form English text (headline, article body, tweet …).

    Returns
    -------
    float
        Sentiment polarity in [-1.0, +1.0].  Positive = bullish,
        negative = bearish, near-zero = neutral.
    """
    tokens: list[str] = _TOKEN_RE.findall(text.lower())
    if not tokens:
        return 0.0

    # Score each token and tag modifiers
    raw_scores: list[Optional[float]] = []
    modifiers: list[Optional[float]] = []    # multiplier from intensifier/dampener

    for tok in tokens:
        score = _POSITIVE_WORDS.get(tok) or _NEGATIVE_WORDS.get(tok)
        raw_scores.append(score)
        if score is None:
            m_pos = _INTENSIFIERS.get(tok)
            m_neg = _DAMPENERS.get(tok)
            modifiers.append(m_pos or m_neg)  # may be None
        else:
            modifiers.append(None)

    total = 0.0
    scored_count = 0

    for i, score in enumerate(raw_scores):
        if score is None:
            continue
        multiplier = 1.0
        # Check preceding tokens (within 3-token window) for modifiers
        window_start = max(0, i - 3)
        negation_count = 0
        for j in range(window_start, i):
            prev_tok = tokens[j] if j < len(tokens) else ""
            if prev_tok in _NEGATORS:
                negation_count += 1
            if modifiers[j] is not None:
                multiplier = modifiers[j]
        # Odd number of negators → flip sentiment
        if negation_count % 2 == 1:
            score = -score
        total += score * multiplier
        scored_count += 1

    if scored_count == 0:
        return 0.0

    # Normalize by token count and compress via tanh to [-1, +1]
    density = total / max(scored_count, 1)
    return round(tanh_safe(density * 1.2), 4)


def tanh_safe(x: float) -> float:
    """Numerically stable tanh for compression into [-1, 1]."""
    try:
        return math.tanh(x)
    except OverflowError:
        return 1.0 if x > 0 else -1.0


def fetch_financial_news(
    ticker: Optional[str] = None,
    max_items: int = 20,
) -> list[NewsItem]:
    """
    Fetch financial news from RSS feeds and (optionally) yfinance for a ticker.

    Parameters
    ----------
    ticker : str | None
        Stock ticker symbol (e.g., "AAPL", "TSLA"). If provided, also pulls
        news from Yahoo Finance via yfinance.Ticker().news.
    max_items : int
        Maximum number of results to return.

    Returns
    -------
    list[NewsItem]
        Up to *max_items* headlines sorted by published date (newest first).
    """
    all_items: list[NewsItem] = []

    # --- RSS feeds ---
    for feed_url in RSS_FEEDS:
        try:
            feed = feedparser.parse(feed_url)
            for entry in feed.entries[:max_items]:
                published = None
                if hasattr(entry, "published") and entry.published:
                    try:
                        dt = datetime(
                            *[int(x) for x in re.split(r"[,\s:]+|T", entry.published)[:6]]
                        )
                        published = dt.isoformat()
                    except (ValueError, TypeError):
                        published = entry.published

                summary = ""
                for attr in ("summary", "description"):
                    val = getattr(entry, attr, None)
                    if val:
                        soup_clean = re.sub(r"<[^>]+>", "", str(val))
                        summary = soup_clean.strip()
                        break

                item = NewsItem(
                    title=entry.get("title", "").strip(),
                    summary=summary[:500],
                    source=feed_url.split("//")[1].split("/")[0] if "//" in feed_url else feed_url,
                    url=entry.get("link", ""),
                    published=published,
                    ticker=ticker,
                )
                all_items.append(item)
        except Exception as exc:
            print(f"[trading_news] RSS fetch warning for {feed_url}: {exc}")

    # --- yfinance ticker news ---
    if ticker:
        try:
            tkr = yf.Ticker(ticker.upper())
            stock_news = tkr.news
            if isinstance(stock_news, list):
                for sn in stock_news[:max_items]:
                    try:
                        published_sn = datetime.fromtimestamp(
                            sn.get("providerPublishTime", 0), tz=timezone.utc
                        ).isoformat() if sn.get("providerPublishTime") else None

                        summary_sn = ""
                        for attr in ("summary", "content"):
                            val = sn.get(attr)
                            if val:
                                summary_sn = str(val)[:500]
                                break

                        item = NewsItem(
                            title=sn.get("title", "").strip(),
                            summary=summary_sn,
                            source="yahoo_finance_yfinance",
                            url=sn.get("link", ""),
                            published=published_sn,
                            ticker=ticker.upper(),
                        )
                        all_items.append(item)
                    except Exception as sn_exc:
                        print(f"[trading_news] yfinance entry warning: {sn_exc}")
        except Exception as exc:
            print(f"[trading_news] yfinance fetch warning for {ticker}: {exc}")

    # Deduplicate by title (case-insensitive)
    seen_titles: set[str] = set()
    unique: list[NewsItem] = []
    for item in all_items:
        key = item.title.lower().strip()
        if key and key not in seen_titles:
            seen_titles.add(key)
            unique.append(item)

    # Sort by published date (newest first), items without date go to the end
    with_date = [i for i in unique if i.published]
    without_date = [i for i in unique if not i.published]
    with_date.sort(key=lambda x: x.published or "", reverse=True)

    return (with_date + without_date)[:max_items]


def market_sentiment_overview(
    num_feeds: int = 0,
    max_headlines: int = 50,
) -> SentimentOverview:
    """
    Aggregate sentiment across multiple financial RSS feeds to produce a
    market mood snapshot.

    Parameters
    ----------
    num_feeds : int
        Number of RSS feeds to query. 0 means all configured feeds.
    max_headlines : int
        Maximum total headlines to consider before aggregating.

    Returns
    -------
    SentimentOverview
        Contains overall score, counts per band, per-source breakdown,
        and the individual headlines evaluated.
    """
    feeds = RSS_FEEDS[:num_feeds] if num_feeds > 0 else RSS_FEEDS
    all_items: list[NewsItem] = []

    for feed_url in feeds:
        try:
            resp = requests.get(feed_url, timeout=10)
            resp.raise_for_status()
            feed = feedparser.parse(resp.text)
            source_id = feed_url.split("//")[1].split("/")[0] if "//" in feed_url else "unknown"
            for entry in feed.entries[:max_headlines]:
                title = entry.get("title", "").strip() or ""
                summary_raw = getattr(entry, "summary", "") or getattr(entry, "description", "") or ""
                summary_clean = re.sub(r"<[^>]+>", "", str(summary_raw)).strip()
                text = f"{title} {summary_clean}"

                score = sentiment_score(text) if text else 0.0
                published = None
                try:
                    dt = datetime(*(int(x) for x in re.split(r"[,\s:]+|T", getattr(entry, "published", "_"))[:6]))
                    published = dt.isoformat()
                except Exception:
                    pass

                item = NewsItem(
                    title=title or "(untitled)",
                    summary=summary_clean[:500],
                    source=source_id,
                    published=published,
                )
                # tag source sentiment
                all_items.append(item)
        except Exception as exc:
            print(f"[trading_news] Overview fetch warning for {feed_url}: {exc}")

    if not all_items:
        return SentimentOverview(
            timestamp=datetime.now(timezone.utc).isoformat(),
            overall_score=0.0,
            article_count=0,
        )

    scores = [item.sentiment() for item in all_items]
    overall = math.fsum(scores) / len(scores) if scores else 0.0

    pos = sum(1 for s in scores if s >= 0.1)
    neg = sum(1 for s in scores if s <= -0.1)
    neu = sum(1 for s in scores if -0.1 < s < 0.1)

    # Per-source average
    source_scores: dict[str, list[float]] = {}
    for item in all_items:
        source_scores.setdefault(item.source, []).append(item.sentiment())
    top_sources = {k: round(math.fsum(v) / len(v), 4) for k, v in source_scores.items()}

    return SentimentOverview(
        overall_score=round(overall, 4),
        article_count=len(all_items),
        positive_count=pos,
        negative_count=neg,
        neutral_count=neu,
        top_sources=top_sources,
        headlines=all_items[:max_headlines],
        timestamp=datetime.now(timezone.utc).isoformat(),
    )


# ---------------------------------------------------------------------------
# CLI entry-point for quick testing
# ---------------------------------------------------------------------------
def _cli_ticker_news() -> None:
    items = fetch_financial_news(ticker="SPY", max_items=10)
    print(f"\n{'='*60}\n  SPY News — fetched {len(items)} items\n{'='*60}")
    for it in items:
        print(f"  {it.brief()}")


def _cli_market_overview() -> None:
    overview = market_sentiment_overview(max_headlines=40)
    mood_emoji = "🟢" if overview.overall_score >= 0.15 else "🔴" if overview.overall_score <= -0.15 else "⚪"
    print(f"\n{'='*60}\n  Market Sentiment Overview\n{'='*60}")
    print(f"  {mood_emoji} Overall: {overview.overall_score:+.3f}")
    print(f"  Articles analyzed: {overview.article_count}")
    print(f"  Positive / Negative / Neutral: {overview.positive_count}/{overview.negative_count}/{overview.neutral_count}")
    if overview.top_sources:
        print("  Per-source averages:")
        for src, avg in sorted(overview.top_sources.items(), key=lambda x: x[1], reverse=True):
            print(f"    {src}: {avg:+.3f}")


if __name__ == "__main__":
    _cli_ticker_news()
    _cli_market_overview()
