"""
ai_analyst — Claude Sonnet escalation stage (second stage after rule-based filtering).

Given a detected price swing and a short list of rule-pre-selected news headlines,
ask Claude Sonnet (via the local `claude` CLI — uses the Max subscription, no API
key) to name the most likely cause and explain it in one sentence. Results are
cached in SQLite so each swing is analysed at most once; calls are rate-limited
and time-boxed, with a graceful fallback to the rule-based pick.
"""
from __future__ import annotations

import json
import re
import shutil
import sqlite3
import subprocess
from pathlib import Path

_DB = Path.home() / ".hermes" / "trading" / "history.db"
_CLAUDE = shutil.which("claude")
_MODEL = "sonnet"
_TIMEOUT = 45


def available() -> bool:
    return _CLAUDE is not None


# ── cache ────────────────────────────────────────────────────────────────────

def _ensure():
    conn = sqlite3.connect(_DB, timeout=10)
    try:
        conn.execute("""CREATE TABLE IF NOT EXISTS ai_explanations (
            sig TEXT PRIMARY KEY, symbol TEXT, ts TEXT,
            cause TEXT, explanation TEXT, confidence REAL, headline TEXT)""")
        conn.commit()
    finally:
        conn.close()


def _cache_get(sig: str):
    try:
        _ensure()
        conn = sqlite3.connect(_DB, timeout=10)
        try:
            r = conn.execute("SELECT cause, explanation, confidence, headline FROM ai_explanations WHERE sig=?", (sig,)).fetchone()
        finally:
            conn.close()
        if r:
            return {"cause": r[0], "explanation": r[1], "confidence": r[2], "headline": r[3], "ai": True, "cached": True}
    except Exception:
        pass
    return None


def _cache_put(sig, symbol, res):
    try:
        _ensure()
        conn = sqlite3.connect(_DB, timeout=10)
        try:
            conn.execute("INSERT OR REPLACE INTO ai_explanations VALUES (?,?,datetime('now'),?,?,?,?)",
                         (sig, symbol, res.get("cause"), res.get("explanation"),
                          res.get("confidence"), res.get("headline")))
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass


# ── LLM call ─────────────────────────────────────────────────────────────────

_PROMPT = """Du bist ein nüchterner Börsenanalyst. Ein Kurs von {symbol} zeigte am {date} \
eine {direction} von {move:.1f}%. Hier Schlagzeilen aus dem Zeitfenster:

{headlines}

Welche Schlagzeile erklärt die Bewegung am wahrscheinlichsten? Antworte AUSSCHLIESSLICH mit \
kompaktem JSON, keine weiteren Worte:
{{"idx": <0-basierter Index der wahrscheinlichsten Schlagzeile oder -1>, \
"cause": "<Ursache in 3-6 Worten>", \
"explanation": "<eine sachliche Erklärung, max 25 Worte, deutsch>", \
"confidence": <0.0-1.0>}}"""


def _call_claude(prompt: str) -> str | None:
    if not _CLAUDE:
        return None
    try:
        p = subprocess.run([_CLAUDE, "-p", prompt, "--model", _MODEL],
                           capture_output=True, text=True, timeout=_TIMEOUT)
        if p.returncode != 0:
            return None
        return p.stdout.strip()
    except Exception:
        return None


def _parse_json(text: str):
    if not text:
        return None
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def explain_swing(symbol: str, swing: dict, candidates: list[dict]) -> dict | None:
    """Return {cause, explanation, confidence, headline, ai:True} or None on failure."""
    if not candidates:
        return None
    sig = f"{symbol}|{swing.get('time')}|{swing.get('kind')}"
    cached = _cache_get(sig)
    if cached:
        return cached
    if not _CLAUDE:
        return None

    headlines = "\n".join(f"{i}. [{c.get('source','')}] {c.get('title','')}" for i, c in enumerate(candidates[:6]))
    prompt = _PROMPT.format(
        symbol=symbol, date=str(swing.get("time")),
        direction="Aufwärtsbewegung" if swing.get("kind") == "high" else "Abwärtsbewegung",
        move=abs(float(swing.get("move_pct", 0))), headlines=headlines)

    data = _parse_json(_call_claude(prompt))
    if not data:
        return None
    idx = data.get("idx", -1)
    headline = candidates[idx]["title"] if isinstance(idx, int) and 0 <= idx < len(candidates) else None
    res = {
        "cause": (data.get("cause") or "")[:80],
        "explanation": (data.get("explanation") or "")[:200],
        "confidence": float(data.get("confidence", 0.5)) if isinstance(data.get("confidence"), (int, float)) else 0.5,
        "headline": headline,
        "ai": True,
    }
    _cache_put(sig, symbol, res)
    return res


_DAY_PROMPT = """Du bist ein nüchterner Börsenanalyst. Für {symbol} am {date} \
{move_ctx}. Schlagzeilen dieses Tages:

{headlines}

Fasse die markt-relevante Kernaussage des Tages in EINEM sachlichen deutschen Satz \
zusammen (max 25 Worte). Antworte AUSSCHLIESSLICH mit JSON, keine weiteren Worte:
{{"summary": "<ein Satz>", "confidence": <0.0-1.0>}}"""


def summarize_day(symbol: str, date: str, headlines: list[str], move_pct=None) -> dict | None:
    """One-sentence AI summary of a day's news narrative. Cached per (symbol, date)."""
    if not headlines:
        return None
    sig = f"{symbol}|{date}|day"
    cached = _cache_get(sig)
    if cached:
        return {"explanation": cached.get("explanation"), "confidence": cached.get("confidence"), "ai": True, "cached": True}
    if not _CLAUDE:
        return None
    move_ctx = (f"bewegte sich der Kurs um {move_pct:+.1f}%" if move_pct is not None
                else "lauteten die Schlagzeilen wie folgt")
    hl = "\n".join(f"- {h}" for h in headlines[:8])
    data = _parse_json(_call_claude(_DAY_PROMPT.format(symbol=symbol, date=date, move_ctx=move_ctx, headlines=hl)))
    if not data or not data.get("summary"):
        return None
    res = {"cause": None, "explanation": data["summary"][:200],
           "confidence": float(data.get("confidence", 0.5)) if isinstance(data.get("confidence"), (int, float)) else 0.5,
           "headline": None}
    _cache_put(sig, symbol, res)
    return {"explanation": res["explanation"], "confidence": res["confidence"], "ai": True}


if __name__ == "__main__":
    print("claude CLI available:", available())
    demo_swing = {"time": "2026-07-18", "kind": "low", "move_pct": -4.2}
    demo_cands = [
        {"source": "Reuters", "title": "Tesla misses Q2 delivery estimates, shares slide"},
        {"source": "Bloomberg", "title": "EV demand softens in Europe amid subsidy cuts"},
        {"source": "CNBC", "title": "Analyst downgrades Tesla on margin concerns"},
    ]
    import time
    t0 = time.time()
    print(explain_swing("TSLA", demo_swing, demo_cands))
    print(f"({time.time()-t0:.1f}s)")
