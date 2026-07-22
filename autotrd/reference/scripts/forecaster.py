"""
forecaster — sentiment-weighted price forecast with a self-tuning ensemble.

Design (honest heuristic, NOT a market oracle):
  * Baseline: least-squares linear regression over the last N daily closes → a
    drift `slope`, projected `horizon` weekdays ahead, with a ±1σ residual band.
  * Sentiment tilt: the drift is nudged in the direction of current news sentiment
    (sentiment.aggregate → overall ∈ [-1,1]), scaled by recent daily volatility so
    a bullish/bearish read moves a volatile name more than a calm one. Bounded.
  * Self-tuning: every time we forecast, we log SHADOW forecasts for a grid of
    sentiment weights w ∈ WEIGHT_GRID. Later, forecast_eval scores each against
    realized prices. The LIVE forecast uses the weight that has historically had
    the best realized accuracy — so it tunes itself with zero lookahead (tuning
    only ever reads already-realized past forecasts).

Tables live in ~/.hermes/trading/history.db:
  forecasts(id, made_ts, symbol, base_date, base_close, horizon, w, sentiment,
            daily_vol, predicted_json)
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

_DB = Path.home() / ".hermes" / "trading" / "history.db"

WEIGHT_GRID = [0.0, 0.25, 0.5, 0.75, 1.0]   # sentiment weights the loop chooses among
LOOKBACK_GRID = [10, 20, 30]                 # regression windows the loop chooses among
DEFAULT_W = 0.5
DEFAULT_LOOKBACK = 20
LOOKBACK = DEFAULT_LOOKBACK                   # back-compat alias
HORIZON = 6                                  # weekdays projected
_TILT_CAP = 1.5                              # tilt ≤ this × baseline daily volatility


# ── schema ───────────────────────────────────────────────────────────────────

def _connect() -> sqlite3.Connection:
    _DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(_DB, timeout=10)
    conn.execute("PRAGMA busy_timeout=8000")
    return conn


def _ensure():
    conn = _connect()
    try:
        conn.execute("""CREATE TABLE IF NOT EXISTS forecasts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            made_ts TEXT, symbol TEXT, base_date TEXT, base_close REAL,
            horizon INTEGER, w REAL, sentiment REAL, daily_vol REAL,
            predicted_json TEXT)""")
        # migrate: add the lookback dimension (tuned alongside the sentiment weight)
        cols = [r[1] for r in conn.execute("PRAGMA table_info(forecasts)").fetchall()]
        if "lookback" not in cols:
            conn.execute("ALTER TABLE forecasts ADD COLUMN lookback INTEGER DEFAULT 20")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_fc_sym ON forecasts(symbol, base_date)")
        # DB-level dedup: one row per (symbol, base_date, w, lookback) combo so
        # concurrent writers (dashboard + cron) can't double-log and bias the stats.
        conn.execute("DROP INDEX IF EXISTS idx_fc_uniq")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_fc_uniq2 ON forecasts(symbol, base_date, w, lookback)")
        conn.commit()
    finally:
        conn.close()


# ── helpers ──────────────────────────────────────────────────────────────────

def _next_weekdays(base_date: str, n: int) -> list[str]:
    d = datetime.fromisoformat(base_date).replace(tzinfo=timezone.utc)
    out = []
    while len(out) < n:
        d += timedelta(days=1)
        if d.weekday() < 5:           # Mon..Fri
            out.append(d.strftime("%Y-%m-%d"))
    return out


def _linreg(ys: list[float]):
    n = len(ys)
    sx = sum(range(n)); sy = sum(ys)
    sxx = sum(i * i for i in range(n))
    sxy = sum(i * ys[i] for i in range(n))
    denom = (n * sxx - sx * sx) or 1e-9
    slope = (n * sxy - sx * sy) / denom
    intercept = (sy - slope * sx) / n
    ss = sum((ys[i] - (intercept + slope * i)) ** 2 for i in range(n))
    sigma = (ss / max(n - 2, 1)) ** 0.5
    return slope, intercept, sigma


def _daily_vol(closes: list[float]) -> float:
    """Mean absolute day-over-day price change over the window."""
    if len(closes) < 2:
        return 0.0
    diffs = [abs(closes[i] - closes[i - 1]) for i in range(1, len(closes))]
    return sum(diffs) / len(diffs)


# ── core forecast ────────────────────────────────────────────────────────────

def compute(closes: list[float], base_date: str, sentiment: float, w: float,
            horizon: int = HORIZON, lookback: int = DEFAULT_LOOKBACK) -> dict | None:
    """Return {points, band, slope, tilt, ...} for one (sentiment, weight, lookback) combo.

    `closes` must be oldest→newest daily closes; `base_date` is the last bar's date.
    """
    n = min(lookback, len(closes))
    if n < 5:
        return None
    seg = closes[-n:]
    slope, intercept, sigma = _linreg(seg)
    vol = _daily_vol(seg)
    last = seg[-1]

    # bounded sentiment tilt per bar
    tilt = w * float(sentiment) * vol
    cap = _TILT_CAP * vol
    tilt = max(-cap, min(cap, tilt))
    slope_adj = slope + tilt

    dates = _next_weekdays(base_date, horizon)
    points, band = [], []
    for k, dt in enumerate(dates, start=1):
        y = last + slope_adj * k
        bandw = sigma * (1 + k / n) ** 0.5
        points.append({"time": dt, "value": round(y, 4)})
        band.append({"time": dt, "upper": round(y + bandw, 4), "lower": round(y - bandw, 4)})
    return {
        "points": points, "band": band,
        "slope": round(slope, 5), "slope_adj": round(slope_adj, 5),
        "tilt": round(tilt, 5), "daily_vol": round(vol, 5),
        "sigma": round(sigma, 5), "base_close": round(last, 4), "lookback": lookback,
    }


def _already_logged(symbol: str, base_date: str) -> bool:
    _ensure()
    conn = _connect()
    try:
        r = conn.execute("SELECT 1 FROM forecasts WHERE symbol=? AND base_date=? LIMIT 1",
                         (symbol, base_date)).fetchone()
        return r is not None
    finally:
        conn.close()


def _log_shadows(symbol: str, base_date: str, base_close: float, sentiment: float,
                 daily_vol: float, combos: list):
    """combos: list of (w, lookback, forecast_dict)."""
    _ensure()
    conn = _connect()
    try:
        made = datetime.now(timezone.utc).isoformat()
        for w, lb, fc in combos:
            conn.execute(
                "INSERT OR IGNORE INTO forecasts (made_ts,symbol,base_date,base_close,horizon,w,"
                "sentiment,daily_vol,predicted_json,lookback) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (made, symbol, base_date, base_close, len(fc["points"]), w, sentiment,
                 daily_vol, json.dumps(fc["points"]), lb))
        conn.commit()
    finally:
        conn.close()


def forecast(symbol: str, closes: list[float], base_date: str, sentiment: float,
             horizon: int = HORIZON, log: bool = True) -> dict | None:
    """Public entry: live forecast using the self-tuned best weight, and (once per
    symbol+base_date) log shadow forecasts across WEIGHT_GRID for later scoring."""
    symbol = symbol.strip().upper()
    import forecast_eval
    bp = forecast_eval.best_params()
    best_w, best_lb = bp["w"], bp["lookback"]

    live = compute(closes, base_date, sentiment, best_w, horizon, best_lb)
    if live is None:
        return None
    live["w"] = best_w
    live["sentiment"] = round(float(sentiment), 3)

    if log and not _already_logged(symbol, base_date):
        combos = []
        for w in WEIGHT_GRID:
            for lb in LOOKBACK_GRID:
                fc = compute(closes, base_date, sentiment, w, horizon, lb)
                if fc:
                    combos.append((w, lb, fc))
        if combos:
            _log_shadows(symbol, base_date, live["base_close"], sentiment,
                         live["daily_vol"], combos)
    return live


if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from market_data import fetch_historical
    import news_feed, sentiment as sm
    sym = sys.argv[1] if len(sys.argv) > 1 else "AAPL"
    df = fetch_historical(sym, period="3mo")
    closes = [float(r.get("Close", 0)) for _, r in df.iterrows()]
    base = str(df.index[-1])[:10]
    agg = sm.aggregate(sm.analyze_items(news_feed.get_news(sym, 40)))
    fc = forecast(sym, closes, base, agg["overall"])
    print(f"{sym} base {base} close {fc['base_close']} | sentiment {agg['overall']:+.2f} "
          f"| best_w {fc['w']} | slope {fc['slope']:+.3f} → adj {fc['slope_adj']:+.3f} (tilt {fc['tilt']:+.3f})")
    for p in fc["points"]:
        print(f"   {p['time']}  {p['value']}")
