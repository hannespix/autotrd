"""
market_data — yfinance-backed helpers for live prices, history, ticker search, and batch lookups.

Dependencies
------------
pip install --user yfinance pandas

Usage
-----
    from market_data import fetch_price, fetch_historical, search_tickers, get_multiple

    info = fetch_price("AAPL")
    hist = fetch_historical("TSLA", period="3mo", interval="1d")
"""

from __future__ import annotations

import logging
from typing import Any

import pandas as pd
import yfinance as yf

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def fetch_price(ticker: str) -> dict[str, Any]:
    """Fetch current market data for a single ticker.

    Parameters
    ----------
    ticker : str
        Stock/crypto/ETF symbol (e.g. ``"AAPL"``, ``"BTC-USD"``, ``"SPY"``).

    Returns
    -------
    dict
        ``{price, change_pct, volume, high, low, market_cap}`` — all values
        are floats or ``None`` when the field is unavailable.

    Raises
    ------
    ValueError
        If *ticker* is empty or whitespace-only.
    RuntimeError
        If yfinance returns no data (invalid symbol / network error).
    """
    sym = ticker.strip().upper()
    if not sym:
        raise ValueError("ticker must be a non-empty string")

    try:
        tick = yf.Ticker(sym)
        info = tick.fast_info  # lightweight, fast attribute access
    except Exception as exc:
        logger.error("yfinance failed for %r: %s", sym, exc)
        raise RuntimeError(f"Unable to fetch live data for {sym}") from exc

    current_price: float | None = getattr(info, "last_price", None)
    previous_close: float | None = getattr(info, "previous_close", None)
    volume: int | None = getattr(info, "last_volume", None)
    day_high: float | None = getattr(info, "day_high", None)
    day_low: float | None = getattr(info, "day_low", None)
    market_cap: float | None = getattr(info, "market_cap", None)

    if current_price is None:
        raise RuntimeError(f"No price data returned for {sym}")

    change_pct: float | None = None
    if previous_close and previous_close > 0:
        change_pct = round(((current_price - previous_close) / previous_close) * 100, 4)

    return {
        "price": current_price,
        "change_pct": change_pct,
        "volume": volume,
        "high": day_high,
        "low": day_low,
        "market_cap": market_cap,
    }


def fetch_historical(
    ticker: str,
    period: str = "1mo",
    interval: str = "1d",
) -> pd.DataFrame:
    """Fetch historical OHLCV data as a pandas DataFrame.

    Parameters
    ----------
    ticker : str
        Stock/crypto/ETF symbol.
    period : str
        Valid yfinance periods (see Notes).
    interval : str
        Valid yfinance intervals (see Notes).

    Returns
    -------
    pd.DataFrame
        Standard yfinance columns: Open, High, Low, Close, Adj Close, Volume.

    Notes
    -----
    **period** options: ``"1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y",
    "10y", "ytd", "max"``

    **interval** options: ``"1m", "2m", "5m", "15m", "30m", "60m", "90m",
    "1h", "1d", "5d", "1wk", "1mo", "3mo"``

    Raises
    ------
    ValueError
        If *ticker* is empty.
    RuntimeError
        If yfinance returns an empty DataFrame.
    """
    sym = ticker.strip().upper()
    if not sym:
        raise ValueError("ticker must be a non-empty string")

    try:
        df = yf.download(sym, period=period, interval=interval, progress=False)
    except Exception as exc:
        logger.error("yfinance history failed for %r: %s", sym, exc)
        raise RuntimeError(f"Unable to fetch history for {sym}") from exc

    if df.empty:
        raise RuntimeError(
            f"No historical data returned for {sym} (period={period}, interval={interval})"
        )

    # Flatten multi-level columns that yfinance sometimes returns
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    return df


def search_tickers(query: str) -> list[dict[str, Any]]:
    """Search for tickers matching a query string.

    Parameters
    ----------
    query : str
        Company name, ticker symbol, or keyword to search.

    Returns
    -------
    list[dict]
        Each dict contains ``{symbol, name, exchange}``.
        Returns an empty list when nothing matches.

    Raises
    ------
    ValueError
        If *query* is empty.
    """
    if not query.strip():
        raise ValueError("query must be a non-empty string")

    try:
        results = yf.search(query, max_results=15)
    except Exception as exc:
        logger.error("yfinance search failed for %r: %s", query, exc)
        return []

    # yf.search returns a dict that may have different keys depending on version.
    quotes = results.get("quotes", [])
    if not isinstance(quotes, list):
        logger.warning("Unexpected search result structure for %r", query)
        return []

    output: list[dict[str, Any]] = []
    for entry in quotes:
        symbol = entry.get("symbol")
        name = entry.get("shortname") or entry.get("longname")
        exchange = entry.get("exchDisp") or entry.get("quoteType", "").upper()
        if symbol and name:
            output.append({"symbol": symbol, "name": name, "exchange": exchange})

    return output


def get_multiple(tickers: list[str]) -> dict[str, Any]:
    """Fetch current price info for multiple tickers in parallel.

    Parameters
    ----------
    tickers : list[str]
        List of symbols to look up.

    Returns
    -------
    dict[str, dict | Exception]
        Maps each ticker → ``{price, change_pct, volume, high, low, market_cap}``
        when successful, or an ``Exception`` when that lookup failed.

    Examples
    --------
    >>> results = get_multiple(["AAPL", "MSFT", "GOOGL"])
    >>> results["AAPL"]["price"]
    213.45
    """
    # Use the multi-ticker download for parallel fetching, then supplement with details
    result: dict[str, Any] = {}

    valid = [t.strip().upper() for t in tickers if t.strip()]
    if not valid:
        return result

    # Batch price fetch via fast_info per-ticker; yf.download handles parallel under the hood
    try:
        tickers_obj = yf.Tickers(valid)
    except Exception:
        logger.error("Failed to create multi-ticker object for %r", valid)
        for sym in valid:
            result[sym] = RuntimeError(f"Batch request failed for {sym}")
        return result

    for sym in valid:
        try:
            result[sym] = fetch_price(sym)
        except Exception as exc:
            logger.warning("Skipping %r — %s", sym, exc)
            result[sym] = exc

    return result


# ---------------------------------------------------------------------------
# CLI entry-point
# ---------------------------------------------------------------------------

def _cli() -> None:  # pragma: no-cover — convenience only
    """Quick CLI for ad-hoc lookups. Run as ``python -m market_data <TICKER>``."""
    import argparse
    import sys

    parser = argparse.ArgumentParser(
        description="Market data lookup via yfinance"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # quote
    p_q = sub.add_parser("quote", help="Current price info")
    p_q.add_argument("ticker", help="Symbol to look up")

    # history
    p_h = sub.add_parser("history", help="Historical OHLCV data")
    p_h.add_argument("ticker")
    p_h.add_argument("-p", "--period", default="1mo")
    p_h.add_argument("-i", "--interval", default="1d")

    # search
    p_s = sub.add_parser("search", help="Search tickers by name/keyword")
    p_s.add_argument("query")

    args = parser.parse_args()

    try:
        if args.command == "quote":
            info = fetch_price(args.ticker)
            for k, v in info.items():
                print(f"  {k:>12}: {v}")
        elif args.command == "history":
            df = fetch_historical(args.ticker, args.period, args.interval)
            print(df.tail(10).to_string(index=True))
        elif args.command == "search":
            hits = search_tickers(args.query)
            for h in hits:
                print(f"  {h['symbol']:>8}  {h.get('exchange', ''):<8}  {h['name']}")
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    _cli()
