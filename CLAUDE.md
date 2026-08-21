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
| `news_feed.py`            | Gratis-News. TS-Rolle seit 29.07. **umgekehrt**: Feeds speisen ein Einstiegs-VETO (`functions/core/news.ts` + `shared/newsGate.ts`), keine Anzeige-Maschinerie (MILESTONES M6, Teil-Rückkehr). |
| `sentiment.py`            | Lexikon-Sentiment. Seit 29.07. wieder portiert (`shared/sentiment.ts`, Golden-Parity) — nur Veto + Schatten-Statistik, kein Prognose-Tilt. |
| `ai_analyst.py`           | Claude-Erklärung pro Tag. **NICHT portiert** (s. o.). |
| `ai_tuner.py`             | Täglicher KI-Review. **NICHT portiert** (s. o.) — das TS-Suchgitter ist fest. |
| `event_engine.py`         | News auf Chart-Tage mappen. **NICHT portiert** (s. o.). |
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
- **Anker-Serie statt Kerzen-Serie.** Lightweight Charts zeichnet NICHTS, was
  an einer `visible: false`-Serie hängt: keine Marker, keine Preislinien; auch
  `priceToCoordinate`/`coordinateToPrice` liefern dann Unbrauchbares. Die
  Kerzen-Serie ist genau dann unsichtbar, wenn der Nutzer Linie/Berg/Baseline/
  Bars wählt oder den Vektor-Look einschaltet. Alles Nicht-Kurs-Zeichnerische
  hängt deshalb an `lineHost` (transparente Linien-Serie mit denselben
  Schlusskursen, `frontend/src/chart.ts`) — News-Punkte, Veto-Kreuze,
  Kauf-Pfeile, Einstieg/Stop/Ziel, Zeichenwerkzeuge, Prognose-Pfeil. Der
  Fehler kam zweimal zurück (Owner 11.08.); die Sperre ist
  `npm run chart:shot` (zählt Marker-Pixel je Chart-Typ) plus der
  Quelltext-Wächter `frontend/test/chartAnkerSerie.test.ts`.
- **Chart-Änderungen ohne Browser-Nachweis sind unverifiziert.** typecheck,
  eslint und die Unit-Tests können die einzige Frage, die bei einem Chart
  zählt — *zeichnet er?* —, nicht beantworten. Vor jedem Chart-Commit:
  `npm i -D playwright --no-save && npm run chart:shot`. Prüft der Prüfstand
  die geänderte Sache nicht, ist er zuerst zu erweitern: Ein Prüfstand, der
  die gemeldete Sache nicht messen kann, bescheinigt Fehlerfreiheit.
- UI ist „Frosted Aurora": Glass-Cards, eine GPU-Aurora-Layer, Mono-Zahlen,
  `prefers-reduced-motion`-Guard, Light/Dark via `data-theme`, responsive bis
  ~360 px (dann Off-Canvas-Drawer + Bottom-Sheet-Modal `#detailModal`).
- Achtung doppelte IDs: Modal-Titel heißt `mvSym` (nicht `mSym` — das ist der
  Manual-Trade-Input). Chart-Tooltip (News-Bubble `#evTip`) ist `position:
  fixed` als **Portal an `document.body`** — nie in eine Glass-Card hängen:
  `backdrop-filter` macht die Card zum Containing Block für fixed (Bubble
  wandert dann mit der Sidebar-Breite) und zum eigenen Stacking Context
  (rechte Spalte malt drüber). Owner-Bug 21.08., Fix in `showNewsTooltip`.
- Watchlist-Picker schreibt ins versteckte `#sTickers` + `doSave()`; Symbole
  müssen Katalog-Symbole sein (`^NDX`, nicht bloß `NDX`).
- **Bild-Prüfstände messen Text gegen Text — nicht Rechteck gegen Text.**
  `share-shot.mjs` und `chart:shot` melden „keine Kollision", während ein
  Tag-Rechteck mitten durch einen Symbolnamen läuft oder ein Balken in die
  Zahlenspalte ragt. Beides kam am 21.08. beim Bau der Depot-Karte vor und
  war NUR im angesehenen Bild zu erkennen. Regel: Wo ein gezeichnetes
  Element neben Text sitzt, muss die GEOMETRIE die Kollision ausschließen
  (feste Spalte statt aus der Zeichenzahl geschätzter Textbreite; Balken
  enden vor der Zahlenspalte) — und ein Unit-Wächter pinnt die Koordinate.
  Aus Zeichenzahl × em geschätzte Breiten liegen bei „BTC-USD" oder „MSFT"
  zuverlässig daneben.
- **Symbol-Anzeigen tragen `data-sym`.** Der Steckbrief-Anker ist generisch
  (`SYM_TIP_ANKER = '[data-sym]'`): Jede neue Stelle, die ein Symbol zeigt,
  ist damit automatisch erklärbar (Hover ~0,3 s, Touch-Longpress 450 ms) —
  ohne dass jemand einen Selektor pflegt. Die Umkehrung gilt auch: Wer ein
  Symbol rendert und das Attribut vergisst, baut eine stumme Stelle
  (Owner-Befund 21.08.: „noch nicht alle Symbole haben Tooltips").

## 7. Broker & Sicherheit

- `broker.py` liest Keys **nur** aus env / `~/.hermes/.env`, loggt sie **nie**.
- **Echtgeld erfordert BEIDES:** `strategy.yaml broker.mode: live` **UND**
  env `ALPACA_ALLOW_LIVE=1`. Fehlt eins → automatischer Downgrade auf Paper.
- Ohne Keys → sauberer Fallback auf `PaperBroker`. Default ist immer Paper.
- Beim Erweitern der Broker-Schicht diese Guards **nie** lockern und Keys nie in
  Logs/Exceptions/Commits durchsickern lassen.
- **Sperren löst man über die URSACHE, nie per Override.** Die
  Abgleich-Sperre (`abgleich_drift`) ist kein Schalter, sondern ein
  Messergebnis: Sie steht, solange das Buch Positionen führt, die der
  Broker nicht hat. Ein Knopf „Sperre aus" wäre genau die Ausnahme, die
  den Schutz wertlos macht — der Fehlbestand bliebe ja. Richtig ist, die
  Prüfung neu auszulösen (dann fällt die Sperre von selbst, wenn die Drift
  weg ist) oder das Buch bewusst anzugleichen (`adoptBroker`, markierter
  Schnitt mit Bestätigung). Dieselbe Regel gilt für jede künftige Sperre:
  Die Admin-Ansicht darf sie SICHTBAR machen und die Messung anstoßen —
  ihren Zustand setzen darf nur die Messung selbst.

## 8. Verifikation (nach jeder nicht-trivialen Änderung)

> **Sabotage-Proben brauchen EINDEUTIGE Anker.** Ein Wächter, der nie rot
> war, bewacht nichts — deshalb wird jeder neue Wächter einmal absichtlich
> gebrochen und zurückgebaut, per Text-Ersetzung (nie `git checkout`, das
> nähme uncommittete Arbeit mit). Der Rückbau muss aber DENSELBEN Ort
> treffen: Am 21.08. ersetzte eine Probe das erste Vorkommen von „Fee
> share" (im EN-Block), der Rückbau das erste Vorkommen von
> „Gebührenanteil" (im DE-Block) — Ergebnis: DE und EN vertauscht. Die
> volle Suite hat es gefangen, aber verlassen darf man sich darauf nicht.
> Also: Anker mit genug Kontext wählen (Nachbarzeile, Zeilennummer oder
> `count == 1` prüfen) und nach dem Rückbau die Suite laufen lassen.

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

## 11. Rolle des Kritikers (Prompt-Strategie, Owner 20.08.)

Jedes größere Arbeitspaket bekommt einen **separaten Kritiker**, der nicht
selbst implementiert hat. Es gibt zwei Sorten mit verschiedenen Aufträgen —
sie zu verwechseln macht beide wertlos:

- **UI-Kritiker (Blindvergleich).** Für alles Sichtbare (Chart, Bedienung,
  mobil). Er vergleicht Screenshots von autotrd und TradingView bei
  DERSELBEN Aufgabe blind nebeneinander — Desktop und Handy (390 px) — und
  sagt, welcher besser aussieht und sich besser bedient. Erkennt er unseren,
  ist das Paket nicht fertig. Nachweis ausschließlich über den Browser:
  `npm i -D playwright --no-save && npm run chart:shot` plus
  `frontend/e2e/smoke.mjs`. „Kompiliert sauber" ist kein Beleg (§6).
- **Engine-Red-Team (Widerlegung).** Für alles Unsichtbare (Kante, Prognose,
  Messung). Seine Frage ist nicht „ist es gut genug", sondern **„beweise,
  dass diese Zahl falsch ist"**: Lookahead (§5 — das Gate ist heilig, ein
  Leck war schon einmal da), Survivorship im Universum, Kosten, die im Test
  fehlen und live anfallen, zu kleine Stichproben, zu viele Freiheitsgrade,
  In-Sample-Auswahl, Datums-/DST-Kanten. Jede gemessene Verbesserung gilt
  als Einbildung, bis sie out-of-sample nach Kosten überlebt. **„Wir sollten
  nicht handeln" ist ein zulässiges Ergebnis** — der Kritiker darf es nie
  wegloben.

Warum die Trennung: Beim Sichtbaren entsteht das Urteil ehrlich AUSSERHALB
des Systems (Blindvergleich). Beim Unsichtbaren wäre „Loop, bis der Kritiker
begeistert ist" exakt die Definition von Overfitting — dort muss der
Kritiker ein Gegner sein, kein Publikum. Der kopierfertige Master-Prompt
steht in MILESTONES.md („Übergabe-Prompt"), Begründung und Kurzvarianten in
`docs/MASTERPROMPT.md`.
