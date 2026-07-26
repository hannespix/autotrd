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

- [x] Forecast-Kern: pure Mathematik in `shared/src/forecast.ts` (Drift +
      gedeckelter Tilt, Werktags-Kalender), Firestore-Seite in
      `core/forecaster.ts` (Shadow-Grid `(w, lookback)` = 15 Docs je
      Symbol+Tag, Doc-ID `baseDate_w_lookback`) — **Golden-Tests zuerst**:
      540 Fälle gegen Python-Fixtures (inkl. DST-Beginn/-Ende, Wochenende,
      Jahreswechsel), Toleranz 1e-9
- [x] Scheduled `evalForecasts` (täglich 16:30 ET): **Lookahead-Gate strikt**
      (letzter Horizont-Tag < heute UND End-Close realisiert; 13 Gate-Tests
      inkl. adversarialer Fälle); Doc-ID ersetzt den UNIQUE-Index;
      Kombi-Statistik + `best_params` nach `meta/forecastStats`
      (GLOBAL über alle Symbole — wie die Python-Referenz, nicht per Symbol);
      Firestore-Falle behoben: Kombi-Schlüssel mit Punkt („0.5_20") brauchen
      `FieldPath`, sonst verschachtelt der Update-Pfad
- [x] Engine: `_forecast_vote()`-Äquivalent in `core/engine.ts`
      (`signals.useForecast/forecastWeight/forecastThresholdPct`) — fließt in
      zentrale UND User-Signale ein; Sentiment ist 0 bis M6 die News liefert
- [x] Frontend: Prognose-Overlay im Chart (gestrichelte Mittellinie + ±1σ-Band
      + Badge) + Genauigkeits-Karte aus `meta/forecastStats`

**Abnahme:** Golden- und Gate-Tests grün in CI ✓ · Emulator: Scan loggt
15er-Shadow-Grid, `evalNow` bewertet heutige Prognosen NICHT (Gate-Beweis),
eine künstlich in die Vergangenheit gelegte Prognose wird korrekt gescored
(MAE + Richtungs-Hit, Statistik aktualisiert, Tuning bleibt unter der
Evidenz-Schwelle bei Defaults) ✓ · *Mehrtages-Live-Stichprobe + Einfrieren
von `reference/` folgt, sobald das System deployt ist (Owner-Schritte).*

## M6 — News, Sentiment & KI-Staffel

**Ziel:** News-Events + tokeneffiziente KI, zentral gecacht.

- [x] `core/news.ts` + Lexikon-Sentiment (in `shared/src/sentiment.ts`,
      Golden-Parity zur Python-Referenz): Yahoo-/Google-RSS + Reddit-Subs via
      Google-News-Proxy, dependency-freier RSS-Parser; 10-min-TTL im Scan;
      Schreibziele `market/{sym}/news/` + `events/{date}` +
      Sentiment-Aggregat am Symbol-Doc — **speist den Forecaster mit echtem
      Sentiment** (bis dahin war es 0)
- [x] KI-Staffel (ARCHITECTURE §6): Anthropic TS-SDK in Functions
      (`core/ai.ts`); Haiku = Klassifikation, Sonnet = Tages-Erklärung; Cache
      `market/{sym}/ai/{date}` (1 Call für alle User); Prompt-Caching
      (`cache_control` auf stabilen System-Prompts); täglicher Tuner-Review
      (`scheduled/tunerReview.ts`, Port `ai_tuner.py`: darf Suchgitter in
      harten Bounds [5,60]/[0,1.5] erweitern, ändert NIE Live-Params autonom)
      via Batch API im Zwei-Phasen-Muster (Submit heute → Collect morgen,
      50 % Kosten)
- [x] Kosten-Guard: Tages-Tokenbudget als Config (`admin/aiBudget
      .dailyTokenBudget`, Default 200k); bei Überschreitung degradiert die
      Pipeline auf regelbasiert (loggt das sichtbar; ebenso bei fehlendem
      Key und API-Fehlern — `degraded`/`reason` stehen im ai-Doc)
- [x] Frontend: Event-Marker auf Kerzen (sentiment-gefärbt aus
      `events/{date}`), News-Panel mit Gauge + Sentiment-Punkten,
      KI-Karte „Warum bewegt sich X?“ (inkl. sichtbarem Degradations-Grund),
      Crosshair-Tooltip mit Event-Details, Layer-Toggles Prognose/Events
      (+ Timeframe-Buttons 1M/3M/Alle nachverdrahtet)

**Abnahme:** Live: Symbol mit News zeigt Marker + KI-Summary; zweiter Abruf
kommt aus Cache (Firestore-Read, kein API-Call — an Logs verifizieren) ·
Anthropic-Konsole: Tageskosten im erwarteten Cent-Bereich.

> Verifiziert (Emulator, 2026-07-23): alle 3 Degradationspfade real
> durchlaufen — ohne Key (`no_api_key`), Budget=1 (`budget_exceeded`,
> Guard greift VOR jedem API-Call), ungültiger Key (`ai_error` mit echtem
> 401 der Anthropic-API, Scan bleibt grün) · Cache-Hit bewiesen (2. Scan:
> kein API-Call, `at` unverändert) · Tuner-Gitter-Erweiterung end-to-end
> (0.6/15 landen im Shadow-Grid, 999/99 hart geclampt; 24 Kombi-Docs) ·
> 29 neue Unit-Tests (Bounds, Parsing, Fallback, Token-Zählung) ·
> Playwright-E2E 10/10 (KI-Karte, Toggles, Tooltip, Phone 390 px).
> *Echte KI-Antworten + Kosten-Check in der Anthropic-Konsole = Owner-Schritt
> nach `firebase functions:secrets:set ANTHROPIC_API_KEY` (SETUP.md §H).*

## M7 — Härtung & Betrieb

**Ziel:** „Offen online zugänglich" verantwortbar machen.

- [x] Firebase **App Check** — Code komplett, zweistufig gated: Frontend
      sendet Tokens sobald `VITE_FIREBASE_APPCHECK_SITE_KEY` gesetzt ist
      (reCAPTCHA v3 + Debug-Token im Emulator), Functions erzwingen mit
      `APPCHECK_ENFORCE=1` in `functions/.env`. *Scharf schalten =
      Owner-Schritt (SETUP.md §I — Reihenfolge wichtig!)*
- [x] E-Mail-Verifikation Pflicht vor Engine-Nutzung (serverseitig in
      saveStrategy; UI-Box mit Mail-senden/Bestätigt-Refresh);
      Passwort-Reset-Flow („Passwort vergessen?" im Login)
- [x] Rate-Limits/Quotas für alle Callables (trade 50/Tag, saveStrategy
      300/Tag, ensureProfile 60/Tag — transaktional in `admin/quotas-{uid}`);
      Rules-Review: Testsuite auf 15 Fälle erweitert (adversarial: plan-
      Upgrade, Forecast-/Tuning-Manipulation, KI-Doc-Writes, Fremd-Zugriffe)
- [x] Monitoring vorbereitet: Scan-Heartbeat `meta/health` (lastScanAt,
      symbolsOk/Failed, auch im Markt-zu-No-Op) — *Alerts + Budget-Alarm in
      der GCP-Konsole = Owner-Schritt (SETUP.md §J)*
- [x] Security-Pass: `npm audit` prod = **0 Findings** (uuid-Kette via
      npm-override auf ^11.1.1 gefixt statt firebase-admin-Downgrade);
      dev: 5 moderate in firebase-tools ohne Upstream-Fix (nur CLI, kein
      Deploy-Artefakt); adversariale Rules-Fälle siehe oben
- [x] Rechtliches Minimum: Impressum + Datenschutzerklärung +
      Risiko-Disclaimer als Modal, Footer auf Login UND Dashboard
      („Paper-Trading zu Lernzwecken — keine Anlageberatung").
      *[OWNER]-Platzhalter (Name/Anschrift/E-Mail) in `legal.ts` ausfüllen!*

**Abnahme:** Fremder Client ohne App Check wird abgewiesen · simulierter
Scan-Ausfall alarmiert · Audit ohne Highs · Rechtstexte live.

> Verifiziert (Emulator, 2026-07-23): Engine-Start unverifiziert →
> failed-precondition mit klarer Meldung, nach OOB-Verifikation ok (REST +
> Playwright, 11/11 UI-Checks inkl. Modal-Flows); Passwort-Reset end-to-end
> (Reset-Mail → neues Passwort → Login); Quota real getript
> (RESOURCE_EXHAUSTED bei 300); Rules 15/15; `meta/health` nach Scan
> korrekt (symbolsOk=4) · Die Abnahme-Punkte „ohne App Check abgewiesen"
> und „Ausfall alarmiert" brauchen das deployte Projekt → Owner (§I/§J).

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

- [x] Panel-Lebenszyklus (`mount/onLink/destroy`) + 12-Spalten-Grid; M3-Karten
      (Chart-Stack, Watchlist, Signale, News, Positionen) als Panels;
      Persistenz `users/{uid}/workspaces/{wsId}` (debounced 2 s)
      *(14 Panels mit Lebenszyklus — ausgeblendet = 0 Listener; Chart-Stack
      via Vergleichs-Chart-Panel. Bewusste Abweichung: spaltenbasiertes
      Layout (3/6/3 von 12) mit Presets/Sichtbarkeit statt freiem
      Drag&Drop-Grid — deterministisch, mobil robust)*
- [x] Link-Bus mit Gruppen A/B/C: Symbol-, Zeit- (timestamp-basiert) und
      Crosshair-Sync (`setCrosshairPosition`), Link-Chip je Panel in
      Aurora-Farben
      *(Symbol-Sync fenster-übergreifend; Zeit- + Crosshair-Sync zwischen
      Haupt- und Vergleichs-Chart beidseitig mit Echo-Schutz)*
- [x] QuoteStore-Multiplexing + Leader-Tab über `BroadcastChannel`:
      n Fenster, ein Listener-Satz — Multi-Monitor ohne Read-Duplikation
      *(mux.ts: Leader-Election via Web Locks, ALLE market/meta-Watcher
      gemuxt — Follower-Fenster halten 0 Market-Listener; Link-Bus synct
      Symbolwechsel über Fenster hinweg; Failover übernimmt Interessen)*
- [x] Command-Palette (`Ctrl+K`): Symbol-Resolve aus `meta/universe`
      (Klarnamen, `^NDX`-Konvention), Befehle für Order/Alert/Workspace;
      Hotkeys in `settings.hotkeys`
      *(Katalog-Resolve, Preset-/Panel-/Engine-/Theme-/Order-Befehle,
      Hotkeys aus settings.hotkeys mit Live-Neuaufbau der Palette;
      Alert-Befehle folgen, sobald es das Alert-Feature gibt)*
- [x] Hotkey-Order-Ticket (`Shift+B/S`) als Overlay auf das
      `trade`-Callable, Risiko-Vorschau-Zeile, Kurs-Altersstempel,
      unübersehbares PAPER-Badge
- [x] Werks-Presets („Überblick", „Ein-Symbol-Fokus", „Signal-Jäger") +
      deterministische Mobile-Degradation zur Stapelliste (Bottom-Sheet bleibt)

> Teil-1-Verifikation (Emulator + Playwright, 2026-07-23, 11/11): Gruppe A
> synchronisiert Chart+News beim Watchlist-Klick; News-Chip → B entkoppelt
> (News bleibt stehen, Chart wechselt weiter); Palette „ndx" → `^NDX`;
> Preset „Signal-Jäger" blendet Panels aus; **kein Listener-Leak** nach 20×
> Durchklicken (24 → 24, Zähler über onSnapshot-Wrapper); Preset + Gruppe
> überleben den Reload (`users/{uid}/workspaces/default`, Rules-Test 16/16);
> 390 px ohne horizontales Scrollen.

> Teil-2a-Verifikation (Zwei-Fenster-E2E, 2026-07-23, 13/13 — die
> M9-Kern-Abnahme): Fenster 2 öffnet als Follower mit **0 Market-Listenern**
> (nur 3 User-Doc-Listener), Leader bleibt konstant bei 20; Watchlist-Klick
> in Fenster 1 wechselt Chart+News in BEIDEN Fenstern (und rückwärts);
> 12 Wechsel über beide Fenster → Listener-Zahlen unverändert; Leader-Tab
> schließen → Fenster 2 übernimmt per Web-Lock (3 → 20 Listener) und alles
> läuft mit Live-Daten weiter. Nebenbei gefixt: rebuildChart-Race
> („Object is disposed" bei schnellen Symbolwechseln) über Chart-Epochen.
> *Chart-Stack (Zeit-/Crosshair-Sync) + Hotkey-Order-Ticket = Teil 2b.*

> Teil-2b-Verifikation (Emulator + Playwright, 2026-07-24, 18/18):
> Vergleichs-Chart startet als Opt-in, Palette blendet es ein (Gruppe B,
> AAPL), Zeitachsen-Sync MESSBAR (setVisibleRange 10–30 auf dem Haupt-Chart
> → Vergleichs-Chart exakt gleich), Chip-Zyklus B→C→A; Shift+B öffnet das
> Order-Ticket mit PAPER-Badge, Risiko-Vorschau (Exposure, % vom Cash,
> Stop-Level) und Kurs-Altersstempel, Order landet real in der Historie;
> Shift+S = Verkaufen; Hotkeys feuern NICHT in Eingabefeldern; 390 px ohne
> horizontales Scrollen. Zwei per E2E gefundene Bugs sofort gefixt
> (DEFAULT_HIDDEN beim Erst-Login, Esc schließt das Ticket). **M9 damit
> komplett** — Abnahme-Hinweis: der Null-Klick-Trade läuft als
> Palette-Symbolwahl + Shift+B + Enter (statt einer `nvda b 10%`-Syntax).

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

- [x] `shared/src/rules/`: Zod-Knoten (`all/any/weighted/not`;
      `compare/crossover/priceLevel/changePct/timeWindow/sentiment/newsEvent/`
      `forecast/position`) + pure `evaluate()`; harte Schema-Guards
      (Tiefe ≤ 5, ≤ 25 Knoten, erreichbarer Threshold)
      *(PR #20 — dreiwertige Logik: fehlende Daten = „unbekannt", nie handeln;
      33 Vitest-Fälle: Guards, Blatt-Semantik inkl. Mitternacht-Wrap,
      Kombinatorik; Zeitzone liefert der Aufrufer via `ctx.minuteOfDay`)*
- [x] `users/{uid}/strategies/{id}` mit `draft`/`compiled`/`status` + Callables
      `saveStrategyDraft`/`publishStrategyVersion`/`assignStrategy`; Rules:
      Client-Write `false`; max. 1 `paper`-Strategie je (uid, Symbol)
      *(StrategySpec = buy-/sell-Baum; Publish friert `compiled.version++` ein,
      Zuordnung transaktional mit Kollisions-Check; max. 10 Strategien, Quota
      300/Tag; Rules-Suite 17/17 — Callable-E2E folgt mit dem Builder-UI)*
- [ ] Migration `settings.strategy` (flach) → `kind:'classic'` + Compiler
      classic→Baum; **Parity-Test:** kompilierte Classic-Strategie liefert
      identische Signale wie die M4-Konfluenz (Golden-Fixtures)
      *(Entscheidung: KEINE Zwangs-Migration — classic-Settings laufen
      parallel weiter (eigener Engine-Pfad), kompilierte Classic-Bäume sind
      im Studio read-only sichtbar. Compiler + Parity FERTIG: `compileClassic` kodiert `buy ≥ minConf ∧
      buy > sell` exakt via weighted-Margin (Σ[B,¬S] = W+Margin ⇒ Threshold
      W+1); 1700 Vergleiche über seeded Serien × 5 Configs × Forecasts grün;
      Abweichung dokumentiert: bei ENTSCHEIDEND fehlenden Daten hält der Baum
      konservativ. Die Laufzeit-Migration der Settings-Docs folgt mit der
      scanMarket-Erweiterung.)*
- [x] `scanMarket`-Erweiterung: 1 Marktdaten-Fetch pro Symbol, N
      Baum-Auswertungen; exotische Indikator-Parameter nur in-memory
      (memoisiert), Katalog-Varianten weiter nach `market/**`
      *(publizierte Strategien mit Zuordnung handeln ihre Symbole selbst,
      der Classic-Pfad überspringt sie; RuleContext inkl. prevValues für
      crossover aus dem In-Memory-Scan. Exotische Indikator-Parameter je
      Knoten folgen mit dem Builder.)*
- [x] Risiko-Hülle außerhalb des Baums (Clamp `maxPositionPct` ≤ 25,
      Pflicht-Stop-Loss, `maxOpenPositions`, Cooldown) — von keinem Knoten
      überschreibbar; Stop/TP greifen vor jeder Regel-Auswertung
      *(core/rulesTrading: RISK_LIMITS-Konstanten, clampStrategyRisk pure,
      Cooldown 30 min nur für ENTRIES (Exits nie geblockt), Risk-Exits
      laufen wie gehabt VOR jeder Auswertung; Unit-Tests 104/104)*
- [x] Karten-Builder `#/strategy/{id}` (Gates/Votes/Exit als Glass-Cards,
      Threshold-Stepper, Gewicht-Badges) + Live-Vorschau über gecachte Bars
      (Marker + Haltebänder, Label „Vorschau, kein Backtest",
      Hinweis „Auswertung alle 5 min")
      *(studio.ts + preview.ts (pure, unit-getestet); Emulator-E2E 14/14:
      Preset kopieren → Schwelle ändern → Marker ändern sich OHNE
      Functions-Call → publizieren → zuordnen → 390 px. v1-Grenze: nicht-
      weighted/all/any-Wurzeln (z. B. kompilierte Classic) nur lesbar)*
- [x] 5 Presets in `meta/strategyPresets`, jede Knotenart in mindestens einem
      Preset (Presets = Doku)
      *(shared/rules/presets.ts, Seeding idempotent im Scan; Coverage-Test
      erzwingt alle 13 Knotenarten)*

**Abnahme:** Preset kopieren → RSI-Schwelle ändern → Vorschau-Marker ändern
sich ohne Server-Call (Network-Tab) · publizierte Strategie handelt im nächsten
Scan auf Paper · direkter Firestore-Write auf `strategies/**` wird abgelehnt
(Rules-Test) · Classic-Parity-Test grün · Builder funktioniert bei 390 px.

## M10b — Depot-Vision: Alle Asset-Klassen handelbar (User-Wunsch 2026-07-24)

**Ziel:** autotrd ist nicht nur US-Daytrading — ein Depot aus Wertpapieren,
Rohstoffen, Krypto, Devisen usw. soll rund um die Uhr betreut werden, so weit
die Märkte es hergeben. Der Katalog (10 Klassen, 166 Symbole) kann das längst;
es fehlten die Handelszeiten je Klasse.

- [x] `shared/marketHours.ts`: `marketOpenForClass` — Krypto 24/7,
      Forex/Rohstoffe ~24/5 (Wochenend-Pause Fr 17 → So 17 ET), Aktien/ETFs/
      Indizes/Anleihen US-Zeiten; DST-korrekt via Intl, Unit-Tests
- [x] Scan-Gate je Symbol statt global: gescannt/gehandelt wird, was gerade
      offen ist; Heartbeat-No-Op nur noch, wenn ALLE Klassen zu sind
- [x] Watchdog-Fenster erweitert (stündlich außerhalb des US-Fensters,
      Actions-Budget-schonend); native 5-min-Kadenz kommt vom Cloud Scheduler
- [x] Produkt-Framing: „Paper-Trading · Aktien, Krypto & mehr" (Titel,
      Manifest, Login)
- [ ] Langfrist-Depot-Horizonte (Positionen über Tage/Wochen, Kennzahlen je
      Assetklasse) → läuft in M12 (Multi-Wallets, Attribution) ein
- [ ] Echte Broker-Anbindung je Klasse (Krypto-Spot, IBKR, …) → M13/M14,
      Echtgeld bleibt owner-gated

## Chart-Vision (User-Wunsch 2026-07-24, laufend)

**Ziel:** Der Chart als vollwertiges, „organisch-vektorbasiertes" Arbeitsgerät:
fehlerfrei zoombar, lang- und kurzfristig, mit typischen Trading-Overlays,
eigenen Prognose-Pfeilen (nach denen der Algorithmus handelt) und mehreren
Charts parallel.

- [x] Zoom-Audit: Rauszoomen möglich, Zoom überlebt Snapshot-Refresh, Fit nur
      bei Symbol-/Zeitrahmen-Wechsel (X **und** Y via Autoscale-Reset)
- [x] 1 Jahr Tages-Historie + 5-Minuten-Intraday (1T/1W) mit Zeitrahmen-Bar
- [x] Indikator-Overlays zum Zuschalten: SMA 20/50/200, EMA 9/21,
      Bollinger-Bänder; Auswahl persistiert (localStorage)
- [x] Vergleichs-Overlay: zweites Symbol als %-Linie im selben Chart
- [x] Prognose-Pfeile: ✏-Modus → Klick setzt Ziel-Kurs → Popover (Datum,
      Vertrauen 1–3) → organischer SVG-Pfeil (Dicke = Vertrauen); Scan nimmt
      die Prognose als gewichtete Stimme (PR #31/#32).
      **Feedback 25.07.: default AUS** — Opt-in übers Options-Modal; ohne
      Opt-in ignoriert auch der Scan gespeicherte Prognosen (Server-Gate)
- [x] Options-Modal ⚙ (User-Wunsch 25.07.): optionale Elemente an/aus
      (Prognose-Pfeil, Vergleichs-Overlay, Raster — settings.ui, geräteübergreifend)
      + Paper-Wallet-Grundeinstellungen (Startkapital, Investment je Trade %,
      Stop-Loss/Take-Profit %) über saveStrategy
- [x] Multi-Chart-Raster 1/2/4 mit Lock-Gruppen: Zusatz-Panels mit eigenem
      Symbol + Zeitrahmen; gelockte Charts (inkl. Haupt-Chart, 🔒) teilen
      Zoom/Sichtbereich/Crosshair; Raster persistiert (localStorage)
- [x] VWAP (Intraday, Session-Reset, `shared/vwapSessions` + Tests) als
      Layer-Chip; RSI(14)- und MACD-Unterpanels als eigene LWC-Instanzen mit
      beidseitigem Zeitachsen-Sync zum Haupt-Chart; alles zusammen als
      „Indikator-Extras" im ⚙-Options-Modal abschaltbar (settings.ui.subPanels)
- [x] UX-Runde 25.07. (Feedback): Werkzeug-Leisten in Aufklapper „Anzeige ▾"
      (Sektionen Overlays/Panels/Raster, Zustand persistiert) · Zoom wie
      TradingView (Achsen-Drag, Achsen-Doppelklick-Reset, Pinch, kinetisch;
      Doppelklick auf die Fläche = frischer X+Y-Fit) · aktive SMA/EMA/BB gelten
      auf ALLEN Charts inkl. Raster-Panels · Legende beschriftet jede aktive
      Linie, Mini-Legenden in RSI/MACD-Panels, Tooltips je Zeitrahmen ·
      jeder Chart per ⛶ vollbild-maximierbar (Portal an body wegen
      backdrop-filter-Containing-Block, z über Header, Esc/✕ schließt)
- [x] Vektor-Polish (Design-Wunsch 25.07.): Prognose-Pfeil im TradingView-Stil
      (gefülltes, konisch zulaufendes Kurven-Band + große Spitze, grün ↑ /
      rot ↓, Dicke = Vertrauen, Label-Pille an der Spitze) · Layer „Fläche"
      mit Signal-gefärbtem Verlauf (Kauf grün / Verkauf rot / neutral blau,
      Legende erklärt die Farbe) · „Kerzen aus" für den ruhigen Vektor-Look ·
      „Clean"-Chip blendet alles Optionale aus ohne die Auswahl zu verlieren ·
      Vollbild maximiert den ganzen Chart-Scope (Zeitrahmen, Anzeige-Werkzeuge,
      Legende, Unterpanels bleiben bedienbar)
- [x] Auto-Auflösung (Feedback 25.07., 3. Runde): „Auto"-Modus — die
      Kerzengröße folgt stufenlos der Zoomstufe (1D ↔ 1h ↔ 15m ↔ 5m,
      client-seitige Aggregation `shared/aggregateBars` + Tests, Badge zeigt
      die aktive Auflösung, Zeitfenster bleibt beim Wechsel erhalten; weit
      rauszoomen springt zurück auf Tageskerzen; manuelle Stufen pausieren
      Auto) · tieferes Rauszoomen (minBarSpacing 0.02) · Fit polstert rechts
      Platz für den Prognose-Pfeil auf · Y-Autoscaling als Anzeige-Option
      schaltbar · Event-Tooltip bleibt auf Touch-Geräten nach dem Loslassen
      ~4 s stehen (vorher nur „aufgeblitzt")
- [x] Chart-Audit 2 Teil 1 (Feedback 25.07., 5. Runde): 5-Jahres-Historie als
      Jahres-Chunks (`market/{sym}/ohlcDaily/{JAHR}`, 1 Read/Jahr, einmaliger
      Backfill-Marker `deepBackfillV`) · nahtloses Nachladen beim Links-Scrollen
      (Position springt nicht — logisches Fenster wird um die Prepend-Länge
      verschoben) · deterministisches Startfenster ~120 Tage via `fitTo`
      (setVisibleLogicalRange statt async fitContent — kein Race mehr mit dem
      Pfeil-Polster) · 45-s-Kurz-Updates über `quoteNow`-Callable (nur sichtbarer
      Tab, Quota 800/Tag, Quote landet in `market/{sym}.quote` für alle)
- [x] UI-Audit-Fix (Feedback 25.07., 6. Runde „Kerzen in der Ecke"): Das
      Pfeil-Polster war proportional zur Datenlänge (`len*0.25` — mit
      5J-Historie hunderte Leertage rechts) → jetzt HORIZONT-basiert
      (Handelstage bis Prognoseziel, 16–30 Bars) · Sanity-Clamp im Fit-Pfad
      (programmatische Fits max ~20 % Leerraum rechts, User-Zoom frei) ·
      Prognose-Speichern/-Laden fordert den Neu-Fit selbst an · E2E wacht
      jetzt über FÜLLGRAD (>70 % nach Fit, >60 % mit Pfeil)
- [x] TV-Vergleich umgesetzt (25.07.): In-Chart-HUD oben links — Symbol ·
      Datum · O H L C · Δ% · Volumen, live unter dem Crosshair (sonst letzter
      Bar, via `onCrosshairData`), Overlay-Legende wandert mit in die HUD ·
      Toolbar auf EINE Zeile: „Indikatoren ▾" (Overlays/Stil/Unterpanels) und
      „Layer ▾" (Layer/Raster/Lock/Vergleich) als verankerte Dropdowns —
      Item-Klicks schließen nicht (Mehrfach-Toggles wie TVs Indikator-Dialog),
      zu per Außenklick/Esc · ✏ sitzt in der Hauptzeile · Chip-Wände + alte
      Hinweiszeilen entfallen (Tooltips übernehmen)
- [ ] 1-Minuten-Daten (Yahoo: nur ~7 Tage, ~5× Volumen — bewusst entscheiden)
      · echte Sekunden-Ticks kommen mit dem M13-Streamer
- [ ] ATR, 52-Wochen-Marken, Pivots (weitere Trading-Hilfen)

## TV-Parität (User-Wunsch 25.07. abends: „so viel wie möglich von TradingView")

**Studie (kompakt):** TradingViews Chart-Kern bietet (a) ~10 Serien-Typen
(Candles, Hollow, Heikin-Ashi, Line, Area, Baseline, Bars, Renko/Kagi/P&F),
(b) Preisskalen-Modi (linear/log/Prozent, invertiert), (c) Zeichenwerkzeuge
(Trendlinien, Horizontale, Fibs, Rechtecke, Text — mit Persistenz je Symbol),
(d) Chart-Vorlagen/Templates + Multi-Chart-Layouts, (e) Sessions/Zeitzonen,
Kerzen-Countdown, Alarm-Linien, (f) Bar-Replay. Mit Lightweight Charts 4.2
sind (a) bis auf Renko/Kagi/P&F direkt oder per Daten-Transformation machbar,
(b) nativ (PriceScaleMode), (c) als eigener SVG-Layer (Basis: predSvg),
(d) als gespeicherte Einstellungs-Bundles, (e) teils nativ/teils UI,
(f) fällt mit dem M12-Tagesfilm zusammen.

- [x] Teil 1: Chart-Typen (Kerzen · Hohl · Heikin-Ashi · Linie · Berg ·
      Baseline · Bars) im Indikatoren-Menü + Preisskala Lin/Log/% —
      synct in alle Raster-Panels, Gerät-lokal persistiert; Heikin-Ashi
      als pure kausale Transformation in shared (5 Tests); dazu (Feedback
      abends): HUD-Legende einklappbar (▾-Toggle, mobil default zu),
      MAX_WATCHLIST 12→20, Katalog-Catch-up-Beschleunigung;
      Screenshots aller 8 Vorlagen an den User geliefert
- [ ] Teil 2: Zeichenwerkzeuge Basis (Trendlinie, Horizontale, Rechteck,
      Fib-Retracement, Text) als SVG-Layer mit Koordinaten-Remap beim
      Zoomen/Pannen; Persistenz je Symbol (settings.drawings)
- [ ] Teil 3: Chart-Vorlagen: benannte Bundles aus Typ + Overlays + Layern +
      Skala (settings.chartTemplates), 1-Klick-Umschalter in der Toolbar
- [ ] Teil 4: Kerzen-Countdown (Zeit bis Bar-Schluss), Preis-Alarm-Linien
      (Kreuzung → Browser-Notification), Sessions-Schattierung
- [ ] Teil 5: Bar-Replay → zusammenlegen mit M12-„Tagesfilm" (ein Feature,
      nicht zwei)
- [ ] Renko/Kagi/Point&Figure: bewusst NACH Teil 1-4 entscheiden (eigene
      Zeitachsen-Semantik — mit LWC nur mit Kompromissen)

## Prognose 2.0 (User-Direktive 25.07. nachts: „die Prognosen sind das Herzstück")

**Ziel:** Die Zukunftsvoraussage ist der Selling-Point. Kernprinzip
Selbstverbesserung: gespeicherte Prognose vs. eingetretene Realität → die
Bewertung verändert die Variablen (w, Lookback, künftig mehr), sodass jede
nächste Prognose feiner wird. Granularität so fein, wie die Daten es hergeben.
**Das Lookahead-Gate (evalForecasts/shared/forecast.ts) bleibt dabei heilig.**

- [x] Teil 1: Prognose in ALLEN Charts (Raster-Panels zeigen den Forecast
      ihres eigenen Symbols, folgen dem Prognose-Layer des Haupt-Charts) +
      neue Karte „Prognose-Labor": Kombi-Statistik (w × Lookback: n,
      Trefferquote, MAE; beste Kombi markiert) aus `meta/forecastStats`
      live + „Vorhersage vs. Realität" der letzten bewerteten Prognosen des
      Chart-Symbols + Selbstverbesserungs-Erklärtext
- [x] Teil 2: Intraday-Kurzfrist-Prognose (max. Granularität): Projektion
      der nächsten Stunde auf 5-min-Bars, bei JEDEM Scan neu berechnet
      (`forecastIntraday` im Symbol-Doc); Shadow-Gitter 3×2 je UTC-Stunden-
      slot bei offenem Markt (`forecastsIntraday`, idempotente Doc-IDs);
      eigener Eval-Pfad huckepack im Scan mit striktem „Bar realisiert"-
      Gate (`isIntradayForecastDue`: Bar-Start + Bar-Länge ≤ jetzt) +
      Expiry-Ventil (unbewertbar verfallene zählen NICHT in die Statistik);
      getrennte Kombi-Statistik `meta/forecastStatsIntraday`; Chart zeigt
      in 1T/1W die Kurzfrist-Prognose (nur Punkte NACH dem letzten Bar),
      Labor-Karte mit zweiter Intraday-Statistik; 10 neue shared-Tests
- [x] Teil 3: Feature-Regressoren + realisierte Konfidenz: `forecastFeatures`
      (RSI-Zustand als Mean-Reversion, MACD-Momentum, Vola-Regime — kausal
      aus denselben vergangenen Closes) speist die V2-Wrapper
      (`computeForecastV2`/`computeIntradayForecastV2`): hart gedeckelter
      Feature-Tilt auf die Drift, Band-Weitung im turbulenten Regime; die
      V1-Kerne bleiben Golden-Parity. `applyBandCalibration` skaliert das
      Band auf die REALISIERTE Fehlerverteilung der aktiven Kombi
      (MAE·√(π/2), geclampt 0.5–3, erst ab 8 Bewertungen) — Live UND
      Shadow nutzen denselben V2-Generator, damit die Bewertung genau das
      misst, was ausgespielt wird. Badge nennt die Kalibrierungsquelle;
      12 neue shared-Tests
- [x] Teil 4: genauigkeitsgewichtetes Forecast-Vote: `accuracyWeightedVote`
      skaliert das Stimmgewicht mit der realisierten KANTE über den Münzwurf
      (50 % ⇒ 0, 75 % ⇒ ½, 100 % ⇒ voll; nie contrarian; erst ab
      MIN_TOTAL_SCORES Evidenz) — greift im zentralen Scan-Signal, wird
      transparent ins Signal-Doc geschrieben und in der Genauigkeits-Karte
      angezeigt (User-Strategien behalten bewusst ihr konfiguriertes
      Gewicht). Backtest: kausale Forecast-Serie je Bar (V2 über
      closes[0..i] + Tages-Sentiment) füllt `ctx.forecastPct` — Forecast-
      Regeln greifen jetzt in Backtests UND Sweeps (forecastWeight-Achse
      aussagekräftig); adversarialer Kausalitätstest (Zukunft variiert ⇒
      Trades vor dem Verzweigungstag identisch); nextWeekdays gegen
      Endlosschleife bei ungültigem Datum gehärtet

## Dashboard-Individualisierung („Schweizer Taschenmesser", User-Wunsch 25.07.)

**Ziel:** Jeder passt sich das Dashboard an: Module wählbar/einklappbar/
verschiebbar, Sidebars flexibel, alle Marktgruppen versorgt und filterbar —
die Watchlist ist nur noch der Scope der Trading-Engine.

- [x] Teil 1: Module im ⚙-Options-Modal an-/abwählbar (gleiche Wahrheit wie
      die Strg+K-Palette, Workspace-synct) · jede Karte per ▾ einklappbar
      (Gerät-lokal) und per ✕ komplett ausblendbar · Desktop-Sidebars über
      ◧/◨ im Header ein-/ausblendbar (persistiert; Mobile-Drawer unberührt) ·
      Bugfix: ✏-Pfeil holt aus der Intraday-/Auto-Ansicht die Tages-Ansicht
      zurück statt stumm nichts zu tun
- [x] Teil 2: Marktgruppen-Datenversorgung (User-Wunsch 25.07. „alle Indizes
      und Märkte erfassen"): Katalog (~166 Symbole) als rotierender
      15er-Chunk je Scan (`supplyCatalog`, Cursor in `meta/catalogSupply`) —
      leichter Quote-Fetch + jüngste Tageskerze; Frische-Gates (offene Klasse
      ~stündlich, geschlossene behalten die letzte Quote); Zähler
      `catalogQuotes` im Heartbeat. Die Watchlist bleibt der Engine-Scope mit
      voller 5-min-Tiefe. ⚙ → „Marktgruppen": Klassen im Markt-Browser +
      Watchlist-Picker ausblendbar (settings.ui.marketGroups, reine Anzeige)
- [x] Teil 3: Sidebar-Breiten per Drag (Resize-Handle an der Innenkante,
      220–440 px, Doppelklick = zurücksetzen, Gerät-lokal wie die
      Sichtbarkeit; Charts folgen via autoSize) · Module per Drag umsortieren
      (⠿-Grip im Kartenkopf, live einsortieren beim Ziehen, Reihenfolge in
      workspace `panels[id].order` — synct über Geräte; Reorder bewusst je
      Spalte) · Test-Hook `__autotrdWs` nutzt denselben Drop-Pfad
- [x] ⓘ-Erklär-Tooltips + Studio-Feinschliff (User-Wunsch 25.07. „nicht
      jeder ist Profi — so lernt man"): infotips.ts mit 30+ ausführlichen
      deutschen Fachbegriff-Erklärungen (RSI/MACD/Konfluenz, Stop/Take,
      Prognose-Gewicht/-Band/Kombi-Statistik/MAE, alle Regel-Knoten,
      Sharpe/MaxDD/Winrate/Buy&Hold, Sweep/Backtest/Modus, Gebühren/
      Kaufkraft) — EIN globales Popover ohne position:fixed (backdrop-
      filter-Falle), delegiert, Esc/Außenklick schließt; ⓘ an Strategie-
      Karte, Trade-Ticket, Prognose-Karten und im gesamten Studio-Editor;
      Label-CSS-Feinschliff (Zeilenhöhe, ⓘ-Ausrichtung) · dazu .htaccess-
      Cache-Politik (Hash-Assets immutable, index.html/sw.js no-cache) —
      Wurzelfix für „Deploy kommt beim User nicht an"
- [x] Trade-Fenster-Redesign (User-Wunsch 25.07.): Katalog-Symbol-Picker
      mit Klarnamen-Suche, Kurs je Einheit + Tages-% + RSI/MACD/Signal
      als Mini-Briefing vor der Order, Live-Summen (Zwischensumme,
      Gebühren, Gesamt, Kaufkraft danach), Max-Button, 2-Schritt-
      Bestätigung mit 6-s-Entschärfung. Realismus serverseitig: die
      Paper-Ausführung rechnet jetzt mit EFFEKTIVEM Preis (0,1 %
      Kommission + 5 bp Slippage wie der Backtest) — in
      `executePaperTrade` UND `shadowTrade` (Duell-Parität);
      Trade-Records tragen additiv rawPrice/feeRate
- [x] Grid-Parität (User-Feedback 25.07. nachts): Raster-Panels haben
      dieselben Zeitrahmen wie das Haupt-Chart (inkl. 1T/1W-Intraday mit
      VWAP und Kurzfrist-Prognose des Panel-Symbols, persistiert),
      News-Punkte (Event-Marker) in jedem Panel, alle Overlays synchron ·
      Chart-Typ-Kombi: Linie/Berg/Baseline ZUSÄTZLICH zu den Kerzen
      (Gerät-lokal im Stil-Schlüssel, synct ins Raster) · Timeline-Schwung:
      kinetisches Scrolling auch mit der Maus + animierte Sprünge
      ⇤ Anfang / ◐ Mitte / ⇥ Ende (am Rand lädt die Historie automatisch)
- [x] Smartphone-Kinetik + News überall (User-Feedback 26.07.): Der Chart-
      Sync würgte jede Trägheits-Animation ab (applyRange stoppt in LWC die
      Kinetik; Range-Events feuern asynchron → der synchrone Boolean-Guard
      ließ Echos durch). Neu: frame-sicherer Echo-Ring mit Origin-Verfolgung
      (pushRange/matchEcho) für Unterpanels, Vergleich und Lock-Gruppen +
      Gesten-Gate (nur pointerdown/wheel/touchstart-nahe Events dürfen
      andere Charts ziehen — Daten-Refits rissen sonst den Haupt-Zoom weg).
      Verifiziert per LWC-Isolationsbeweis + Echo-Regressions-E2E ·
      News-Punkte in ALLEN Sichten (Intraday am ersten Bar des Handelstags,
      UTC) und allen Charts, Toggle wirkt parallel · News-Fokus: Klick in
      ein beliebiges Chart-Fenster lädt News/Sentiment/KI dieses Symbols ·
      Datumsleisten-Sync der RSI/MACD-Panels: Zeitachsen-Anker über die
      volle Haupt-Domäne inkl. Prognose-Whitespace (MACD bekam die
      fachlich übliche Null-Linie)

## M11 — Strategie-Studio II: Backtest, Shadow, Sweeps, A/B

**Ziel:** Den Experimentier-Loop schließen: Jede publizierte Version wird
automatisch backgetestet, kann als Shadow live beobachtet, gesweept und im
fairen A/B gegen die aktive Strategie befördert werden.

- [ ] Port `backtest_engine.py` → `functions/src/core/backtest.ts`;
      **Backtest-on-Save** nach `runs/{runId}`: Sharpe, MaxDD, Winrate,
      Trades, Equity-Kurve (≤ 200 Punkte), Bedingungs-Statistik
      („MACD-Cross feuerte 41×, 12× entscheidend")
      *(Port + runBacktest-Callable + Report-Karte FERTIG: runs/{runId}
      (ISO-Minute, idempotent, Quota 10/Tag, Rules read-only + Tests),
      Studio-Karte mit Kennzahlen-Grid + Equity-Sparkline via onSnapshot;
      E2E 16/16 inkl. Report. Bewusste Abweichung: Backtest per Button
      statt on-Save (Kosten-Kontrolle); Bedingungs-Statistik folgt.)*
- [ ] Lookahead-Disziplin: Evaluator/Backtest sehen je Bar nur Daten ≤ dieses
      Bars; Regressionstests inkl. Wochenend-/DST-Fällen — gleiche Härte wie
      das `forecast_eval`-Gate
- [x] Shadow-Modus: virtuelles Konto im Strategie-Doc (nur Functions
      schreiben), `shadowSignals` nur bei Entscheidungs-Wechsel; UI-Tab mit
      Hätte-Feed + virtueller vs. echter Equity-Kurve
      *(assignStrategy mode paper|shadow; Shadow-Konto (25k) im Doc, Scan
      handelt es mit identischer Risiko-Hülle, berührt NIE das Wallet;
      shadowSignals nur bei Richtungs-Wechsel via lastDirs; Shadow blockt
      den Classic-Pfad nicht (A/B parallel möglich); Rules+Tests, pure
      Buchführung unit-getestet, Studio-Karte mit Equity/Cash/Δ%.
      Hätte-FEED + Equity-Kurven-Vergleich folgen mit dem A/B-Teil.)*
- [x] Sweeps: ≤ 2 Parameter, ≤ 60 Kombis, Budget-Check im Callable; Historie
      einmal laden, alle Kombis im RAM; Ergebnis als Tabelle + Heatmap,
      „Als neuen Entwurf übernehmen" — bewusst **kein** Auto-Apply
      *(runSweep-Callable (Quota 5/Tag): Whitelist rsiBuy/rsiSell/bbBreakout/
      minConfluence/forecastWeight mit harten Bounds, buildSweepPlan clampt/
      dedupt/deckelt (unit-getestet, 10 Tests), Basis = Classic-Strategie des
      Users, je Kombi compileClassic→backtestSpec; Antwort enthält rows/best/
      bestSpec — die Übernahme legt via saveStrategyDraft exakt die server-
      seitig getestete Sieger-Spec als NEUEN Entwurf an. Studio-Karte mit
      Achsen-Auswahl + Rendite-Heatmap (Farbskala, Hover = Sharpe/MaxDD/
      Trades, Sieger umrandet); E2E 27/27.)*
- [x] A/B auf Papier: A `paper` (echtes Wallet), B `shadow` mit gleicher
      Startbalance; Kennzahlen-Duell, Divergenz-Hervorhebung, transaktionales
      „Befördern" (Rollentausch)
      *(A/B-Duell-Karte im Studio: A = Wallet mark-to-market (Quotes) vs.
      B = Shadow, „vorn"-Badge + Divergenz in Prozentpunkten; Hätte-Feed
      (letzte 20 shadowSignals via `at` desc — Firestore kann keine
      absteigenden Key-Scans); promoteStrategy: purer planPromotion-Plan
      (Unit-Tests) + Transaktion — Ziel wird paper, überlappende
      Paper-Strategien werden shadow mit frischem 25k-Konto, das Wallet
      bleibt unangetastet. E2E 22/22.)*
- [ ] Versionierung mit Diff-Ansicht + Rollback (append-only); Quotas in
      `admin/quotas` (10 Strategien, 3 Shadow, 10 Backtests + 3 Sweeps/Tag)

**Abnahme:** Publish erzeugt binnen ~1 min eine Report-Karte per `onSnapshot` ·
Shadow-Strategie schreibt beim Signalwechsel genau ein `shadowSignals`-Doc ·
60-Kombi-Sweep bleibt unter dem Function-Timeout · ein absichtlich eingebautes
Lookahead-Leck lässt den Regressionstest fehlschlagen (adversariale Fixture im
Repo) · „Befördern" tauscht Rollen atomar.

## MA — Großes Engine-Audit (Owner-Auftrag 26.07.: „Herzstück — muss fehlerfrei sein")

**Ziel:** Systematisches Logik- und Bug-Audit der kompletten Auto-Trading-
Kette — jede gefundene Schwäche wird sofort mit Test + Fix ausgeliefert.
Reihenfolge = Geldfluss: erst wo Geld bewegt wird, dann wie entschieden wird.

- [ ] MA1 Broker-Kern: `executePaperTrade` (Transaktionalität, Rundung,
      Gebühren-/Slippage-Vorzeichen je Seite, qty-Sizing, avgEntry bei
      Nachkäufen, Verkauf > Bestand, negative/Null-Preise, Idempotenz bei
      Doppel-Scans), `riskExitReason`-Grenzfälle, Wallet-Konsistenz
      (cash+Positionen=Equity), adversariale Unit-Tests je Fund
- [x] MA2 Signal-Kette **(26.07. umgesetzt)**: Der Owner-Befund „2 Tage, kein
      einziger Verkauf" hatte zwei Ursachen in der Konfluenz, beide behoben.
      (1) Die Prognose (Gewicht 2) riss die Schwelle (2) im Alleingang — die
      „Konfluenz aus drei Indikatoren" war ein Etikett. Ihr Gewicht ist beim
      EINSTIEG jetzt auf minConfluence−1 gedeckelt (`signals.forecastSolo`
      hebt das bewusst auf); beim AUSSTIEG zählt sie voll. (2) Die
      Gleichstandsregel blockierte Ausstiege genau dann, wenn sie nötig
      waren: In fallenden Märkten sagen RSI und Bollinger „überverkauft,
      also kaufen", MACD und Prognose „verkaufen" → 2:2 → nichts. Ein- und
      Ausstieg sind jetzt getrennt (`signals.exitConfluence`, Default
      minConfluence−1), bei Gleichstand gewinnt der Verkauf. Der Compiler
      (compileClassic) trägt dieselbe Asymmetrie, die Parity-Suite bleibt grün.
      Frühere Beschreibung: `computeSignal`/Konfluenz (Vote-Zählung, Schwellen-
      Symmetrie buy/sell, Forecast-Vote-Faktor inkl. accuracyWeighted-
      Clamps, Prediction-Vote), Indikator-Randfälle (kurze Historie, NaN,
      flache Serien) — Property-Tests + Golden-Parity gegen reference/
- [x] MA3 Scan-Orchestrierung **(26.07. auditiert, 4 Funde gefixt)**:
      Reihenfolge (Risk-Exits VOR Signalen), strategyOwned, Marktzeiten-
      Gates, Scan-Set (Positionen vor Watchlists), Fehler-Isolation und
      Reentry (transaktionaler Broker) waren korrekt. Funde:
      a) **assetClass fehlte bei allen Engine-/Manuell-Käufen** — die
         MA6-Klassen-Profile landeten nie in den festgeschriebenen
         Stop/Take-Leveln (Level haben Vorrang, MA1) → jetzt `classify()`
         an jedem executePaperTrade; E2E beweist 6 %/10 % bei BTC.
      b) **Rückkauf-Schleife nach Risk-Exit**: Stop-Loss verkaufte, RSI/
         Bollinger („überverkauft = kaufen") kauften im selben Scan zurück
         → `engineCooldowns` am User-Doc (30 min, server-only, Aufräumung
         nach 1 Tag), geprüft in Classic- UND Regelbaum-Entries.
      c) **Positionslimit galt nur im Regelbaum-Pfad** — der Konfluenz-Pfad
         konnte > maxOpenPositions öffnen → Guard ergänzt.
      d) **Krypto war mit ganzen Stücken praktisch unkaufbar** (BTC ~64 000 $
         vs. 2 500-$-Tranche → floor = 0, stiller `qty_unter_1`) →
         Bruchstück-Sizing (µ-Einheiten) für die Krypto-Klasse in
         sizeOrder + shadowTrade.
- [x] MA4 Regelbaum + Shadow **(26.07. auditiert, 3 Funde gefixt)**:
      decideTree/evaluate/Compiler-Parity und planPromotion waren korrekt.
      Funde (alle Duell-Fairness): Das Shadow-Buch kannte **keine
      Risk-Exits** (kein Stop/Trailing/Zeitgrenze — Kennzahlen-Duell und
      „Befördern" verglichen Äpfel mit Birnen) → highWater je Scan +
      riskExitReason mit denselben geklammerten Parametern + ATR, Exit als
      shadowSignal mit riskExit-Grund; **Sizing-Basis** folgt jetzt
      broker.sizingBase (Cash/Startkapital) inkl. Cash-Deckung; **Shadow
      schrieb nie lastTrades** — der Entry-Cooldown war wirkungslos →
      Stempel bei jedem Shadow-Trade.
- [x] MA5 End-to-End-Beweis **(26.07., 12/12 grün)**: `e2e-engine.mjs` legt
      echte User-Dokumente an, ruft `scanNow` (denselben Pfad wie der
      Scheduler) und prüft Positionen/Trades in Firestore — Stop-Loss,
      Take-Profit, Halten zwischen den Schwellen, gespeicherte Level vor
      Prozenten, Notbremse bei −30 %, nachziehender Stop, highWater-
      Fortschreibung, Zeitgrenze, Konfluenz-Verkauf, Cent-Rundung.
      Frühere Beschreibung: im Emulator: konstruierte Kursverläufe, die
      JEDEN Pfad real auslösen (Buy → Take-Profit, Buy → Stop-Loss,
      Konfluenz-Sell, Regelbaum-Sell, Shadow parallel) + Abschlussbericht
      an den Owner mit allen Funden/Fixes

- [x] MA6 **Volatilitäts-Realismus (26.07. umgesetzt)**: Risiko-Profile je
      Asset-Klasse (`engine.byClass`, Defaults: Krypto 6/10 %, Rohstoffe
      4/7 %, Devisen 1/2 %, Indizes 1,5/3 %), ATR(14) als pure Funktion mit
      Golden-Tests plus `atrStopMult`/`atrTakeMult` für volatilitätsadaptive
      Stops, nachziehender Stop (`trailingStopPct`, Default 3 %) und
      Zeitgrenze (`maxHoldDays`). Alle Parameter im Options-Modal mit
      ⓘ-Erklärung. Zur Kadenz: Der 5-min-Takt bleibt der Kosten-Deckel;
      Sub-Minuten-Reaktion braucht den Streamer aus M13.
      Frühere Beschreibung: (Owner-Frage 26.07.: „Krypto, Indizes,
      Aktien sind doch völlig unterschiedlich volatil — und reicht alle
      5 Minuten?"). Heute gilt EIN Stop/Take/Positionsgröße für alles: 2 %
      Stop ist bei BTC (±4 % Tagesrange) reines Rauschen und wird sofort
      ausgelöst, bei einem Index (±0,6 %) dagegen ein echtes Signal — die
      Engine handelt Krypto damit systematisch schlechter als Aktien.
      Drei Stufen:
      a) **Risiko-Profile je Asset-Klasse** in `strategy.engine.byClass`
         (additiv, Fallback = heutige globale Werte; UI-Karte je Klasse mit
         den 10 Katalog-Klassen). Die Risiko-Hülle klammert je Klasse.
      b) **ATR-normierte Stops/Takes** (Opt-in je Strategie): Stop =
         `k × ATR(14)` statt fixem Prozentsatz — passt sich automatisch an
         jedes Instrument UND an ruhige/wilde Phasen an. ATR gehört als
         pure Funktion mit Golden-Test in `shared/src/indicators.ts`.
      c) **Adaptive Kadenz**: Der 5-min-Scan bleibt der Takt (Kosten-Deckel),
         aber Reaktion wird ereignisgetrieben statt starr — Risiko-Exits
         prüfen bei JEDEM Scan gegen den frischesten Preis (heute schon),
         zusätzlich Intraday-Trigger für schnelle Klassen; dokumentierte
         Grenze: unter 5 min brauchen wir einen Streamer (M13).

**Abnahme:** Jeder gefundene Bug hat einen adversarialen Test, der ohne den
Fix rot ist · ein Emulator-E2E beweist alle fünf Exit-/Entry-Pfade · Bericht
listet Fund → Schwere → Fix → Test · MA6: Ein BTC-Backtest mit klassen-
spezifischen Parametern schlägt denselben Backtest mit globalen Parametern.

- [x] MA7 **Cash-Sizing (26.07., Owner-Frage „warum arbeitet nicht das ganze
      Wallet?")**: `broker.sizingBase` — Positionsgröße rechnet per Default
      vom VERFÜGBAREN Cash (`'balance'`) statt vom Startkapital; die alte
      fixe Tranche scheiterte still an `zu_wenig_cash`, sobald der Rest-Cash
      sie nicht mehr deckte — genau das ließ Cash ungenutzt liegen.
      `'initial'` bleibt als Option (Options-Modal + ⓘ). `sizeOrder()` ist
      pure + getestet (`functions/test/sizing.test.ts`, 7 Fälle).

- [x] **Short-Selling Runde 1 (26.07., Owner: „bitte auch schorten
      können")**: `signals.allowShort` (Opt-in, ⓘ warnt vor unbegrenzten
      Verlusten) — Verkaufs-Signal ohne Position eröffnet einen Short
      (100-%-Margin vom Cash, Level GESPIEGELT: Stop über dem Einstand,
      Take darunter, Trailing via lowWater, Notbremse gilt), Kauf-Signal
      deckt ein (Cover: Margin + P&L zurück, cent-genau). Exit-Asymmetrie
      in computeSignal für Shorts auf die buy-Seite gespiegelt; Engine-
      Risk-Exits schließen Shorts per Cover; Portfolio zeigt SHORT-Badge,
      gespiegeltes P&L und „Cover"-Knopf; manuelles Ticket shortet bei
      aktiviertem Opt-in. Runde 2 (26.07. nachmittags): Regelbaum-Pfad
      shortet/covert mit denselben Entry-Guards; Shadow-Buch führt Shorts
      mit Margin-Buchhaltung, lowWater und gespiegelten Risk-Exits —
      Duell-Parität vollständig. Dazu Exit-Transparenz im Portfolio:
      Begleitzeile je Position mit Abstand zu Stop/Trailing/Ziel in %,
      Zeitgrenze und „nächster Exit"-Kandidat (Shorts gespiegelt,
      ATR-Modus als Hinweis).
      Emulator-Beweis 17/17: Short-Open (Stop 696.87 ÜBER Einstand 683.20,
      Margin reserviert), Short-Stop (Cover mit Verlust), Short-Take
      (Cover mit Gewinn, Cash cent-genau).

- [x] **Trade-Frequenz (26.07., Owner: „bitte die Tradefrequenz deutlich
      erhöhen")**: `signals.timeframe` — Konfluenz UND Regelbaum rechnen
      per Default auf **5-Minuten-Kerzen** (Signale drehen im Scan-Takt
      statt alle paar Tage; die Forecast-Stimme nutzt dann die Kurzfrist-
      Prognose); 'daily' bleibt als ruhige Option. `engine.cooldownMin`
      (Kauf-Pause nach Verkauf) konfigurierbar, Default 15, Hüllen-Klemme
      5–1440. Options-Modal: Signal-Zeitrahmen, Kauf-Pause, Konfluenz
      Einstieg — alle mit ⓘ inkl. ehrlicher Gebühren-Warnung. Die zentrale
      Signal-Anzeige (market/signals) bleibt bewusst auf Tages-Basis.

- [x] **Grid-Gleichwertigkeit (26.07., Owner-Wunsch „alles soll gleichwertig
      sein")**: OHLC-Kurszeile als In-Chart-Accordion in ALLEN Fenstern
      (Haupt + Raster + Vergleich; EIN gerätelokaler Zustand, Klick toggelt
      überall) · Auto-Zeitrahmen je Raster-Panel und am Vergleichs-Chart
      (eng zoomen → 5-min-Sicht, weit → Tageskerzen; Zeitfenster bleibt) ·
      Vergleichs-Chart-Symbol frei wählbar per Eingabefeld (unabhängig vom
      Raster; Link-Gruppe B kann weiter gezielt mitziehen).

- [x] **Strategien löschen (26.07., Owner-Frage „wie löscht man gepublishte
      Strategien?")**: `deleteStrategy`-Callable — bewusst auch für
      publizierte erlaubt; räumt die Subcollections (Backtest-Runs,
      Shadow-Signale) pageweise mit ab. Folgen sind sicher: Symbole sind
      danach nicht mehr strategyOwned (Classic-Konfluenz übernimmt), offene
      Positionen gehören dem Wallet und bleiben unter Stop/Take/Konfluenz.
      UI: „Löschen"-Knopf an jeder Studio-Karte UND im Editor, jeweils mit
      2-Klick-Armierung („Wirklich löschen?", 4-s-Reset) gegen Fehlklicks.

## M12 — Portfolio, Risiko & Tagesfilm-Journal

**Ziel:** Multi-Wallets je Strategie mit vorberechneten Kennzahlen (Dashboard =
1 Stats-Doc-Read), serverseitige Risiko-Guards inkl. Circuit Breaker — und der
Tagesfilm: Replay des Handelstags mit eigenen Trades, damaligen Signalen, News
und KI-Erklärung, gekoppelt an ein automatisches Journal.

- [ ] Migration `wallet` → `users/{uid}/wallets/{walletId}` (`epoch` für
      Resets, `strategyId`-Bindung), Positionen als `{walletId_symbol}`;
      Callables `createWallet/archiveWallet/resetWallet` (Quota 5)
- [x] `core/portfolio.ts` (pure, Vitest inkl. DST-/Feiertagsfälle) +
      `snapshotEquity` (täglich nach US-Close): `equity/{walletId_date}` mit
      HWM/Drawdown, `stats/{walletId}` mit Sharpe 30/90, MaxDD, WinRate,
      ProfitFactor, Expectancy-R, Attribution je Symbol/Strategie/Assetklasse
      **(26.07. Teil 1 umgesetzt)**: läuft auf dem heutigen Ein-Wallet-Modell
      als `users/{uid}/equity/{date}` + `stats/main` (`walletId: 'main'` als
      Migrations-Vorgriff), täglich 17:15 ET inkl. Wochenende (Krypto);
      Shorts gespiegelt bewertet, Rerun idempotent (Datums-Doc-ID), Rules
      read-only, Selbstdiagnose in `meta/health.equitySnapshot`. Noch offen
      hier: Expectancy-R (braucht R-Multiples aus `core/risk.ts`) und
      Attribution je Strategie (braucht `strategyId` am Trade).
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
      **(26.07. Teil 2: Kennzahlen-Block in der Performance-Karte)**:
      Equity-Sparkline (Inline-SVG, keine zweite Chart-Instanz) + Sharpe
      30/90, Max-Drawdown, Hochwasser-Marke, Profit-Faktor und Erwartung je
      Trade — alle mit ⓘ-Erklärung. Quelle ist ausschließlich das
      Stats-Doc des Snapshot-Laufs (das UI aggregiert bewusst NICHTS
      selbst, sonst laufen Live-Ansicht und Kennzahlen auseinander).
      Ehrlichkeits-Hinweis bleibt sichtbar, bis eine Woche Kurve vorliegt.

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
