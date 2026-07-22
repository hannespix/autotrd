#!/usr/bin/env python3
"""Quick smoke-test for trading_news module."""
import sys
sys.path.insert(0, "scripts")

import feedparser

# --- Test 1: RSS feeds reachable? ---
FEEDS = [
    "https://feeds.finance.yahoo.com/rss/2.0/topstories.xml",
    "https://markets.businessinsider.com/google_AMP_feeds/stock-market-news",
    "https://www.reutersagency.com/feed/?best-topics=3&post-type=article",
]

print("=== RSS reachability ===")
working_feeds = []
for url in FEEDS:
    try:
        feed = feedparser.parse(url)
        count = len(feed.entries)
        status = "parse-ok" if feed.bozo == 0 else "parse-warnings"
        print(f"  [{status}] {{url[:60]}} ... -> {{count}} entries")
        if count > 0:
            working_feeds.append(url)
    except Exception as exc:
        print(f"  [ERROR] {{url[:60]}} -> {{exc}}")

print(f"\nWorking feeds: {len(working_feeds)}")

if not working_feeds:
    # Try some backup feeds
    backups = [
        "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml",
        "https://finance.yahoo.com/topics/bonds/",
        "feed://feeds.finance.yahoo.com/rss/2.0/topstories.xml",
    ]
    print("\nTrying backup feeds...")
    for url in backups:
        try:
            feed = feedparser.parse(url)
            count = len(feed.entries)
            print(f"  {{count}} entries from {{url[:70]}}")
        except Exception as exc:
            print(f"  FAIL {{url[:60]}} -> {{exc}}")
else:
    # --- Test 2: fetch_financial_news ---
    print("\n=== fetch_financial_news ===")
    from trading_news import fetch_financial_news, sentiment_score, market_sentiment_overview

    items = fetch_financial_news(max_items=5)
    print(f"  Generic news: {{len(items)}} items")
    for it in items[:3]:
        print(f"    {{it.brief()}}")

    tick_items = fetch_financial_news(ticker="SPY", max_items=5)
    print(f"  SPY ticker news: {{len(tick_items)}} items")
    for it in tick_items[:3]:
        print(f"    {{it.brief()}}")

    # --- Test 3: market_sentiment_overview ---
    print("\n=== market_sentiment_overview ===")
    ov = market_sentiment_overview(max_headlines=20)
    print(f"  Overall score: {{ov.overall_score:+.4f}}")
    print(f"  Articles: {{ov.article_count}}")
    print(f"  Pos/Neg/Neutral: {{ov.positive_count}}/{{ov.negative_count}}/{{ov.neutral_count}}")

print("\nAll smoke tests done.")
