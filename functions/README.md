# functions/ — Cloud Functions (Node 20, TypeScript)

**Status: M1 steht — `healthz`-Smoke-Function läuft (Build: `npm run build -w
functions`, Test via Emulator). Fachlogik folgt ab M2 (siehe
[MILESTONES.md](../MILESTONES.md)).**

> Build-Detail: `tsconfig.json` kompiliert `../shared/src` MIT nach `lib/`
> (rootDir = Repo-Root), damit das Deploy-Artefakt self-contained ist —
> shared deshalb hier per relativem Pfad importieren
> (`../../shared/src/index.js`), nicht als npm-Paket.

Geplante Struktur (ARCHITECTURE.md §3):

```
src/
├── core/         # portierte Fach-Logik (einzige Heimat von Business-Logik!)
│   ├── marketData.ts    ← reference/scripts/market_data.py + market_universe.py
│   ├── indicators.ts    ← reference/technical-analysis/… (Wilder-RSI!)
│   ├── engine.ts        ← reference/scripts/trading_engine.py
│   ├── forecaster.ts    ← reference/scripts/forecaster.py (+ eval, M5)
│   └── broker.ts        ← reference/scripts/broker.py (PaperBroker, M4)
├── scheduled/    # scanMarket (5 min), evalForecasts, snapshotEquity, autoTune
└── callable/     # trade, saveStrategy, … (auth-geprüft, validiert, rate-limited)
```

Regeln:
- Secrets NUR über Firebase Secret Manager (`defineSecret`), nie hartkodiert.
- Alle Firestore-Writes idempotent (Doc-IDs = fachliche Schlüssel).
- Geld-Schreibendes (`wallet/positions/trades`) passiert ausschließlich hier.
- Jede Portierung aus `reference/` braucht Golden-Tests (MILESTONES M2/M5).
