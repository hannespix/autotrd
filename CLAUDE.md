# CLAUDE.md — Regelwerk für den Alpaca-Auto-Trader (Neubau, Branch `claude/auto-trader-alpaca-rebuild-lghm4u`)

Diese Datei richtet sich an **Claude Code** (und Menschen), die an diesem Repo
arbeiten. Sie beschreibt die Architektur des Neubaus, die **nicht
verhandelbaren Regeln** und die Fallen, die im Vorgängersystem Geld gekostet
haben. Vollständig lesen, bevor du etwas anfasst.

Sprache: Antworten und Commit-Messages auf **Deutsch** (Imperativ, klein,
thematisch). Bezeichner im Code Englisch, Kommentare Deutsch.

> **Zwei Betriebsarten, ein Kern.** `src/` ist der Handelskern. Er läuft als
> eigener Prozess (`src/cli.ts run`, `docs/BETRIEB.md`) **und** als
> Firebase-Function je Minute für alle Nutzer der Plattform autotrd.net
> (`functions/src/scheduled/engineTick.ts`, `docs/PLATTFORM.md`). Login,
> Key-Tresor, Nutzerverwaltung, Firestore-Regeln und Deploy-Pipelines der
> alten Plattform bleiben; ihre Signal-Engine (Scan, Prognose, News, KI,
> Charts) ist entfernt.
>
> **Altbestand ohne Funktion:** `reference/`, `supabase/`, `rules-test/`,
> `ARCHITECTURE.md`, `MILESTONES.md`, `vitest.rules.config.ts` liegen noch im
> Baum und werden von keinem Werkzeug geprüft. Die Löschung ist ein einzelner
> Commit, der die ausdrückliche Freigabe des Owners braucht. Die Erkenntnisse
> aus dem Vorgänger stehen in `docs/ARCHITEKTUR.md` und hier in §2.

---

## 0. TL;DR der harten Regeln

1. **Ein Entscheidungspfad.** Backtest und Live-Engine rufen dieselbe Funktion
   `decide()` in `src/core/logic.ts`. Was nur in einer Welt gilt, ist ein
   Messfehler — nie „im Backtest abkürzen" oder „live etwas dazurechnen".
2. **Kein Lookahead.** Indikatoren sind kausal; jede neue Indikator-/
   Strategie-Funktion bekommt einen Präfix-Konsistenz-Test
   (`precompute(bars.prefix(i+1))[i] === precompute(bars)[i]`). Der Simulator
   reicht Strategien nur `bars.prefix(i+1)` — das bleibt so.
   **Querschnittlich gilt dasselbe eine Ebene höher:** Eine Rangliste über den
   Korb (`Strategy.crossScore`) darf nur aus geschlossenen Bars DESSELBEN
   Zeitpunkts entstehen, und sie wird ausschließlich in `decide()` gebaut —
   nie in der Strategie und nie im Aufrufer. Eine Rangliste ist die
   verführerischste Lookahead-Stelle im Repo, weil jede einzelne Zeitreihe
   dabei kausal aussieht; Wächter dafür stehen in `test/core/korb.test.ts`.
   **Die zweite ist die Korb-Zugehörigkeit:** Der Korb eines Folds wird zu
   dessen OOS-Beginn gewählt (`optimize/korbJeFold.ts`), nicht der Endkorb
   rückwärts — am 09.09.2026 hing daran ein Urteil (0,71 / −0,18 / 0,04 je
   Endkorb). Was bleibt: Der Kandidatenpool ist von heute; wer im
   Messzeitraum verschwand, ist nicht darin (§5a.13 — bekannt, in Richtung
   optimistisch). Wächter: `test/optimize/korbJeFold.test.ts`.
3. **Echtgeld-Doppel-Guard.** Live nur, wenn `broker.mode: live` UND
   `ALPACA_ALLOW_LIVE=1` UND ein Live-Key (`AK…`). Fehlt eins ⇒ Paper. Ein
   Live-Key gegen Paper wird abgelehnt (`resolveMode`). Nie lockern.
4. **Exits werden nie gesperrt.** Halt, Datenalter, PDT, Positionslimit
   blockieren nur Einstiege. Stops liegen beim Broker (Bracket-Bein oder
   GTC-Stop), nicht nur im Prozess.
5. **Sperren löst man über die Ursache, nie per Override.** Tages-Halt endet
   am nächsten Handelstag von selbst; Drawdown-Halt nur über `resume`, das den
   Peak neu setzt und im Journal steht. Kein Schalter „Sperre aus".
6. **Idempotenz an der logischen Einheit.** Einstiegs-Order-ID aus
   (mode, symbol, Bucket-Beginn); Exit-ID aus (mode, symbol, entryTime). Vor
   dem Senden per `getOrderByClientId` prüfen. Nichts buchen ohne Fill.
7. **Storno vor eigenem Exit; 422 ⇒ nachsehen, nie nachverkaufen.**
8. **Keys nie im Log.** `registerSecret()` beim Start, alles durch `redact()`.
9. **„Wir sollten nicht handeln" ist ein zulässiges Ergebnis.** Der Optimierer
   schreibt Symbole ohne bestandene Gates nach `noTrade`. Niemand „hilft nach".
10. **Verifizieren, nicht glauben.** `npm run check` (typecheck + lint + test)
    vor jedem Commit; ein neuer Wächter wird einmal absichtlich gebrochen.

## 1. Laufzeit-Layout

**Eigener Prozess** (Entwicklung, Backtest, Optimierer, Einzelbetreiber):

| Zweck | Ort |
|---|---|
| Programm | dieses Repo, `node src/cli.ts …` (Node ≥ 22.18, Type-Stripping) oder `dist/` nach `npm run build` |
| Config | `config/config.yaml` (Vorlage: `config/config.example.yaml`), Schema in `src/core/config.ts` |
| Secrets | `.env` (Vorlage `.env.example`) — nie committen |
| State | `AUTOTRD_HOME` bzw. `paths.home` (Default `./var`): `state.json`, `journal.jsonl`, `champion.json`, `universe.json`, `bars/`, `calendar.json`, `reports/`, Not-Aus-Datei `HALT` |

Ein Prozess, ein Journal (append-only), ein State-Snapshot (atomar
geschrieben).

**Plattform** (Standard für autotrd.net, Details in `docs/PLATTFORM.md`):

| Zweck | Ort |
|---|---|
| Takt | `functions/src/scheduled/engineTick.ts` — `onSchedule('* * * * *')`, `maxInstances: 1`, Lease `meta/engineLease` |
| Kern-Adapter | `functions/src/engine/` — Firestore-State/-Journal (`StateStoreLike`/`JournalLike` aus `src/core/journal.ts`), geteilte Marktdaten, Spiegel, Kommandos |
| Config | `meta/engineConfig` (global, aus `config/platform.yaml` per `scripts/sync-engine-config.mjs`) + `users/{uid}.settings.auto` (nur Risiko/Grenzen je Nutzer, nur über `saveStrategy`) |
| Champion | `meta/champion`, geschrieben vom Optimierer-Workflow (`.github/workflows/optimize.yml`, `scripts/publish-champion.mjs`) |
| State/Journal | `users/{uid}/private/engineState`, `users/{uid}/journal`, Trades im alten Schema `users/{uid}/trades` |
| Not-Aus | Kill-Switch `meta/live.killSwitch` (Admin, fail-closed — sperrt Einstiege, nie Exits), je Nutzer Callable `engineCommand` (`halt`/`resume`/`flatten`) |
| Secrets | Functions-Secrets `BROKER_MASTER_KEY`, `ALPACA_API_KEY`/`ALPACA_SECRET_KEY` (Plattform-Datenkey); Nutzer-Keys im Key-Tresor |

Beide Betriebsarten rufen dieselbe Engine (`src/engine/engine.ts`) und
dieselbe `decide()`. Die Plattform hat keine Streams: Stops liegen beim
Broker, ein Takt je Minute genügt für den Zeitrahmen der Plattform (seit
09.09.2026 Tagesbars — auf 5-Minuten-Bars frassen die Gebühren 271–2438 %
des Bruttogewinns, siehe docs/ARCHITEKTUR.md §5a.10).

## 2. Was das Vorgängersystem gelehrt hat (und wie es hier gelöst ist)

| Befund (Owner, Juli–Sept. 2026) | Konsequenz hier |
|---|---|
| „Der Handel funktioniert; er wird zu Tode gehandelt." Gebühren 3 049 $ bei brutto +1 456 $; 525 Trades in 2 Tagen. | Wenige Einstiege, Exits über Stop/Ziel/Trailing, Kosten im Simulator inkl. Stress ×1,5, Gate `feeShare ≤ 0,5`. |
| Signal-Exits schnitten Gewinner ab; Take-Profit-Exits gewannen 26/26. | Bracket-Orders mit Ziel; Signal-Exit nur als Trendbruch. |
| Trailing-Stop vom Einstand gerechnet ⇒ Verkauf bei −3 % statt −25 %. | Trailing nur nachziehen, wenn `highWater` besser als Einstand; nur enger (`logic.ts`). |
| Doppel-Exit durch zwei Zeitgeber ⇒ echter Short ohne Stop. | Ein Prozess, positionsstabile Client-IDs. |
| Backtest maß Tagesbars/Long-Flat, live lief Intraday/Short. | Ein `decide()`; Bars aus lokaler Aggregation derselben Minutenbars. |
| 30 Trades als Beweis; Auswahl auf denselben Daten wiederholt. | Walk-Forward mit Embargo, ≥ 60 OOS-Trades, PSR ≥ 0,9 auf der OOS-Kette, Nachbarschafts-Plateau, Deflated Sharpe informativ (`dsrIsGate`), Holdout nur Bericht. |
| Krypto: −1 133 $ bei 25 bp Taker; ohne Krypto +40 $. | Krypto ist Assetklasse mit eigenen Kosten, Default ist `us_equity`. |
| Sizing auf Cash ⇒ Kapital arbeitete nicht. | Sizing auf Equity, Risiko je Trade über Stop-Distanz. |
| PDT nur angezeigt, nie geprüft. | `risk/pdt.ts` ist ein Gate unter 25 000 $. |
| Cloud Scheduler kann kein WebSocket halten; 5-Min-Takt als Kostendeckel. | Eigener Prozess: Datenstrom + `trade_updates` per WebSocket. Plattform: Takt je Minute genügt, weil Stops beim Broker liegen und kein Signal-Exit auf Sekunden angewiesen ist. |
| Nutzer stellten Strategie-Parameter selbst ein; jeder handelte eine andere, nie gemessene Variante. | Strategie und Parameter kommen für alle aus dem Champion; Nutzer stellen nur Risiko und Grenzen ein (`settings.auto`). |

## 3. Modulkarte (`src/`)

| Modul | Rolle |
|---|---|
| `core/types.ts` | Alle geteilten Typen (Bar, Strategy, Decision, OrderIntent, Trade, Metrics). |
| `core/config.ts` | zod-Schema, `.env`-Parser, `resolveMode` (Doppel-Guard). |
| `core/time.ts` | ET-Zeitlogik (DST via Intl), NYSE-Kalender-Fallback, Buckets. |
| `core/bars.ts` | Kolumnare `BarSeries`, `aggregate()` aus Minutenbars, `anfangsStreuner()` (verirrte IEX-Einzelbars vor dem Datenbeginn — eine zog den Fold-Plan ins Leere). |
| `core/session.ts` | Sitzungs-Sicht je geschlossener Bar (Minuten bis Schluss, letzte Bar). |
| `core/logic.ts` | `decide()`: Tore, Sizing, Exits — für Backtest UND Live. |
| `core/journal.ts`, `core/log.ts` | Journal/State, Logging mit Schwärzung. |
| `risk/` | Sizing, Tages-/Drawdown-Halt, PDT. |
| `alpaca/` | Vertrag (`types.ts`), REST-Client (`rest.ts`), Streams (`stream.ts`), Symbol-Mapping. |
| `data/` | Bars-Cache auf Platte, inkrementeller Backfill, Kalender. |
| `strategy/` | Indikatoren (kausal) und Vorlagen. Symbolweise: `trend_donchian`, `momentum_pullback`, `mean_reversion`, `orb_breakout`. Querschnittlich (fragt den KORB, nicht das Symbol): `cross_sectional_momentum` — die Rangliste baut `decide()`, nie die Strategie selbst. Monatsrhythmus (`regime_allocation`): Regime + relative und absolute Stärke in einem Fenster von drei Tagen je Monat, Sizing wie alle über das Risiko-Budget je Trade, weiter Katastrophen-Stop beim Broker, kein Trailing. Bei knappen Plätzen konkurrieren Symbole mit Korb-Rang nach Rang (`decide()`). |
| `backtest/` | Portfolio-Simulator (Fills am nächsten Open, Stop vor Ziel), Kosten, Metriken (Sharpe/Sortino/PSR/DSR), Marktbezug (`marktbezug.ts`: kaufen und halten als Maßstab unter jedem Holdout — kein Gate, aber ohne ihn liest man Markt als Kante). |
| `universe/` | Nächtliche Wahl des Handelsuniversums — nach **Handelbarkeit**, nie nach dem Ergebnis der Strategie (Grenzen der Kennzahl im Modulkopf). |
| `optimize/korbJeFold.ts` | Korb je Fold: Punkt-in-Zeit-Stände aus dem Kandidatenpool (dieselbe `waehleUniverse` wie nachts, Hysterese Stand für Stand); IS-Suche und OOS eines Folds laufen auf dem Korb zu dessen OOS-Beginn, der Maßstab folgt mit. Schalter `optimizer.foldMembership`. |
| `optimize/` | Walk-Forward, Robustheits-Gates (darunter `beats_market`: schlägt die OOS-Kette den Sharpe von kaufen-und-halten? Gegen die Benchmark, nicht den Korb; ohne Benchmark gilt die Kasse — das Gate wird nie vakant), Champion/Challenger, Report. |
| `engine/` | Buch, Order-Ausführung, Abgleich, Uhr, Schleife. |
| `notify/`, `status/` | Telegram, Status-HTTP (nur 127.0.0.1). |
| `readiness.ts` | Live-Reife aus dem Journal (≥ 200 Trades, ≥ 30 Tage, PF ≥ 1,2, feeShare ≤ 0,5, netto > 0). |
| `cli.ts` | `doctor · universe · fetch · backtest · optimize · run · status · flatten · halt · resume · readiness`. |

Plattform (`functions/src/`, `frontend/`, `shared/`):

| Modul | Rolle |
|---|---|
| `functions/src/engine/tick.ts` | Ein Takt: Lease, Kalender, Nutzer laden, geteilte Bars, Engine je Nutzer (parallel ≤ 3), Health. |
| `functions/src/engine/{state,journal,mirror,commands,config,sharedData,strategyFor}.ts` | Firestore-Adapter für den Kern; Spiegel für das Frontend; Kommandos; Config-Ableitung; geteilter Bars-Cache. |
| `functions/src/core/{brokerZugang,keyVault,liveGate,access}.ts` | Übernommen: Key-Tresor (AES-256-GCM), Broker-Verbindung, Echtgeld-Kette, Freischaltung. |
| `functions/src/callable/{engineCommand,strategy,connectBroker,setLiveMode,…}.ts` | Callables des Frontends; `saveStrategy` validiert `settings.auto` serverseitig. |
| `shared/src/autoSettings.ts` | `AutoSettings`, Defaults, Validierung, Ableitung aus alten Feldern. |
| `frontend/` | Login, Broker-Keys, Auto-Trader-Einstellungen, Positionen, Historie, Champion, Engine-Status/-Kommandos, Admin. |

## 4. Konventionen

- TS strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `erasableSyntaxOnly` (keine Parameter-Properties, keine enums),
  `verbatimModuleSyntax`, relative Imports **mit `.ts`-Endung** (Node führt
  die Quellen direkt aus; `tsc` schreibt `.js` um).
- Keine neuen Abhängigkeiten ohne Grund. Laufzeit: `zod`, `yaml`. Streams
  über das globale `WebSocket`, HTTP über `fetch`/`node:http`.
- Tests: vitest unter `test/<modul>/` (Kern) und `functions/test/` (Takt,
  Adapter). Keine Netzwerkzugriffe, keine echten Keys, Dateien nur unter
  `os.tmpdir()`. Jede Funktion, die Geld bewegt oder Zeit rechnet, bekommt
  einen Test mit dem Fall, in dem sie Geld verliert.
- `functions/` importiert den Kern relativ (`../../../src/...`), nie kopiert.
  Der Kern kennt Firestore nicht: Er sieht nur `StateStoreLike`/`JournalLike`
  und injizierte Deps. Alles, was Geld bewegt, bleibt in `src/`.
- Zeit ist immer Epoch-ms (UTC). `Bar.t` ist der Bucket-BEGINN. ET nur in
  `core/time.ts`. Krypto rechnet in UTC-Tagen (`dayKeyFor`).
- Preise an Alpaca: Stops VOM Kurs WEG runden, Limits ZUM Kurs HIN.

## 5. Verifikation

```bash
npm run check                    # typecheck + lint + alle Tests
node src/cli.ts doctor           # Keys, Modus, Konto, Uhr, Assets (braucht .env)
node src/cli.ts universe         # Handelsuniversum nach Liquidität wählen
node src/cli.ts fetch            # Bars + Kalender in den Cache
node src/cli.ts backtest         # Champion/Default gegen den Cache
node src/cli.ts optimize         # Walk-Forward ⇒ champion.json + Report
node src/cli.ts run              # Engine (Paper, solange der Guard nicht erfüllt ist)
```

Plattform zusätzlich: `npm run typecheck --workspace functions`,
`npm run build --workspace frontend`; die Functions-Tests laufen mit dem
Firestore-Fake (`functions/test/fakes/firestore.ts`) im selben `npm test`.
Chart-/UI-Prüfstände gibt es nicht mehr. Der Prüfstand für alles Unsichtbare
ist das **Engine-Red-Team** (siehe §6).

## 6. Arbeitsweise (Owner-Anweisungen, weiterhin gültig)

- **Multi-agentisch** (22.08.): Jede nicht-triviale Aufgabe wird auf mehrere
  Agenten mit verschiedenen Rollen aufgefächert; Prüfer haben nicht selbst
  gebaut und bekommen den Auftrag zu WIDERLEGEN. `git push`, Merges und alles
  Echtgeld-Nahe bleiben an einer Stelle.
- **Engine-Red-Team** (20.08.): Für Kante, Prognose, Messung lautet die Frage
  „beweise, dass diese Zahl falsch ist" — Lookahead, Survivorship, fehlende
  Kosten, zu kleine Stichproben, zu viele Freiheitsgrade, DST-/Datumskanten.
  Jede gemessene Verbesserung gilt als Einbildung, bis sie out-of-sample nach
  Kosten überlebt. Der Kritiker darf „nicht handeln" nie wegloben.
- **Echtgeld erst nach Live-Reife** („bis man sicher nur noch Gewinn
  schreibt, dann erst den Schalter umlegen"). `readiness` misst das aus dem
  Journal des Paper-Betriebs.

## 7. Git

- Nie `.env`, `var/`, `*.db`, `*.bak` committen. Vor jedem Commit prüfen,
  dass keine Keys im Diff stehen.
- Kleine, thematische Commits, deutsche Messages im Imperativ.
- State-Formate (`state.json`, `champion.json`, Bars-Cache) tragen `version`;
  Migrationen additiv und idempotent.
