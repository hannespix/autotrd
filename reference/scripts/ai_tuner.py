"""
ai_tuner — Claude-driven continuous improvement of the forecast (the bot's heart).

The EMPIRICAL loop (forecast_eval) already picks the best (w, lookback) combo from
realized accuracy — that is the reliable, data-driven self-tuning. This module adds
a QUALITATIVE layer: once a day, Claude Sonnet reviews the realized accuracy stats
and error patterns and proposes concrete, bounded improvements (new grid values to
try, regime observations, threshold tweaks).

SAFETY: it does NOT autonomously change live trading parameters. It records
recommendations (and may EXPAND the empirical search grid within hard bounds, since
every added candidate is still validated by realized accuracy before it's ever used).
Runs via cron (self-gated to once per day); degrades gracefully when the `claude`
CLI is unavailable (e.g. spend limit) — the empirical loop keeps working regardless.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path

_DB = Path.home() / ".hermes" / "trading" / "history.db"
_HARD_LOOKBACK = (5, 60)     # any AI-proposed lookback is clamped into this range
_HARD_WEIGHT = (0.0, 1.5)


def _connect():
    _DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(_DB, timeout=10)
    conn.execute("PRAGMA busy_timeout=8000")
    return conn


def _ensure():
    conn = _connect()
    try:
        conn.execute("""CREATE TABLE IF NOT EXISTS tuner_reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, scored INTEGER,
            dir_accuracy REAL, diagnosis TEXT, suggestions_json TEXT,
            applied_json TEXT, status TEXT)""")
        conn.commit()
    finally:
        conn.close()


def latest() -> dict | None:
    _ensure()
    conn = _connect()
    try:
        r = conn.execute("SELECT ts, scored, dir_accuracy, diagnosis, suggestions_json, applied_json, status "
                         "FROM tuner_reviews ORDER BY id DESC LIMIT 1").fetchone()
    finally:
        conn.close()
    if not r:
        return None
    return {"ts": r[0], "scored": r[1], "dir_accuracy": r[2], "diagnosis": r[3],
            "suggestions": json.loads(r[4] or "[]"), "applied": json.loads(r[5] or "[]"), "status": r[6]}


def _hours_since_last() -> float:
    last = latest()
    if not last or not last.get("ts"):
        return 1e9
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(last["ts"])).total_seconds() / 3600
    except Exception:
        return 1e9


_PROMPT = """Du bist ein quantitativer Analyst und verbesserst das Prognosemodell eines Paper-Trading-Bots.
Das Modell ist eine lineare Regression über die letzten `lookback` Tages-Schlusskurse plus ein
gedeckelter, volatilitäts-skalierter Sentiment-Tilt (Gewicht `w`). Ein empirischer Loop wählt
bereits automatisch die (w, lookback)-Kombination mit der besten realisierten Trefferquote.

Aktuelle realisierte Statistik:
{stats}

Aktuelle Suchgitter: w ∈ {wgrid}, lookback ∈ {lbgrid}.

Analysiere kurz und schlage KONKRETE, begründete Verbesserungen vor. Antworte AUSSCHLIESSLICH mit JSON:
{{"diagnosis": "<2-3 Sätze: was funktioniert, was nicht, welche Regime-Muster>",
"suggestions": ["<konkrete Empfehlung>", ...],
"expand_lookback": [<neue lookback-Kandidaten als Zahlen, oder leer>],
"expand_weight": [<neue w-Kandidaten als Zahlen, oder leer>]}}"""


def review(force: bool = False, min_scored: int = 20, min_hours: float = 20.0) -> dict:
    """Run a daily AI review of forecast accuracy. Self-gated; safe to call every scan."""
    import forecast_eval
    import forecaster
    _ensure()

    summ = forecast_eval.accuracy_summary()
    scored = summ.get("scored", 0)

    if not force:
        if scored < min_scored:
            return {"status": "waiting_for_data", "scored": scored}
        if _hours_since_last() < min_hours:
            return {"status": "recent_review_exists", **(latest() or {})}

    try:
        import ai_analyst
        if not ai_analyst.available():
            _record(summ, "KI nicht verfügbar (claude CLI fehlt oder Limit) — empirisches Tuning läuft weiter.",
                    [], [], status="ai_unavailable")
            return {"status": "ai_unavailable", **(latest() or {})}

        prompt = _PROMPT.format(
            stats=json.dumps({k: summ[k] for k in ("scored", "dir_accuracy", "mae_pct",
                              "best_weight", "best_lookback", "top_combos")}, ensure_ascii=False),
            wgrid=forecaster.WEIGHT_GRID, lbgrid=forecaster.LOOKBACK_GRID)
        data = ai_analyst._parse_json(ai_analyst._call_claude(prompt))
        if not data:
            _record(summ, "KI-Antwort nicht auswertbar.", [], [], status="ai_error")
            return {"status": "ai_error", **(latest() or {})}

        applied = _safely_expand_grids(forecaster, data.get("expand_lookback"), data.get("expand_weight"))
        _record(summ, data.get("diagnosis", ""), data.get("suggestions", []), applied, status="ok")
        return {"status": "ok", **(latest() or {})}
    except Exception as exc:
        _record(summ, f"Fehler: {exc}", [], [], status="error")
        return {"status": "error", "error": str(exc)}


def _safely_expand_grids(forecaster_mod, add_lb, add_w) -> list:
    """Add AI-proposed candidates to the empirical search grids, clamped to hard bounds.
    Every added value is still validated by realized accuracy before it can be chosen —
    so this cannot by itself make a bad parameter go live."""
    applied = []
    for v in (add_lb or []):
        try:
            iv = int(v)
        except (TypeError, ValueError):
            continue
        if _HARD_LOOKBACK[0] <= iv <= _HARD_LOOKBACK[1] and iv not in forecaster_mod.LOOKBACK_GRID:
            forecaster_mod.LOOKBACK_GRID.append(iv)
            forecaster_mod.LOOKBACK_GRID.sort()
            applied.append(f"lookback+={iv}")
    for v in (add_w or []):
        try:
            fv = round(float(v), 3)
        except (TypeError, ValueError):
            continue
        if _HARD_WEIGHT[0] <= fv <= _HARD_WEIGHT[1] and fv not in forecaster_mod.WEIGHT_GRID:
            forecaster_mod.WEIGHT_GRID.append(fv)
            forecaster_mod.WEIGHT_GRID.sort()
            applied.append(f"w+={fv}")
    return applied


def _record(summ, diagnosis, suggestions, applied, status):
    conn = _connect()
    try:
        conn.execute("INSERT INTO tuner_reviews (ts,scored,dir_accuracy,diagnosis,suggestions_json,applied_json,status) "
                     "VALUES (?,?,?,?,?,?,?)",
                     (datetime.now(timezone.utc).isoformat(), summ.get("scored", 0),
                      summ.get("dir_accuracy"), diagnosis, json.dumps(suggestions, ensure_ascii=False),
                      json.dumps(applied, ensure_ascii=False), status))
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    import sys
    print(json.dumps(review(force="--force" in sys.argv), indent=2, ensure_ascii=False))
