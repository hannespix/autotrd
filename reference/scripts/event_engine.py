"""
event_engine — link price swings to the news that likely caused them.

Pipeline:
  1. detect swing highs/lows (Scheitelpunkte) in the OHLC series
  2. fetch + rule-score news/social for the symbol (news_feed + sentiment)
  3. for each swing, gather news in a date window around it and rank by relevance
     (event weight + sentiment magnitude + direction alignment + recency)
  4. rule-based pick = top candidate; the most significant swings are escalated
     to Claude Sonnet (ai_analyst) for a concise causal explanation
  5. emit chart annotations (marker + tooltip) and cache them

Honest limitation: free news sources mostly cover the last ~2 weeks, so only
recent swings get linked events. Older swings return a marker without a cause.
"""
from __future__ import annotations

from datetime import datetime, timezone

import news_feed
import sentiment as sentiment_mod

_WINDOW_BEFORE = 5   # days before the swing a cause may appear (rumors/leaks)
_WINDOW_AFTER = 2    # days after (reporting lag)


def _epoch_to_day(epoch):
    if not epoch:
        return None
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%d")


def _day_diff(a: str, b: str) -> int:
    return abs((datetime.fromisoformat(a) - datetime.fromisoformat(b)).days)


def detect_swings(bars: list[dict], k: int = 3, min_move_pct: float = 1.5) -> list[dict]:
    """Local extrema with a magnitude (% run into the swing over k bars)."""
    out = []
    for i in range(k, len(bars) - k):
        hi = all(bars[j]["high"] <= bars[i]["high"] for j in range(i - k, i + k + 1) if j != i)
        lo = all(bars[j]["low"] >= bars[i]["low"] for j in range(i - k, i + k + 1) if j != i)
        base = bars[i - k]["close"] or 1e-9
        move = (bars[i]["close"] / base - 1) * 100
        if hi and abs(move) >= min_move_pct:
            out.append({"time": bars[i]["time"], "price": bars[i]["high"], "kind": "high", "move_pct": round(move, 2)})
        elif lo and abs(move) >= min_move_pct:
            out.append({"time": bars[i]["time"], "price": bars[i]["low"], "kind": "low", "move_pct": round(move, 2)})
    return out


def _item_score(it: dict) -> float:
    s = it.get("sent") or {}
    ev = max((e["weight"] for e in s.get("events", [])), default=0)
    return ev + s.get("magnitude", 0) * 2 + (0.3 if it.get("kind") == "social" else 0)


def build_events(symbol: str, bars: list[dict], use_ai: bool = True,
                 max_ai: int = 3, min_move_pct: float = 1.5) -> list[dict]:
    """News markers aligned to real chart days (sentiment-coloured), enriched with
    swing info where a day coincides with a Scheitelpunkt, and an AI daily summary
    for the most notable days. Reliable for the recent window that news covers."""
    symbol = symbol.strip().upper()
    if not bars:
        return []
    bar_by_day = {b["time"]: b for b in bars}
    swings = {s["time"]: s for s in detect_swings(bars, k=3, min_move_pct=min_move_pct)}

    news = sentiment_mod.analyze_items(news_feed.get_news(symbol, limit=80))

    # Group news onto the trading day it belongs to (news day must exist on the chart)
    by_day: dict[str, list[dict]] = {}
    for it in news:
        d = _epoch_to_day(it.get("published"))
        if d and d in bar_by_day:
            by_day.setdefault(d, []).append(it)

    markers = []
    for day, items in by_day.items():
        agg = sentiment_mod.aggregate(items)
        top = max(items, key=_item_score)
        bar = bar_by_day[day]
        sw = swings.get(day)
        markers.append({
            "time": day, "price": bar["close"],
            "sentiment": agg["overall"], "sent_label": agg["label"], "count": len(items),
            "headline": top["title"], "source": top["source"], "url": top.get("url", ""),
            "event_types": top["sent"]["event_types"],
            "is_swing": bool(sw), "kind": sw["kind"] if sw else None,
            "move_pct": sw["move_pct"] if sw else None,
            "explanation": None, "ai": False,
            "headlines": [{"title": i["title"], "source": i["source"],
                           "label": i["sent"]["label"], "url": i.get("url", "")}
                          for i in sorted(items, key=_item_score, reverse=True)[:5]],
        })
    markers.sort(key=lambda m: m["time"])

    # AI daily summary for the most notable days (swing days + strongest sentiment)
    if use_ai and markers:
        try:
            import ai_analyst
            if ai_analyst.available():
                ranked = sorted(markers, key=lambda m: (m["is_swing"], abs(m["sentiment"]) * m["count"]), reverse=True)
                for m in ranked[:max_ai]:
                    res = ai_analyst.summarize_day(
                        symbol, m["time"], [h["title"] for h in m["headlines"]], m.get("move_pct"))
                    if res:
                        m["explanation"] = res["explanation"]
                        m["ai"] = True
                        m["confidence"] = res.get("confidence")
        except Exception:
            pass

    return markers


if __name__ == "__main__":
    import sys
    from market_data import fetch_historical
    sym = sys.argv[1] if len(sys.argv) > 1 else "AAPL"
    df = fetch_historical(sym, period="3mo")
    bars = [{"time": str(idx)[:10], "open": float(r.get("Open", 0)), "high": float(r.get("High", 0)),
             "low": float(r.get("Low", 0)), "close": float(r.get("Close", 0))} for idx, r in df.iterrows()]
    evs = build_events(sym, bars, use_ai=True, max_ai=2)
    print(f"{sym}: {len(evs)} news-day markers on the chart")
    for e in evs:
        tag = "🤖" if e.get("ai") else "  "
        sw = f" [SWING {e['kind']} {e['move_pct']:+.1f}%]" if e.get("is_swing") else ""
        print(f"  {tag} {e['time']} {e['sent_label']:8} ({e['sentiment']:+.2f}) {e['count']} news{sw}")
        print(f"       top: {e.get('headline','')[:72]}")
        if e.get("explanation"):
            print(f"       🤖 {e['explanation'][:72]}")
