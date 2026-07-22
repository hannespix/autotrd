# functions/ — Cloud Functions (Node 20, TypeScript)

**Status: Skeleton — wird in M1 aufgesetzt (siehe [MILESTONES.md](../MILESTONES.md)).**

Geplante Struktur (ARCHITECTURE.md §3):

```
src/
├── core/         # portierte Fach-Logik (einzige Heimat von Business-Logik!)
│   ├── marketData.ts    ← reference/scripts/market_data.py + market_universe.py
│   ├── indicators.ts    ← reference/technical-analysis/… (Wilder-RSI!)
│   ├── engine.ts        ← reference/scripts/trading_engine.py
│   ├── forecaster.ts    ← reference/scripts/forecaster.py (+ eval, M5)
│   ├── sentiment.ts     ← reference/scripts/sentiment.py (M6)
│   ├── news.ts          ← reference/scripts/news_feed.py (M6)
│   └── broker.ts        ← reference/scripts/broker.py (PaperBroker, M4)
├── scheduled/    # scanMarket (5 min), evalForecasts (täglich), aiTuner (täglich)
└── callable/     # trade, saveStrategy, … (auth-geprüft, validiert, rate-limited)
```

Regeln:
- Secrets NUR über Firebase Secret Manager (`defineSecret`), nie hartkodiert.
- Alle Firestore-Writes idempotent (Doc-IDs = fachliche Schlüssel).
- Geld-Schreibendes (`wallet/positions/trades`) passiert ausschließlich hier.
- Jede Portierung aus `reference/` braucht Golden-Tests (MILESTONES M2/M5).
