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

- [ ] Root-`package.json` mit npm-Workspaces (`frontend`, `functions`, `shared`),
      TypeScript strict, ESLint, Vitest; `shared` baut als reines Typ-/Util-Paket
- [ ] `frontend/`: Vite + TS + Firebase JS-SDK; Login-Screen (E-Mail+Passwort,
      Google) mit Firebase Auth; nach Login leeres Dashboard-Shell
- [ ] `functions/`: Firebase Functions v2 (Node 20, TS) initialisiert;
      eine `healthz`-HTTP-Function als Smoke
- [ ] Firebase-Projekt anlegen (Konsole, Blaze + **Budget-Alarm**), `.firebaserc`
      Projekt-ID eintragen, `firestore.rules` deployen
- [ ] Emulator-Suite (`firebase emulators:start`: auth, firestore, functions)
      läuft lokal; README-Abschnitt „Lokal entwickeln"
- [ ] GitHub Secrets setzen: `FTP_HOST/FTP_USERNAME/FTP_PASSWORD` (webgo, FTPS!),
      `FIREBASE_SERVICE_ACCOUNT` bzw. Token; Workflows aus `.github/workflows/`
      laufen durch (CI hat Guard, solange Tooling fehlt)
- [ ] webgo: `autotrd.net` DocumentRoot auf Deploy-Zielordner; HTTPS aktiv

**Abnahme:** PR-CI grün · `firebase emulators:start` ok · Merge auf `main`
lädt Frontend-Build zu webgo hoch · `https://autotrd.net` zeigt Login,
Registrierung + Login funktionieren live.

## M2 — Marktdaten zentral (`scanMarket`)

**Ziel:** Ein zentraler Scan schreibt geteilte Marktdaten; Indikatoren rechnen
in TS nachweislich wie in Python.

- [ ] `core/marketData.ts`: Alpaca Market Data (Key aus Secret Manager) +
      `yahoo-finance2`-Fallback; Symbol-Konventionen aus
      `reference/scripts/market_universe.py` portieren → `meta/universe` seeden
- [ ] `core/indicators.ts`: RSI (**Wilder-Glättung!**), MACD, Bollinger —
      portiert aus `reference/technical-analysis/scripts/technical_analysis.py`
- [ ] **Golden-Tests:** OHLCV-Fixtures mit Python erzeugen
      (`reference/golden/`, Skript beilegen), Vitest vergleicht TS-Ergebnisse
      (Toleranz 1e-9) — CI-Pflicht ab jetzt
- [ ] Scheduled Function `scanMarket` (alle 5 min via Cloud Scheduler):
      ET-Marktzeiten-Gate (09:30–16:00, Mo–Fr; Logik aus
      `reference/deploy/run_scan.sh`), schreibt `market/{sym}` quote/bars/
      indicators/signals idempotent (Doc-IDs = fachliche Schlüssel)
- [ ] Konfluenz-Logik `core/engine.ts` (aus `trading_engine.py`, zunächst ohne
      Forecast-Vote): Signale nach `market/{sym}/signals/`
- [ ] Frontend: Watchlist-Kacheln mit Live-Quote via `onSnapshot` (erst
      hartkodierte Default-Watchlist)

**Abnahme:** Golden-Tests grün in CI · Emulator: `scanMarket` manuell
getriggert füllt `market/**` · Live: Function läuft im 5-min-Takt, Frontend
zeigt sich selbst aktualisierende Kurse · außerhalb Marktzeiten: sauberer No-Op.

## M3 — Dashboard-Port (Frosted Aurora → SPA)

**Ziel:** Das bestehende UI (Seed: `reference/scripts/static/index.html` —
der Kern ist gut und bleibt!) als komponentisierte SPA auf Firestore-Reads.

- [ ] UI portieren: Aurora-Theme, Glass-Cards, Light/Dark (`data-theme`),
      Candlestick-Chart (Lightweight Charts **v4.2.0** gepinnt, Guards wie
      gehabt), Watchlist-Picker mit Katalog aus `meta/universe`
- [ ] Alle Daten via `onSnapshot` statt fetch-Polling; kein `/api/*` mehr
- [ ] User-Settings (`users/{uid}.settings`, flaches Schema aus `shared`)
      lesen/schreiben — Strategie-Karte funktioniert pro User
- [ ] Responsive-Abnahme wie in `CLAUDE.md` §6: headless Chrome Desktop 1500
      **und** Phone 390; Bottom-Sheet-Detail-Modal erhalten
- [ ] Bekannte UI-Verbesserungen aus dem Alt-Dashboard einarbeiten (Liste beim
      Start des Milestones mit dem Owner konkretisieren)

**Abnahme:** Live auf autotrd.net: Login → Dashboard mit Realtime-Kursen,
Chart, eigener Watchlist; Lighthouse Performance > 80; beide Viewports ok.

## M4 — Paper-Trading pro User

**Ziel:** Jeder Account hat Wallet/Positionen/Trades; Engine handelt je nach
User-Strategie. **Alles Geld-Schreibende nur serverseitig.**

- [ ] `shared`: Typen `Wallet/Position/Trade`; Firestore-Rules-Tests:
      Client-Write auf wallet/positions/trades wird ABGELEHNT
- [ ] `core/broker.ts`: PaperBroker (Port aus `reference/scripts/broker.py`);
      Alpaca-Slot als Interface vorbereitet, Live-Doppel-Guard-Logik übernehmen
- [ ] Callable `trade` (auth-geprüft, Input-Validierung, Rate-Limit über
      `admin/quotas`): manueller Paper-Trade
- [ ] `scanMarket`-Erweiterung: pro User mit `settings.engine.running=true`
      Signale gegen dessen Strategie ausführen (SL/TP, max_position_pct);
      effizient: 1 Marktdaten-Fetch, N User-Auswertungen
- [ ] Frontend: Portfolio-Karte (Wallet, Positionen, P&L), Trade-Historie,
      Engine-Start/Stop-Schalter, manueller Trade
- [ ] Onboarding: neues Konto → `wallet.paperBalance` Startkapital aus Default

**Abnahme:** Zwei Test-Accounts live: getrennte Wallets/Watchlists/Trades ·
Rules-Tests grün · Engine-ON-Account handelt beim nächsten Scan, OFF nicht ·
Manipulationsversuch per Browser-Konsole (direktes Firestore-Write auf wallet)
scheitert nachweislich.

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

## M8 — Später: Echter Broker (erst nach bewusstem Go des Owners)

- [ ] Alpaca-Connect pro User: Keys verschlüsselt (KMS), nie client-lesbar
- [ ] Live-Doppel-Guard: User-Setting `mode: live` UND serverseitiges,
      nur manuell gesetztes Freigabe-Flag; Default bleibt Paper
- [ ] Getrennte Anzeige Paper vs. Live; erweiterte Rechtstexte

**Abnahme:** definiert der Owner, wenn es soweit ist. **Nicht eigenmächtig
beginnen.**

---

## Übergabe-Prompt (so startet man Claude Code in diesem Repo)

> Lies ARCHITECTURE.md, CLAUDE.md und MILESTONES.md. Arbeite nach dem
> Coding-Loop aus MILESTONES.md am ersten nicht abgehakten Milestone.
> Verifiziere jede Abnahme wirklich, hake erledigte Tasks ab und committe
> klein mit deutschen Messages.
