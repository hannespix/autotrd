---
name: market-data
category: daytrading
triggers: price, quote, ticker, kurs, live chart, stock data, ohlcv
description: >
  Fetch live prices, historical OHLCV, batch quotes, and ticker search via
  yfinance. Use when the user asks for current market data, historical charts,
  or wants to look up a symbol by company name.
---

# Market Data (yfinance)

Live and historical market-data helpers backed by **yfinance**. Imports from
`~/.hermes/skills/daytrading/scripts/market_data.py`.

## Quick Start

```python
from market_data import fetch_price, fetch_historical, search_tickers, get_multiple

# Single quote
info = fetch_price("AAPL")           # → {price, change_pct, volume, high, low, market_cap}

# Historical data
df = fetch_historical("TSLA")        # last 1 month, daily candles

# Batch quotes
batch = get_multiple(["AAPL", "MSFT", "GOOGL", "AMZN"])

# Search by keyword
hits = search_tickers("nvidia")      # → [{symbol, name, exchange}, …]
```

## CLI

```bash
python market_data.py quote AAPL       # current price snapshot
python market_data.py history TSLA -p 3mo -i 1d   # historical tail
python market_data.py search "apple"   # symbol lookup
```

## API Reference

### `fetch_price(ticker) → dict`

Returns a dict with:

| Key          | Type    | Description                              |
| ------------ | ------- | ---------------------------------------- |
| `price`      | float   | Last traded price                        |
| `change_pct` | float   | % change from previous close             |
| `volume`     | int     | Today's trade volume                     |
| `high`       | float   | Intraday high                            |
| `low`        | float   | Intraday low                             |
| `market_cap` | float   | Approximate market cap (in local cur.)   |

Raises `RuntimeError` if the symbol has no data.

### `fetch_historical(ticker, period="1mo", interval="1d") → DataFrame`

**period** options: `1d`, `5d`, `1mo`, `3mo`, `6mo`, `1y`, `2y`, `5y`, `10y`, `ytd`, `max`

**interval** options: `1m`, `2m`, `5m`, `15m`, `30m`, `60m`, `90m`, `1h`, `1d`, `5d`, `1wk`, `1mo`, `3mo`

Returns a DataFrame with columns: *Open, High, Low, Close, Adj Close, Volume*.
Raises `RuntimeError` on empty result.

### `search_tickers(query) → list[dict]`

Each result dict contains `{symbol, name, exchange}`.
Capped at 15 results. Returns `[]` on failure rather than raising.

### `get_multiple(tickers) → dict[ticker → info_or_error]`

Batch lookup — each key maps to either a price-info dict (success) or an
`Exception` (failure). Skips blank entries silently.

## Rate-Limit Notes

- **yfinance** proxies Yahoo Finance public endpoints; there is no official API
  key, but aggressive polling triggers IP-level throttling (~429 responses).
- **Safe cadence**: ≥ 1 s between individual `fetch_price` calls.
  `get_multiple()` fetches one-at-a-time internally with implicit delays from
  yfinance's own connection pooling.
- If you see a burst of `RuntimeError: Unable to fetch live data`, wait 60–90 s
  before retrying.

## Supported Asset Types

Stocks (``AAPL``), ETFs (``SPY``), cryptocurrencies (``BTC-USD``), forex pairs
(``EURUSD=X``), futures indices (``^GSPC``, ``^DJI``), and commodities
(``GC=F``). Always use the exact symbol format Yahoo Finance expects.
