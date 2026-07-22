---
name: trading-news
description: >
  Use when the user asks for financial/stock news, earnings reports, market
  sentiment analysis, economic calendar events, or "market mood" assessments.
  Fetches live news from RSS + yfinance, scores each headline with a
  VADER-like lexicon, and returns sentiment bands (🟢 bullish / ⚪ neutral / 🔴 bearish).
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [trading, news, sentiment, earnings, calendar, finance]
    related_skills: [daytrading-hub, market-data]
---

# Trading News & Sentiment

Fetch financial headlines, score their tone, and produce a market-mood snapshot.
Runs entirely offline-sentiment + RSS/yfinance — **no paid API key required**.

## When to Use

**Load this skill when the user mentions any of:**

| Trigger class | Examples |
|---|---|
| **News / Headlines** | "Any news on TSLA?", "stock news today", "what's happening with AAPL?" |
| **Earnings** | "earnings report", "quarterly results", "beat/miss estimates" |
| **Sentiment** | "how does the market feel?", "sentiment analysis", "is it bullish?" |
| **Market Mood** | "market mood today", "overall tone", "should I be worried?" |
| **Calendar** | "earnings calendar", "what's coming up this week" |

**Don't use for:** technical indicators, chart generation, portfolio P&L — those live in `technical-analysis` and `trading-journal`.

## Module Reference

```text
~/.hermes/skills/daytrading/trading-news/scripts/trading_news.py
```

### Public API

| Function | Returns | Purpose |
|---|---|---|
| `fetch_financial_news(ticker=None, max_items=20)` | `list[NewsItem]` | Pull headlines from RSS feeds + (optionally) yfinance per ticker |
| `sentiment_score(text)` | `float [-1.0, +1.0]` | Lexicon-based VADER-like scoring on any English text |
| `market_sentiment_overview(num_feeds=0, max_headlines=50)` | `SentimentOverview` | Aggregate tone across all configured RSS feeds |
| `get_macro_news(limit=25)` | `list[dict]` | Ticker-agnostic macro/economics headlines (DJ World + Yahoo Macro + Reddit) |
| `fetch_reddit(symbol)` | `list[dict]` | Trading-community posts from r/FuturesTrading, r/Trading, r/Daytrading, r/StockMarket, r/SecurityAnalysis → kind=`social` |
| `fetch_reddit_sentiment(symbol)` | `list[dict]` | WSB posts (r/wallstreetbets) → kind=`sentiment`, contrarian gauge |

### Item kinds
Each returned dict has a `kind` field:
- **`news`** — Yahoo Finance, Google News, RSS
- **`social`** — Reddit trading communities (serious subs)
- **`sentiment`** — r/wallstreetbets (retail mood / contrarian indicator)
- **`macro`** — Dow Jones, FT, macro indexers (ticker-agnostic context)

### Data classes

- **`NewsItem`** — title, summary, source, url, published (ISO-8601), optional ticker.
  - `.sentiment()` → float
  - `.brief()` → one-liner with emoji + score for console printing
- **`SentimentOverview`** — overall_score, article_count, pos/neg/neutral counts, per-source breakdown

### RSS sources (free, no key)

**Financial news:**
1. Yahoo Finance Top Stories
2. Google News per-ticker search

**Reddit trading communities (via Google News proxy):**
3. r/FuturesTrading — futures/CFD action
4. r/Trading — general trading discussion and setups
5. r/Daytrading + r/StockMarket + r/SecurityAnalysis — intraday flow and fundamentals

**Macro / economics:**
6. Dow Jones World News RSS
7. Yahoo Finance macro indexers (.SPY, .QQQ)

**Retail sentiment:**
8. r/wallstreetbets — tagged as `'sentiment'` not `'social'`, used as a contrarian gauge

Add more by editing `MACRO_RSS_FEEDS`, `TRADING_SUBS`, or `SENTIMENT_SUBS` in the script.

## Workflow

### 1. Fetch news for a ticker
```bash
/home/hannes/.hermes/hermes-agent/venv/bin/python3 -c "
from scripts.trading_news import fetch_financial_news
items = fetch_financial_news(ticker='AAPL', max_items=15)
for it in items: print(it.brief())
"
```

### 2. Quick sentiment on a headline
```bash
/home/hannes/.hermes/hermes-agent/venv/bin/python3 -c "
from scripts.trading_news import sentiment_score
print(f'{{sentiment_score(\"TSLA surges after record delivery numbers\")!+.3f}}')
"
```

### 3. Full market mood snapshot
```bash
/home/hannes/.hermes/hermes-agent/venv/bin/python3 -c "
from scripts.trading_news import market_sentiment_overview
ov = market_sentiment_overview(max_headlines=40)
print(f'Overall sentiment: {{ov.overall_score!+.3f}}')
print(f'Bands: pos={{ov.positive_count}} neg={{ov.negative_count}} neutral={{ov.neutral_count}}')
"
```

### 4. Run as standalone (quick test)
```bash
/home/hannes/.hermes/hermes-agent/venv/bin/python3 \
  ~/.hermes/skills/daytrading/trading-news/scripts/trading_news.py
```
This prints SPY ticker news + market overview to stdout.

## Response Formatting

When presenting results to the user:

1. **Lead with** overall sentiment direction (🟢 / ⚪ / 🔴)
2. **Show top 5-10 headlines** with score and timestamp
3. **Summarize** dominant themes (e.g., "Most coverage around rate expectations")
4. **Flag** any strongly negative items (> -0.6) as potential risk signals

## Sentiment Scoring Details

The scoring uses a 3-tier approach:

1. **Lexicon lookup** — ~80 positive + ~50 negative financial terms with weights
2. **Modifier window** (±3 tokens) — intensifiers (×1.3-1.6), dampeners (×0.4-0.7), negation flips
3. **Compression** — `tanh(density × 1.2)` compresses the sum into [-1, +1]

Score bands:
| Range | Label | Emoji |
|---|---|---|
| ≥ +0.3 | Bullish | 🟢 |
| (+0.1, +0.3) | Slightly positive | ⚪ |
| (−0.1, +0.1) | Neutral | ⚪ |
| (−0.3, −0.1) | Slightly negative | ⚪ |
| ≤ −0.3 | Bearish | 🔴 |

## Common Pitfalls

1. **yfinance rate limits** — cap ticker lookups to ≤3 per minute; the module catches exceptions with warnings.
2. **RSS feeds change URLs** — if a feed consistently returns empty, swap it out in `RSS_FEEDS`.
3. **No guaranteed real-time** — RSS feeds have 5-30 min latency; don't claim "instant" for day-trading decisions.
4. **Sentiment is a signal not a rule** word-based scoring misses sarcasm, irony, and context-dependent meaning — always flag uncertainty when scores cluster near zero.

## Verification Checklist

- [ ] Script imports cleanly in the venv (`python3 -c "from scripts.trading_news import sentiment_score; print('ok')"`)
- [ ] `fetch_financial_news()` returns ≥ 1 item on a valid ticker
- [ ] Sentiment score for clearly positive text > 0.2
- [ ] Sentiment score for clearly negative text < -0.2
- [ ] `market_sentiment_overview()` completes without crash and reports ≥ 0 articles
