#!/usr/bin/env python3
"""
Daytrading cron task — one scan cycle for the auto-trading engine.

Only prints when something important happens:
  - Paper trades executed
  - Engine errors / failures
  - Significant signal shifts (HOLD → BUY/SELL)
Otherwise exits silently so no Telegram noise.
"""
import json
import sys
from datetime import datetime
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

TRADING_DIR = Path.home() / ".hermes" / "trading"
STATE_PATH = TRADING_DIR / "engine_state.json"


def _load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text())
        except Exception:
            pass
    return {"running": False}


def _save_state(state: dict):
    STATE_PATH.write_text(json.dumps(state, indent=2, default=str))


def main() -> int:
    from trading_engine import TradingEngine

    state = _load_state()
    running = bool(state.get("running", False))

    engine = TradingEngine()

    # Load previous signals to detect changes
    prev_signals_path = TRADING_DIR / "signals.json"
    prev_decisions = {}
    if prev_signals_path.exists():
        try:
            prev = json.loads(prev_signals_path.read_text())
            prev_decisions = {s["ticker"]: s.get("decision", "HOLD") for s in prev.get("results", [])}
        except Exception:
            pass

    if running:
        executed = engine.run_scan()
        summary = engine.get_signals().get("results", [])
    else:
        watchlist = engine.strategy.get("watchlist", [])
        summary = [engine._analyze_ticker(t) for t in watchlist]
        engine._save_json(
            "signals.json",
            {"timestamp": datetime.now().isoformat(), "results": summary},
        )
        executed = []

    # Collect important lines only
    important_lines = []
    for s in summary:
        ticker = s.get("ticker", "?")
        decision = s.get("decision", "HOLD")
        prev = prev_decisions.get(ticker, "HOLD")
        rsi = s.get("indicators", {}).get("rsi", "-")
        icon = {"BUY": "🟢", "SELL": "🔴", "HOLD": "⚪"}.get(decision, "⚪")

        # Print signal line if trading OR decision changed from HOLD
        if running or prev == "HOLD":
            important_lines.append(
                f"  {icon} {ticker:<6} {decision:<4} "
                f"(buy {s.get('buy_signals', 0)} / sell {s.get('sell_signals', 0)}, RSI={rsi})"
            )

    # Only output if there's something worth reporting
    if executed:
        print("=" * 60)
        print(f"🔍 Daytrading — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"   Engine: {'RUNNING' if running else 'STOPPED (scan only)'}")
        print("=" * 60)
        for line in important_lines:
            print(line)
        trades = executed if isinstance(executed, list) else [executed]
        for t in trades:
            if isinstance(t, dict):
                print(f"\n💰 Trade: {t.get('action','?').upper()} {t.get('symbol', t.get('ticker','?'))} "
                      f"@ ${t.get('price','?')} | qty={t.get('quantity','?')}")
        print(f"\n✅ {len(trades) if isinstance(trades, list) else 1} Trade(s) ausgeführt!")

    # Forecast eval — only report if there's a result
    try:
        import forecast_eval
        n = forecast_eval.evaluate_due()
        if n:
            summ = forecast_eval.accuracy_summary()
            print(f"\n📈 {n} Prognose(n) bewertet | Richtungstreffer {summ.get('dir_accuracy')}%")
    except Exception:
        pass

    # AI tuner — only report on success
    try:
        import ai_tuner
        res = ai_tuner.review()
        if res.get("status") == "ok":
            print(f"🧠 KI-Review: {res.get('diagnosis','')[:100]}")
    except Exception:
        pass

    # Record last scan time silently
    state["running"] = running
    state["last_scan"] = datetime.now().isoformat()
    _save_state(state)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"❌ Cron scan failed: {exc}", file=sys.stderr)
        sys.exit(1)
