---
name: daytrading-technical-analysis
description: "Use when analysing stocks with RSI, MACD, Bollinger Bands, SMA crossovers (Golden/Death Cross), ATR, or generating trading charts."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [daytrading, technical-analysis, rsi, macd, bollinger-bands, sma, golden-cross, death-cross, atr, yfinance, charting]
    related_skills: [jupyter-live-kernel]
---

# Technical Analysis (Day Trading)

Stock-market technical analysis via **ta**, **yfinance**, and **mplfinance**. Every indicator
returns a signal interpretation, not just raw numbers. Charts are saved as PNG to `/tmp/`.

## When to Use

- Calculating RSI, MACD, Bollinger Bands, SMA crossovers, or ATR for any ticker
- Detecting Golden Cross / Death Cross signals
- Generating equity charts with overlays (moving averages, BB, volume)
- User asks about entry/exit timing based on classic indicators
- Triage: fetch data → run indicator(s) → return signal + chart path

**Don't use for:** fundamental analysis, earnings reports, news sentiment, portfolio
optimisation algorithms — those need other skills.

## Quick Indicator Reference

| Trigger Word | Function | Key Signals |
|---|---|---|
| RSI | `rsi(ticker, period)` | Overbought (>70) / Oversold (<30) |
| MACD | `macd(ticker, period)` | Bullish/bearish crossover, histogram direction |
| BBand | `bollinger_bands(ticker, period)` | Band squeeze, price at upper/lower band |
| SMA Cross | `golden_cross(ticker, period)` | 50/200 SMA golden & death cross detection |
| Chart / Plot | `chart_ticker(ticker, indicator, period)` | mplfinance candlestick PNG to `/tmp/` |

## Environment

- **Python:** `/home/hannes/.hermes/hermes-agent/venv/bin/python3`
- **Key deps:** yfinance, ta, matplotlib, mplfinance, pandas, numpy
- **Script:** `~/.hermes/skills/daytrading/technical-analysis/scripts/technical_analysis.py`

## Workflow

### 1. Run a single indicator

```bash
/home/hannes/.hermes/hermes-agent/venv/bin/python3 \
  ~/.hermes/skills/daytrading/technical-analysis/scripts/technical_analysis.py \
  --ticker AAPL --indicator rsi --period 3mo
```

All indicators return structured dict plus a human-readable signal text.

### 2. Generate a chart

```bash
/home/hannes/.hermes/hermes-agent/venv/bin/python3 \
  ~/.hermes/skills/daytrading/technical-analysis/scripts/technical_analysis.py \
  --ticker AAPL --indicator macd --period 3mo --chart true
```

Charts are written to `/tmp/techanalysis_<ticker>_<indicator>.png` and returned as a path.

### 3. Run all indicators at once

```bash
/home/hannes/.hermes/hermes-agent/venv/bin/python3 \
  ~/.hermes/skills/daytrading/technical-analysis/scripts/technical_analysis.py \
  --ticker AAPL --indicator all --period 1y
```

### 4. Use as a module inside other scripts

```python
import sys
sys.path.insert(0, "~/…/scripts")
from technical_analysis import fetch_data, rsi, macd, bollinger_bands, golden_cross, chart_ticker
```

Or call the CLI entry-point from `terminal()` — this is faster than embedding imports.

## Indicator Details

### RSI (Relative Strength Index)

- **Returns:** `{current_rsi: float, signal: str}`
- Signal text: *overbought* (>70), *oversold* (<30), or *neutral*
- Default window: 14 bars
- Default period: `3mo`

### MACD (Moving Average Convergence Divergence)

- **Returns:** `{macd_line: float, signal_line: float, histogram: float, crossover: str}`
- Crossover text: *bullish* (MACD crosses above signal), *bearish* (below), or *none*
- Parameters: fast=12, slow=26, signal=9

### Bollinger Bands

- **Returns:** `{upper: float, middle: float, lower: float, squeeze: bool}`
- Squeeze detection: band width narrows below 2 × average width (compression → breakout likely)
- Parameters: window=20, num_std=2

### Golden / Death Cross (50/200 SMA)

- **Returns:** `{cross_type: str, sma_50: float, sma_200: float, detected: bool}`
- *golden_cross*: SMA-50 crosses above SMA-200 (bullish)
- *death_cross*: SMA-50 crosses below SMA-200 (bearish)

## Common Pitfalls

1. **yfinance rate limits** — don't blast through dozens of tickers in rapid succession.
   Add a 0.5-second sleep between calls if batch-processing.

2. **Insufficient lookback** — the Golden Cross needs SMA-200, so use at least `1y` or `2y`
   period for daily data. The script handles this automatically when `indicator=golden_cross`.

3. **Interval → period constraints** — yfinance enforces max ranges per interval:

   | Interval | Max Period | Bars Yielded |
   |----------|-----------|--------------|
   | 5m       | 30d      | ~180/day     |
   | 15m      | 60d      | ~62/day      |
   | 30m      | 60d      | ~31/day      |
   | 60m      | 90d      | ~17/day      |
   | 1d       | max      | unlimited    |

   Always pass both `period` AND `interval`. Omitting interval defaults to daily — sub-daily
   requests silently return daily bars. See `references/chart_zoom.md` for dashboard mapping.

4. **Stale cache** — yfinance may return cached quotes. Pass auto-adjusted close prices (the
   default) for consistent calculations.

5. **Trading hours** — indicators reflect last-known data at query time. Pre-market / after-hours
   gaps are included in yfinance closing prices as of the regular session end.

6. **mplfinance rendering on headless servers** — use Agg backend (the script does this by
   default) so charts render without a display server.

7. **Delisted tickers** — fetch_data returns empty DataFrame; the indicator functions raise
   `ValueError`. Catch and surface clearly instead of letting it crash silently.

## Verification Checklist

- [ ] yfinance returns data (non-empty DataFrame) for the requested ticker and period
- [ ] Indicator computation succeeds and returns a valid signal string
- [ ] Chart file written to `/tmp/` when `--chart true` is set (verify with `ls -lh`)
- [ ] RSI values in expected range [0, 100]
- [ ] MACD histogram = macd_line – signal_line (sanity check)
- [ ] For Golden Cross, period ≥ 250 trading days (~1.2 calendar years)
