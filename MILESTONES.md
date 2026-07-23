# MILESTONES.md — Fahrplan & Coding-Loop

Arbeitsanweisung für **Claude Code** (und Menschen) zur Umsetzung der
[ARCHITECTURE.md](ARCHITECTURE.md). Die Milestones sind **in Reihenfolge**
abzuarbeiten; jeder endet in einem lauffähigen, deploybaren Zustand.

---

## Der Coding-Loop (so wird gearbeitet)

Für jede Session / jeden Arbeitsblock:

1. **Kontext laden:** `ARCHITECTURE.md` (Ziel) + `CLAUDE.md` (Fallen/Konventionen)
   + diese Datei. Dann den **ersten nicht abgehakten Milestone** nehmen —
   niemals vorgreifen.
2. **Klein planen:** Den nächsten offenen Task des Milestones in kleine,
   einzeln verifizierbare Schritte zerlegen. Bei Architektur-Zweifeln:
   ARCHITECTURE.md gewinnt; bei Widerspruch → Frage stellen statt raten.
3. **Implementieren:** Kleine Schritte, laufend Typecheck/Tests. Neue Logik
   immer in `functions/src/core/` bzw. `shared/` — nie Business-Logik ins
   Frontend, nie Berechnung pro User duplizieren (ARCHITECTURE §2).
4. **Verifizieren — echt, nicht behauptet:** Die „Abnahme"-Punkte des
   Milestones tatsächlich ausführen (Emulator starten, curl, Browser/Headless,
   Tests laufen lassen). Fehlschläge ehrlich berichten, nicht schönreden.
5. **Abhaken + committen:** Erledigte `[ ]` → `[x]` in dieser Datei (im selben
   Commit!). Commits: deutsch, imperativ, klein, thematisch. Vor jedem Commit:
   kein Secret, kein `node_modules`, kein State im Diff.
6. **Mergen → Pipelines:** Merge auf `main` deployt automatisch (Frontend →
   webgo, Functions → Firebase). Nach Deploy einmal Live-URL prüfen.

### Eiserne Regeln (gelten in jedem Milestone)

- **Lookahead-Gate niemals aufweichen** (Forecast-Eval: `base_date < today`,
  letzter Horizont-Tag muss realisiert sein). Jede Änderung an Datumslogik
  braucht Tests mit DST-Wechsel/Wochenende/Feiertag.
- **Flaches Strategie-Schema** (`broker/watchlist/engine/indicators/signals`) —
  Typen in `shared/src/strategy.ts` sind die einzige Wahrheit.
- **Clients schreiben nie** `wallet`/`positions`/`trades` — nur Functions
  (Admin SDK). Firestore Rules entsprechend, Änderungen an Rules immer mit
  Emulator-Rules-Tests.
- **Secrets nur** in GitHub Secrets / Firebase Secret Manager. Nie im Code,
  nie im Frontend-Bundle, nie in Firestore-plain.
- **Parity vor Abschaltung:** Python in `reference/` bleibt Referenz, bis die
  TS-Portierung per Golden-Tests (Toleranz 1e-9) nachweislich gleich rechnet.
- **Frontend-Konventionen** aus `CLAUDE.md` §6 gelten weiter (Lightweight
  Charts v4 gepinnt, keine Top-Level-CDN-Referenz, `prefers-reduced-motion`,
  responsive bis 360px).

---

## M0 — Monorepo-Skeleton ✅

- [x] Python-Bestand nach `reference/` verschoben (bleibt lauffähig)
- [x] Ordner `frontend/ functions/ shared/ .github/workflows/` angelegt
- [x] `ARCHITECTURE.md`, `CLAUDE.md`, `MILESTONES.md`, Rules/Workflows/Typen-Seed

## M1 — Tooling & Firebase-Grundgerüst

**Ziel:** `npm install` + CI grün; Firebase-Projekt verbunden; leere, aber
deploybare SPA mit Login hinter `autotrd.net`.

- [x] Root-`package.json` mit npm-Workspaces (`frontend`, `functions`, `shared`),
      TypeScript strict, ESLint, Vitest; `shared` baut als reines Typ-/Util-Paket
      (+ `validateStrategy()` mit Tests gegen das Alt-Schema)
- [x] `frontend/`: Vite + TS + Firebase JS-SDK; Login-Screen (E-Mail+Passwort,
      Google) mit Firebase Auth; nach Login leeres Dashboard-Shell
      (E2E-verifiziert gegen den Auth-Emulator: Registrieren → Shell → Logout →
      Login → Fehlerpfad; Desktop 1500 + Phone 390 ohne Overflow)
- [x] `functions/`: Firebase Functions v2 (Node 20, TS) initialisiert;
      eine `healthz`-HTTP-Function als Smoke (im Emulator verifiziert;
      kompiliert `shared/` mit ins Deploy-Artefakt)
- [ ] Firebase-Projekt anlegen (Konsole, Blaze + **Budget-Alarm**), `.firebaserc`
      Projekt-ID eintragen, `firestore.rules` deployen
      *(Owner-Schritt; `.firebaserc` mit Platzhalter `autotrd` liegt bereit)*
- [x] Emulator-Suite (`firebase emulators:start`: auth, firestore, functions)
      läuft lokal; README-Abschnitt „Lokal entwickeln"
- [ ] GitHub Secrets setzen: `FTP_HOST/FTP_USERNAME/FTP_PASSWORD` (webgo, FTPS!),
      `FIREBASE_SERVICE_ACCOUNT` bzw. Token; Workflows aus `.github/workflows/`
      laufen durch (CI hat Guard, solange Tooling fehlt)
      *(Owner-Schritt: Secrets; die drei Workflows liegen bereit, Deploys
      überspringen sich sauber per Guard, solange Secrets fehlen)*
- [ ] webgo: `autotrd.net` DocumentRoot auf Deploy-Zielordner; HTTPS aktiv
      *(Owner-Schritt)*

**Abnahme:** PR-CI grün · `firebase emulators:start` ok · Merge auf `main`
lädt Frontend-Build zu webgo hoch · `https://autotrd.net` zeigt Login,
Registrierung + Login funktionieren live.

## M2 — Marktdaten zentral (`scanMarket`)

**Ziel:** Ein zentraler Scan schreibt geteilte Marktdaten; Indikatoren rechnen
in TS nachweislich wie in Python.

- [x] `core/marketData.ts`: Yahoo-Chart-API (alle Katalog-Konventionen) +
      Alpaca-Slot (aktiv sobald `ALPACA_API_KEY/SECRET` gesetzt, nur
      US-Equities, Fallback Yahoo); Universum nach `shared/src/universe.ts`
      portiert → `meta/universe` wird beim Scan geseedet (verifiziert)
- [x] `core/indicators.ts`: RSI (**Wilder-Glättung!**), MACD, Bollinger —
      Mathematik in `shared/src/indicators.ts` (eine Implementierung für
      Scan, Backtest und Frontend), Fassade in functions/core
- [x] **Golden-Tests:** Fixtures via `reference/golden/gen_fixtures.py`
      (`ta`-Bibliothek, geseedete Serien), Vitest vergleicht TS (1e-9) —
      21 Parity-Tests, CI-Pflicht ab jetzt
- [x] Scheduled Function `scanMarket` (alle 5 min via Cloud Scheduler):
      ET-Marktzeiten-Gate (09:30–16:00, Mo–Fr, DST-getestet), schreibt
      `market/{sym}` quote/bars/indicators/signals idempotent (Doc-IDs =
      Datum/Scan-Minute; Bars: Erst-Backfill, danach nur letzter Bar);
      `scanNow`-HTTP-Trigger nur im Emulator
- [x] Konfluenz-Logik `core/engine.ts` (aus `trading_engine.py`, zunächst ohne
      Forecast-Vote): Signale nach `market/{sym}/signals/` (6 Unit-Tests)
- [x] Frontend: Watchlist-Kacheln mit Live-Quote via `onSnapshot` (erst
      hartkodierte Default-Watchlist); Listener werden beim Logout gelöst

**Abnahme:** Golden-Tests grün in CI ✓ · Emulator: `scanMarket` manuell
getriggert füllt `market/**` ✓ (2. Scan idempotent: Bar-Zahl konstant) ·
Playwright-E2E: Login → 4/4 Kacheln mit Live-Quotes, Phone 390 ohne
Overflow ✓ · *Live-5-min-Takt folgt automatisch mit dem ersten
Functions-Deploy (Owner-Schritte aus docs/SETUP.md).*

## M3 — Dashboard-Port (Frosted Aurora → SPA)

**Ziel:** Das bestehende UI (Seed: `reference/scripts/static/index.html` —
der Kern ist gut und bleibt!) als komponentisierte SPA auf Firestore-Reads.

- [x] UI portieren: Aurora-Theme, Glass-Cards, Light/Dark (`data-theme` +
      Toggle, persistiert), Candlestick+Volumen-Chart (Lightweight Charts
      **4.2.0 exakt gepinnt**, dynamischer Import mit Lade-Guard + Fallback-
      Text, `crosshair.mode: 0`), Watchlist-Picker mit Katalog aus
      `meta/universe` (Chips, Kategorie-Tabs, Checkbox-Browse)
- [x] Alle Daten via `onSnapshot`/`getDocs` statt fetch-Polling; kein
      `/api/*` mehr (Aktionen über Callables)
- [x] User-Settings (`users/{uid}.settings`, flaches Schema aus `shared`)
      lesen/schreiben — `ensureProfile` legt das Profil serverseitig an,
      `saveStrategy` validiert serverseitig (lehnt Alt-Schema, Nicht-Katalog-
      Symbole und `mode: live` hart ab); Engine-Start/Stop-Schalter persistiert
      `engine.running`
- [x] Responsive-Abnahme wie in `CLAUDE.md` §6: Playwright Desktop 1500
      **und** Phone 390 (kein Overflow); Off-Canvas-Drawer + Bottom-Sheet-
      Detail-Modal erhalten
- [ ] Bekannte UI-Verbesserungen aus dem Alt-Dashboard einarbeiten (Liste beim
      Start des Milestones mit dem Owner konkretisieren)
      *(Owner-Schritt: Wunschliste nennen — dann Umsetzung als Folge-PR)*

**Abnahme:** Emulator-E2E grün: Login → Dashboard mit Realtime-Kursen, Chart,
eigener Watchlist (Picker → `saveStrategy` → nächster Scan erfasst neue
Symbole zentral) · beide Viewports ok · *Live-Abnahme auf autotrd.net +
Lighthouse > 80 folgt mit den Owner-Deploy-Schritten (docs/SETUP.md).*

## M4 — Paper-Trading pro User

**Ziel:** Jeder Account hat Wallet/Positionen/Trades; Engine handelt je nach
User-Strategie. **Alles Geld-Schreibende nur serverseitig.**

- [x] `shared`: Typen `Wallet/Position/Trade`; Firestore-Rules-Tests
      (`npm run test:rules`, emulators:exec, auch in CI): Client-Write auf
      wallet/positions/trades wird ABGELEHNT — 9 Tests grün
- [x] `core/broker.ts`: Paper-Ausführung als Firestore-Transaktion (Port aus
      `broker.py`: nie nachkaufen, Sizing aus maxPositionPct, P&L in den
      Trade-Record); `resolveBrokerMode()` als einzige Modus-Entscheidung mit
      Live-Doppel-Guard (`mode:live` UND `ALPACA_ALLOW_LIVE=1`, sonst Paper)
- [x] Callable `trade` (auth-geprüft, Katalog-/Input-Validierung, Tages-Quota
      über `admin/quotas-{uid}`): manueller Paper-Trade — Preis kommt IMMER
      aus den zentralen Scan-Daten, nie vom Client
- [x] `scanMarket`-Erweiterung: pro User mit `engine.running=true` Signale
      gegen dessen Strategie (SL/TP-Risk-Exits zuerst, dann Konfluenz);
      effizient: 1 Marktdaten-Fetch, N User-Auswertungen in-memory
- [x] Frontend: Performance-Karte (Cash/Equity/P&L/Win-Rate live), Positionen
      mit Exit-Button, Trade-Historie (Engine-Trades markiert), manueller Trade
- [x] Onboarding: `ensureProfile` legt `wallet.paperBalance` mit dem
      Default-Startkapital an

**Abnahme (Emulator-E2E):** Zwei Test-Accounts: getrennte Wallets/Trades ✓ ·
Rules-Tests grün (CI-Pflicht) ✓ · Engine-ON-Account handelt beim nächsten
Scan (2 Engine-Trades), OFF-Account nicht ✓ · Manipulationsversuch mit echtem
User-ID-Token (Firestore-REST-PATCH auf wallet) → HTTP 403, Wallet
unverändert ✓ · *Live-Abnahme folgt mit den Owner-Deploy-Schritten.*

## M5 — Forecast-Kern & Self-Tuning

**Ziel:** Das „Herz" portieren — sentiment-gewichtete Prognose + Selbst-
Bewertung. **Höchstes Portier-Risiko, langsam und testgetrieben arbeiten.**

- [ ] `core/forecaster.ts`: Port aus `reference/scripts/forecaster.py`
      (Drift + gedeckelter Tilt; Shadow-Grid `(w, lookback)`) — Golden-Tests
      gegen Python-Fixtures ZUERST schreiben, dann portieren
- [ ] Scheduled `evalForecasts` (täglich nach Börsenschluss): Port aus
      `forecast_eval.py` — **Lookahead-Gate strikt**, Doc-ID
      `baseDate_w_lookback` ersetzt UNIQUE-Index; `best_params` nach
      `market/{sym}` · Extra-Tests: DST-Wechsel, Wochenende, Feiertag
- [ ] Engine: `_forecast_vote()`-Äquivalent in `core/engine.ts`
      (`signals.use_forecast/forecast_weight/forecast_threshold_pct`)
- [ ] Frontend: Prognose-Overlay im Chart + Genauigkeits-Karte (`/api/accuracy`-
      Äquivalent aus Firestore)

**Abnahme:** Golden-Tests Forecaster + Eval grün · über mehrere Live-Tage:
Prognosen werden geloggt, fällige korrekt bewertet, KEINE Bewertung vor
Realisierung (Stichprobe von Hand prüfen) · danach `reference/` als eingefroren
markieren (README-Notiz), systemd-Referenz-Loop darf abgeschaltet werden.

## M6 — News, Sentiment & KI-Staffel

**Ziel:** News-Events + tokeneffiziente KI, zentral gecacht.

- [ ] `core/news.ts` + `core/sentiment.ts`: Feeds (yahoo-finance2 News +
      RSS via feedparser-Äquivalent) und Lexikon-Sentiment portieren;
      10-min-Cache; Schreibziel `market/{sym}/news/`
- [ ] KI-Staffel (ARCHITECTURE §6): Anthropic TS-SDK in Functions;
      Haiku = Klassifikation, Sonnet = Tages-Erklärung; Cache
      `market/{sym}/ai/{date}` (1 Call für alle User); Prompt-Caching;
      täglicher Tuner-Review (Port `ai_tuner.py`: darf Suchgitter in Bounds
      erweitern, ändert NIE Live-Params autonom) via Batch API
- [ ] Kosten-Guard: Tages-Tokenbudget als Config; bei Überschreitung
      degradiert die Pipeline auf regelbasiert (loggt das sichtbar)
- [ ] Frontend: Event-Marker auf Kerzen + Tooltip/Bottom-Sheet, News-Panel
      mit Sentiment-Färbung, Layer-Toggles (Port aus Alt-UI)

**Abnahme:** Live: Symbol mit News zeigt Marker + KI-Summary; zweiter Abruf
kommt aus Cache (Firestore-Read, kein API-Call — an Logs verifizieren) ·
Anthropic-Konsole: Tageskosten im erwarteten Cent-Bereich.

## M7 — Härtung & Betrieb

**Ziel:** „Offen online zugänglich" verantwortbar machen.

- [ ] Firebase **App Check** (Frontend + Functions erzwingen)
- [ ] E-Mail-Verifikation Pflicht vor Engine-Nutzung; Passwort-Reset-Flow testen
- [ ] Rate-Limits/Quotas für alle Callables; Firestore-Rules-Review
      (Emulator-Testsuite komplett)
- [ ] Monitoring: Cloud Logging Alerts (Function-Fehler, Scan-Ausfall
      > 15 min während Marktzeiten), GCP-Budget-Alarm verifizieren
- [ ] Security-Pass: `npm audit`, Abhängigkeiten pinnen, Rules nochmal
      adversarial denken (was kann ein böswilliger eingeloggter User?)
- [ ] Rechtliches Minimum: Impressum, Datenschutzerklärung,
      Risiko-Disclaimer („kein Finanzrat") im Frontend

**Abnahme:** Fremder Client ohne App Check wird abgewiesen · simulierter
Scan-Ausfall alarmiert · Audit ohne Highs · Rechtstexte live.

## M8 — (neu geschnitten → M13 + M14)

Der ursprüngliche Broker-Connect-Milestone ist in zwei Teile aufgegangen
(siehe [docs/VISION.md](docs/VISION.md)): sein **Paper-Anteil** (KMS-Keys,
Connect-Flow, echte Order-Mechanik gegen `paper-api.alpaca.markets`) ist jetzt
**M13**, sein **Echtgeld-Kern** ist **M14** — Echtgeld bleibt damit der letzte,
verriegelte Milestone.

---

> **M9–M14 — Ausbau zur Vision** (siehe [docs/VISION.md](docs/VISION.md)).
> Voraussetzung: M2–M7 abgeschlossen. Reihenfolge gilt; Echtgeld (M14) zuletzt
> und nur mit ausdrücklichem Owner-Go.

## M9 — Linked Workspaces & Null-Klick-Cockpit

**Ziel:** Das portierte Dashboard (M3) wird zum modularen Arbeitsraum mit
gemeinsamer Aufmerksamkeit: Panels, Link-Gruppen, Keyboard-first, Multi-Monitor
— rein clientseitig, ohne zusätzliche Firestore-Reads.

- [ ] Panel-Lebenszyklus (`mount/onLink/destroy`) + 12-Spalten-Grid; M3-Karten
      (Chart-Stack, Watchlist, Signale, News, Positionen) als Panels;
      Persistenz `users/{uid}/workspaces/{wsId}` (debounced 2 s)
- [ ] Link-Bus mit Gruppen A/B/C: Symbol-, Zeit- (timestamp-basiert) und
      Crosshair-Sync (`setCrosshairPosition`), Link-Chip je Panel in
      Aurora-Farben
- [ ] QuoteStore-Multiplexing + Leader-Tab über `BroadcastChannel`:
      n Fenster, ein Listener-Satz — Multi-Monitor ohne Read-Duplikation
- [ ] Command-Palette (`Ctrl+K`): Symbol-Resolve aus `meta/universe`
      (Klarnamen, `^NDX`-Konvention), Befehle für Order/Alert/Workspace;
      Hotkeys in `settings.hotkeys`
- [ ] Hotkey-Order-Ticket (`Shift+B/S`) als Overlay auf das
      `placeOrder`-Callable, Risiko-Vorschau-Zeile, Kurs-Altersstempel,
      unübersehbares PAPER-Badge
- [ ] Werks-Presets („Überblick", „Ein-Symbol-Fokus", „Signal-Jäger") +
      deterministische Mobile-Degradation zur Stapelliste (Bottom-Sheet bleibt)

**Abnahme:** Zwei Browserfenster, Gruppe A: Watchlist-Klick wechselt
Chart+News+Signale in beiden Fenstern, Firestore-Listener-Zahl bleibt konstant
(DevTools-Nachweis) · `Ctrl+K` → `nvda b 10%` → bestätigter Paper-Trade ohne
Maus · 390 px rendert die Stapelliste ohne horizontales Scrollen · Panel-Wechsel
erzeugt keine Listener-Leaks (Zähler vor/nach 20× Durchklicken identisch).

## M10 — Strategie-Studio I: Regel-JSON, Karten-Builder, Live-Vorschau

**Ziel:** Strategie-Logik wird Daten: ein getypter Bedingungsbaum in `shared/`,
den Builder-Vorschau, Scan-Engine und (später) Backtest identisch
interpretieren; das flache Schema lebt als kompilierbares `classic`-Preset
weiter.

- [ ] `shared/src/rules/`: Zod-Knoten (`all/any/weighted/not`;
      `compare/crossover/priceLevel/changePct/timeWindow/sentiment/newsEvent/`
      `forecast/position`) + pure `evaluate()`; harte Schema-Guards
      (Tiefe ≤ 5, ≤ 25 Knoten, erreichbarer Threshold)
- [ ] `users/{uid}/strategies/{id}` mit `draft`/`compiled`/`status` + Callables
      `saveStrategyDraft`/`publishStrategyVersion`/`assignStrategy`; Rules:
      Client-Write `false`; max. 1 `paper`-Strategie je (uid, Symbol)
- [ ] Migration `settings.strategy` (flach) → `kind:'classic'` + Compiler
      classic→Baum; **Parity-Test:** kompilierte Classic-Strategie liefert
      identische Signale wie die M4-Konfluenz (Golden-Fixtures)
- [ ] `scanMarket`-Erweiterung: 1 Marktdaten-Fetch pro Symbol, N
      Baum-Auswertungen; exotische Indikator-Parameter nur in-memory
      (memoisiert), Katalog-Varianten weiter nach `market/**`
- [ ] Risiko-Hülle außerhalb des Baums (Clamp `maxPositionPct` ≤ 25,
      Pflicht-Stop-Loss, `maxOpenPositions`, Cooldown) — von keinem Knoten
      überschreibbar; Stop/TP greifen vor jeder Regel-Auswertung
- [ ] Karten-Builder `#/strategy/{id}` (Gates/Votes/Exit als Glass-Cards,
      Threshold-Stepper, Gewicht-Badges) + Live-Vorschau über gecachte Bars
      (Marker + Haltebänder, Label „Vorschau, kein Backtest",
      Hinweis „Auswertung alle 5 min")
- [ ] 5 Presets in `meta/strategyPresets`, jede Knotenart in mindestens einem
      Preset (Presets = Doku)

**Abnahme:** Preset kopieren → RSI-Schwelle ändern → Vorschau-Marker ändern
sich ohne Server-Call (Network-Tab) · publizierte Strategie handelt im nächsten
Scan auf Paper · direkter Firestore-Write auf `strategies/**` wird abgelehnt
(Rules-Test) · Classic-Parity-Test grün · Builder funktioniert bei 390 px.

## M11 — Strategie-Studio II: Backtest, Shadow, Sweeps, A/B

**Ziel:** Den Experimentier-Loop schließen: Jede publizierte Version wird
automatisch backgetestet, kann als Shadow live beobachtet, gesweept und im
fairen A/B gegen die aktive Strategie befördert werden.

- [ ] Port `backtest_engine.py` → `functions/src/core/backtest.ts`;
      **Backtest-on-Save** nach `runs/{runId}`: Sharpe, MaxDD, Winrate,
      Trades, Equity-Kurve (≤ 200 Punkte), Bedingungs-Statistik
      („MACD-Cross feuerte 41×, 12× entscheidend")
- [ ] Lookahead-Disziplin: Evaluator/Backtest sehen je Bar nur Daten ≤ dieses
      Bars; Regressionstests inkl. Wochenend-/DST-Fällen — gleiche Härte wie
      das `forecast_eval`-Gate
- [ ] Shadow-Modus: virtuelles Konto im Strategie-Doc (nur Functions
      schreiben), `shadowSignals` nur bei Entscheidungs-Wechsel; UI-Tab mit
      Hätte-Feed + virtueller vs. echter Equity-Kurve
- [ ] Sweeps: ≤ 2 Parameter, ≤ 60 Kombis, Budget-Check im Callable; Historie
      einmal laden, alle Kombis im RAM; Ergebnis als Tabelle + Heatmap,
      „Als neuen Entwurf übernehmen" — bewusst **kein** Auto-Apply
- [ ] A/B auf Papier: A `paper` (echtes Wallet), B `shadow` mit gleicher
      Startbalance; Kennzahlen-Duell, Divergenz-Hervorhebung, transaktionales
      „Befördern" (Rollentausch)
- [ ] Versionierung mit Diff-Ansicht + Rollback (append-only); Quotas in
      `admin/quotas` (10 Strategien, 3 Shadow, 10 Backtests + 3 Sweeps/Tag)

**Abnahme:** Publish erzeugt binnen ~1 min eine Report-Karte per `onSnapshot` ·
Shadow-Strategie schreibt beim Signalwechsel genau ein `shadowSignals`-Doc ·
60-Kombi-Sweep bleibt unter dem Function-Timeout · ein absichtlich eingebautes
Lookahead-Leck lässt den Regressionstest fehlschlagen (adversariale Fixture im
Repo) · „Befördern" tauscht Rollen atomar.

## M12 — Portfolio, Risiko & Tagesfilm-Journal

**Ziel:** Multi-Wallets je Strategie mit vorberechneten Kennzahlen (Dashboard =
1 Stats-Doc-Read), serverseitige Risiko-Guards inkl. Circuit Breaker — und der
Tagesfilm: Replay des Handelstags mit eigenen Trades, damaligen Signalen, News
und KI-Erklärung, gekoppelt an ein automatisches Journal.

- [ ] Migration `wallet` → `users/{uid}/wallets/{walletId}` (`epoch` für
      Resets, `strategyId`-Bindung), Positionen als `{walletId_symbol}`;
      Callables `createWallet/archiveWallet/resetWallet` (Quota 5)
- [ ] `core/portfolio.ts` (pure, Vitest inkl. DST-/Feiertagsfälle) +
      `snapshotEquity` (täglich nach US-Close): `equity/{walletId_date}` mit
      HWM/Drawdown, `stats/{walletId}` mit Sharpe 30/90, MaxDD, WinRate,
      ProfitFactor, Expectancy-R, Attribution je Symbol/Strategie/Assetklasse
- [ ] `core/risk.ts`: Circuit Breaker (Tages-Loss-Limit je Wallet,
      `blockNew`/`flattenAll`, Re-Arm per Callable, Sofort-Push),
      Positionslimit, fixed-fractional Sizing (Initial-Stop beim Entry
      eingefroren → R-Multiples) — in derselben Transaktion wie der
      Wallet-Write, für Scan- und Manuell-Pfad
- [ ] Journal-Autoanlage bei Entry/Exit mit eingefrorenem `signalContext`
      (Votes, Indikatorwerte, Forecast, News-Refs, ≤ 60 Bars inline);
      Rules erlauben dem Client nur `notes/tags/mistakes/review` (diff-Check);
      Review-Flow mit Grades A–D
- [ ] **Tagesfilm:** Replay-Panel mit Scrubber aus `ohlc/m5`-Chunk + eigenen
      Trades + `signals/{scanId}` + `events/{date}`-Markern + `ai/{date}` als
      Abspann; Abgleich „Signal befolgt / ignoriert / dagegen"
- [ ] Portfolio-Tab: Equity-Kurve + synchronisiertes Drawdown-Panel,
      Wallet-Vergleich normalisiert auf 100; Reports Stufe 0 (Template) +
      Stufe 1 (Haiku-Batch, nur aktive User) via Push/E-Mail, opt-in

**Abnahme:** Simulierter −3 %-Tag trippt den Breaker, neuer Entry wird im
selben Scan geblockt, Grund erscheint im Signal-Feed · Journal-Update mit
fremdem Feld wird von Rules abgelehnt · Portfolio-Öffnung kostet ≤ ~10 Reads
(Profiler-Nachweis) · Tagesfilm lädt mit genau 1 Chunk-Read · Wallet-Reset
erhöht `epoch`, die Kennzahlen-Reihe bricht nachweislich an der Zäsur.

## M13 — Alpaca Paper Connect & Realtime-Streamer

**Ziel:** Das zweite Paper-Gleis mit echter Order-Mechanik gegen
`paper-api.alpaca.markets` (eigene Paper-Keys, KMS-verschlüsselt) plus der
Cloud-Run-`streamer` als einziger Websocket-Halter: Hot-Set-Quotes,
Sekunden-Preis-Alerts, `trade_updates`.

- [ ] `connectAlpacaPaper`: PK-Präfix-Pflicht (Live-Keys werden abgelehnt),
      **hartkodierte** Paper-Basis-URL, Probe-Call, KMS-Envelope →
      `users/{uid}/private/broker` (`read/write: if false` für alle Clients),
      Initial-Sync + Disconnect-Callable
- [ ] Order-Statusmaschine: `bracket`/`oco`/`trailing_stop`, `notional`,
      `extended_hours`, TIF; `client_order_id` = Firestore-Doc-ID
      (Idempotenz), `cancelOrder`/`replaceOrder`; `engine.stopLoss/takeProfit`
      mappen auf Bracket-Orders
- [ ] Cloud-Run-`streamer`, Modul Quotes: IEX-/Krypto-Websocket auf das
      Hot-Set (Presence via `admin/presence`, 60-s-Heartbeat), Drossel
      ≤ 1 Write/2 s/Symbol + Change-Filter, `min-instances` 1/0 per
      Marktzeit-Scheduler
- [ ] `streamer`, Modul trade_updates: `partial_fill`/`fill`/`canceled` →
      Order/Position/Wallet (Teilfill-Fortschritt im UI); Reconciliation je
      Scan („Alpaca ist die Wahrheit" für Gleis B), Drift-Log nach
      `admin/reconciliations`
- [ ] Cloud-Tasks-Queue `alpaca-central` für alle Calls mit dem zentralen
      Daten-Key (429-Header respektieren, Backoff, Dead-Letter-Docs) +
      Token-Bucket je User-Key in `admin/quotas`
- [ ] Preis-Alerts realtime über den Streamer (in-memory, nur Firing-Events
      als Writes); Fehlerbilder-Matrix (401/403/422/429/5xx/WS-Disconnect):
      fachliche Fehler nie retryen, technische idempotent

**Abnahme:** Limit-Order gegen Alpaca-Paper durchläuft sichtbar
`pending_new→new→(partial_)filled` inkl. Teilfill-Fortschritt · erzwungener
Timeout + Retry erzeugt keine Doppel-Order (gleiche `client_order_id`) ·
Preis-Alert feuert < 5 s nach Schwellen-Tick (gemessen) · grep über Logs,
Firestore-Export und Frontend-Bundle findet keinen Key · Streamer-Kill
degradiert das UI sichtbar auf den 5-min-Stand („verzögert"-Badge).

## M14 — Echtgeld-Live (verriegelt, nur mit ausdrücklichem Owner-Go)

**Ziel:** Der Echtgeld-Kern des alten M8 als letzter Schritt: dieselbe
Order-Maschine, dieselben Risiko-Guards, kein neuer Codepfad außer der
Live-Basis-URL — hinter dem doppelten Guard und einem Kill-Switch.
**Nicht eigenmächtig beginnen.**

- [ ] Doppel-Guard: `settings.broker.mode:'live'` **UND** serverseitiges
      `profile.liveApprovedAt` (setzt ausschließlich der Owner manuell);
      fehlt eins → automatischer Downgrade auf Paper, mit Log
- [ ] Live-Keys über separaten KMS-Pfad; `track:'alpaca_live'` in
      Orders/Wallet (M13-Datenmodell trägt das ohne Migration); LIVE-Badge +
      Tipp-Bestätigungs-Dialog; Live-UI vor Freischaltung unsichtbar
- [ ] Risiko-Guards (Breaker, Sizing, Positionslimit) unverändert aktiv;
      Stops zusätzlich broker-seitig als Bracket-Orders (schließt die
      5-min-Lücke für Live)
- [ ] Live-Fehlerbilder (PDT-Sperre, Margin, Buying-Power) in Statusmaschine
      und UX; getrennte Anzeige Paper vs. Live; erweiterte Rechtstexte
- [ ] Owner-Kill-Switch: ein Admin-Flag friert alle Live-Order-Pfade
      plattformweit ein (nur noch Exits erlaubt)
- [ ] Adversarialer Security-Review + Guard-Tests: kein erreichbarer Codepfad
      zu `api.alpaca.markets` ohne beide Flags; Rules-/Log-Audit auf Key-Leaks

**Abnahme:** Testaccount mit `mode:'live'` ohne `liveApprovedAt` landet
nachweislich auf Paper (Log) · mit beiden Flags wird eine Live-Order korrekt
als `alpaca_live` getrackt · Kill-Switch stoppt Live-Entries binnen eines
Scans · Review-Protokoll liegt im Repo · alle M12-Guards feuern identisch im
Live-Pfad (Testfall je Guard). Details definiert der Owner, wenn es soweit ist.

---

## Übergabe-Prompt (so startet man Claude Code in diesem Repo)

> Lies ARCHITECTURE.md, CLAUDE.md und MILESTONES.md. Arbeite nach dem
> Coding-Loop aus MILESTONES.md am ersten nicht abgehakten Milestone.
> Verifiziere jede Abnahme wirklich, hake erledigte Tasks ab und committe
> klein mit deutschen Messages.
