"""
history_store — append-only SQLite time-series log of every observation.

Each engine scan and each dashboard price query appends a row per symbol, so
indicator/price trends can be charted over time (RSI drift, MACD crossovers,
price path) instead of only seeing the latest snapshot.

Concurrency: the cron scan process and the dashboard process both write, so we
use WAL mode + a busy timeout and open a short-lived connection per call.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path

DB_PATH = Path.home() / ".hermes" / "trading" / "history.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS observations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT    NOT NULL,
    symbol      TEXT    NOT NULL,
    price       REAL,
    rsi         REAL,
    macd_line   REAL,
    signal_line REAL,
    bb_pct      REAL,
    decision    TEXT,
    source      TEXT
);
CREATE INDEX IF NOT EXISTS idx_obs_symbol_ts ON observations(symbol, ts);
"""

_METRICS = ("price", "rsi", "macd_line", "signal_line", "bb_pct")


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=8000")
    return conn


def _ensure() -> None:
    conn = _connect()
    try:
        conn.executescript(_SCHEMA)
        conn.commit()
    finally:
        conn.close()


def log_observation(symbol: str, *, price=None, rsi=None, macd_line=None,
                    signal_line=None, bb_pct=None, decision=None,
                    source: str = "scan", ts: str | None = None) -> None:
    """Append one observation. Silently no-ops on DB errors (never break a scan)."""
    if not symbol:
        return
    try:
        _ensure()
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO observations "
                "(ts, symbol, price, rsi, macd_line, signal_line, bb_pct, decision, source) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (ts or datetime.now().isoformat(), symbol.upper(),
                 _f(price), _f(rsi), _f(macd_line), _f(signal_line), _f(bb_pct),
                 decision, source),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass


def history(symbol: str, limit: int = 500) -> list[dict]:
    """Return the most recent `limit` observations for `symbol`, oldest-first."""
    try:
        _ensure()
        conn = _connect()
        try:
            cur = conn.execute(
                "SELECT ts, price, rsi, macd_line, signal_line, bb_pct, decision "
                "FROM observations WHERE symbol=? ORDER BY id DESC LIMIT ?",
                (symbol.upper(), int(limit)),
            )
            cols = ("ts", "price", "rsi", "macd_line", "signal_line", "bb_pct", "decision")
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
            return list(reversed(rows))
        finally:
            conn.close()
    except Exception:
        return []


def tracked_symbols() -> list[str]:
    """Distinct symbols that have any logged history."""
    try:
        _ensure()
        conn = _connect()
        try:
            cur = conn.execute("SELECT DISTINCT symbol FROM observations ORDER BY symbol")
            return [r[0] for r in cur.fetchall()]
        finally:
            conn.close()
    except Exception:
        return []


def _f(v):
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


if __name__ == "__main__":
    _ensure()
    syms = tracked_symbols()
    print(f"history.db @ {DB_PATH}")
    print(f"tracked symbols: {syms or '(none yet)'}")
    for s in syms:
        print(f"  {s}: {len(history(s, 10000))} observations")
