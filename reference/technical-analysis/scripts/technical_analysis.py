#!/usr/bin/env python3
"""
Technical analysis module for day-trading / swing-trading indicators.

Uses the **ta** library (not pandas_ta), yfinance for data, and mplfinance for charting.

Functions take either a ticker symbol + period string OR a pre-built DataFrame.
Each indicator returns a dict with computed values *and* a human-readable signal string.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Optional, Union

# Ensure parent is on path for imports regardless of entry point
_script_dir = Path(__file__).resolve().parent
if str(_script_dir.parent) not in sys.path:
    sys.path.insert(0, str(_script_dir.parent))

import matplotlib
matplotlib.use("Agg")  # headless rendering
import matplotlib.pyplot as plt
import mplfinance as mpf
import numpy as np
import pandas as pd
import ta.momentum as ta_mom
import ta.trend as ta_trend
import ta.volatility as ta_vol
import yfinance as yf


# ---------------------------------------------------------------------------
# Data fetching helper
# ---------------------------------------------------------------------------

def fetch_data(ticker: str, period: str = "3mo") -> pd.DataFrame:
    """Download adjusted-close data for *ticker* via yfinance.

    Parameters
    ----------
    ticker : str
        Exchange ticker symbol, e.g. ``"AAPL"``, ``"TSLA"``, ``"SPY"``.
    period : str
        yfinance period string — ``1d``, ``5d``, ``1mo``, ``3mo``, ``6mo``,
        ``1y``, ``2y``, ``5y``, ``10y``, ``max``.

    Returns
    -------
    pd.DataFrame with OHLCV columns + Adjusted Close.

    Raises
    ------
    ValueError
        If the ticker has no data (delisted / invalid) or fetch fails.
    """
    df = yf.download(ticker, period=period, progress=False)
    if df is None or df.empty:
        raise ValueError(f"No data returned for ticker '{ticker}' (period={period}). "
                         "Ticker may be delisted or the period too short.")
    # yfinance sometimes returns MultiIndex columns for single tickers
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.droplevel(1)
    return df


# ---------------------------------------------------------------------------
# RSI — Relative Strength Index
# ---------------------------------------------------------------------------

def rsi(source: Union[str, pd.DataFrame], ticker: Optional[str] = None,
        period: str = "3mo", window: int = 14) -> dict:
    """Compute RSI and return current value + signal interpretation.

    Parameters
    ----------
    source : str or DataFrame
        Ticker symbol (str) or pre-fetched OHLCV DataFrame.
    ticker : str, optional
        Required when *source* is already a DataFrame (for chart filenames).
    period : str
        yfinance period if *source* is a ticker string.
    window : int
        RSI lookback window (default 14).

    Returns
    -------
    dict with keys ``current_rsi`` (float) and ``signal`` (str).
    """
    df = _resolve_data(source, ticker, period)
    rsi_series = ta_mom.rsi(df["Close"], window=window)
    current = float(rsi_series.dropna().iloc[-1])

    if current >= 70:
        signal = f"OVERBOUGHT ({current:.1f}) — consider taking profits or tightening stops."
    elif current <= 30:
        signal = f"OVERSOLD ({current:.1f}) — potential reversal upward / buy opportunity."
    else:
        signal = f"NEUTRAL ({current:.1f}) — no clear overbought/oversold condition."

    return {"current_rsi": round(current, 2), "signal": signal}


# ---------------------------------------------------------------------------
# MACD — Moving Average Convergence Divergence
# ---------------------------------------------------------------------------

def macd(source: Union[str, pd.DataFrame], ticker: Optional[str] = None,
         period: str = "3mo", fast: int = 12, slow: int = 26,
         signal_window: int = 9) -> dict:
    """Compute MACD and return current values + crossover signal.

    Returns
    -------
    dict with keys ``macd_line``, ``signal_line``, ``histogram``, ``crossover``.
    """
    df = _resolve_data(source, ticker, period)
    indicator = ta_trend.MACD(df["Close"], window_fast=fast, window_slow=slow,
                             window_sign=signal_window)
    macd_line = indicator.macd()
    signal_line = indicator.macd_signal()
    histogram = indicator.macd_diff()

    current_macd = float(macd_line.dropna().iloc[-1])
    current_sig  = float(signal_line.dropna().iloc[-1])
    current_hist = float(histogram.dropna().iloc[-1])

    # Detect crossover from last two valid bars
    macd_vals = macd_line.dropna().tail(2)
    sig_vals  = signal_line.dropna().tail(2)
    if len(macd_vals) >= 2:
        prev_diff = (macd_vals.iloc[-2] - sig_vals.iloc[-2])
        curr_diff = (macd_vals.iloc[-1] - sig_vals.iloc[-1])
        if curr_diff > 0 and prev_diff <= 0:
            crossover = "BULLISH_CROSS — MACD crossed above signal line."
        elif curr_diff < 0 and prev_diff >= 0:
            crossover = "BEARISH_CROSS — MACD crossed below signal line."
        else:
            crossover = ("NO_CROSS"
                         f" (MACD {'above' if curr_diff > 0 else 'below'} signal).")
    else:
        crossover = "INSUFFICIENT_DATA for crossover detection."

    return {
        "macd_line": round(current_macd, 4),
        "signal_line": round(current_sig, 4),
        "histogram": round(current_hist, 4),
        "crossover": crossover,
    }


# ---------------------------------------------------------------------------
# Bollinger Bands
# ---------------------------------------------------------------------------

def bollinger_bands(source: Union[str, pd.DataFrame], ticker: Optional[str] = None,
                    period: str = "3mo", window: int = 20, num_std: float = 2.0) -> dict:
    """Compute Bollinger Bands and detect squeeze condition.

    Returns
    -------
    dict with keys ``upper``, ``middle``, ``lower``, ``squeeze``.
    """
    df = _resolve_data(source, ticker, period)
    bb = ta_vol.BollingerBands(df["Close"], window=window, window_dev=num_std)

    upper    = float(bb.bollinger_hband().dropna().iloc[-1])
    middle   = float(bb.bollinger_mavg().dropna().iloc[-1])
    lower    = float(bb.bollinger_lband().dropna().iloc[-1])
    bandwidth = bb.bollinger_wband()  # width as pct of mid

    avg_width = float(bandwidth.dropna().mean())
    current_width = float(bandwidth.dropna().iloc[-1])

    squeeze = current_width < (0.5 * avg_width) if not pd.isna(avg_width) else False

    signal_parts: list[str] = []
    close = float(df["Close"].iloc[-1])
    if close >= upper:
        signal_parts.append("Price at or above UPPER band → strong momentum / overbought.")
    elif close <= lower:
        signal_parts.append("Price at or below LOWER band → oversold / support zone.")
    else:
        signal_parts.append("Price inside bands.")

    if squeeze:
        signal_parts.append("⚠ BAND SQUEEZE detected — tightening range, breakout likely soon.")

    return {
        "upper": round(upper, 4),
        "middle": round(middle, 4),
        "lower": round(lower, 4),
        "squeeze": squeeze,
        "signal": " ".join(signal_parts),
    }


# ---------------------------------------------------------------------------
# Golden Cross / Death Cross (50 SMA vs 200 SMA)
# ---------------------------------------------------------------------------

def golden_cross(source: Union[str, pd.DataFrame], ticker: Optional[str] = None,
                 period: str = "1y") -> dict:
    """Detect 50/200 Simple Moving Average cross.

    Requires at least ~200 trading days of data. The default ``period`` is ``"1y"``;
    for reliable results use ``"2y"`` or longer.

    Returns
    -------
    dict with keys ``sma_50``, ``sma_200``, ``cross_type``, ``detected``.
    """
    # Golden cross needs ~200 trading days; force a long period unless caller
    # already asked for >= 1 year. Any sub-year period string (e.g. "3mo") -> "2y".
    def _is_year_period(p: str) -> bool:
        p = str(p).strip().lower()
        if p in ("max", "ytd"):
            return True
        if p.endswith("y"):
            try:
                return int(p[:-1]) >= 1
            except ValueError:
                return False
        return False

    actual_period = period if _is_year_period(period) else "2y"
    df = _resolve_data(source, ticker, actual_period)

    sma_50_series = ta_trend.sma_indicator(df["Close"], window=50)
    sma_200_series = ta_trend.sma_indicator(df["Close"], window=200)

    valid = sma_50_series.dropna().dropna().index.intersection(
        sma_200_series.dropna().index)
    if len(valid) < 2:
        return {
            "sma_50": None,
            "sma_200": None,
            "cross_type": "INSUFFICIENT_DATA",
            "detected": False,
            "signal": "Need at least ~200 trading days. Extend the period.",
        }

    s50 = sma_50_series[valid].tail(2)
    s200 = sma_200_series[valid].tail(2)
    current_sma_50  = float(s50.iloc[-1])
    current_sma_200 = float(s200.iloc[-1])

    prev_spread  = (s50.iloc[-2] - s200.iloc[-2])
    curr_spread  = (s50.iloc[-1] - s200.iloc[-1])

    if curr_spread > 0 and prev_spread <= 0:
        cross_type = "GOLDEN_CROSS"
        signal = ("🟢 GOLDEN CROSS DETECTED — SMA-50 crossed above SMA-200. "
                  "Strong bullish signal, long-term uptrend.")
    elif curr_spread < 0 and prev_spread >= 0:
        cross_type = "DEATH_CROSS"
        signal = ("🔴 DEATH CROSS DETECTED — SMA-50 crossed below SMA-200. "
                  "Strong bearish signal, long-term downtrend.")
    else:
        cross_type = "NO_CROSS"
        position = "above" if curr_spread > 0 else "below"
        signal = (f"SMA-50 ({position}) SMA-200. No recent cross detected.")

    return {
        "sma_50": round(current_sma_50, 4),
        "sma_200": round(current_sma_200, 4),
        "cross_type": cross_type,
        "detected": cross_type in ("GOLDEN_CROSS", "DEATH_CROSS"),
        "signal": signal,
    }


# ---------------------------------------------------------------------------
# Charting helper — mplfinance candlestick with optional overlays
# ---------------------------------------------------------------------------

def chart_ticker(ticker: str, period: str = "3mo",
                 indicator: str = "ma", output_dir: str = "/tmp") -> str:
    """Generate a candlestick chart with overlay and save as PNG.

    Parameters
    ----------
    ticker : str
        Ticker symbol.
    period : str
        yfinance period string.
    indicator : str
        One of ``"ma"``, ``"bb"``, ``"macd"``, ``"rsi"``, ``"golden_cross"``.
    output_dir : str
        Directory for the PNG file (default ``/tmp``).

    Returns
    -------
    str : Absolute path to the saved chart PNG.
    """
    df = fetch_data(ticker, period)
    clean_ticker = ticker.replace("$", "").replace(" ", "_").upper()
    out_path = os.path.join(output_dir, f"techanalysis_{clean_ticker}_{indicator}.png")

    add_plots: list[mpf.make_addplot] = []
    title_extra = ""

    if indicator == "ma":
        sma_20 = ta_trend.sma_indicator(df["Close"], window=20)
        sma_50 = ta_trend.sma_indicator(df["Close"], window=50)
        sma_20.name = "SMA20"
        sma_50.name = "SMA50"
        add_plots.append(mpf.make_addplot(sma_20, color="orange"))
        add_plots.append(mpf.make_addplot(sma_50, color="blue"))
        title_extra = "SMA 20/50"

    elif indicator == "bb":
        bb = ta_vol.BollingerBands(df["Close"])
        upper_s = bb.bollinger_hband()
        mid_s   = bb.bollinger_mavg()
        lower_s = bb.bollinger_lband()
        add_plots.append(mpf.make_addplot(upper_s, color="purple", linewidth=1.0))
        add_plots.append(mpf.make_addplot(lower_s, color="purple", linewidth=1.0))
        title_extra = "Bollinger Bands"

    elif indicator == "macd":
        ind = ta_trend.MACD(df["Close"])
        fig, axes = plt.subplots(2, 1, figsize=(14, 8), sharex=True,
                                 gridspec_kw={"height_ratios": [3, 1]})
        mpf.plot(df, type="candle", style="charles", title=f"{ticker} — {title_extra or 'Candlestick'}",
                 savefig=dict(filepath=out_path, dpi=150), returnfig=True, ax=axes[0],
                 volume=False, ylabel="", legend=None)
        axes[1].plot(ind.macd(), label="MACD", color="blue")
        axes[1].plot(ind.macd_signal(), label="Signal", color="orange")
        hist = ind.macd_diff()
        colours = ["#26a69a" if h >= 0 else "#ef5350" for h in hist]
        axes[1].bar(range(len(hist)), hist, color=colours)
        axes[1].axhline(0, color="gray", linewidth=0.8)
        axes[1].legend()
        plt.tight_layout()
        fig.savefig(out_path, dpi=150, bbox_inches="tight")
        plt.close(fig)
        return out_path

    elif indicator == "rsi":
        ind = ta_mom.rsi(df["Close"], window=14)
        fig, axes = plt.subplots(2, 1, figsize=(14, 8), sharex=True,
                                 gridspec_kw={"height_ratios": [3, 1]})
        mpf.plot(df, type="candle", style="charles",
                 savefig=dict(filepath=out_path, dpi=150), returnfig=True, ax=axes[0],
                 volume=False)
        axes[1].plot(ind, label="RSI(14)", color="cyan")
        axes[1].axhline(70, color="red", linestyle="--", alpha=0.7)
        axes[1].axhline(30, color="green", linestyle="--", alpha=0.7)
        axes[1].set_ylim(0, 100)
        axes[1].legend()
        plt.tight_layout()
        fig.savefig(out_path, dpi=150, bbox_inches="tight")
        plt.close(fig)
        return out_path

    elif indicator == "golden_cross":
        sma_50 = ta_trend.sma_indicator(df["Close"], window=50)
        sma_200 = ta_trend.sma_indicator(df["Close"], window=200)
        sma_50.name = "SMA50"
        sma_200.name = "SMA200"
        add_plots.append(mpf.make_addplot(sma_50, color="orange"))
        add_plots.append(mpf.make_addplot(sma_200, color="red", linewidth=2.0))
        title_extra = "Golden / Death Cross (SMA 50/200)"

    # Default single-panel render
    if not os.path.exists(out_path):
        mpf.plot(df, type="candle", style="charles",
                 mav=(20, 50) if indicator == "golden_cross" else None,
                 addplot=add_plots if indicator in ("ma", "bb") else None,
                 volume=True, title=f"{ticker} — {title_extra}",
                 savefig=dict(filepath=out_path, dpi=150))

    return out_path


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _resolve_data(source: Union[str, pd.DataFrame], ticker: Optional[str] = None,
                  period: str = "3mo") -> pd.DataFrame:
    """Return DataFrame, fetching from yfinance if source is a string."""
    if isinstance(source, pd.DataFrame):
        return source
    if not ticker:
        raise ValueError("ticker argument required when source is a string.")
    return fetch_data(ticker, period)


# ---------------------------------------------------------------------------
# CLI entry-point
# ---------------------------------------------------------------------------

INDICATORS = ("rsi", "macd", "bollinger_bands", "golden_cross", "all")
CHART_MAP = {
    "rsi": "rsi",
    "macd": "macd",
    "bollinger_bands": "bb",
    "golden_cross": "golden_cross",
}

def _pretty_print(result: dict) -> None:
    """Print analysis result as a readable summary."""
    for key, val in result.items():
        if isinstance(val, float):
            print(f"  {key}: {val}")
        elif isinstance(val, bool):
            print(f"  {key}: {'Yes' if val else 'No'}")
        else:
            print(f"  {key}: {val}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Technical analysis indicators for stocks.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--ticker", required=True, help="Stock ticker symbol (e.g. AAPL)")
    parser.add_argument("--indicator", default="rsi",
                        choices=INDICATORS, help="Indicator to run (default: rsi)")
    parser.add_argument("--period", default="3mo",
                        help="yfinance period string (default: 3mo)")
    parser.add_argument("--chart", action="store_true", default=False,
                        help="Generate and save a candlestick chart as PNG under /tmp/")
    args = parser.parse_args()

    tickers = [t.strip().upper() for t in args.ticker.split(",")]
    charts: list[str] = []

    for ticker in tickers:
        print(f"\n{'=' * 60}")
        print(f"  Technical Analysis — {ticker} (period={args.period})")
        print("=" * 60)

        if args.indicator == "all":
            print("\n--- RSI ---")
            _pretty_print(rsi(ticker, ticker=ticker, period=args.period))

            print("\n--- MACD ---")
            _pretty_print(macd(ticker, ticker=ticker, period=args.period))

            print("\n--- Bollinger Bands ---")
            _pretty_print(bollinger_bands(ticker, ticker=ticker, period=args.period))

            print("\n--- Golden / Death Cross ---")
            _pretty_print(golden_cross(ticker, ticker=ticker, period="2y"))

            if args.chart:
                for ind_name in ("ma", "bb", "rsi", "macd"):
                    p = chart_ticker(ticker, indicator=ind_name)
                    charts.append(p)
        else:
            indicator_fns = {
                "rsi": rsi,
                "macd": macd,
                "bollinger_bands": bollinger_bands,
                "golden_cross": golden_cross,
            }
            fn = indicator_fns[args.indicator]

            if args.indicator == "golden_cross":
                result = fn(ticker, ticker=ticker, period="2y")
            else:
                result = fn(ticker, ticker=ticker, period=args.period)

            _pretty_print(result)

            if args.chart and args.indicator in CHART_MAP:
                p = chart_ticker(ticker, indicator=CHART_MAP[args.indicator])
                charts.append(p)

        print()

    if charts:
        print("Charts saved:")
        for c in charts:
            size = os.path.getsize(c) / 1024
            print(f"  ✅ {c} ({size:.0f} KB)")


if __name__ == "__main__":
    main()
