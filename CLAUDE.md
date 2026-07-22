# CLAUDE.md — Entwickler-Leitfaden für autotrd

Diese Datei richtet sich an **Claude Code** (und Menschen), die an diesem Repo
arbeiten. Sie beschreibt die Architektur, die **nicht-offensichtlichen Fallen**
und die Konventionen, die man kennen muss, bevor man Code ändert.

> **⚠️ Zielarchitektur beachten:** Das Projekt wird zu einer Multi-User-
> TypeScript-Plattform (Firebase + autotrd.net) umgebaut — **zuerst
> [ARCHITECTURE.md](ARCHITECTURE.md) + [MILESTONES.md](MILESTONES.md) lesen.**
> Der Python-Code liegt jetzt unter **`reference/`** (alle `scripts/…`-Pfade in
> diesem Dokument sind relativ dazu) und dient als Referenz-Implementierung
> für Parity-Tests; neue Features entstehen in TS unter `functions/`+`frontend/`.
> Die Fallen unten (flaches Schema, Lookahead-Gate, Wilder-RSI, Frontend-
> Konventionen) gelten fachlich auch für die TS-Portierung weiter. Bitte
vollständig lesen, bevor du etwas anfasst — mehrere Bugs hier kommen zuverlässig
zurück, wenn man die Regeln unten nicht befolgt.

Sprache: Antworten und Commit-Messages auf **Deutsch**.

---

## 0. TL;DR der harten Regeln

1. **Schema ist flach.** `broker/watchlist/engine/indicators/signals` — nie
   verschachteln (§2).
2. **State lebt in `~/.hermes/trading/`**, nicht im Repo-Ordner (§1).
3. **Interpreter = das venv**, nicht das System-Python (§1).
4. **Kurs-/TA-Endpoints im Dashboard sind `def`, nie `async def`** — sonst
   friert der Event-Loop ein → weißer Screen (§4).
5. **Prognose-Evaluation ohne Lookahead** — das Gate ist heilig (§5).
6. **Frontend nur direkt in `scripts/static/index.html`** editieren (§6).
7. Nach jeder nicht-trivialen Änderung: **verifizieren** wie in §8.

---

## 1. Laufzeit-Layout (Pfad-Annahmen)

Der Code trennt **Programm** (dieses Repo) von **State** (Home-Verzeichnis):

| Zweck                | Ort                                              |
|----------------------|--------------------------------------------------|
| Python-Interpreter   | `~/.hermes/hermes-agent/venv/bin/python`         |
| Live-Config          | `~/.hermes/trading/strategy.yaml`                |
| Engine-Flag & Scans  | `~/.hermes/trading/engine_state.json`            |
| Positionen / Trades  | `~/.hermes/trading/{positions,trade_log}.json`   |
| Letzte Signale       | `~/.hermes/trading/signals.json`                 |
| Zeitreihen-Store     | `~/.hermes/trading/history.db` (SQLite, WAL)     |
| Secrets              | `~/.hermes/.env`                                  |
| Auto-Loop-Wrapper    | `~/.hermes/scripts/run_scan.sh`                  |

> Das System-`python` (3.14) hat die Deps **nicht**. Immer das venv nutzen —
> auch für Ad-hoc-Tests: `~/.hermes/hermes-agent/venv/bin/python scripts/…`.

Wenn du Pfade portabler machen willst (z. B. `AUTOTRD_HOME`-Env-Var), ist das
eine legitime Verbesserung — aber **an einer Stelle zentralisieren** und alle
Leser (Engine, Dashboard, cron_task, forecast_eval) gleichzeitig umstellen,
sonst lesen Loop und Dashboard verschiedene State-Files (siehe §2, running-Gate).

## 2. Die Doppel-Architektur-Falle (WICHTIGSTE Regel)

Es existierten historisch **zwei** Schemata. Nur das **flache** ist korrekt:

**✅ Richtig (flach):**
```yaml
broker: {provider, mode, initial_capital, paper_trading}
watchlist: [SYM, …]
engine: {check_interval_min, max_position_pct, stop_loss_pct, take_profit_pct}
indicators: {rsi:{…}, macd:{…}, bollinger:{…}}
signals: {min_confluence, period, use_forecast, forecast_weight, forecast_threshold_pct}
```

**❌ Falsch (verschachtelt — verursacht den UI-Speichern-Bug):**
```yaml
strategy: {type, parameters, …}
indices: [{symbol}]
risk_management: {…}
execution: {…}
```

Symptome der kaputten Variante: `broker:`/`watchlist:` fehlen; `cron_task.py`
zeigt auf `<repo>/data` statt `~/.hermes/trading/`; das UI kann die Strategie
nicht speichern. **Fix:** immer auf flaches Schema + `~/.hermes/trading/`
zurückbiegen.

> **Der `running`-Gate MUSS denselben State-File lesen wie das Dashboard
> schreibt** (`~/.hermes/trading/engine_state.json`). Lesen Loop und Dashboard
> verschiedene Dateien, handelt der Loop nie — obwohl das UI „ON" zeigt.

## 3. Dateien & Verantwortlichkeiten (`scripts/`)

| Datei                     | Rolle |
|---------------------------|-------|
| `trading_dashboard.py`    | FastAPI-App (`:8080`) + alle `/api/*`-Endpoints; startet via `__main__` mit uvicorn. |
| `trading_engine.py`       | Konfluenz-Logik, Positionsführung, `_execute_trade` → Broker-Routing, `_forecast_vote()`. |
| `cron_task.py`            | Ein Scan-Zyklus (vom Timer aufgerufen); respektiert den `running`-Gate; bewertet fällige Prognosen. |
| `market_data.py`          | yfinance-Wrapper (Kurse, History, Ticker-Resolve). |
| `market_universe.py`      | Katalog aller handelbaren Assets (166 Symbole, 10 Klassen, yfinance-Konventionen); Klarnamen-Resolve. |
| `history_store.py`        | SQLite-Zeitreihen (`history.db`, WAL); jeder Scan & jede Kursansicht hängt eine Observation an. |
| `forecaster.py`           | Sentiment-gewichtete Regression-Prognose; loggt Shadow-Forecasts über `(w, lookback)`-Gitter. |
| `forecast_eval.py`        | Self-Improvement: bewertet fällige Prognosen, tunt `best_params`. **Kein Lookahead** (§5). |
| `news_feed.py`            | Gratis-News (yfinance + Yahoo/Google RSS + Reddit), 10-min-Cache. |
| `sentiment.py`            | Lexikon-Sentiment + Event-Tags. |
| `ai_analyst.py`           | Claude-Erklärung pro Tag via `claude` CLI (`-p --model sonnet`); cached in `history.db`. |
| `ai_tuner.py`             | Täglicher KI-Review der Genauigkeit; darf Suchgitter in harten Bounds erweitern, **nie** Live-Params autonom ändern. |
| `event_engine.py`         | Mappt News auf echte Chart-Tage → sentiment-gefärbte Marker + KI-Tagessummary. |
| `broker.py`               | `get_broker(strategy)` → `PaperBroker` \| `AlpacaBroker`; liest Keys aus env; **live hart geguarded** (§7). |
| `backtest_engine.py`      | Strategie-Backtests (Sharpe/Drawdown). |
| `static/index.html`       | Komplettes Frontend (hand-maintained, ~87 KB). |

Sub-Skill-Ordner (`market-data/`, `technical-analysis/`, `trading-news/`,
`daytrading-automation/`) tragen jeweils eine `SKILL.md` + Scripts aus der
Hermes-Skill-Historie. `technical-analysis/scripts/technical_analysis.py`
liefert die RSI/MACD/BBands-Berechnung (nutzt `ta` + `mplfinance`).

## 4. Async-Blocking-Falle (Dashboard)

`yfinance`-Calls **blockieren**. Im FastAPI-Dashboard MÜSSEN kurs-/TA-Endpoints
gewöhnliche `def`-Funktionen sein (FastAPI führt die im Threadpool aus), **nicht**
`async def`. Ein `async def`-Endpoint, der blockierend yfinance ruft, friert den
gesamten Event-Loop ein → Server hängt → Browser bekommt leere Antwort →
**weißer Screen**.

- Symptom „Dashboard weiß / hängt" = fast immer ein geblockter Loop.
- Schnelltest: `/api/status` muss **<1 s** antworten, während `/api/pulse` läuft.
- Frontend-Polling ist bewusst langsam (Puls/Chart 60 s).

## 5. Prognose-Kern & Self-Tuning (kein Lookahead!)

- `forecaster.py` loggt „Shadow"-Prognosen über ein Gitter aus
  `WEIGHT_GRID × LOOKBACK_GRID (=[10,20,30])` — ~15 Kombis/Tag.
- `forecast_eval.py` bewertet nur Prognosen, deren **letzter Horizont-Tag
  realisiert** ist, mit striktem Gate `base_date < today`. Der `UNIQUE`-Index
  `(symbol, base_date, w, lookback)` verhindert Doppel-Logs.
- **Diese Gates nie aufweichen.** Ein früherer HIGH-Bug war exakt ein
  Lookahead-Leck hier; adversarial gefixt. Jede Änderung an der Zeitlogik ist
  hochriskant — mit echten Datumsgrenzen testen (§8).
- **Prognose treibt Trades:** `trading_engine._forecast_vote()` gibt der
  Konfluenz eine gewichtete Richtungsstimme, gesteuert über `signals.use_forecast`,
  `forecast_weight`, `forecast_threshold_pct` in `strategy.yaml`.

## 6. Frontend-Konventionen (`static/index.html`)

- **Direkt editieren.** Es gab einen Generator (`gen_dashboard.py`), der
  korruptes HTML erzeugte — er wurde aus dem Repo entfernt. Nicht wieder einführen.
- Charts: **TradingView Lightweight Charts v4.2.0** (CDN, gepinnt). **Nicht auf
  v5 bumpen**, ohne `addCandlestickSeries` → `addSeries(...)` umzuschreiben.
  React Flow ist für Kurse falsch.
- `LightweightCharts` **nicht** auf Top-Level referenzieren (CDN-Fail würde
  sonst das gesamte JS killen) — Guards in `buildPriceChart`/`loadTrend`,
  `crosshair.mode: 0` statt Enum.
- UI ist „Frosted Aurora": Glass-Cards, eine GPU-Aurora-Layer, Mono-Zahlen,
  `prefers-reduced-motion`-Guard, Light/Dark via `data-theme`, responsive bis
  ~360 px (dann Off-Canvas-Drawer + Bottom-Sheet-Modal `#detailModal`).
- Achtung doppelte IDs: Modal-Titel heißt `mvSym` (nicht `mSym` — das ist der
  Manual-Trade-Input). Chart-Tooltip `position: fixed`.
- Watchlist-Picker schreibt ins versteckte `#sTickers` + `doSave()`; Symbole
  müssen Katalog-Symbole sein (`^NDX`, nicht bloß `NDX`).

## 7. Broker & Sicherheit

- `broker.py` liest Keys **nur** aus env / `~/.hermes/.env`, loggt sie **nie**.
- **Echtgeld erfordert BEIDES:** `strategy.yaml broker.mode: live` **UND**
  env `ALPACA_ALLOW_LIVE=1`. Fehlt eins → automatischer Downgrade auf Paper.
- Ohne Keys → sauberer Fallback auf `PaperBroker`. Default ist immer Paper.
- Beim Erweitern der Broker-Schicht diese Guards **nie** lockern und Keys nie in
  Logs/Exceptions/Commits durchsickern lassen.

## 8. Verifikation (nach jeder nicht-trivialen Änderung)

Es gibt keine umfassende Test-Suite — **beobachte echtes Verhalten**:

```bash
PY=~/.hermes/hermes-agent/venv/bin/python

# a) Import-/Syntax-Smoke
$PY -c "import scripts.trading_engine, scripts.trading_dashboard, scripts.forecaster"

# b) Ein Scan-Zyklus (außerhalb Marktzeiten mit --force über den Wrapper)
$PY scripts/cron_task.py            # schreibt signals.json / history.db

# c) Dashboard live + Blocking-Test
$PY scripts/trading_dashboard.py &  # :8080
curl -s -m 1 localhost:8080/api/status   # MUSS <1s antworten
curl -s localhost:8080/api/pulse >/dev/null &   # währenddessen …
curl -s -m 1 localhost:8080/api/status   # … immer noch <1s? sonst §4-Regression

# d) Prognose-Evaluation ohne Lookahead
$PY scripts/forecast_eval.py        # darf nur realisierte Horizonte bewerten
```

Für UI-Änderungen zusätzlich mit headless Chrome bei Desktop (1500) **und** Phone
(390) prüfen. Für Flows mit mehreren Klicks lohnt das `verify`-Skill / Chrome-MCP.

## 9. Git-Konventionen

- **Nie** `~/.hermes/trading/`, `.env`, `*.db`, `*.bak` committen (siehe
  `.gitignore`). Vor jedem Commit prüfen, dass keine Keys im Diff stehen.
- Kleine, thematische Commits; deutsche Messages im Imperativ.
- State-Format-Migrationen (z. B. neue Spalte in `history.db`) additiv +
  idempotent halten und beim Start migrieren — nie bestehende `history.db`
  löschen (sie ist die Trainingshistorie des Self-Tuners).

## 10. Roadmap-Ideen (offen)

- Portable Pfade via `AUTOTRD_HOME` statt hartkodiertem `~/.hermes` (§1).
- Test-Suite um `forecast_eval` (Lookahead-Regression) und den `running`-Gate.
- Weitere Broker (IBKR), Krypto-Spot, konfigurierbare Marktzeiten pro Asset-Klasse.
- Backtest-Ergebnisse ins Dashboard.
