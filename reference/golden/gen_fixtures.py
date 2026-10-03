#!/usr/bin/env python3
"""Golden-Fixture-Generator für die TS-Indikator-Parity (MILESTONES M2).

Erzeugt deterministische synthetische Close-Serien (geseedeter Random-Walk)
und berechnet die Referenz-Indikatoren mit der `ta`-Bibliothek — exakt wie
reference/technical-analysis/scripts/technical_analysis.py sie nutzt:
RSI (Wilder-EWM), MACD (Span-EMAs), Bollinger (SMA ± k·std, ddof=0).

Ausgabe: reference/golden/indicators.json — von
shared/test/indicators.golden.test.ts eingelesen (Toleranz 1e-9).

Aufruf:  <venv-python> reference/golden/gen_fixtures.py
Deps:    pandas, numpy, ta
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import ta.momentum as ta_mom
import ta.trend as ta_trend
import ta.volatility as ta_vol

OUT = Path(__file__).parent / "indicators.json"


def make_series(seed: int, n: int, start: float, drift: float, vol: float) -> list[float]:
    """Deterministischer Random-Walk (Log-Returns), reproduzierbar per Seed."""
    rng = np.random.default_rng(seed)
    rets = rng.normal(loc=drift, scale=vol, size=n)
    closes = start * np.exp(np.cumsum(rets))
    return [float(x) for x in closes]


def series_to_list(s: pd.Series) -> list[float | None]:
    return [None if pd.isna(v) else float(v) for v in s.tolist()]


def compute(closes: list[float]) -> dict:
    c = pd.Series(closes, dtype="float64")

    out: dict = {"closes": closes, "indicators": {}}

    for window in (7, 14, 21):
        out["indicators"][f"rsi_{window}"] = series_to_list(
            ta_mom.rsi(c, window=window)
        )

    macd_ind = ta_trend.MACD(c, window_fast=12, window_slow=26, window_sign=9)
    out["indicators"]["macd_line"] = series_to_list(macd_ind.macd())
    out["indicators"]["macd_signal"] = series_to_list(macd_ind.macd_signal())
    out["indicators"]["macd_histogram"] = series_to_list(macd_ind.macd_diff())

    bb = ta_vol.BollingerBands(c, window=20, window_dev=2)
    out["indicators"]["bb_upper"] = series_to_list(bb.bollinger_hband())
    out["indicators"]["bb_middle"] = series_to_list(bb.bollinger_mavg())
    out["indicators"]["bb_lower"] = series_to_list(bb.bollinger_lband())

    out["indicators"]["sma_20"] = series_to_list(ta_trend.sma_indicator(c, window=20))
    out["indicators"]["ema_20"] = series_to_list(ta_trend.ema_indicator(c, window=20))

    return out


def main() -> None:
    fixtures = {
        # (seed, n, start, drift, vol) — drei Marktcharaktere + ein Kurz-Fall
        "trend_up": compute(make_series(seed=42, n=250, start=100.0, drift=0.0008, vol=0.012)),
        "choppy": compute(make_series(seed=7, n=120, start=50.0, drift=0.0, vol=0.02)),
        "crash": compute(make_series(seed=1234, n=250, start=400.0, drift=-0.002, vol=0.03)),
        "short": compute(make_series(seed=99, n=40, start=25.0, drift=0.001, vol=0.015)),
    }
    OUT.write_text(json.dumps(fixtures, indent=1))
    total = sum(len(f["closes"]) for f in fixtures.values())
    print(f"OK — {len(fixtures)} Fixtures, {total} Bars → {OUT}")


if __name__ == "__main__":
    main()
