# CLAUDE.md — Regelwerk für den Alpaca-Auto-Trader (Neubau, Branch `claude/auto-trader-alpaca-rebuild-lghm4u`)

Diese Datei richtet sich an **Claude Code** (und Menschen), die an diesem Repo
arbeiten. Sie beschreibt die Architektur des Neubaus, die **nicht
verhandelbaren Regeln** und die Fallen, die im Vorgängersystem Geld gekostet
haben. Vollständig lesen, bevor du etwas anfasst.

Sprache: Antworten und Commit-Messages auf **Deutsch** (Imperativ, klein,
thematisch). Bezeichner im Code Englisch, Kommentare Deutsch.

> **Altbestand:** Die Firebase-Multi-User-Plattform (Verzeichnisse
> `functions/`, `frontend/`, `shared/`, `reference/`, `supabase/`,
> `rules-test/`, `scripts-ci/`, Dateien `ARCHITECTURE.md`, `MILESTONES.md`,
> `firebase.json`, `firestore.*`, `.firebaserc`, `tsconfig.base.json`,
> `vitest.rules.config.ts`) liegt noch im Baum, wird aber von keinem Werkzeug
> mehr geprüft oder gebaut. Sie lebt unverändert auf `main`. Die Löschung auf
> diesem Branch ist ein einzelner Commit, der die ausdrückliche Freigabe des
> Owners braucht. Die Erkenntnisse daraus stehen in `docs/ARCHITEKTUR.md` und
> hier in §2.

---

## 0. TL;DR der harten Regeln

1. **Ein Entscheidungspfad.** Backtest und Live-Engine rufen dieselbe Funktion
   `decide()` in `src/core/logic.ts`. Was nur in einer Welt gilt, ist ein
   Messfehler — nie „im Backtest abkürzen" oder „live etwas dazurechnen".
2. **Kein Lookahead.** Indikatoren sind kausal; jede neue Indikator-/
   Strategie-Funktion bekommt einen Präfix-Konsistenz-Test
   (`precompute(bars.prefix(i+1))[i] === precompute(bars)[i]`). Der Simulator
   reicht Strategien nur `bars.prefix(i+1)` — das bleibt so.
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

| Zweck | Ort |
|---|---|
| Programm | dieses Repo, `node src/cli.ts …` (Node ≥ 22.18, Type-Stripping) oder `dist/` nach `npm run build` |
| Config | `config/config.yaml` (Vorlage: `config/config.example.yaml`), Schema in `src/core/config.ts` |
| Secrets | `.env` (Vorlage `.env.example`) — nie committen |
| State | `AUTOTRD_HOME` bzw. `paths.home` (Default `./var`): `state.json`, `journal.jsonl`, `champion.json`, `bars/`, `calendar.json`, `reports/`, Not-Aus-Datei `HALT` |

Keine Datenbank, kein Frontend, keine Cloud-Functions. Ein Prozess, ein
Journal (append-only), ein State-Snapshot (atomar geschrieben).

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
| Cloud Scheduler kann kein WebSocket halten; 5-Min-Takt als Kostendeckel. | Datenstrom + `trade_updates` per WebSocket, Timer-getriebene Bucket-Schließung mit Karenz. |

## 3. Modulkarte (`src/`)

| Modul | Rolle |
|---|---|
| `core/types.ts` | Alle geteilten Typen (Bar, Strategy, Decision, OrderIntent, Trade, Metrics). |
| `core/config.ts` | zod-Schema, `.env`-Parser, `resolveMode` (Doppel-Guard). |
| `core/time.ts` | ET-Zeitlogik (DST via Intl), NYSE-Kalender-Fallback, Buckets. |
| `core/bars.ts` | Kolumnare `BarSeries`, `aggregate()` aus Minutenbars. |
| `core/session.ts` | Sitzungs-Sicht je geschlossener Bar (Minuten bis Schluss, letzte Bar). |
| `core/logic.ts` | `decide()`: Tore, Sizing, Exits — für Backtest UND Live. |
| `core/journal.ts`, `core/log.ts` | Journal/State, Logging mit Schwärzung. |
| `risk/` | Sizing, Tages-/Drawdown-Halt, PDT. |
| `alpaca/` | Vertrag (`types.ts`), REST-Client (`rest.ts`), Streams (`stream.ts`), Symbol-Mapping. |
| `data/` | Bars-Cache auf Platte, inkrementeller Backfill, Kalender. |
| `strategy/` | Indikatoren (kausal) und Vorlagen: `trend_donchian`, `momentum_pullback`, `mean_reversion`, `orb_breakout`. |
| `backtest/` | Portfolio-Simulator (Fills am nächsten Open, Stop vor Ziel), Kosten, Metriken (Sharpe/Sortino/PSR/DSR). |
| `optimize/` | Walk-Forward, Robustheits-Gates, Champion/Challenger, Report. |
| `engine/` | Buch, Order-Ausführung, Abgleich, Uhr, Schleife. |
| `notify/`, `status/` | Telegram, Status-HTTP (nur 127.0.0.1). |
| `readiness.ts` | Live-Reife aus dem Journal (≥ 200 Trades, ≥ 30 Tage, PF ≥ 1,2, feeShare ≤ 0,5, netto > 0). |
| `cli.ts` | `doctor · fetch · backtest · optimize · run · status · flatten · halt · resume · readiness`. |

## 4. Konventionen

- TS strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `erasableSyntaxOnly` (keine Parameter-Properties, keine enums),
  `verbatimModuleSyntax`, relative Imports **mit `.ts`-Endung** (Node führt
  die Quellen direkt aus; `tsc` schreibt `.js` um).
- Keine neuen Abhängigkeiten ohne Grund. Laufzeit: `zod`, `yaml`. Streams
  über das globale `WebSocket`, HTTP über `fetch`/`node:http`.
- Tests: vitest unter `test/<modul>/`. Keine Netzwerkzugriffe, keine echten
  Keys, Dateien nur unter `os.tmpdir()`. Jede Funktion, die Geld bewegt oder
  Zeit rechnet, bekommt einen Test mit dem Fall, in dem sie Geld verliert.
- Zeit ist immer Epoch-ms (UTC). `Bar.t` ist der Bucket-BEGINN. ET nur in
  `core/time.ts`. Krypto rechnet in UTC-Tagen (`dayKeyFor`).
- Preise an Alpaca: Stops VOM Kurs WEG runden, Limits ZUM Kurs HIN.

## 5. Verifikation

```bash
npm run check                    # typecheck + lint + alle Tests
node src/cli.ts doctor           # Keys, Modus, Konto, Uhr, Assets (braucht .env)
node src/cli.ts fetch            # Bars + Kalender in den Cache
node src/cli.ts backtest         # Champion/Default gegen den Cache
node src/cli.ts optimize         # Walk-Forward ⇒ champion.json + Report
node src/cli.ts run              # Engine (Paper, solange der Guard nicht erfüllt ist)
```

Chart-/UI-Prüfstände gibt es nicht mehr — es gibt keine UI. Der Prüfstand
für alles Unsichtbare ist das **Engine-Red-Team** (siehe §6).

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
