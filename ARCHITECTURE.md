# ARCHITECTURE.md — Zielarchitektur autotrd.net

Gründungsdokument für den Umbau von **Single-User-Python-Skill** (Ist-Zustand,
siehe `CLAUDE.md`) zu einer **öffentlichen Multi-User-Plattform** unter
`autotrd.net`. Alles Neue wird in **TypeScript** gebaut; der Python-Code bleibt
als **Referenz-Implementierung** für Parity-Tests erhalten (§8).

Leitziele: **kosteneffizient · sicher · leistungsfähig · schnell.**

---

## 1. Stack-Entscheidungen (beschlossen)

| Baustein | Entscheidung | Begründung |
|---|---|---|
| Sprache | **TypeScript** (Frontend + Backend + Shared) | Ein Stack, geteilte Typen, Firebase ist Node-first |
| Entwicklung | **GitHub Monorepo**, GitHub Actions CI/CD | Wunsch + Standard |
| Frontend-Hosting | **webgo** (`autotrd.net`) via FTP-Deploy aus Action; optional später Cloudflare Pages | Vorhandener Vertrag + Domain; Frontend ist rein statisch |
| Auth + DB | **Firebase Auth + Firestore** | Login/Userverwaltung fertig & sicher; Firestore ist realtime (`onSnapshot`) UND hat Queries + Security Rules |
| Engine/Compute | **Cloud Functions (2nd gen, Node) + Cloud Scheduler** | Kein VPS nötig: Scan = kurzer Job alle 5 min; Node-Cold-Start minimal |
| Marktdaten | **Alpaca Market Data** (offizielles JS-SDK, gratis); Fallback `yahoo-finance2` | Ein Provider für Daten UND (später) Broker; yfinance-Ersatz |
| Geld-Modell | **Erst Paper, später echt** | Architektur sieht Broker-Slot vor, Start ohne echtes Geld |

> **Kostenrealität:** Cloud Functions mit ausgehenden HTTP-Calls brauchen den
> **Blaze-Plan** (Pay-as-you-go). Bei diesem Volumen (Scan alle 5 min, kleine
> Reads) liegt das real bei ~0–5 €/Monat. Budget-Alarm im GCP-Projekt setzen!

### Supabase: verworfen und ausgebaut (04.08.)

Am 26.07. wurde beschlossen, auf Supabase (Postgres) umzuziehen. Fertig
waren Schema mit RLS, Auth-Schicht und der Lesepfad für Marktdaten. Am
04.08. wurde der gesamte Strang **gelöscht** — Migrationen, Edge Function,
`frontend/src/{supabase,authSupabase,dataSupabase}.ts`, der Deploy-Workflow
und die CI-Schritte (Deno-Drift-Guard, Postgres-RLS-Tests).

**Warum:** Die Kostenrechnung trug nicht. Bei fünf Konten kostet Firebase
~14 $/Monat, Supabase ~25 $ — und Firebase bleibt bei *jeder* Nutzerzahl
billiger, weil Realtime-Nachrichten (2,50 $/Mio) gegen Firestore-Reads
(0,60 $/Mio) beim Fan-out um Faktor vier verlieren. Das ursprüngliche
Zeitdruck-Argument („M12b und M13 schreiben den meisten Persistenzcode,
sonst schreibt man ihn zweimal") wurde zirkulär, seit beide Vorhaben nicht
als Nächstes kommen.

**Warum löschen statt einfrieren:** Eine halbfertige zweite Datenschicht
kostet auch dann, wenn sie niemand benutzt. `dataSupabase.ts` fehlten 20 von
40 Exporten aus `data.ts`, und jede Erweiterung vergrößerte den Abstand
still. Wer die eine Schicht ändert, muss die andere mitdenken oder bewusst
ignorieren — beides ist Aufwand ohne Gegenwert. Der Code steht in der
Git-Historie (Stand `789e2ef`) und lässt sich jederzeit zurückholen, falls
die Rechnung einmal kippt.

**Was die Rechnung kippen würde** — nicht der Kalender, sondern die
Fenster-Grenze der Auswertung: `snapshotEquity` liest je Konto die jüngsten
`TRADES_WINDOW = 500` Trades. Das ist keine fachliche Grenze, sondern eine
Kostenbremse, denn Firestore rechnet je gelesenem Dokument ab. Am 04.08.
stehen 514 geschlossene Trades über vier Konten — bei dieser Frequenz
schneidet das Fenster in wenigen Monaten echte Information ab, und der
Selbstverbesserer lernt aus einem Ausschnitt, ohne dass es jemand sieht.
Postgres läse denselben Zeitraum als eine Query zum Pauschalpreis und
beantwortete dabei Fragen, für die Firestore je Frage einen Index braucht.
**Erst wenn die Auswertung mehr Historie braucht, als das Fenster hergibt,
lohnt das Thema erneut.**

*Nicht* auf der Liste steht der lange Backtest, der hier zwischenzeitlich
als Auslöser notiert war: `functions/src/core/backtest.ts` rechnet Long/Flat
über Tages-Bars, während die Live-Engine auf 5-Minuten-Kerzen handelt und
shorten darf. Er misst eine Strategie, die so nie läuft, und ließe sich mit
Yahoo (5m nur ~60 Tage) gar nicht auf die echte Zeitbasis heben.

## 2. Gesamtbild

```
┌─────────────────────┐  merge → Action: Build + FTP   ┌─────────────────────────┐
│ GitHub (Monorepo)   │ ─────────────────────────────► │ webgo · autotrd.net     │
│ frontend/ functions/│  merge → firebase deploy       │ statisches SPA-Frontend │
│ shared/ reference/  │ ───────────┐                   └───────────┬─────────────┘
└─────────────────────┘            │                               │ Firebase JS-SDK
                                   ▼                               │ (Auth + onSnapshot)
                     ┌──────────────────────────┐       ┌──────────▼─────────────┐
  Cloud Scheduler ──►│ Cloud Functions (Node/TS)│ ────► │ Firestore              │
  (alle 5 min,       │ • scanMarket   (sched.)  │ read/ │ • market/** (geteilt)  │
   Markt-Gate)       │ • evalForecasts (täglich)│ write │ • users/{uid}/** (priv)│
                     │ • aiTuner       (täglich)│       │ Security Rules = Zaun  │
                     │ • trade, saveStrategy    │       └────────────────────────┘
                     │   (callable, auth-geprüft)│
                     └────────────┬─────────────┘
                                  │ Secrets NUR hier (Secret Manager)
                                  ▼
                    Alpaca Data · (später: Broker-Konten)
```

**Kernprinzip (Effizienz-Hebel):** User-*unabhängiges* (Kurse, Indikatoren,
News, Sentiment, Prognosen, KI-Erklärungen) wird **einmal zentral** berechnet
und nach `market/**` geschrieben — alle Clients lesen realtime mit. Nur
User-*abhängiges* (Watchlist, Wallet, Positionen, Trades) liegt unter
`users/{uid}/**`. Niemals Marktdaten oder LLM-Calls pro User duplizieren.

## 3. Monorepo-Layout

```
autotrd/
├── ARCHITECTURE.md            ← dieses Dokument
├── CLAUDE.md                  ← Entwickler-Regeln (Ist + Ziel)
├── frontend/                  ← SPA (Vite + TS); Seed = heutiges static/index.html
│   └── …                        Firebase SDK: Auth-Gate + onSnapshot statt fetch-Polling
├── functions/                 ← Cloud Functions (Node 20, TS)
│   ├── src/scheduled/           scanMarket, evalForecasts, aiTuner
│   ├── src/callable/            trade, saveStrategy, (später) connectBroker
│   └── src/core/                engine, indicators, forecaster, broker
├── shared/                    ← Typen + Schema (Firestore-Dokumente, strategy),
│                                von frontend UND functions importiert
├── reference/                 ← eingefrorener Python-Code (heutige scripts/ etc.)
│   └── golden/                  Fixtures: gleiche Inputs → erwartete Outputs
├── firestore.rules            ← Security Rules (§5)
├── firebase.json / .firebaserc
└── .github/workflows/         ← ci.yml (Lint+Tests), deploy-frontend.yml (FTP),
                                 deploy-functions.yml (firebase deploy)
```

## 4. Firestore-Datenmodell

```
meta/universe                     # Katalog (aus market_universe.py portiert)

market/{symbol}                   # ── GETEILT, nur Functions schreiben ──
  · quote: {price, changePct, updatedAt}
  bars/{YYYY-MM-DD}               # OHLCV-Tageskerzen (History)
  indicators/{YYYY-MM-DD}         # RSI/MACD/BBands des Tages
  signals/{scanId}                # Konfluenz-Ergebnis je Scan
  forecasts/{baseDate_lookback}   # Shadow-Prognosen (UNIQUE per Doc-ID! §7)
  forecastsIntraday/{baseT_lookback}

users/{uid}                       # ── PRIVAT ──
  · profile: {createdAt, plan}
  · settings: {strategy…}         # flaches Schema wie gehabt (broker/watchlist/
                                  # engine/indicators/signals) — User darf schreiben (validiert)
  · wallet: {paperBalance, currency}        # NUR Functions schreiben!
  positions/{symbol}                        # NUR Functions schreiben!
  trades/{tradeId}                          # NUR Functions schreiben!
  alerts/{alertId}                          # User darf schreiben

admin/quotas/{uid}                # LLM-/Trade-Rate-Limits je User (§6)
```

Doc-IDs mit fachlichem Schlüssel (`baseDate_w_lookback`, `YYYY-MM-DD`) ersetzen
die SQLite-UNIQUE-Indizes: idempotente Writes statt Doppel-Logs.

## 5. Sicherheit (nicht verhandelbar)

1. **Frontend handelt nie selbst.** `wallet`, `positions`, `trades` sind für
   Clients **read-only** — Schreiben nur via Admin SDK in Functions. Sonst kann
   jeder User seine Paper-Balance editieren (und „später echt" wäre verbrannt.)
2. Rules-Skizze:
   ```
   match /market/{doc=**}        { allow read: if request.auth != null; allow write: if false; }
   match /meta/{doc=**}          { allow read: if true;                 allow write: if false; }
   match /users/{uid}/{doc=**}   { allow read: if request.auth.uid == uid; allow write: if false; }
   match /users/{uid}/alerts/{a} { allow write: if request.auth.uid == uid; }
   match /users/{uid}            { // nur settings-Feld, schema-validiert:
                                   allow update: if request.auth.uid == uid
                                     && request.resource.data.diff(resource.data)
                                        .affectedKeys().hasOnly(['settings']); }
   ```
3. **Alle Secrets** (Alpaca, später Broker-Keys der User —
   verschlüsselt!) leben im **Secret Manager** / Functions-Env. Nichts davon je
   im Frontend-Bundle oder in Firestore-plain.
4. **Callable Functions** prüfen `context.auth`, validieren Input gegen
   `shared/`-Schemata und wenden Rate-Limits (`admin/quotas`) an.
5. **Echtgeld-Doppel-Guard bleibt** (aus `broker.py` übernehmen): User-Setting
   `mode: live` **UND** serverseitiges Flag pro User, das nur manuell/nach
   Verifikation gesetzt wird. Default immer Paper.
6. Firebase **App Check** aktivieren (schützt Functions/Firestore vor fremden
   Clients), Budget-Alarm, Auth mit E-Mail-Verifikation.

## 6. KI-Anbindung — keine (Stand 28.07.)

Das System ruft **kein** Sprachmodell auf. Es gab eine gestaffelte Anbindung
(Lexikon → Haiku → Sonnet) für News-Klassifikation, Tages-Erklärungen und
einen Review des Prognose-Suchgitters; sie ist mit der News-Strecke
ausgebaut worden (MILESTONES M6).

Der Grund war nicht die Technik, sondern die Wirkung: Keine dieser Ausgaben
hat je eine Handelsentscheidung verbessert, die man hätte nachweisen können —
und der Scan lief alle fünf Minuten. Wer die Staffel wieder einführen will,
braucht zuerst eine Messung, die zeigt, dass sie den Handel besser macht.
Für Erklärtexte allein lohnt sie nicht.

## 7. Was vom heutigen Code wohin wandert

| Heute (Python) | Ziel | Aufwand/Risiko |
|---|---|---|
| `static/index.html` (Dashboard) | **`frontend/` — Kern bleibt!** UI/UX weiterentwickeln; Datenzugriff: fetch-Polling → `onSnapshot`; + Login-Gate | mittel |
| `trading_engine.py` (Konfluenz, Forecast-Vote) | `functions/src/core/engine.ts` | mittel |
| `technical_analysis.py` (RSI/MACD/BBands) | `core/indicators.ts` — **Wilder-Glättung beibehalten!** Parity-Test Pflicht | klein, heikel |
| `forecaster.py` + `forecast_eval.py` | `core/forecaster.ts` + scheduled `evalForecasts` — **Lookahead-Gate strikt portieren** (`base_date < today`, letzter Horizont-Tag realisiert) | mittel, **höchstes Risiko** |
| `market_data.py` / `market_universe.py` | `core/marketData.ts` (Alpaca + yahoo-finance2-Fallback) / `meta/universe` | klein |
| `news_feed.py` / `sentiment.py` / `ai_analyst.py` / `ai_tuner.py` | **NICHT portiert** — 28.07. ausgebaut, siehe MILESTONES M6 | — |
| `broker.py` | `core/broker.ts` (PaperBroker jetzt; Alpaca-Slot vorbereitet, Guards aus §5) | klein |
| `history_store.py` (SQLite) | **entfällt** → Firestore (§4) | — |
| `trading_dashboard.py` (FastAPI) | **entfällt** → Frontend liest Firestore direkt; Aktionen via Callables | — |
| `cron_task.py` + systemd/`deploy/` | **entfällt** → Cloud Scheduler (Markt-Gate ET 09:30–16:00 in `scanMarket` prüfen) | klein |
| `backtest_engine.py`, `mplfinance` | später als Function/Frontend-Feature; kein Blocker | — |

## 8. Parity-Tests (Abschaltbedingung für Python)

Der Python-Code in `reference/` bleibt lauffähig, bis TS nachweislich gleich
rechnet: gleiche OHLCV-Fixtures (`reference/golden/`) durch beide Implementierungen
→ Indikatoren, Signale und Prognosen müssen innerhalb Toleranz (1e-9) matchen.
Getestet mit Vitest in CI. **Größte Fehlerquelle ist nicht Mathe (beide IEEE-754),
sondern Datums-/Zeitzonenlogik (ET-Marktzeiten, Horizont-Tage)** — dafür eigene
Testfälle (DST-Wechsel, Wochenende, Feiertag). Erst wenn Parity grün ist, wird
`reference/` eingefroren.

## 9. CI/CD

- **ci.yml** (jeder PR): Lint (eslint), Typecheck, Vitest inkl. Parity, Rules-Tests
  (`firebase emulators:exec`).
- **deploy-frontend.yml** (merge auf `main`): `vite build` → **SFTP/FTPS**-Upload
  zu webgo (Secrets: `FTP_HOST/USER/PASS` als GitHub Secrets; niemals plain FTP).
- **deploy-functions.yml** (merge auf `main`): `firebase deploy --only functions,firestore:rules`
  (Secret: `FIREBASE_TOKEN` bzw. Workload Identity).

## 10. Fahrplan (Phasen, jeweils shippable)

1. **Skeleton:** Monorepo-Umbau (heutigen Code nach `reference/`), Firebase-Projekt,
   Auth (E-Mail + Google), leere SPA mit Login hinter `autotrd.net`, CI/CD-Pipelines.
2. **Marktdaten zentral:** `scanMarket`-Function schreibt Kurse+Indikatoren nach
   `market/**`; Frontend zeigt sie realtime. Parity-Tests für Indikatoren.
3. **Dashboard-Port:** heutiges UI (Frosted Aurora, Lightweight Charts v4 —
   Konventionen aus `CLAUDE.md` §6 gelten weiter!) auf Firestore-Reads umstellen.
4. **Paper-Trading pro User:** Wallet/Positionen/Trades + `trade`-Callable +
   Engine-Auto-Trades je nach User-Strategie (`settings`).
5. **Forecast-Kern:** Forecaster + `evalForecasts` + Genauigkeits-UI (Golden-Tests!).
6. **News/Sentiment/KI:** Feeds, Lexikon, Haiku/Sonnet-Staffel, Event-Marker im Chart.
7. **Härtung:** App Check, Quotas, Monitoring/Alerts, Lasttest.
8. **Später:** echter Broker-Connect (verschlüsselte Keys, Live-Doppel-Guard), Backtests im UI.
```
