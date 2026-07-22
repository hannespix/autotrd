"""
forecast_eval — self-improvement loop: score past forecasts, tune the weight.

Temporal safety (no lookahead):
  * evaluate_due() only scores forecasts whose target dates are already in the
    PAST, comparing them to what actually happened — that is hindsight scoring,
    not lookahead.
  * best_weight() only ever reads ALREADY-SCORED (realized) forecasts, so when
    forecaster.forecast() calls it to build a NEW forecast it uses history only.

Tables (in history.db):
  forecast_scores(forecast_id PK, evaluated_ts, mae_pct, dir_hit, n_points)
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

_DB = Path.home() / ".hermes" / "trading" / "history.db"

MIN_SAMPLES_PER_W = 8     # need this many scored forecasts for a weight before trusting it
MIN_TOTAL = 20            # need this many total scores before deviating from the default


def _connect():
    _DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(_DB, timeout=10)
    conn.execute("PRAGMA busy_timeout=8000")
    return conn


def _ensure():
    conn = _connect()
    try:
        conn.execute("""CREATE TABLE IF NOT EXISTS forecast_scores (
            forecast_id INTEGER PRIMARY KEY,
            evaluated_ts TEXT, mae_pct REAL, dir_hit INTEGER, n_points INTEGER)""")
        conn.commit()
    finally:
        conn.close()


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def evaluate_due(max_forecasts: int = 200) -> int:
    """Score every unscored forecast whose horizon has fully elapsed. Returns count scored."""
    from forecaster import _ensure as _fc_ensure
    _fc_ensure(); _ensure()
    today = _today()

    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT f.id, f.symbol, f.base_close, f.predicted_json FROM forecasts f "
            "LEFT JOIN forecast_scores s ON s.forecast_id = f.id "
            "WHERE s.forecast_id IS NULL ORDER BY f.id LIMIT ?", (max_forecasts,)).fetchall()
    finally:
        conn.close()
    if not rows:
        return 0

    # Only rows whose LAST predicted date is in the past are evaluable
    due = []
    for fid, sym, base_close, pj in rows:
        try:
            pts = json.loads(pj)
        except Exception:
            continue
        # strictly-past: the last target date must be BEFORE today so every target
        # has a final realized close (today's bar may be absent/unsettled)
        if pts and pts[-1]["time"] < today:
            due.append((fid, sym, base_close, pts))
    if not due:
        return 0

    # Fetch actuals once per symbol
    from market_data import fetch_historical
    actuals: dict[str, dict[str, float]] = {}
    for sym in {d[1] for d in due}:
        try:
            df = fetch_historical(sym, period="6mo")
            actuals[sym] = {str(idx)[:10]: float(r.get("Close", 0)) for idx, r in df.iterrows()}
        except Exception:
            actuals[sym] = {}

    scored = 0
    conn = _connect()
    try:
        for fid, sym, base_close, pts in due:
            amap = actuals.get(sym, {})
            # Require the FINAL horizon day to have a realized close before scoring,
            # so we never lock in a score that misses the last day (or uses a partial bar).
            last_day = pts[-1]["time"]
            if last_day not in amap or amap[last_day] <= 0:
                continue
            matched = [(p["value"], amap[p["time"]]) for p in pts if p["time"] in amap and amap[p["time"]] > 0]
            if not matched:
                continue
            mae = sum(abs(pred - act) / act for pred, act in matched) / len(matched) * 100
            pred_last, act_last = matched[-1]
            # directional hit relative to the forecast's own base close
            dir_hit = int((pred_last - base_close > 0) == (act_last - base_close > 0))
            conn.execute("INSERT OR REPLACE INTO forecast_scores VALUES (?,?,?,?,?)",
                         (fid, datetime.now(timezone.utc).isoformat(), round(mae, 4), dir_hit, len(matched)))
            scored += 1
        conn.commit()
    finally:
        conn.close()
    return scored


def _combo_stats() -> dict[tuple, dict]:
    """Realized accuracy per (sentiment weight, lookback) combo (scored forecasts only)."""
    from forecaster import _ensure as _fc_ensure
    _fc_ensure(); _ensure()
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT f.w, COALESCE(f.lookback,20), s.dir_hit, s.mae_pct FROM forecast_scores s "
            "JOIN forecasts f ON f.id = s.forecast_id").fetchall()
    finally:
        conn.close()
    stats: dict[tuple, dict] = {}
    for w, lb, dh, mae in rows:
        d = stats.setdefault((w, lb), {"n": 0, "hits": 0, "mae_sum": 0.0})
        d["n"] += 1; d["hits"] += int(dh or 0); d["mae_sum"] += (mae or 0)
    for d in stats.values():
        d["dir_acc"] = d["hits"] / d["n"] if d["n"] else 0.0
        d["mae_pct"] = d["mae_sum"] / d["n"] if d["n"] else 0.0
    return stats


def best_params() -> dict:
    """Self-tuned {w, lookback}: best realized directional accuracy (tiebreak: lowest MAE).
    Falls back to defaults until enough evidence has accumulated (no lookahead)."""
    from forecaster import DEFAULT_W, DEFAULT_LOOKBACK
    stats = _combo_stats()
    total = sum(d["n"] for d in stats.values())
    if total < MIN_TOTAL:
        return {"w": DEFAULT_W, "lookback": DEFAULT_LOOKBACK}
    eligible = {k: d for k, d in stats.items() if d["n"] >= MIN_SAMPLES_PER_W}
    if not eligible:
        return {"w": DEFAULT_W, "lookback": DEFAULT_LOOKBACK}
    (bw, blb), _ = max(eligible.items(), key=lambda kv: (kv[1]["dir_acc"], -kv[1]["mae_pct"]))
    return {"w": bw, "lookback": int(blb)}


def best_weight() -> float:
    """Back-compat: the self-tuned sentiment weight only."""
    return best_params()["w"]


def accuracy_summary() -> dict:
    """Overall + per-combo accuracy for the UI (the visible 'self-improvement')."""
    from forecaster import DEFAULT_W, DEFAULT_LOOKBACK
    stats = _combo_stats()
    total = sum(d["n"] for d in stats.values())
    hits = sum(d["hits"] for d in stats.values())
    mae = (sum(d["mae_sum"] for d in stats.values()) / total) if total else 0.0
    bp = best_params()
    top = sorted(stats.items(), key=lambda kv: (kv[1]["dir_acc"], -kv[1]["mae_pct"]), reverse=True)
    return {
        "scored": total,
        "dir_accuracy": round(hits / total * 100, 1) if total else None,
        "mae_pct": round(mae, 2) if total else None,
        "best_weight": bp["w"], "best_lookback": bp["lookback"],
        "tuning_active": total >= MIN_TOTAL,
        "default_weight": DEFAULT_W, "default_lookback": DEFAULT_LOOKBACK,
        "combos_tracked": len(stats),
        "top_combos": [{"w": w, "lookback": int(lb), "n": d["n"],
                        "dir_acc": round(d["dir_acc"] * 100, 1), "mae_pct": round(d["mae_pct"], 2)}
                       for (w, lb), d in top[:6]],
    }


if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    scored = evaluate_due()
    print(f"evaluated {scored} due forecast(s)")
    import json as _j
    print(_j.dumps(accuracy_summary(), indent=2))
