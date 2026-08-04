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

## AUDIT 28.07. — Status quo, Befunde, Reihenfolge

Vollständige Bestandsaufnahme auf Owner-Auftrag („was muss ich als nächstes
machen, wo gibt's Probleme, gibt es Code-Relikte"). Alle Zahlen sind gemessen,
nicht geschätzt.

### Umfang

| Bereich | Dateien | Zeilen |
|---|---|---|
| `shared/src` (Wertkern, pure Logik) | 18 | 3 777 |
| `functions/src` (Firebase, live) | 22 | 4 944 |
| `frontend/src` | 18 | 8 458 |
| `reference/` (Python-Parity) | 22 | 4 739 |
| Tests | 38 Dateien | 411 Prüfungen |

### A. Funktionale Befunde (nach Schwere)

- [x] **A1 — Das System steht die meiste Zeit still.** *(gefixt 28.07.)* Live gemessen:
      `lastRunSkipped: market_closed` um 12:10 UTC, obwohl Krypto rund um die
      Uhr handelt. Ursache: `DEFAULT_STRATEGY.watchlist` ist
      `['QQQ','AAPL','TSLA','^NDX']` — **ausschließlich US-Aktien**. Solange
      die Rangliste fehlt, ist der Scan außerhalb 13:30–20:00 UTC (Mo–Fr) ein
      reiner No-Op: rund **70 % der Zeit plus Wochenenden**.
      Der Fallback verschwindet zwar mit der ersten Rangliste, das Muster aber
      nicht: `selectScanSymbols` nimmt die GLOBALEN Top-N, erst danach filtert
      `runScan` auf offene Klassen. Sind die Top-40 überwiegend Aktien, ist
      nachts wieder fast nichts zu tun — bei einem Katalog, der 24/7-Krypto
      und ~24/5-Forex enthält.
      **Fix (umgesetzt):** `selectScanSymbols` bekommt `isOpen` und filtert
      schon BEIM Füllen; dazu der ganze Katalog als letzter Boden, falls
      Ranking und Defaults nichts Offenes hergeben. Positionen bleiben
      bewusst ungefiltert (sonst verlöre eine offene Position ihren
      Exit-Pfad). 5 Tests halten das fest.
- [x] **A2 — `intradayScored` bleibt noch tagelang auf 0.** *(aufgelöst wie
      erwartet: 31.07. stehen 2 184 realisierte Scores in
      `meta/forecastStatsIntraday`, Richtungsquote 47,3 % — die Altlasten
      sind verfallen, neue Prognosen sitzen auf dem Raster.)* Der Raster-Fix
      (#104) wirkt nur für NEUE Prognosen. Die 150 Altlasten sind off-grid
      und werden nie bewertbar; sie verfallen erst über `INTRADAY_EXPIRE_SEC`
      (12 h). Das ist so gewollt (nie mit unvollständigen Daten scoren), aber
      man muss es wissen, sonst liest man die 0 als „Fix wirkt nicht".
      **Erwartung:** ab ~1 h nach dem ersten Scan mit offenem Markt steigen
      die Zahlen, die Altlasten verschwinden binnen 12 h.
- [x] **A3 — Die Rangliste existiert noch nicht.** *(aufgelöst: `meta/momentum`
      wird seit 28.07. 22:00 UTC täglich geschrieben, zuletzt 30.07. — die
      beobachteten 13 Scan-Symbole kommen aus ihr.)* War: HTTP 404 bis zur
      ersten Füllung um 22:00 UTC.

### B. Architektur-Widersprüche

- [x] **B1 — Zwei Backends parallel, eines unerreichbar.** *(aufgelöst
      04.08. durch Löschen, s. MS.)* `frontend/src/dataSupabase.ts` (774 Z.)
      und `authSupabase.ts` wurden von **keinem** Modul importiert; der
      Dispatcher, der umgeschaltet hätte, war nie gebaut. Der gesamte
      Supabase-Strang ist entfernt — Firebase ist die Antwort.
- [x] **B2 — `supabase/functions/_shared/` ist eine DRIFTENDE Kopie von
      `shared/src/`.** *(aufgelöst in zwei Schritten: Seit PR #94 ist die
      Kopie ein GENERAT — `scripts-ci/build-edge-shared.mjs` leitet sie aus
      `shared/src` + `functions/src/core/engine.ts` ab, `.gitignore` hält
      sie aus dem Repo; die gemessene Drift war der eingecheckte Altstand
      vor #94. Seit 02.08. prüft CI zusätzlich als Drift-Guard: `_shared`
      frisch bauen + `deno check` der Edge Function — eine shared-Änderung,
      die nur in der Deno-Welt bricht, macht damit den PR rot statt erst
      das manuelle Deploy.)* War: 12 von 17 Dateien abweichend, Golden-Tests
      deckten die Kopie nicht.
- [x] **B3 — Zwei Stopgap-Workflows, deren Grund entfallen ist.** *(entfernt 28.07.)*
      `scan-watchdog.yml` (alle 15 min, 13–21 UTC, Mo–Fr) und
      `daily-jobs.yml` (3× täglich) tragen beide im Kopf: *„Stopgap, solange
      der Deploy-SA keine Cloud-Scheduler-Rolle hat."* Die Rolle ist seit dem
      28.07. vergeben, `check-scheduler.mjs` legt alle fünf Zeitpläne selbst
      an. Beide laufen also ZUSÄTZLICH zum Cloud Scheduler — doppelte Scans,
      doppelte Tages-Läufe, doppelte Kosten, und bei Rennen zwischen beiden
      auch doppelte Schreibvorgänge.
      **Nachweis vor dem Löschen:** Der Heartbeat stand um 12:35:01 UTC
      frisch — außerhalb des Watchdog-Fensters (`*/15 13-21`). Der Cloud
      Scheduler feuert also selbst; die Stopgaps waren reine Dopplung.

### C. Relikte

- [x] **C1** `frontend/src/dataSupabase.ts`, `authSupabase.ts`, `supabase.ts`
      (~1 000 Z.) — *(gelöscht 04.08. mit dem gesamten Strang, s. B1/MS.)*
- [x] **C2** `supabase/functions/_shared/sentiment.ts` — *(gegenstandslos:
      die Kopie ist seit #94 ein Generat außerhalb des Repos, und
      `sentiment.ts` ist seit 29.07. regulär zurück in `shared/`.)*
- [ ] **C3** `functions/src/core/{backtest,sweep}.ts` (325 Z.) — Kerne ohne
      Aufrufer, seit dem Studio-Ausbau. **Bewusst behalten** als
      Bewertungsmaschine für MO Teil 2; wird MO gestrichen, gehen sie mit.
- [ ] **C4** Der Regelbaum-Ausführungspfad in `scanMarket` läuft leer, bis MO
      Teil 2 ihn füttert (dokumentierter Wegpunkt, kein Versehen).

**Ausdrücklich KEIN Relikt:** `reference/` (4 739 Z. Python) wird von drei
Golden-Tests gelesen (`indicators.golden`, `forecast.golden`, `marketGate`).
Das ist die Parity-Absicherung des Wertkerns und bleibt.

### D. Was tragfähig ist

`shared/` als pure Logik mit Golden-Tests gegen die Python-Referenz; die
Sicherheitsschichten (Doppelschloss für Echtgeld, Lookahead-Gates,
Risiko-Hülle, serverseitige Geldschreibung); der Heartbeat als
Diagnosekanal, der schon dreimal Befunde geliefert hat, die im Log
unsichtbar geblieben wären.

### E. Reihenfolge (Owner-Entscheidung 28.07.)

1. ~~**A1**~~ + ~~**B3**~~ — erledigt, s. o.
2. **MO Teil 2** — Struktursuche im Regelbaum.
3. ~~**Supabase MS2–MS5 fertigbauen.**~~ *(Am 28.07. hatte sich der Owner
      gegen das Löschen entschieden; am 04.08. — nach der Kostenrechnung und
      der Prüfung des Backtest-Arguments — dann dafür. Der Strang ist
      entfernt, s. MS.)*

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

## M6 — News, Sentiment & KI-Staffel — ZURÜCKGEBAUT (28.07.)

Gebaut, live betrieben, wieder entfernt. Der Eintrag bleibt stehen, weil ein
gestrichener Meilenstein mehr über ein System aussagt als ein nie versuchter.

**Was es war:** News-Feeds (Yahoo-/Google-RSS + Reddit), Lexikon-Sentiment mit
Golden-Parity zur Python-Referenz, eine KI-Staffel (Haiku klassifiziert,
Sonnet erklärt) mit Tages-Cache und Token-Budget, ein täglicher KI-Review des
Prognose-Suchgitters, dazu Event-Marker auf den Kerzen und eine News-Karte.

**Warum es weg ist** (Owner-Direktive „Performance Maximierung! Kosten
Minimierung! […] Erklärungen sind nicht wichtig solange Performance besser
ist"):

1. **Die Sentiment-Stimme hat nie Evidenz gesammelt.** `meta/forecastStats`
   stand live dauerhaft auf `scored: 0` — die Prognose beeinflusste
   Handelsentscheidungen, ohne dass irgendjemand ihre Trefferquote kannte.
2. **Gratis-Feeds sind zu langsam.** Yahoo/Google-RSS und Reddit liegen
   Minuten bis Stunden hinter dem Kurs. Was dort steht, ist eingepreist.
3. **Es war der teuerste Posten je Scan.** Drei HTTP-Quellen pro Symbol plus
   Claude-Aufrufe, alle fünf Minuten.

**Was der Rückbau mitgenommen hat:** `core/news.ts`, `core/ai.ts`,
`core/tuner.ts`, `scheduled/tunerReview.ts`, `shared/src/sentiment.ts`, die
Regelbaum-Knoten `sentiment` und `newsEvent`, das News-Preset, die Frontend-
Karten samt Event-Markern — und den **Sentiment-Tilt im Forecast-Kern**.
Damit fiel auch die `w`-Achse des Suchgitters: Sie unterschied Kombinationen,
die dieselbe Zahl rechneten. Aus 15 Shadow-Prognosen je Symbol und Tag wurden
drei echte.

**Was geblieben ist:** Die Prognose selbst — als reine Preis-Regression über
ein self-getuntes Lookback-Fenster. Und die härtere Regel, die aus dem Befund
folgte: Ohne nachgewiesene Trefferquote stimmt sie beim Handeln **gar nicht**
mit.

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

**Teil-Rückkehr (29.07., Owner-Frage „lohnt sich das?"):** Feeds + Lexikon
sind zurück — aber mit **umgekehrter Rolle**. Kein Prognose-Tilt, keine
KI-Staffel, kein Tuner-Review. Stattdessen: (1) **Event-Veto** — ein frisches
hartes Ereignis in der SCHLAGZEILE (Earnings, Klage, Guidance, M&A,
Führungswechsel; `shared/newsGate.ts`) sperrt neue Einstiege 12 h, weil um
solche Termine Kurse springen und die TA-Signale dann nichts wert sind. Das
Veto kann Trades nur verhindern — Punkt 2 und 3 der Rückbau-Begründung oben
treffen es nicht (es reagiert nicht auf Kurse, und der Abruf ist auf 4
Symbole je Scan gedeckelt, TTL 45 min). (2) **Sentiment-Schatten** — die
News-Lage wird auf Shadow-Prognosen gestempelt und in `meta/sentimentStats`
gegen die realisierte Richtung gezählt; Stimmrecht bekommt sie erst, wenn
diese Quote die Beweislast trägt (Regel von oben gilt unverändert).
(3) Schlagzeilen im Symbol-Detail als Anzeige. Kosten: 0 KI-Token.

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

## M10 — Regel-Baum I: Regel-JSON, Karten-Builder, Live-Vorschau

> **Rückgebaut am 28.07. (siehe MO).** Der Karten-Builder und die Live-Vorschau
> sind entfernt; der Regel-Baum selbst bleibt als Suchraum des Optimierers.

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

## M11 — Regel-Baum II: Backtest, Shadow, Sweeps, A/B

> **Teilweise rückgebaut am 28.07. (siehe MO).** Die User-Einstiege (Backtest-
> Karte, Sweep-Heatmap, A/B-Duell, „Befördern") sind entfernt; die Kerne
> unter `functions/src/core/` bleiben als Bewertungsmaschine der Struktursuche.

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

## MS — Migration zu Supabase (26.07. beschlossen, 04.08. verworfen)

**Status: gestrichen. Der gesamte Strang ist gelöscht.** Entfernt wurden
`supabase/` (Migrationen, Edge Function, Templates, RLS-Tests),
`frontend/src/{supabase,authSupabase,dataSupabase}.ts` samt Tests, der
Workflow *Deploy Supabase* und die beiden CI-Schritte (Deno-Drift-Guard,
Postgres-RLS-Tests). Firebase bleibt.

**Was der Plan war:** Firestore → Postgres, Firebase Auth → Supabase Auth,
Cloud Functions → Edge Functions, Cloud Scheduler → pg_cron. Fertig waren
MS1 (Schema mit RLS und Geld-Invarianten, live verifiziert) und MS2 Teil 1+2
(Auth-Schicht, Lesepfad Marktdaten). Offen blieben Nutzerdaten,
Prognose-Ketten und der Dispatcher, der überhaupt erst umgeschaltet hätte.

**Warum verworfen — drei Gründe, jeder für sich ausreichend:**

1. **Die Kostenrechnung trägt nicht.** Fünf Konten kosten auf Firebase
   ~14 $/Monat, auf Supabase ~25 $ (Pro-Plan-Sockel). Firebase bleibt bei
   *jeder* Nutzerzahl billiger, weil Realtime-Nachrichten (2,50 $/Mio) gegen
   Firestore-Reads (0,60 $/Mio) beim Fan-out um Faktor vier verlieren.

2. **Das Zeitdruck-Argument war zirkulär.** MS begründete sich damit, dass
   M12b (Steuer-Log) und M13 (Alpaca-Orders) den meisten Persistenzcode
   schreiben und man ihn sonst zweimal schriebe. Das gilt nur, wenn beide
   *nach* der Migration kommen — sie kamen davor.

3. **Der Backtest-Auslöser hielt der Prüfung nicht stand.** Zwischenzeitlich
   war als Auftau-Trigger ein Lese-Break-even notiert: fünf Jahre × 166
   Symbole = 207.500 Firestore-Reads (0,12 $) gegen eine SQL-Query, bei ~20
   Läufen/Tag kippe die Rechnung. Aber `functions/src/core/backtest.ts`
   rechnet Long/Flat über **Tages**-Bars, während die Live-Engine auf
   5-Minuten-Kerzen handelt und shorten darf — er misst eine Strategie, die
   so nie läuft. Auf die echte Zeitbasis ließe er sich gar nicht heben:
   Yahoo gibt 5-Minuten-Historie nur ~60 Tage zurück. Als
   *Optimierungs*-Werkzeug wäre er zudem schädlich (ein Kurspfad, über ein
   Dutzend Stellschrauben ⇒ Überanpassung). Sein legitimer Zweck ist der
   Stresstest „überlebt die Regel-Logik einen Crash wie 2022?" — einmal im
   Monat, nicht zwanzigmal am Tag.

**Warum löschen statt einfrieren:** Zuerst war nur ein Einfrieren geplant,
abgesichert durch einen Signatur-Wächter (`supabaseParitaet.test.ts`, 20 von
40 Exporten fehlten). Der Owner entschied am 04.08. anders — zu Recht: Eine
halbfertige zweite Datenschicht kostet auch dann, wenn niemand sie benutzt.
Wer `data.ts` erweitert, muss die andere Seite mitdenken oder bewusst
ignorieren; beides ist Aufwand ohne Gegenwert. Der Code steht in der
Git-Historie (`789e2ef`) und ist jederzeit zurückholbar.

**Was das Thema wieder öffnen würde:** die Fenster-Grenze der Auswertung.
`snapshotEquity` liest je Konto nur die jüngsten `TRADES_WINDOW = 500`
Trades — eine Kostenbremse, keine fachliche Grenze. Am 04.08. stehen 514
geschlossene Trades über vier Konten; bei dieser Frequenz schneidet das
Fenster in wenigen Monaten echte Information ab, und der Selbstverbesserer
lernt aus einem Ausschnitt, ohne dass es auffällt. Postgres läse denselben
Zeitraum als eine Query zum Pauschalpreis und beantwortete Fragen, für die
Firestore je Frage einen Index braucht. **Erst dann lohnt die Rechnung neu.**


## MT — Auto-Tuner: der Kreislauf aus Messen, Ausprobieren, Übernehmen

**Owner-Direktive 27.07.:** *„alles soll vollautomatisch laufen! Messungen,
Strategie ausprobieren, verbessern, anpassen, testen, optimieren. Das Ziel des
gesamten Systems ist wenig nötige Interaktion, Selbstkontrolle,
Selbstverbesserung, Transparenz."*

**Der Anlass:** Die Auswertung der beiden Testkonten am 27.07. brauchte einen
Menschen (bzw. mich) mit Taschenrechner. Aus „Win Rate 12 %, Profit-Faktor
0,04" musste ich von Hand zurückrechnen, dass praktisch **alle** Trades am
Signal-Ausstieg sterben und die Gebühren 54–86 % des Verlusts ausmachen. Genau
diese Arbeit muss das System selbst tun — sonst ist „Selbstverbesserung" nur
ein Wort.

**Was bereits selbstregelnd läuft** (und als Vorbild dient): `bestParams`
wählt die Prognose-Parameter `(w, lookback)` aus **realisierten**
Trefferquoten, ohne Lookahead. Der KI-Tuner darf das Suchgitter erweitern,
aber **nie** Live-Parameter ändern. Die Risiko-Hülle klemmt jeden Wert in
harte Grenzen. Dieses Muster wird auf die HANDELS-Parameter übertragen.

- [x] **MT1 Messen — Ausstiegsgründe und Kostenanteil.** `stats/main` bekommt
      eine Aufschlüsselung nach Ausstiegsgrund (stop_loss · take_profit ·
      trailing · Signal · Haltefrist) sowie den Gebührenanteil am Ergebnis.
      **Das ist der wichtigste Teil:** Dass 100 % der Trades am Signal enden,
      war nirgends ablesbar. Dazu eine Kennzahl „Ø Bewegung brutto gegen
      Roundtrip-Kosten" — sie sagt in einer Zahl, ob eine Strategie überhaupt
      Luft über der Reibung hat.
- [x] **MT2 Ausprobieren — Schatten-Flotte statt Backtest-Gitter.** Mehrere
      Parameter-Varianten der aktiven Strategie laufen parallel als
      Schattenkonten auf denselben Symbolen mit. Kostet nichts (virtuelles
      Geld) und liefert **Out-of-Sample**-Evidenz — anders als ein
      Backtest-Gitter, das zuverlässig die Vergangenheit überanpasst.
      Der Shadow-Modus und `shadowTrade` existieren bereits; neu ist nur,
      dass die Varianten automatisch erzeugt und gepflegt werden.
- [x] **MT3 Bewerten — mit Evidenzschwelle.** Eine Variante gewinnt erst,
      wenn sie genug Trades hat UND ihr Vorsprung außerhalb des Rauschens
      liegt. Der Fisher-Test am 27.07. zeigte, warum das nicht verhandelbar
      ist: 12 % gegen 39 % Trefferquote war bei 16 Trades **nicht**
      signifikant (p = 0,12). Ohne diese Schwelle würde der Tuner Rauschen
      hinterherlaufen und die Parameter im Wochenrhythmus umwerfen.
- [x] **MT4 Übernehmen — automatisch, aber eingehegt.** Der Sieger wird per
      `promoteStrategy` zur Live-Strategie. Grenzen, die NICHT verhandelbar
      sind: nur innerhalb der Risiko-Hülle, nie bei Echtgeld (M14 bleibt
      verriegelt), höchstens eine Änderung je Zyklus, und jede Änderung ist
      rücknehmbar.
- [x] **MT5 Transparenz — das Änderungs-Journal.** Jede automatische Änderung
      schreibt „was, warum, mit welcher Evidenz" — im Dashboard als Verlauf
      sichtbar. Ohne das wäre der Tuner eine Blackbox, die dem Owner sein
      Depot umbaut. Selbstverbesserung ohne Nachvollziehbarkeit ist kein
      Feature, sondern ein Risiko.

**Abnahme:** Der Zyklus läuft ohne Zutun durch (messen → variieren → bewerten
→ übernehmen → messen) · eine Variante mit zu wenig Evidenz wird
nachweislich NICHT befördert · eine Beförderung erscheint mit Begründung im
Journal · die Risiko-Hülle lehnt eine Variante außerhalb der Grenzen ab ·
Echtgeld bleibt in jedem Pfad unberührt.

## M12b — Steuer-Log & Jahresreport (Deutschland)

**Ziel (Owner-Auftrag 26.07.):** Jeder Trade wird so protokolliert, dass er
für die deutsche Steuererklärung verwertbar ist — ohne Nacharbeit, ohne
Schätzung. Alpaca ist ein US-Broker und behält **keine** deutsche
Abgeltungsteuer ein; der Anleger erklärt alles selbst (Anlage KAP, bei
Fonds/ETF zusätzlich KAP-INV, für Krypto die Anlage SO). Das Tool liefert
die Daten — **keine Steuerberatung**, der Report ist Beleg-Grundlage.

Die fachlichen Fallen, die das Datenmodell abbilden MUSS:

- [ ] **EUR-Umrechnung je Vorgang, nicht am Ergebnis.** Kauf UND Verkauf
      werden getrennt zum Kurs des jeweiligen Tages in Euro umgerechnet; das
      Fremdwährungs-Ergebnis einfach umzurechnen ist unzulässig. Also:
      täglicher EZB-Referenzkurs → `meta/fx/{date}`, beim Trade EINGEFROREN
      im Trade-Doc (`fxRate`, `fxDate`, `fxSource`) — nie nachträglich neu
      berechnen, sonst wandern historische Gewinne.
- [~] **FIFO-Lots.** *(Rechnung fertig 04.08. — `shared/src/tax.ts`
      `fifoVerrechnen` zerlegt Verkäufe lotweise, Long und Short in
      getrennten Schlangen, mit Tests. OFFEN bleibt das Datenmodell: die
      Position trägt kein `lots[]` mit EUR-Einstand. Solange die Engine
      ganze Positionen verkauft, reicht die Rechnung über die Trade-Historie;
      mit Nachkäufen und Teilverkäufen wird `lots[]` zwingend.)*
- [x] **Getrennte Verlusttöpfe.** *(04.08.)* Vier Töpfe in `tax.ts`
      (`aktien` | `sonstige` | `termin` | `privat`), abgeleitet aus
      Anlageklasse **und** Richtung — jeder Leerverkauf landet im
      Termin-Topf, auch auf Krypto. Die Oberfläche zeigt bewusst KEINE
      Gesamtsumme, weil die Töpfe nicht gegeneinander verrechenbar sind.
- [x] **Krypto ist KEIN Kapitalertrag.** *(04.08.)* § 23 als eigener Topf,
      Jahresfrist **taggenau über den Kalender** statt über 365 Tage (in
      Schaltjahren liegt das einen Tag auseinander, und der Tag entscheidet
      über den vollen Gewinn). Steuerfreie Gewinne landen in KEINEM Topf,
      weil sie kein Einkommen sind. Freigrenze wirkt als Grenze, nicht als
      Freibetrag, und greift nie bei Verlust. Offene Bestände zeigen die
      Restlaufzeit bis zur Steuerfreiheit.
- [~] **Trade-Doc erweitern.** *(Teil 1 fertig 04.08.: `assetClass`,
      `currency`, `commissionRate`/`slippageRate` getrennt, `fee`,
      `entryPrice`, `acquiredAt`, `holdingDays` — alle optional, Altbestand
      bleibt gültig. Kommission zählt als Anschaffungsnebenkosten, Slippage
      als Teil des Preises. OFFEN: ISIN/WKN, Instrumentenname, EUR-Beträge,
      `lotRefs`.)*
- [~] **Jahresreport.** *(CSV fertig 04.08.: Callable `taxReport(year)`,
      Semikolon-getrennt mit deutschen Dezimalkommas und BOM, je Zeile
      Anschaffung → Veräußerung → Ergebnis. Liest `trades` UND
      `tradesArchive`, damit ein Konto-Reset keine Anschaffungskurse
      verschluckt. OFFEN: druckbares PDF und die Zuordnung zu den Zeilen der
      Anlage KAP/SO.)*
- [x] **Shorts sind steuerlich anders.** *(04.08.)* Eigener Termin-Topf,
      im Report getrennt ausgewiesen; die Karte sagt ausdrücklich, dass keine
      Steuerschuld gerechnet wird und die Zahlen Beleg-Grundlage für den
      Steuerberater sind.

**Abnahme:** Ein Kauf in USD und ein Verkauf am anderen Tag ergeben in EUR
exakt das Ergebnis aus getrennter Umrechnung (Golden-Test mit zwei
EZB-Kursen) · ein Teilverkauf nach zwei Käufen wird FIFO korrekt zerlegt ·
BTC-Verkauf nach 366 Tagen erscheint als steuerfrei, nach 300 Tagen als
steuerpflichtig · der Jahresreport summiert Aktien und Krypto in getrennten
Blöcken · Report enthält den Hinweis, dass er keine Steuerberatung ersetzt.

## MH — Margin & Hebel (Owner-Auftrag 28.07.) — ERLEDIGT

**Anlass:** Owner-Frage „können wir auch margin Trades machen? funktioniert
das? im aktuellen tool? führe margin Trades mit Hebel ein!" — nachgeschoben:
„margin Trades dürfen natürlich nur ausgeführt werden, wenn der Algorithmus
sich sehr sicher ist. sonst kann das stark in die Hose gehen."

**Der Status quo davor, ehrlich:** Es gab **keinen** Hebel. Der Kauf prüfte
`kosten > balance`, war also strikt bar gedeckt. Auch der Leerverkauf sah nur
AUS wie Margin — er reservierte den vollen Gegenwert und war damit zu 100 %
besichert. Geliehen wurde nie etwas.

**Warum das nicht in einer Zeile geht.** Die Kaufkraft zu verdoppeln ist
trivial, und genau deshalb ist es die gefährlichste Art, das zu bauen: Ein
Simulator, der Hebel gewährt, aber nie zwangsschließt, zeigt systematisch zu
gute Ergebnisse. Deshalb gehören drei Dinge untrennbar zusammen, und alle
drei sind drin.

- [x] `shared/src/margin.ts`: Kaufkraft, Nachschussgrenze (Reg T, 25 %),
      Margin-Zinsen (8 % p. a., 360-Tage-Basis), Zwangsschluss-Plan,
      `effectiveLeverage` — 53 Tests
- [x] Hebel nur bei Überzeugung: zwei Stimmen über der Einstiegsschwelle
      **und** mindestens 3 absolut. Die zweite Bedingung schließt den
      Fehlanreiz, dass eine LOCKERERE Einstiegsschwelle den Hebel leichter
      macht. Darunter läuft der Trade bar gedeckt wie bisher — kein
      anteiliger Hebel auf ein halbes Signal.
- [x] Broker: `TradeRequest.margin` (Budget des Aufrufers). Fehlt es, ist
      alles exakt wie vorher — der Hebel ist reines Opt-in.
- [x] `riskPulse` prüft die Nachschussgrenze **minütlich** und stellt glatt
      (`riskExit: 'margin_call'`, sticht jeden Einzel-Stop)
- [x] `snapshotEquity` bucht die Margin-Zinsen täglich, idempotent je Tag
- [x] `engine.maxOpenPositions` konfigurierbar (Owner-Frage: „habe es nicht
      in den Optionen gefunden" — stand fest im Code), Hülle 1–30
- [x] Options-Modal: Hebel-Auswahl + Positionslimit, beide mit ⓘ-Erklärung

**Der Fund, den nur der Emulator zeigte.** Die erste Fassung rechnete die
Tranche vom blanken Eigenkapital — mit der Begründung, der Hebel dürfe nicht
doppelt wirken. Der Lauf gegen den Firestore-Emulator zeigte: Damit wirkt er
GAR NICHT. Bei den Voreinstellungen (10 % je Position, höchstens 10
Positionen) kommt das Depot auf exakt 100 % des Eigenkapitals; die Kaufkraft
von 300 % wurde nie angekratzt. Ein Schalter, den man umlegen kann und der
nichts tut, ist schlimmer als kein Schalter. Jetzt skaliert die Tranche mit
dem Hebel, die Kaufkraft deckelt die Summe weiterhin bei `Eigenkapital ×
Hebel`.

**Abnahme (Emulator, 28.07.):** Kauf bar gedeckt 9 Stück / mit 3× 29 Stück ·
12 Kaufversuche in Folge enden bei 29 945 $ Gegenwert und −19 945 $ Cash,
also exakt 3× Auslastung, der 12. wird abgelehnt · erschöpfte Kaufkraft fällt
NICHT auf Bargeld zurück · 20 000 $ Kredit kosten 4,44 $ am Tag, ein zweiter
Lauf am selben Tag bucht 0 · ein Konto ohne Kredit zahlt nichts.

**Was bewusst NICHT gehebelt wird:** manuelle Trades (ein Klick hat keine
Konfluenz) und Regelbaum-Strategien (ein Baum liefert ja/nein, kein Maß für
Überzeugung). Echtgeld bleibt unberührt — M14 ist weiter verriegelt.

## MO — Struktursuche: der Regelbaum wird Suchraum (Owner-Go 28.07.)

**Anlass:** Owner-Frage „ist das Strategie Studio überhaupt noch sinnvoll?"
Die ehrliche Antwort war: der Bau-Teil nein, der Baum darunter ja.

**Der Befund, der es entschieden hat.** `autoTune` liest und schreibt
ausschließlich `settings.strategy` — die klassische Konfiguration. Regelbäume
fasst der Selbstoptimierer **überhaupt nicht an**. Eine im Studio gezeichnete
Strategie stand damit als einziges Teil des Systems außerhalb der täglichen
Verbesserung: einmal gebaut, für immer eingefroren. Schlimmer noch,
`strategyOwned` gab ihr die Symbole **exklusiv** — sie verdrängte also genau
den Pfad, der sich verbessert. Je mehr im Studio gebaut wurde, desto weniger
optimierte sich das System.

**Teil 1 — Rückbau (ERLEDIGT 28.07.):**
- [x] `frontend/src/studio.ts` (857 Z.), `preview.ts` (98 Z.) und die
      Callables `strategies.ts`/`backtest.ts`/`sweep.ts` entfernt; Router
      hat nur noch eine Ansicht. Die Backtest-/Sweep-**Kerne** unter
      `functions/src/core/` bleiben — sie sind die Bewertungsmaschine, die
      Teil 2 serverseitig braucht; nur die User-Einstiege sind weg.
- [x] `meta/strategyPresets`-Saat entfernt (las niemand mehr). Die Preset-
      Bäume bleiben im Code als **Startpopulation** der Suche.
- [x] 15 verwaiste ⓘ-Tooltips entfernt — 5 davon waren schon vorher tot.
- [x] `shared/src/rules/` unverändert erhalten; Kopfkommentare beschreiben
      die neue Rolle (Suchraum statt Zeichenfläche).

**Teil 2 — Struktursuche (OFFEN):**
- [ ] `TUNE_AXES` (5 Skalare) um Struktur-Mutationen erweitern: Knoten
      tauschen, Zweig streichen, Bedingung hinzufügen — Startpunkt sind der
      kompilierte Klassik-Baum plus die 5 Presets (Diversität gegen lokale
      Optima).
- [ ] **Overfitting-Bremse.** Das ist der eigentliche Aufwand, nicht die
      Mutation: Ein größerer Suchraum findet zuverlässig Bäume, die auf der
      Historie glänzen und nichts können. Bonferroni allein reicht dafür
      NICHT — es braucht Walk-Forward (Bewertung nur auf Daten nach dem
      Suchfenster) und Deflated Sharpe (Bailey/López de Prado 2014, korrigiert
      um die Anzahl der Versuche). Die harten Guards aus `schema.ts`
      (Tiefe ≤ 5, ≤ 25 Knoten) sind die Sparsamkeits-Bremse und bleiben.
- [ ] Beförderung serverseitig wie bei `autoTune`: nur über das Shadow-Konto,
      höchstens eine Änderung je Durchgang, jede mit Begründung im Journal.

**Abnahme:** Ein mutierter Baum, der im Suchfenster gewinnt und im
Walk-Forward-Fenster verliert, wird NICHT befördert (Testfall) · das Journal
nennt für jede Beförderung Vorsprung, p-Wert, Deflated Sharpe und beide
Stichprobengrößen · der Knoten-Deckel greift nachweislich (Mutation, die ihn
reißen würde, wird verworfen).

**Zwischenzustand, ehrlich benannt:** Nach Teil 1 erzeugt NICHTS mehr
Regelbaum-Strategien — der Ausführungspfad in `scanMarket` läuft leer, bis
Teil 2 ihn füttert. Das ist ein bewusster Wegpunkt, kein vergessener Rest.

## ME — Drei Aufträge an einem Tag (04.08.): Supabase raus, Steuer, Echtgeld

Owner: „setze jetzt alles um in firebase. Werfe die supabase Entwürfe und
alles was zusammenhängt raus und Räume auf … ich hätte gerne heute noch eine
fertige echtgeld trade Möglichkeit und Finanzamt, Export etc."

- [x] **ME1 Supabase gelöscht.** ~4.000 Zeilen raus, Begründung in **MS**.
- [x] **ME2 Steuer-Export** (`shared/src/tax.ts`, `callable/taxReport.ts`,
      Karte + CSV): FIFO über beide Trade-Sammlungen (auch das Reset-Archiv),
      vier getrennte Töpfe, taggenaue § 23-Jahresfrist, Freigrenze als Grenze.
      Deckt M12b Teil 1 sachlich ab; offen bleiben dort Verlustverrechnung
      über Jahre, EZB-Umrechnung und PDF.
- [x] **ME3 Echtgeld-Anbindung** (`core/alpacaBroker.ts`,
      `callable/brokerStatus.ts`, Karte): Adapter mit Vorflugkontrolle,
      lauf-gebundener Order-Kennung und beidseitigem Depot-Abgleich. Nimmt
      M13 den Kern vorweg; **ohne** Order-Routing in die Engine — das gehört
      hinter eine an echten Daten geprüfte Anbindung, nicht davor.
- [x] **ME4 Live-Reife als dritter Guard** (`shared/src/liveReadiness.ts`,
      `core/liveGate.ts`). Owner-Maxime: „bis man sicher nur noch Gewinn
      schreibt, dann erst den Schalter umlegen, aber trotzdem schon
      theoretisch startklar sein. jederzeit." `resolveBrokerMode` verlangt
      neben Nutzer-Schalter und Umgebungs-Freigabe fünf erfüllte Kriterien:
      200 Trades, Profitfaktor ≥ 1,20, Gebührenanteil ≤ 50 %, Netto > 0,
      30 Tage Messstrecke.

      **Das Entscheidende ist, was aus einem unreifen Live-Konto FOLGT:** Es
      handelt weiter wie ein Papierkonto. Stilllegen wäre zirkulär — Reife
      entsteht durch Trades; ein stillgelegtes Konto würde nie reif, und der
      Nutzer hätte sein System durchs Umlegen zum Stillstand gebracht.
- [x] **ME5 Kante je Anlageklasse** (`attribution`, `aggregateTradingHealth`).
      Die Kennzahl, deren Fehlen erklärt, warum `unter_kosten` nie blockte:
      `costGate` prüft, ob sich ein Instrument genug BEWEGT — Bewegung ist
      aber kein Gewinn, ein Random Walk hat Erwartungswert null. Gemessen am
      04.08.: **0,143 % brutto je Trade gegen 0,300 % Roundtrip-Kosten,
      Deckung 0,48.** Jeder Trade verdient die Hälfte dessen, was er kostet.

**Was zum echten Geld noch fehlt, und zwar außerhalb dieses Repos:** ein
Alpaca-Live-Konto (für Nicht-US-Residenten 30.000 $ Mindesteinlage; das
Papierkonto ist gratis), die Verifikation gegen die echte API statt gegen
die Test-Attrappe, und danach erst die Verdrahtung `scanMarket → Alpaca`.

**Der nächste Schritt ist aber ein anderer:** Das Reife-Gate öffnet erst,
wenn das System profitabel ist — und das ist es nicht. Der Hebel liegt bei
der Frequenz, nicht bei der Anbindung. Vorgehen bewusst in dieser
Reihenfolge (offen als ME6):

1. Klassen-Kante nach dem ersten `snapshotEquity`-Lauf mit dem neuen Code
   auswerten — welche Anlageklasse ist defizitär?
2. Diese Klasse abschalten oder ihr `minEdgeMultiple` anheben. Eine Klasse
   mit negativer Kante gehört nicht feinjustiert, sondern raus.
3. `costGate` um die Einfangquote erweitern, statt nur die Auslenkung zu
   prüfen.

Erst messen, dann schärfen: Ein Filter, der alles blockt, beendet auch die
Datensammlung, die ihn kalibrieren müsste — dieselbe Zirkularität wie bei
ME4.

**Der Befund, der schwerer wiegt als alle drei Aufträge** (Heartbeat 16:30):
514 Trades, Gebühren 3.049,01 $, netto −1.593,19 $ — also brutto **+1.455,82 $**.
Je Trade: 2,83 $ verdient, 5,93 $ bezahlt. Der Handel funktioniert; er wird
zu Tode gehandelt. Solange das so ist, verwandelt echtes Geld einen
Buchverlust in einen echten. Der Hebel liegt nicht bei der Anbindung,
sondern bei der Handelsfrequenz — `entryGate.unter_kosten` stand bei
`geprueft: 7` auf **0**, die Kostenschwelle greift also nie.

## MF — Warum die Engine stillsteht (04.08., gemessen)

Der Befund, der drei Fehldiagnosen an einem Tag beendet hat. Die Reihenfolge
ist lehrreich, weil jede Zwischenstufe plausibel aussah:

1. „Die Gebühren fressen den Gewinn." — Stimmt (0,143 % Kante gegen 0,300 %
   Kosten), erklärt aber nicht den Stillstand.
2. „Die Kostenschwelle blockt nie." — Stimmt auch, ist aber folgenlos: Es
   kommt nichts bis zu ihr durch (`regime_gegen_trend: 12` bei
   `geprueft: 12`).
3. „Die Konfluenz erzeugt im Aufwärtstrend nur Verkaufssignale, weil RSI und
   Bollinger Mean-Reversion-Maße sind." — **Falsch.** Sie erzeugen gar
   nichts.

### Die Messung (`voteDirs`, 20:15 UTC, n = 13 Symbole)

```
rsi          0 buy    0 sell   13 hold      ← stimmt NIE ab
bollinger    0 buy    2 sell   11 hold      ← stimmt fast nie ab
macd         7 buy    6 sell    0 hold      ← stimmt IMMER ab
knappVerfehlt: 13 von 13 hold-Signalen fehlte genau EINE Stimme
```

### Die Ursache steht in den Voreinstellungen

| Indikator | Regel | schweigt |
|---|---|---|
| RSI | buy < 30, sell > 70 | zwischen 30 und 70 — die meiste Zeit |
| Bollinger | `bbBreakoutPct: 95` ⇒ sell > 95 %, buy < 5 % | in den mittleren **90 %** des Bandes |
| MACD | `line` gegen `signal` | praktisch nie |

Bei `minConfluence: 2` sind zwei einige Stimmen nötig. **MACD liefert die
eine, und es fehlt strukturell immer die zweite.** Genau das misst
`knappVerfehlt` mit 13 von 13.

Die „Konfluenz aus drei Indikatoren" ist damit faktisch **„MACD plus ein
seltener Extremwert"** — dieselbe Art Etikett wie beim Forecast-Vote
(Audit 26.07., s. `engine.ts`). Und es erklärt rückwirkend die
Verkaufslastigkeit: Wenn überhaupt ein zweiter Indikator spricht, meldet er
ein Extrem — im Aufwärtstrend ist das Bollinger am oberen Band, also
`sell`. Die Regime-Ampel blockt es folgerichtig als Short gegen den Trend.

### Was daraus NICHT folgt

Die naheliegende Reaktion wäre, die Schwellen zu lockern (RSI 40/60,
Bollinger 80) und so mehr Signale zu erzeugen. **Das wäre die falsche
Richtung.** Die Kante je Trade ist mit +0,143 % kleiner als die
Roundtrip-Kosten von 0,300 % — mehr Trades vergrößern den Verlust, sie
verkleinern ihn nicht. Erst muss die Kante über die Kosten, dann darf die
Frequenz steigen.

### Was daraus folgt — offen als MF1

Die einzige Änderung, die eine direkte Ergebnismessung mit belastbarer
Stichprobe hinter sich hat, ist die Klassen-Kante: **crypto, 290 Trades,
−1.132,87 $, Kante −0,19 %.** Ohne Krypto stünde das Konto bei +40,12 $
statt −1.092,75 $. Das ist keine Schätzung über Einfangquoten aus einer
Woche, sondern ein gemessenes Ergebnis.

Weil es zwölf der neununddreißig Watchlist-Symbole betrifft, gehört die
Entscheidung dem Owner und nicht dem Coding-Loop.

## MG — Kapital-Regler je Anlageklasse (Owner-Vorschlag 04.08.)

Owner: „kann man für die einzelnen Handelsklassen auch Schieberegler
einbauen? am besten Shadow-Trades mit allen handeln lassen damit man die
theoretische Performance messen kann, und dann eine Empfehlung ausgeben
welche Handelsklassen jeweils am besten performen. auch einen Auto-Regler."

Der Vorschlag löst das Problem, an dem MF1 hing: Krypto abzuschalten wäre
endgültig gewesen, weil eine abgeschaltete Klasse nicht mehr gemessen wird.
Mit laufendem Schatten ist die Entscheidung reversibel — dieselbe
Zirkularität wie beim Live-Reife-Gate und bei der Kostenschwelle, zum
dritten Mal an derselben Stelle gelöst.

- [x] **MG1 Kern + Verdrahtung** *(04.08.)*: `shared/src/classAdvisor.ts`,
      `engine.classWeights` (0…1,5) und `engine.classAutoTune`. Der Regler
      multipliziert auf denselben `sizeFactor` wie das Überzeugungs-Sizing
      und ist mit ihm gemeinsam bei 1,5 gedeckelt. Gewicht 0 stoppt NUR die
      Ausführung (`entryGate.klasse_aus`); Signale und Schatten laufen
      weiter. Ausstiege bleiben immer frei. Empfehlung erst ab 30 Trades.
- [x] **MG2 Oberfläche** *(04.08.)*: Schieberegler je Klasse (0…1,5 in
      Schritten von 0,25) im Options-Modal, Empfehlungs-Karte mit Kante,
      Urteil und Begründung je Klasse, „Vorschlag übernehmen" als ein Klick.
      Die Karte rechnet bewusst NICHTS nach — sie zeigt `classAdvice` aus
      `stats/main`, das der Tageslauf schreibt. Zwei Implementierungen
      derselben Regel wären zwei Wahrheiten, sobald eine nachzieht.
      `saveStrategy` normalisiert die Gewichte serverseitig (nur bekannte
      Klassen, Hülle 0…1,5).
- [x] **MG3 Auto-Regler verdrahten** *(04.08.)*: `reglerSchritt` läuft im
      Tageslauf (`snapshotEquity`, direkt nach `attribution` — dort liegen
      die Zahlen ohnehin), aber nur bei gesetztem `classAutoTune`. Jede
      Bewegung landet mit Vorher/Nachher, Urteil, Kante und Begründung in
      `users/{uid}/classLog/{datum}_{klasse}` — ein Gewicht, das sich von
      selbst bewegt, muss erklärbar bleiben.
- [x] **MG4b Schatten in die Empfehlung** *(04.08.)*: `KlassenErgebnis`
      trägt jetzt optional die Schatten-Kante; `snapshotEquity` liest sie
      aus `meta/classShadow` und nimmt auch Klassen in den Bericht, die
      NUR im Schatten vorkommen — genau die abgeschalteten. Die
      Asymmetrie ist Absicht: Der Schatten darf ausschließlich
      zurückholen (auf `SCHATTEN_PROBELOS = 0,5`), nie abschalten. Ihm
      fehlt der Stop, der reale Verluste kappt, also ist eine negative
      Schatten-Kante kein Beleg für einen negativen Trade-Ertrag — eine
      positive dagegen ein Grund, es mit halbem Einsatz zu versuchen.
      Realisierte Trades schlagen den Schatten immer.
- [x] **MG4 Schatten für abgeschaltete Klassen — Messung** *(04.08.)*:
      `shared/src/classShadow.ts`. Jeder Scan legt Richtung, Kurs und
      Zeitpunkt seines Signals ans Markt-Dokument; der nächste misst, was
      daraus geworden ist — vorzeichenrichtig zur Richtung, abzüglich
      klassenechter Roundtrip-Kosten. Das Aggregat je Klasse steht in
      `meta/classShadow` (atomar per `increment`) und im Heartbeat unter
      `schatten`. Kostet keinen zusätzlichen Fetch: Das Markt-Dokument wird
      ohnehin gelesen und geschrieben.
      Zwei Gates, die die Zahl erst brauchbar machen: unbekannte Richtung ⇒
      verwerfen statt als `sell` lesen, und `SCHATTEN_MAX_ALTER_MS = 30 min`
      ⇒ Übernacht- und Wochenendlücken zählen nicht mit (sonst wäre die
      Kante eine Funktion der Scan-Lücken, und die sind je Klasse
      verschieden groß — ausgerechnet bei den Klassen, über die sie
      entscheiden soll). Es misst die Güte der SIGNALQUELLE, nicht die der
      Ausführung: Stop, Ziel und Haltedauer fehlen. Deshalb
      `SCHATTEN_MIN_N = 200` statt der 30 Trades der Trade-Kante.

## Arbeitsreihenfolge (Stand 04.08.)

Über vierzig offene Punkte, und nicht alle sind gleich viel wert. Diese
Reihenfolge folgt einer einzigen
Frage: **Was bringt das System näher an „schreibt zuverlässig Gewinn"?**
Denn daran hängt der Echtgeld-Schalter, und daran hängt alles andere.

**Zuerst — was die Profitabilität direkt betrifft:**

1. ~~**MG1–MG4b** Klassen-Regler komplett~~ *(04.08. erledigt)*: Kern,
   Schatten-Messung, Oberfläche, Auto-Regler und der Rückweg aus der 0.
   Was jetzt noch fehlt, ist keine Arbeit, sondern Zeit — der Schatten
   braucht 200 Signale je Klasse, bevor er sprechen darf.
2. **ME6** `captureGate` scharf schalten, sobald `kante_wuerde_blocken`
   eine belastbare Zahl zeigt.

**Danach — was Echtgeld möglich macht:**

4. **M13 Order-Routing** `scanMarket → Alpaca`, aber erst nach einer an
   echten Daten geprüften Anbindung (Owner muss Paper-Schlüssel hinterlegen).
5. **M12b Rest**: EUR-Umrechnung je Vorgang (EZB-Kurse), `lots[]` am
   Bestand, PDF. Wird zwingend, sobald echtes Geld fließt — vorher nicht.

**Bewusst hinten:**

6. **M13 Streamer** (Cloud Run, Websockets). Teuer im Betrieb und im Aufbau;
   der 5-Minuten-Takt reicht für eine Strategie, die auf Tagesbasis denkt.
7. **MO Struktursuche**, **Chart-Zeichenwerkzeuge**, **Bar-Replay**,
   **1-Minuten-Daten**. Alles sinnvoll, nichts davon bringt einen Euro
   näher an die Profitabilität.
8. **M14 Echtgeld** bleibt verriegelt — und zwar nicht nur durch den
   Doppel-Guard, sondern durch die Live-Reife: aktuell 1 von 5 Kriterien.

## M13 — Alpaca Paper Connect & Realtime-Streamer

**Ziel:** Das zweite Paper-Gleis mit echter Order-Mechanik gegen
`paper-api.alpaca.markets` (eigene Paper-Keys, KMS-verschlüsselt) plus der
Cloud-Run-`streamer` als einziger Websocket-Halter: Hot-Set-Quotes,
Sekunden-Preis-Alerts, `trade_updates`.

- [~] `connectAlpacaPaper`. *(04.08. als `connectBroker` gebaut: PK-Präfix-
      Pflicht — `AK…` wird mit Begründung abgelehnt —, hartkodierte
      Paper-Basis-URL, Probe-Call VOR dem Speichern, Ablage in
      `users/{uid}/private/broker` mit `read, write: if false`,
      Disconnect löscht das Paar. Die Schlüssel kommen nie an einen Client
      zurück; die App zeigt nur eine maskierte Kennung. OFFEN: KMS-Envelope
      statt Klartext — vertretbar, solange nur Papier-Schlüssel dort liegen,
      und zwingend, bevor je ein Live-Schlüssel in die Datenbank dürfte.)*
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

## MP — Performance-Offensive (Owner-Direktive 04.08.) — ERLEDIGT

> „hast du eine bahnbrechende Idee, wie wir das ganze Tool verbessern
> könnten? … eine stabile sichere Art und Weise langsam eine positive
> Performance zu erreichen und zu dem richtig krasse Hebel, wenn sich das
> Tool sicher ist … wenn die Gelegenheit sicher und günstig ist."

### Die Diagnose, aus der alles folgt

Nach der Notbremse vom 02.08. stand die Engine bei **471 Trades, netto
−2.743 $ — bei 2.865 $ Gebühren**. Brutto also **+122 $**. Die Strategie
war nicht kaputt; sie wurde von den Kosten erschlagen: 6,08 $ Gebühr gegen
0,26 $ Rohertrag je Trade, ein Verhältnis von 23 : 1.

Daraus folgt die Leitlinie, die alle sechs Bausteine trägt: **Gebühren sind
prozentual — größere Positionen ändern daran nichts. Nur größere Bewegungen
pro Trade.** Und für den Hebel-Wunsch: **erst Kante, dann Hebel.** Ein Hebel
multipliziert eine negative Kante genauso zuverlässig wie eine positive.

### Was gebaut wurde

- [x] **Kern-Satellit** (#133, #135): `engine.corePct` führt einen Anteil des
      Kapitals als ruhigen Momentum-Sockel; `Position.core` ist die
      Besitzgrenze, der 5-Minuten-Scan fasst diese Positionen nicht an.
      Auslöser war eine Messung: Der Momentum-Schatten stand am 04.08. bei
      **+4,0 % seit dem 28.07. mit null Trades**, die vier aktiven Konten
      zwischen −3,2 % und −6,3 % — er hatte nur nie Kapital
      (`echteKonten: 0`). Migration `corePctAll_2026_08_04` schaltete ihn
      auf Owner-Anweisung für alle 6 Bestandskonten ein.
- [x] **Regime-Ampel Stufe 2** (#134): `regimeEntryBlocked` sperrt Shorts im
      Aufwärtstrend und alle Einstiege im Stress. Die Evidenz lag vor: Alle
      **vier** Short-Steckbriefe im Trend-Regime waren negativ, zusammen
      **112 Trades mit 8 Gewinnern** (t von −3,1 bis −9,0). Entscheidend
      war, was NICHT im Muster steckte — auch MACD-bestätigte Shorts
      verloren. Gesperrt wird deshalb die RICHTUNG, nicht eine Signatur.
      Erste Wirkung: 6 blockierte Einstiege im ersten Scan nach dem Deploy.
- [x] **Positionierungs-Daten** (#136): Funding Rate und Open Interest von
      **Kraken Futures** — Information, die kein Preis-Indikator hat. Der
      erste Entwurf lief auf Binance und wurde im Live-Test verworfen:
      „Service unavailable from a restricted location" (us-central1 ist
      gesperrt, Bybit ebenso per CloudFront). Der Code hätte gebaut,
      deployt und nie ein Datum bekommen. Stufe 1: nur messen.
- [x] **Hebel-Ampel** (#137): `leverageChance` verlangt fünf UNABHÄNGIGE
      Bestätigungen — Konfluenz, Regime, **Steckbrief mit t ≥ 2 bei n ≥ 30**,
      Positionierung, Kostenabstand ≥ 5×. Vorher hing der Hebel allein an
      der Konfluenz; alle vier verlierenden Short-Sorten hatten Konfluenz.
- [x] **Termin-Kalender** (#138): Owner fragte nach FinancialJuice — kein
      RSS, keine API, nur Login. Die Termine sind stattdessen BERECHENBAR
      (NFP = erster Freitag, FOMC = veröffentlichte Liste, Turn-of-Month
      braucht nur das Datum). Stufe 1: nur messen.
- [x] **Sichtbarkeit** (#139): Karte „Was die Engine gerade tut". Fünf
      Mechaniken entschieden unsichtbar mit — und „es passiert nichts" sieht
      bei einer scharfen Regel genauso aus wie bei einem toten System.

### Das Muster, das sich durchzieht

Jeder Baustein folgt derselben Beweislast wie der Trade-Filter (31.07.):
**erst messen, dann steuern.** Positionierung und Kalender stehen bewusst
noch auf Stufe 1. Die Regime-Ampel wurde erst scharf geschaltet, als 112
Trades vorlagen — nicht, als die Theorie plausibel klang.

### Offen (bewusst)

- Positionierung und Kalender bekommen Stimmrecht erst mit Evidenz.
- Die Wirkung auf die Equity-Kurve braucht Tage. Am 04.08., zwei Stunden
  nach dem Deploy: 4 neue Trades (statt zuvor Dutzende je Stunde), PF
  stabil bei 0,32, Win-Rate 18,8 → 19,0 %. Das ist die beabsichtigte
  Frequenz-Senkung, noch kein Ertragsbeweis.

---

## MC — Offene Position im Chart (Owner-Wunsch 04.08.) — ERLEDIGT

> „Könnte man in den Charts sauber und grafisch gut und klar darstellen, wenn
> man in einem aktiven Trade das Chart öffnet, wann man reingegangen ist und
> wie es sich seither entwickelt hat?"

Bis dahin stand die Antwort nur in der Positionstabelle — als Zahlenreihe, die
man selbst mit dem Kursverlauf verrechnen musste. Jetzt zeigt das Chart sie:

| Schicht | Was man sieht |
|---|---|
| Einstiegs-Marke | Pfeil am Einstiegs-Bar (hoch = Kauf, runter = Short) mit Einstandskurs |
| Preislinien | Einstand (durchgezogen, gold), Stop (gestrichelt rot), Trailing (gepunktet orange), Ziel (gestrichelt grün) — je mit Achsen-Label |
| Verlauf | Kurslinie **ab dem Einstiegs-Bar**, grün wenn die Position im Gewinn steht, sonst rot |
| Chip | `LONG 12 · seit 3 Tagen · 104,37 → 113,80 · +9,04 % · $113,16 · Sockel · Stop 12,9 % · Ziel 0,9 %` |

Gilt in **jedem** Chart-Fenster (Haupt-Chart, Raster, Vergleich) für dessen
eigenes Symbol — Grid-Gleichwertigkeit wie bei News und Indikatoren. Ein Klick
aufs Symbol in der Positionstabelle holt die Position ins Haupt-Chart.
Abschaltbar über Layer → Position (Default AN); der Clean-View blendet es
mit allem anderen Optionalen aus.

### Zwei Entscheidungen, die nicht offensichtlich sind

**Die Level kommen aus `shared/src/positionView.ts`, nicht aus dem Chart-Code.**
Dieselbe Funktion (`positionLevels`) speist jetzt auch die Exit-Abstände der
Positionstabelle. Zwei getrennte Rechnungen wären auseinandergedriftet — und
dann sagt die Tabelle „Stop in 2,1 %", während die Linie woanders liegt. Genau
diese Sorte Widerspruch kostet Vertrauen in die ganze Anzeige.

**Die Preislinien hängen an einer eigenen, transparenten Trägerserie.**
Lightweight Charts zeichnet Preislinien einer AUSGEBLENDETEN Serie nicht.
Hätten sie an den Kerzen gehangen, wären Einstand und Stop im Vektor-Look
(„Kerzen aus") oder bei Linien-/Berg-Typen genau dann verschwunden, wenn man
ruhig auf den Kurs schauen will. Mit Chromium in beiden Zuständen belegt.

### Ehrliche Grenze

Der Einstiegs-**Marker** hängt (wie die News-Punkte) an der Kerzen-Serie und
ist im Modus „Kerzen aus" nicht sichtbar. Dort tragen Einstiegs-Linie und der
Beginn der Seit-Einstieg-Kurve dieselbe Aussage. Liegt der Einstieg links
außerhalb des Fensters, wird bewusst KEIN Marker gesetzt — er würde einen Tag
behaupten, an dem nichts passiert ist.

---

## MK — Die Messgrundlage stimmte nicht (04.08.) — ERLEDIGT

Entstanden aus der Owner-Frage nach Steuer-Export und Supabase. Beim Prüfen
des Bestands fiel etwas auf, das beide Themen an Dringlichkeit übertraf.

### Der Befund

`broker.ts` verrechnete für **jede** Anlageklasse denselben Pauschalsatz von
0,15 % je Seite — während das Kosten-Tor beim EINSTIEG (`scanMarket.ts:623`)
längst klassenecht rechnete. Beide Zahlen sahen plausibel aus; die Abweichung
fiel niemandem auf, weil nirgends stand, welcher Satz gelten sollte.

| Klasse | verbucht | real | Wirkung |
|---|---|---|---|
| US-Aktien/ETF | 0,15 % | 0,05 % | dreifach zu **teuer** gerechnet |
| **Krypto** | 0,15 % | **0,25 %** | 1,7-fach zu **billig** gerechnet |

Das ist schlimmer als eine falsche Zahl im Dashboard: **Trade-Filter, A/B-Duell
und Auto-Tuner lernen aus diesen P&Ls.** Krypto-Steckbriefe wurden zu spät
geblockt, Aktien-Steckbriefe zu früh — und Krypto handelt rund um die Uhr,
steht also mit Abstand am häufigsten im Buch. Die Verzerrung schmeichelte
ausgerechnet der Klasse, die am meisten kostet.

Der Schatten-Pfad (`rulesTrading.shadowTrade`) wurde mit umgestellt. Bliebe er
beim Pauschalsatz, verglichen A/B-Duell und Auto-Tuner zwei verschieden teure
Welten.

**Erwartete Folge:** Die ausgewiesenen Kosten steigen, `netPnl` fällt. Das ist
kein Rückschritt, sondern das Ende einer Schönfärberei — und die Voraussetzung
dafür, dass Filter und Tuner das Richtige lernen.

### Zwei weitere Funde derselben Runde

**`reset.ts` vernichtete die Handelshistorie.** `'trades'` stand in der
Löschliste, `recursiveDelete` kennt kein Zurück; beim letzten Mal traf es 297
Einträge. Jetzt wandern sie nach `tradesArchive` mit `archivedAt`-Stempel.
Verschieben statt filtern ist bewusst gewählt: Alle Leser von `trades` sehen
nach dem Reset weiterhin eine leere Liste — das Verhalten ändert sich an
keiner Stelle, nur die Daten überleben.

**Die Handeingabe ließ Papiere zu, die nicht in Dollar notieren.** `trade.ts`
prüfte gegen `allSymbols()` statt `tradableSymbols()`. Der Katalog enthält
`BMW.DE` (Euro), `7203.T` (Yen), `AZN.L` (**Pence**) — der Kontostand ist hart
in USD geführt. Ein solcher Kauf hätte den Saldo lautlos verfälscht.

### Was jetzt an jedem Trade steht

`assetClass`, `currency`, `commissionRate`, `slippageRate`, `fee` — und an
schließenden Trades zusätzlich `entryPrice`, `acquiredAt`, `holdingDays`.

Nicht aus Steuergründen (Papiergeld erzeugt keinen steuerbaren Vorgang),
sondern weil sich all das **später nicht rekonstruieren lässt**: Eine
Katalog-Änderung verschiebt die Anlageklasse rückwirkend, eine geänderte
Gebühren-Konstante macht jede nachträgliche Aufteilung falsch, und das
Positions-Doc wird beim Schließen in derselben Transaktion gelöscht. Die
Haltedauer ist heute noch aus Kauf/Verkauf paarbar — aber nur, WEIL Nachkauf
verboten und jeder Verkauf ganz ist. Genau diese Bedingungen fallen mit FIFO.

### Bewusst NICHT gebaut

`taxReport(year)`, CSV, PDF, FIFO-Lots, Verlusttöpfe, §23-Haltefristuhr: drei
bis fünf Tage Arbeit für eine Ausgabe, die ohne Echtgeld niemand liest.
EZB-Kursabruf ebenfalls nicht — historische Kurse sind nachladbar, solange
`executedAt` existiert, und das tut es millisekundengenau.

### Supabase: verworfen und gelöscht (04.08.)

Erst eingefroren, dann auf Owner-Entscheidung ganz entfernt. Die
Kostenrechnung trug nicht (5 Konten: Firebase ~14 $/Monat gegen Supabase
~25 $; Firebase bleibt bei jeder Nutzerzahl billiger, weil
Realtime-Nachrichten mit 2,50 $/Mio gegen Firestore-Reads mit 0,60 $/Mio
beim Fan-out um Faktor 4 verlieren). Der zwischenzeitlich notierte
Auftau-Trigger — ein Fünf-Jahres-Backtest als Lese-Break-even — hielt der
Prüfung nicht stand: Der Backtest rechnet Tages-Bars und Long/Flat, die
Live-Engine handelt intraday und shortet. Ausführlich in **MS**.

---

## Übergabe-Prompt (so startet man Claude Code in diesem Repo)

> Lies ARCHITECTURE.md, CLAUDE.md und MILESTONES.md. Arbeite nach dem
> Coding-Loop aus MILESTONES.md am ersten nicht abgehakten Milestone.
> Verifiziere jede Abnahme wirklich, hake erledigte Tasks ab und committe
> klein mit deutschen Messages.
