"""
Trading Dashboard Server — FastAPI + Static HTML Dashboard für Auto-Trading
Port: 8080 | Host: 0.0.0.0 (LAN-accessible)
Features: Strategy Editor, Live Positions, P&L Overview, Manual Override, Signal Monitor
"""
import uvicorn
import asyncio
import json
import yaml # type: ignore
import os
import sys
import pandas as pd
from pathlib import Path
from datetime import datetime
from threading import Lock

try:
    from fastapi import FastAPI, Request, HTTPException, Query
    from fastapi.staticfiles import StaticFiles
    from fastapi.responses import HTMLResponse, JSONResponse
    from fastapi.middleware.cors import CORSMiddleware
except ImportError:
    raise RuntimeError("fastapi not found. pip install fastapi uvicorn pyyaml")

# ── Import Resolution for sibling modules ────────────
_SKILL_DIR = Path(__file__).resolve().parent.parent  # daytrading/
_TA_DIR = _SKILL_DIR / "technical-analysis" / "scripts"
for _p in [_SKILL_DIR, _TA_DIR]:
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

# ── Configuration Paths ───────────────────────────────

TRADING_DIR = Path.home() / ".hermes" / "trading"
STRATEGY_PATH = TRADING_DIR / "strategy.yaml"
POSITIONS_PATH = TRADING_DIR / "positions.json"
TRADE_LOG_PATH = TRADING_DIR / "trade_log.json"
STATE_PATH = TRADING_DIR / "engine_state.json"
TRADING_DIR.mkdir(exist_ok=True)

# ── State Store (Thread-safe) ─────────────────────────

state_lock = Lock()

def _load_json(path, default=None):
    if default is None:
        default = {}
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            return default
    return default

def _save_json(path, data):
    path.write_text(json.dumps(data, indent=2, default=str))

def _log_prices(out_flat: dict, source: str) -> None:
    """Append a price-only observation for each symbol (best-effort, never raises)."""
    try:
        import history_store
        for sym, price in out_flat.items():
            if price is not None:
                history_store.log_observation(sym, price=price, source=source)
    except Exception:
        pass

# ── FastAPI App ───────────────────────────────────────

app = FastAPI(title="AutoTrading Dashboard", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.get("/api/broker")
def get_broker_ep():
    """Connected broker status (paper sim or Alpaca paper/live) + account summary."""
    try:
        import broker
        strat = yaml.safe_load(STRATEGY_PATH.read_text()) if STRATEGY_PATH.exists() else {}
        return broker.get_broker(strat or {}).status()
    except Exception as exc:
        raise HTTPException(500, str(exc))

@app.get("/api/status")
def status():
    """Engine health check."""
    return {
        "engine": _load_json(STATE_PATH).get("running", False),
        "last_check": datetime.now().isoformat(),
        "positions_open": len(_load_json(POSITIONS_PATH)),
    }

@app.get("/api/strategy")
def get_strategy():
    """Load current strategy config."""
    if not STRATEGY_PATH.exists():
        raise HTTPException(404, "No strategy.yaml found")
    return yaml.safe_load(STRATEGY_PATH.read_text())

@app.post("/api/strategy")
async def update_strategy(request: Request):
    """Save new strategy config from dashboard."""
    body = await request.json()
    STRATEGY_PATH.write_text(yaml.dump(body, default_flow_style=False))
    return {"ok": True}

@app.get("/api/positions")
def get_positions():
    """Live positions (paper trading)."""
    return _load_json(POSITIONS_PATH)

@app.post("/api/manual/trade")
async def manual_trade(request: Request):
    """Manual buy/sell override."""
    body = await request.json()
    symbol = str(body.get("symbol", "")).upper()
    side = str(body.get("side", "")).lower()
    price = float(body.get("price", 0))
    qty = int(body.get("qty", 1))
    
    if not all([symbol, side in ("buy","sell"), price > 0]):
        raise HTTPException(400, "Invalid trade params: symbol+side+price required")

    with state_lock:
        positions = _load_json(POSITIONS_PATH)
        log = _load_json(TRADE_LOG_PATH)
        
        trade_id = len(log) + 1
        entry = {
            "id": trade_id, "timestamp": datetime.now().isoformat(),
            "symbol": symbol, "side": side, "price": price,
            "qty": qty, "manual": True,
        }
        log.append(entry)
        
        if side == "buy":
            positions[symbol] = {"qty": qty, "entry_price": price, "ts": entry["timestamp"]}
        elif symbol in positions:
            old = positions[symbol]
            pnl = (price - old["entry_price"]) * old["qty"]
            entry["pnl"] = round(pnl, 2)
            del positions[symbol]

        _save_json(TRADE_LOG_PATH, log)
        _save_json(POSITIONS_PATH, positions)
    
    return {"ok": True, "trade_id": trade_id}

@app.post("/api/engine/action")
async def engine_action(request: Request):
    """Start/stop/pause the auto-trading engine."""
    body = await request.json()
    action = body.get("action", "").lower()  # start | stop | pause

    with state_lock:
        state = _load_json(STATE_PATH)
        if action == "start":
            state["running"] = True
            state["started_at"] = datetime.now().isoformat()
        elif action in ("stop", "pause"):
            state["running"] = False

        _save_json(STATE_PATH, state)

    return {"ok": True, "engine_running": state.get("running")}

@app.post("/api/scan")
async def run_scan():
    """Trigger one scan of the trading engine right now."""
    try:
        from trading_engine import TradingEngine
        te = TradingEngine()
        executed = te.run_scan()
        signals = te.get_signals()
        return {
            "ok": True,
            "trades_executed": len(executed),
            "signals": signals.get("results", []),
        }
    except Exception as exc:
        raise HTTPException(500, str(exc))

@app.get("/api/signals")
def get_signals():
    """Load last computed trading signals."""
    return _load_json(Path.home() / ".hermes" / "trading" / "signals.json", {})

@app.get("/api/portfolio")
def get_portfolio():
    """Full portfolio state with live P&L."""
    try:
        from trading_engine import TradingEngine
        te = TradingEngine()
        return te.portfolio
    except Exception as exc:
        raise HTTPException(500, str(exc))

@app.get("/api/journal")
def get_journal(limit: int = Query(50)):
    """Trade execution history."""
    log = _load_json(TRADE_LOG_PATH, default=[])
    if isinstance(log, list):
        return log[-limit:]
    return []

@app.get("/api/pnl")
def calc_pnl():
    """Current P&L summary."""
    positions = _load_json(POSITIONS_PATH)
    log = _load_json(TRADE_LOG_PATH, default=[]) if isinstance(_load_json(TRADE_LOG_PATH, default=[]), list) else []
    
    closed_pnls = [t.get("pnl", 0) for t in log if "pnl" in t]
    total_closed = sum(closed_pnls) if closed_pnls else 0
    wins = sum(1 for p in closed_pnls if p > 0)
    losses = sum(1 for p in closed_pnls if p < 0)
    
    strat = _load_json(STRATEGY_PATH) if os.path.exists(STRATEGY_PATH) else {}
    base_capital = float(strat.get("broker", {}).get("initial_capital", 25000))
    
    return {
        "base_capital": base_capital,
        "closed_pnl": round(total_closed, 2),
        "total_equity_estimate": round(base_capital + total_closed, 2),
        "win_rate_pct": round((wins/max(wins+losses,1))*100, 1),
        "total_trades": len(log),
        "open_positions": len(positions),
    }

_SUGGEST_CACHE = {}

@app.get("/api/suggestions")
def get_suggestions_ep(limit: int = Query(14)):
    """Screen a curated liquid universe for what's moving now — attractive picks."""
    import time as _t
    hit = _SUGGEST_CACHE.get("data")
    if hit and (_t.time() - hit[0]) < 300:
        rows = hit[1]
    else:
        from market_universe import name_map
        from market_data import get_multiple
        # curated liquid candidates across stocks / ETFs / crypto
        cands = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","JPM",
                 "SPY","QQQ","IWM","SMH","ARKK","XLE","XLF","GLD",
                 "BTC-USD","ETH-USD","SOL-USD","COIN","MSTR","PLTR"]
        raw = get_multiple(cands)
        names = name_map()
        rows = []
        for s, info in raw.items():
            if isinstance(info, dict) and info.get("change_pct") is not None and info.get("price"):
                rows.append({"symbol": s, "name": names.get(s, s),
                             "price": info["price"], "change_pct": info["change_pct"]})
        rows.sort(key=lambda r: abs(r["change_pct"]), reverse=True)
        _SUGGEST_CACHE["data"] = (_t.time(), rows)
    top = []
    for r in rows[:limit]:
        top.append({**r, "direction": "up" if r["change_pct"] > 0 else "down",
                    "reason": "starker Aufwärts-Move" if r["change_pct"] > 0 else "starker Abwärts-Move"})
    return {"suggestions": top,
            "gainers": [r for r in rows if r["change_pct"] > 0][:6],
            "losers":  [r for r in rows if r["change_pct"] < 0][:6]}

@app.get("/api/catalog")
def get_catalog():
    """Full tradeable-asset catalog (asset classes -> groups -> [symbol, name])."""
    from market_universe import CATALOG, CLASS_LABELS
    return {
        "labels": CLASS_LABELS,
        "classes": {cls: {grp: [{"symbol": s, "name": n} for s, n in items]
                          for grp, items in groups.items()}
                    for cls, groups in CATALOG.items()},
    }

@app.get("/api/overview")
def get_overview(cls: str = Query("indices")):
    """Live quotes for every symbol in one asset class, grouped for a grid view."""
    from market_universe import CATALOG, CLASS_LABELS
    from market_data import get_multiple
    groups = CATALOG.get(cls)
    if not groups:
        raise HTTPException(404, f"Unknown asset class '{cls}'")
    syms = [s for g in groups.values() for s, _ in g]
    raw = get_multiple(syms)
    def q(sym):
        info = raw.get(sym)
        if isinstance(info, dict):
            return {"price": info.get("price"), "change_pct": info.get("change_pct")}
        return {"price": None, "change_pct": None}
    out = {}
    for grp, items in groups.items():
        out[grp] = [{"symbol": s, "name": n, **q(s)} for s, n in items]
    _log_prices(out_flat={s: q(s)["price"] for g in groups.values() for s, _ in g}, source="overview")
    return {"class": cls, "label": CLASS_LABELS.get(cls, cls), "groups": out}

@app.get("/api/pulse")
def get_pulse():
    """Compact cross-asset 'market pulse' strip (indices, fx, crypto, commodities, rates)."""
    from market_universe import MARKET_PULSE, name_map
    from market_data import get_multiple
    names = name_map()
    raw = get_multiple(MARKET_PULSE)
    out = []
    for sym in MARKET_PULSE:
        info = raw.get(sym)
        d = info if isinstance(info, dict) else {}
        out.append({"symbol": sym, "name": names.get(sym, sym),
                    "price": d.get("price"), "change_pct": d.get("change_pct")})
    _log_prices({x["symbol"]: x["price"] for x in out}, source="pulse")
    return out

@app.get("/api/quotes")
def get_quotes(symbols: str = Query("SPY,QQQ")):
    """Lightweight batch price lookup for the live ticker bar (no indicators)."""
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    out = {}
    try:
        from market_data import get_multiple
        raw = get_multiple(syms)
        for sym, info in raw.items():
            if isinstance(info, dict):
                out[sym] = {"price": info.get("price"), "change_pct": info.get("change_pct")}
            else:
                out[sym] = {"price": None, "change_pct": None}
    except Exception as exc:
        raise HTTPException(500, str(exc))
    _log_prices({s: v.get("price") for s, v in out.items()}, source="quote")
    return out

# Timeframe presets — label → (period, interval) mapping
# Each row uses the MAX period yfinance allows for that interval → full visibility
# yfinance range limits: 5m->60d, 15m->60d, 60m->120d, 1d->max
TIMEFRAMES = {
    "session": ("1d",   "5m"),   # Today only — ~78 bars, market open→close precision
    "1h":      ("5d",   "5m"),   # Full week of 5min bars — ~390 bars intraday pattern recognition
    "4h":      ("2wk",  "15m"),  # Two weeks at 15min — ~312 bars, multi-week micro-structure
    "1D":      ("60d",  "60m"),  # Monthly hourly view — ~960 bars, supports daily level mapping
    "1W":      ("3mo",  "1d"),   # Quarterly daily — ~64 bars structural pivot points
    "3M":      ("6mo",  "1d"),   # Half-year daily — ~130 bars medium-term arc
    "1Y":      ("2y",   "1d"),   # Two years daily — ~504 bars major support/resistance zones
}

@app.get("/api/price")
def get_price(symbol: str = Query("SPY"), period: str = Query("5d"), interval: str = Query("1d")):
    """Fetch live price + historical data + technical indicators for a ticker.
    
    Args:
        symbol:   Ticker symbol (e.g. AAPL, SPY, EURUSD=X)
        period:   yfinance period string (1d, 5d, 1mo, 3mo, 6mo, 1y, 2y)
        interval: Bar granularity — "5m", "15m", "30m", "60m" or "1d"
    """
    sym = symbol.strip().upper()
    
    results = {}
    price_info = None
    # Indicators need at least 3mo of daily bars regardless of chart window.
    _rank = {"1d": 1, "2d": 1, "5d": 2, "1mo": 3, "3mo": 4, "6mo": 5, "1y": 6, "2y": 7}
    ta_period = period if _rank.get(period, 2) >= _rank["3mo"] else "3mo"

    # Fetch live price + chart history
    try:
        from market_data import fetch_price, fetch_historical

        price_info = fetch_price(sym)
        results["current"] = price_info
        # Convenience top-level fields for the frontend
        results["price"] = price_info.get("price")
        results["change_pct"] = price_info.get("change_pct")
        try:
            from market_universe import resolve_name
            results["name"] = resolve_name(sym)
        except Exception:
            results["name"] = sym

        hist_df = fetch_historical(sym, period=period, interval=interval)
        history_rows = []
        for idx, row in hist_df.iterrows():
            history_rows.append({
                "date": str(idx),
                "open": float(row.get("Open", 0)),
                "high": float(row.get("High", 0)),
                "low": float(row.get("Low", 0)),
                "close": float(row.get("Close", 0)),
                "volume": float(row.get("Volume", 0)),
            })
        results["historical"] = history_rows
    except Exception as exc:
        results["error"] = str(exc)

    # Technical indicators (optional — chart still works without them)
    try:
        import technical_analysis as ta

        rsi_res = ta.rsi(sym, ticker=sym, period=ta_period)
        rsi_val = round(float(rsi_res.get("current_rsi", 0)), 2)
        results["rsi"] = rsi_val

        macd_res = ta.macd(sym, ticker=sym, period=ta_period)
        macd_line = round(float(macd_res.get("macd_line", 0)), 4)
        signal_line = round(float(macd_res.get("signal_line", 0)), 4)
        results["macd_line"] = macd_line
        results["signal_line"] = signal_line

        bb_res = ta.bollinger_bands(sym, ticker=sym, period=ta_period)
        bb_u = round(float(bb_res.get("upper", 0)), 2)
        bb_l = round(float(bb_res.get("lower", 0)), 2)
        results["bb_upper"] = bb_u
        results["bb_lower"] = bb_l
        current_p = float(price_info.get("price", 0)) if price_info else 0
        bb_range = (bb_u - bb_l) or 1e-9
        bb_pos = round((current_p - bb_l) / bb_range * 100, 1) if current_p else 50.0
        results["bb_position"] = bb_pos

        # Derive a lightweight overall signal (mirrors the engine's confluence idea)
        buy = (rsi_val < 30) + (macd_line > signal_line) + (bb_pos < 20)
        sell = (rsi_val > 70) + (macd_line < signal_line) + (bb_pos > 80)
        results["signal"] = "buy" if buy >= 2 and buy > sell else "sell" if sell >= 2 and sell > buy else "hold"

        # Append this query to the time-series store so viewing a symbol builds its trend
        try:
            import history_store
            history_store.log_observation(
                sym, price=results.get("price"), rsi=rsi_val,
                macd_line=macd_line, signal_line=signal_line, bb_pct=bb_pos,
                decision=results.get("signal", "").upper() or None, source="view",
            )
        except Exception:
            pass
    except Exception as exc:
        results.setdefault("indicator_error", str(exc))

    return results

@app.get("/api/news")
def get_news_ep(symbol: str = Query("SPY"), limit: int = Query(40)):
    """Recent news + social for a symbol, each with rule-based sentiment, plus an aggregate."""
    try:
        import news_feed, sentiment as sm
        items = sm.analyze_items(news_feed.get_news(symbol.strip().upper(), limit=limit))
        return {
            "symbol": symbol.strip().upper(),
            "aggregate": sm.aggregate(items),
            "items": [{
                "title": it["title"], "source": it["source"], "url": it.get("url", ""),
                "ts": it.get("ts", ""), "kind": it.get("kind", "news"),
                "sentiment": it["sent"]["sentiment"], "label": it["sent"]["label"],
                "event_types": it["sent"]["event_types"],
            } for it in items],
        }
    except Exception as exc:
        raise HTTPException(500, str(exc))

@app.get("/api/sentiment")
def get_sentiment_ep(symbol: str = Query("SPY")):
    """Aggregate news+social sentiment (a prediction feature)."""
    try:
        import news_feed, sentiment as sm
        items = sm.analyze_items(news_feed.get_news(symbol.strip().upper(), limit=60))
        return {"symbol": symbol.strip().upper(), **sm.aggregate(items)}
    except Exception as exc:
        raise HTTPException(500, str(exc))

@app.get("/api/events")
def get_events_ep(symbol: str = Query("SPY"), period: str = Query("3mo"), ai: int = Query(1)):
    """News-day markers aligned to the chart (sentiment-coloured, swing-aware, AI-summarised)."""
    try:
        from market_data import fetch_historical
        import event_engine
        df = fetch_historical(symbol.strip().upper(), period=period)
        bars = [{"time": str(idx)[:10], "open": float(r.get("Open", 0)), "high": float(r.get("High", 0)),
                 "low": float(r.get("Low", 0)), "close": float(r.get("Close", 0))} for idx, r in df.iterrows()]
        markers = event_engine.build_events(symbol.strip().upper(), bars, use_ai=bool(ai), max_ai=3)
        return {"symbol": symbol.strip().upper(), "markers": markers}
    except Exception as exc:
        raise HTTPException(500, str(exc))

@app.get("/api/forecast")
def get_forecast_ep(symbol: str = Query("SPY"), period: str = Query("3mo")):
    """Sentiment-weighted, self-tuned price forecast (dashed line + band on the chart)."""
    try:
        from market_data import fetch_historical
        import news_feed, sentiment as sm, forecaster
        sym = symbol.strip().upper()
        df = fetch_historical(sym, period=period)
        closes = [float(r.get("Close", 0)) for _, r in df.iterrows() if float(r.get("Close", 0)) > 0]
        if len(closes) < 5:
            return {"symbol": sym, "forecast": None}
        base_date = str(df.index[-1])[:10]
        agg = sm.aggregate(sm.analyze_items(news_feed.get_news(sym, limit=40)))
        fc = forecaster.forecast(sym, closes, base_date, agg.get("overall", 0.0))
        return {"symbol": sym, "sentiment": agg.get("overall", 0.0),
                "sent_label": agg.get("label", "neutral"), "forecast": fc}
    except Exception as exc:
        raise HTTPException(500, str(exc))

@app.get("/api/tuner")
def get_tuner_ep(run: int = Query(0)):
    """AI meta-tuner: Claude's latest review of forecast accuracy + proposed improvements."""
    try:
        import ai_tuner
        if run:
            ai_tuner.review(force=True)
        return ai_tuner.latest() or {"status": "none"}
    except Exception as exc:
        raise HTTPException(500, str(exc))

@app.get("/api/accuracy")
def get_accuracy_ep(evaluate: int = Query(0)):
    """Self-improvement metrics: realized forecast accuracy + the tuned weight."""
    try:
        import forecast_eval
        if evaluate:
            forecast_eval.evaluate_due()
        return forecast_eval.accuracy_summary()
    except Exception as exc:
        raise HTTPException(500, str(exc))

@app.get("/api/history")
def get_history(symbol: str = Query("SPY"), limit: int = Query(500)):
    """Logged time-series observations for a symbol (for trend charts)."""
    try:
        import history_store
        return {"symbol": symbol.strip().upper(),
                "observations": history_store.history(symbol.strip().upper(), limit)}
    except Exception as exc:
        raise HTTPException(500, str(exc))

# Serve static files if dashboard/index.html exists
STATIC_DIR = Path(__file__).parent / "static"
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/")
async def dashboard_root():
    """Main trading dashboard page."""
    html_path = STATIC_DIR / "index.html"
    if not html_path.exists():
        return HTMLResponse("<h1>Trading Dashboard</h1><p>No UI yet — build frontend or use API endpoints.</p>")
    return HTMLResponse(html_path.read_text())

if __name__ == "__main__":
    # Initial state on first run
    for p, default in [(STATE_PATH, {"running": False}), (POSITIONS_PATH, {}), (TRADE_LOG_PATH, [])]:
        if not p.exists():
            _save_json(p, default)

    print("🚀 Trading Dashboard starting on 0.0.0.0:8080")
    uvicorn.run(app, host="0.0.0.0", port=8080, log_level="warning")
