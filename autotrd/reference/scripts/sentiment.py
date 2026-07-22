"""
sentiment — fast, dependency-free rule-based news analysis.

This is the *coarse* first stage (per the design: rule-based filtering first,
Claude escalation second). It scores headline/summary text for bullish/bearish
sentiment and tags market-relevant event types (earnings, upgrade, M&A, legal,
guidance, …). The event engine uses these scores to rank which news items are
worth linking to a price swing (and worth escalating to the LLM).
"""
from __future__ import annotations

import re

# Weighted sentiment lexicon (lowercase). Positive = bullish, negative = bearish.
_BULL = {
    "beat": 2, "beats": 2, "surge": 3, "surges": 3, "soar": 3, "soars": 3, "jump": 2,
    "jumps": 2, "rally": 2, "rallies": 2, "record": 2, "upgrade": 3, "upgraded": 3,
    "outperform": 2, "buy": 1, "strong": 2, "growth": 1, "profit": 1, "gains": 2,
    "gain": 1, "raises": 2, "raised": 2, "boost": 2, "boosts": 2, "bullish": 3,
    "breakout": 2, "top": 1, "tops": 2, "wins": 2, "win": 1, "approval": 2,
    "approved": 2, "expansion": 1, "buyback": 2, "dividend": 1, "partnership": 1,
    "milestone": 1, "optimism": 2, "rebound": 2, "momentum": 1, "all-time high": 3,
}
_BEAR = {
    "miss": 2, "misses": 2, "plunge": 3, "plunges": 3, "crash": 3, "crashes": 3,
    "slump": 2, "slumps": 2, "fall": 1, "falls": 2, "drop": 2, "drops": 2, "sink": 2,
    "sinks": 2, "downgrade": 3, "downgraded": 3, "underperform": 2, "sell": 1,
    "weak": 2, "loss": 2, "losses": 2, "cuts": 2, "cut": 1, "warning": 2, "warns": 2,
    "bearish": 3, "lawsuit": 2, "sued": 2, "probe": 2, "investigation": 2, "fraud": 3,
    "recall": 2, "layoffs": 2, "bankruptcy": 3, "default": 3, "slowdown": 2,
    "decline": 2, "declines": 2, "tumble": 3, "tumbles": 3, "selloff": 3, "fears": 2,
    "concern": 1, "concerns": 1, "halt": 2, "halted": 2, "delay": 1, "delays": 1,
}

# Event-type patterns → (label, weight). Weight = how market-moving the type is.
_EVENT_PATTERNS = [
    (r"\bearnings?\b|\bq[1-4]\b|\bquarter(ly)?\b|\bresults\b|\beps\b|\brevenue\b", "earnings", 3),
    (r"\bupgrade[ds]?\b|\bdowngrade[ds]?\b|\bprice target\b|\banalyst\b|\brating\b", "analyst", 2),
    (r"\bmerger\b|\bacqui|\bbuyout\b|\btakeover\b|\bdeal\b|\bstake\b", "m&a", 3),
    (r"\blawsuit\b|\bsued?\b|\bprobe\b|\binvestigat|\bsec\b|\bregulat|\bantitrust\b|\bfine\b", "legal", 2),
    (r"\bguidance\b|\boutlook\b|\bforecast\b|\bwarns?\b|\bwarning\b", "guidance", 3),
    (r"\bceo\b|\bcfo\b|\bexecutive\b|\bresign|\bappoint|\bfires?\b|\bsteps down\b", "leadership", 2),
    (r"\bproduct\b|\blaunch\b|\bunveil|\brelease[ds]?\b|\bpartnership\b|\bcontract\b", "product", 1),
    (r"\bfda\b|\bapproval\b|\btrial\b|\bpatent\b", "regulatory", 2),
    (r"\bdividend\b|\bbuyback\b|\bsplit\b|\bspin-?off\b", "capital", 1),
    (r"\bfed\b|\brate[s]?\b|\binflation\b|\bcpi\b|\btariff|\bgdp\b|\bjobs report\b", "macro", 2),
]

_WORD = re.compile(r"[a-z][a-z'&-]+")


def score_text(text: str) -> dict:
    """Return {sentiment: -1..1, label, magnitude, events:[...], hits:[...]}."""
    t = (text or "").lower()
    words = _WORD.findall(t)
    pos = neg = 0
    hits = []
    for w in words:
        if w in _BULL:
            pos += _BULL[w]; hits.append("+" + w)
        elif w in _BEAR:
            neg += _BEAR[w]; hits.append("-" + w)
    # multi-word phrase check
    for phrase, wt in (("all-time high", 3),):
        if phrase in t:
            pos += wt; hits.append("+" + phrase)

    events = []
    for pat, label, wt in _EVENT_PATTERNS:
        if re.search(pat, t):
            events.append({"type": label, "weight": wt})

    total = pos + neg
    raw = (pos - neg) / total if total else 0.0
    magnitude = min(1.0, total / 6.0)  # confidence-ish: how much signal was present
    label = "bullish" if raw > 0.15 else "bearish" if raw < -0.15 else "neutral"
    return {
        "sentiment": round(raw, 3),
        "label": label,
        "magnitude": round(magnitude, 3),
        "events": events,
        "event_types": [e["type"] for e in events],
        "hits": hits[:8],
    }


def analyze_items(items: list[dict]) -> list[dict]:
    """Attach a `sent` block to each news/social item."""
    for it in items:
        it["sent"] = score_text(f"{it.get('title','')} . {it.get('summary','')}")
    return items


def aggregate(items: list[dict]) -> dict:
    """Overall sentiment picture across a list of analysed items."""
    scored = [it for it in items if it.get("sent")]
    if not scored:
        return {"overall": 0.0, "label": "neutral", "n": 0, "bullish": 0, "bearish": 0,
                "neutral": 0, "top_events": [], "social_tilt": 0.0}
    # weight by magnitude + a small recency/engagement nudge for social
    num = den = 0.0
    counts = {"bullish": 0, "bearish": 0, "neutral": 0}
    ev_counter: dict[str, int] = {}
    social_scores = []
    for it in scored:
        s = it["sent"]
        w = 0.4 + s["magnitude"]
        if it.get("kind") == "social":
            w += min(0.5, (it.get("ups", 0) or 0) / 500.0)
            social_scores.append(s["sentiment"])
        num += s["sentiment"] * w
        den += w
        counts[s["label"]] += 1
        for et in s["event_types"]:
            ev_counter[et] = ev_counter.get(et, 0) + 1
    overall = num / den if den else 0.0
    top_events = sorted(ev_counter.items(), key=lambda kv: kv[1], reverse=True)[:5]
    social_tilt = sum(social_scores) / len(social_scores) if social_scores else 0.0
    return {
        "overall": round(overall, 3),
        "label": "bullish" if overall > 0.12 else "bearish" if overall < -0.12 else "neutral",
        "n": len(scored),
        "bullish": counts["bullish"], "bearish": counts["bearish"], "neutral": counts["neutral"],
        "top_events": [{"type": t, "count": c} for t, c in top_events],
        "social_tilt": round(social_tilt, 3),
    }


if __name__ == "__main__":
    samples = [
        "Apple beats earnings, stock surges to record high on strong iPhone growth",
        "Tesla plunges after analyst downgrade and demand warning",
        "Nvidia announces $50B buyback; shares jump in after-hours",
        "SEC opens probe into company accounting; lawsuit filed",
    ]
    for s in samples:
        r = score_text(s)
        print(f"  {r['label']:8} ({r['sentiment']:+.2f}) events={r['event_types']}  :: {s[:55]}")
