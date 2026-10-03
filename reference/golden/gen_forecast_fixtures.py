#!/usr/bin/env python3
"""Golden-Fixtures für den Forecast-Port (MILESTONES M5).

Ruft die ECHTE Referenz (reference/scripts/forecaster.compute — pure Mathe,
kein SQLite) mit deterministischen Serien auf und schreibt die Ergebnisse für
den TS-Parity-Test (shared/test/forecast.golden.test.ts, Toleranz 1e-9).

Basisdaten decken bewusst heikle Kalenderfälle ab: US-DST-Wechsel
(März/November), Freitag (Horizont überspringt ein Wochenende), Jahreswechsel.

Aufruf:  <venv-python> reference/golden/gen_forecast_fixtures.py
Deps:    numpy (Serien), Referenz braucht sonst nichts
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from forecaster import HORIZON, LOOKBACK_GRID, WEIGHT_GRID, compute  # noqa: E402

OUT = Path(__file__).parent / "forecast.json"


def series(seed: int, n: int, start: float, drift: float, vol: float) -> list[float]:
    rng = np.random.default_rng(seed)
    return [float(x) for x in start * np.exp(np.cumsum(rng.normal(drift, vol, n)))]


BASE_DATES = [
    "2026-03-06",  # Freitag vor US-DST-Beginn (8. März) — Wochenende + DST
    "2026-10-30",  # Freitag vor DST-Ende (1. November)
    "2025-12-30",  # Jahreswechsel im Horizont
    "2026-07-22",  # gewöhnlicher Mittwoch
]

SENTIMENTS = [-0.8, 0.0, 0.6]


def main() -> None:
    fixtures = []
    closes_by_name = {
        "up": series(11, 60, 100.0, 0.001, 0.012),
        "down": series(22, 60, 250.0, -0.0015, 0.02),
        "short": series(33, 8, 50.0, 0.0, 0.01),  # < lookback → n = len
    }
    for name, closes in closes_by_name.items():
        for base_date in BASE_DATES:
            for sent in SENTIMENTS:
                for w in WEIGHT_GRID:
                    for lb in LOOKBACK_GRID:
                        fc = compute(closes, base_date, sent, w, HORIZON, lb)
                        fixtures.append({
                            "series": name, "baseDate": base_date, "sentiment": sent,
                            "w": w, "lookback": lb,
                            "result": fc,
                        })
    OUT.write_text(json.dumps({"closes": closes_by_name, "cases": fixtures}, indent=None))
    print(f"OK — {len(fixtures)} Forecast-Fixtures → {OUT}")


if __name__ == "__main__":
    main()
