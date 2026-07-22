---
name: daytrading-automation
description: "Auto-trading engine, market-universe catalog, web dashboard server, strategy config, paper trading with risk management, and scheduled scans."
version: 1.1.0
tags: [daytrading, automation, paper-trading, dashboard, risk-management, confluence-signals, market-overview]
---

# Daytrading Automation Engine

Full auto-trading stack: cross-asset market overview (166 symbols across 10
asset classes), signal-based scanner, paper-trade execution with position
sizing & risk management (stop-loss/take-profit), FastAPI dashboard on port
8080, and a scheduled scan loop.

## Trigger Words

Trading automation, engine start/stop, scan, signal, paper trading, stop loss,
take profit, portfolio, equity, P&L, live dashboard, strategy config, watchlist,
confluence signal, market overview, indices, forex, crypto, commodities, ETF.

## Canonical architecture (verified working)

**State + config live in `~/.hermes/trading/` — NOT in `<skill>/data` or `<skill>/config`.**
The `<skill>/data` and `<skill>/config` dirs (with a nested `strategy.type/indices/…`
schema) are a stale, broken parallel variant — ignore/remove them.

```
~/.hermes/trading/                     # persistent state (the ONLY runtime dir)
├── strategy.yaml                      # FLAT schema (broker/watchlist/engine/indicators/signals) ★
├── positions.json                     # open paper positions
├── trade_log.json                     # completed trades w/ P&L
├── engine_state.json                  # running flag (dashboard Start/Stop) + last_scan
└── signals.json                       # last signal snapshot

~/.hermes/skills/daytrading/scripts/
├── trading_engine.py                  # engine class: scan, execute, risk mgmt ★
├── trading_dashboard.py               # FastAPI + endpoints (port 8080)
├── market_data.py                     # yfinance price/history/search/batch
├── market_universe.py                 # asset catalog (indices/fx/crypto/…) ★ NEW
├── cron_task.py                       # one scan cycle (running-flag gated)
├── static/index.html                  # dashboard UI (hand-maintained) ★
└── gen_dashboard.py                   # DEPRECATED / neutered — do not run
~/.hermes/skills/daytrading/technical-analysis/scripts/technical_analysis.py
```

## Interpreter

Everything needs the Hermes venv (has yfinance/fastapi/ta/mplfinance):
`~/.hermes/hermes-agent/venv/bin/python`. System `python` (3.14) lacks the deps.

## Strategy config (FLAT schema — `~/.hermes/trading/strategy.yaml`)

```yaml
broker: {paper_trading: true, initial_capital: 25000}
watchlist: [SPY, QQQ, AAPL, TSLA]
engine: {check_interval_min: 5, max_position_pct: 10, stop_loss_pct: 2.0, take_profit_pct: 4.0}
indicators:
  rsi:       {enabled: true, threshold_buy: 30, threshold_sell: 70, window: 14}
  macd:      {enabled: true, crossover_buy: true}
  bollinger: {enabled: true, bb_breakout_pct: 95}
signals: {min_confluence: 2, period: "3mo"}
```
The dashboard UI reads and writes exactly this schema. Do not reintroduce the
old `strategy/indices/risk_management/execution` shape (it caused the UI-save bug).

## Running as services (this machine has no cron)

```bash
systemctl --user status daytrading-dashboard.service   # FastAPI on :8080, restart=on-failure
systemctl --user status daytrading-scan.timer          # fires run_scan.sh every 5 min
journalctl --user -u daytrading-scan.service -f        # scan logs
```
`~/.hermes/scripts/run_scan.sh` gates on US market hours (Mon–Fri 09:30–16:00 ET;
`--force` to bypass) then runs `cron_task.py`, which executes paper trades only
when the engine is "running" (dashboard Start/Stop). To survive logout:
`sudo loginctl enable-linger $USER`.

**⚠️ CRITICAL — NO SPAM TO TELEGRAM:**

User explicitly wants **NO Telegram noise from cron**. Only important events.
When configuring a Hermes cron with `no_agent: true`, every stdout line becomes
a delivered message. A script that prints on every run floods the user.

Design all cron scripts as SILENT WATCHDOGS:

1. **No action taken + no signal change → print NOTHING, exit 0.** Empty stdout = silent delivery (user sees nothing).
2. **Only print on:** executed trades, signal direction changes (HOLD→BUY/SELL),
   forecast evaluation results, AI tuner updates, or errors/crashes.
3. `cron_task.py` compares current signals against previous `signals.json` —
   only tickers whose decision flipped from HOLD trigger output lines.
4. To survive a daily reset and not re-create spammy crons: prefer `no_agent: true`
   with a silent watchdog script over agent-driven cron that always narrates.

## Signal confluence

Each watchlist ticker → all enabled indicators vote per direction; trade fires
only when votes ≥ `signals.min_confluence`.

## Signal confluence

Each watchlist ticker → all enabled indicators vote per direction; trade fires
only when votes ≥ `signals.min_confluence`.

| Indicator | Buy vote | Sell vote |
|-----------|----------|-----------|
| RSI | < threshold_buy (30) | > threshold_sell (70) |
| MACD | line > signal & hist > 0 | line < signal & hist < 0 |
| BBands | price < (100−bb_breakout_pct)% of band | price > bb_breakout_pct% of band |

Risk: stop-loss −stop_loss_pct%, take-profit +take_profit_pct%, max
max_position_pct% equity per position.

## Dashboard API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | `{engine, last_check, positions_open}` |
| GET/POST | `/api/strategy` | Flat strategy config (get/save) |
| GET | `/api/portfolio` | Positions + live P&L + equity (use for perf/positions) |
| GET | `/api/pnl` | Flat P&L summary (`closed_pnl`, `win_rate_pct`, …) |
| GET | `/api/journal?limit=50` | Trade history |
| GET | `/api/signals` | Last snapshot `{timestamp, results:[…]}` |
| POST | `/api/scan` | Run one scan now |
| POST | `/api/manual/trade` | Manual buy/sell |
| POST | `/api/engine/action` | `{action:"start"\|"stop"}` |
| GET | `/api/price?symbol=&period=` | Live price + history + indicators + derived `signal` |
| GET | `/api/quotes?symbols=A,B` | Lightweight batch prices |
| GET | `/api/catalog` | Full asset catalog (classes → groups → [symbol,name]) |
| GET | `/api/overview?cls=indices` | Live grid for one asset class |
| GET | `/api/pulse` | Compact cross-asset strip (indices/fx/crypto/commodities/rates) |
| GET | `/api/history?symbol=&limit=` | Logged time-series observations (for trend charts) |

**Signal shape** (`/api/signals` → `results[]`):
`{ticker, decision, buy_signals, sell_signals, required_confluence, indicators:{rsi, macd:{line,signal}, bb_pct}}`

## Market universe (`market_universe.py`)

166 symbols in 10 classes with correct yfinance conventions: indices (`^GDAXI`),
forex (`EURUSD=X`, `DX-Y.NYB`), crypto (`BTC-USD`), commodities/futures (`GC=F`,
`CL=F`, `ES=F`), rates (`^TNX`), sector/region/thematic ETFs, and global stocks
(`SAP.DE`, `MC.PA`, `ASML.AS`, `7203.T`, `0700.HK`). Extend by editing `CATALOG`.
`classify(symbol)` guesses the class from the suffix; `MARKET_PULSE` is the
top-strip set.

## Visualizations & time-series history

Charts use **TradingView Lightweight Charts v4.2.0** (CDN, pinned) — the main
chart is candlestick + volume; the "Verlauf" panel is a logged trend line
(price/RSI/MACD/BB%) with a metric selector. React Flow is NOT applicable (it is
for node graphs, not price series).

The main chart also draws **visual aids**: an SMA-20 trend overlay, swing
high/low markers (Scheitelpunkte, via local-extrema detection), and a **dashed
linear-regression forecast** (last 20 closes projected ~5-8 weekdays ahead, ±1σ
band in the enlarged view). Click the chart or "⛶ Vergrößern + Analyse" for a
full-screen modal with the band and marker labels (Esc closes). The chart pulls
`period=3mo` daily bars so these aids have enough data. Forecast is naive/honest
(least-squares drift), clearly dashed — not a real predictive model.

`history_store.py` appends **every** price observation to
**`~/.hermes/trading/history.db`** (SQLite, WAL). Write paths: engine scan
(`source="scan"`), and every price-serving endpoint — `/api/price` (`view`),
`/api/quotes` (`quote`), `/api/pulse` (`pulse`), `/api/overview` (`overview`).
So trends fill in continuously for everything shown. Inspect: `python
history_store.py`. **Growth:** logging every fetch grows the DB steadily; prune
old rows if needed (`DELETE FROM observations WHERE ts < date('now','-30 days')`).

**Lightweight Charts API note:** pinned to v4.x (`addCandlestickSeries` /
`addHistogramSeries` / `addLineSeries`). v5 renamed these to
`addSeries(CandlestickSeries,…)` — do not bump the CDN version without updating
the calls in `static/index.html`.

## News-event intelligence (AI-linked chart annotations)

Two-stage pipeline (rule-based filter → Claude Sonnet escalation), sources are
free (no key): yfinance news + Yahoo/Google RSS + Reddit JSON sentiment.

- `news_feed.py` — unified fetch/dedupe/cache (10-min TTL) → normalized items.
- `sentiment.py` — rule-based lexicon + event-type tagging (earnings/analyst/m&a/
  legal/guidance/macro…); `score_text`, `aggregate`.
- `ai_analyst.py` — Claude Sonnet via the **`claude` CLI** (`claude -p … --model
  sonnet`, no API key, uses Max sub). `explain_swing` / `summarize_day`. Cached
  in `history.db` (table `ai_explanations`), rate-limited, time-boxed, graceful
  fallback if `claude` missing.
- `event_engine.py` — aligns news to real chart days (sentiment-coloured markers),
  swing-aware, AI-summarises the most notable days. **Honest limit:** free news
  ≈ last 2 weeks, so only recent days get markers; older swings stay bare.

Endpoints: `/api/news?symbol=`, `/api/sentiment?symbol=`,
`/api/events?symbol=&period=&ai=1` (first call ~10s for AI, then SQLite-cached).

Frontend: sentiment-coloured event circles on the candle chart with a rich
crosshair **tooltip** (headline + AI summary + day sentiment + more headlines),
a News & Sentiment panel (gauge + feed), and a **layer-toggle** row
(News-Events / SMA / Swings / Prognose / Volumen). `normalizeBars` drops
zero/NaN yfinance rows. Watchlist must use catalog symbols (`^NDX`, not bare `NDX`).

**Not yet built (next iterations):** full 2026 visual redesign/animations,
sentiment-weighted forecast, and the self-improving prediction-accuracy loop.

## Common pitfalls

1. TA functions return **dicts** (`.get("key")`), not Series.
2. TA needs BOTH source and ticker kwargs: `ta.rsi("SPY", ticker="SPY", period="3mo")`.
3. Min indicator period is 3mo; golden cross forces ≥2y internally.
4. yfinance fast_info uses snake_case: `last_price`, not `currentPrice`.
5. `/api/overview` and `/api/pulse` fetch serially — a full class (~25 symbols)
   takes several seconds. Fine on-demand; don't poll aggressively.
6. Paper trading only. Never place real orders.
