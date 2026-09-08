# ARCHITEKTUR.md — autotrd als Alpaca-Auto-Trader

Stand: Neubau (Branch `auto-trader-alpaca-rebuild`). Dieses Dokument
beschreibt, **warum** das Tool neu gebaut wurde, **wie** es geschnitten ist
und welche Regeln nicht verhandelbar sind. Die Validierung der Strategien
steht in [VALIDIERUNG.md](VALIDIERUNG.md), der Betrieb in
[BETRIEB.md](BETRIEB.md) und [ops/README.md](../ops/README.md).

## 1. Warum ein Neubau

Der Vorgänger war eine Multi-User-Plattform (Firebase Auth/Firestore, Cloud
Functions, statisches Frontend auf autotrd.net) mit einem Scan alle fünf
Minuten über Cloud Scheduler, Yahoo-Finance-Kursen und einer Signal-Engine
aus Konfluenz, Prognose und News-Sentiment. Die Plattform hat funktioniert —
die Handelsergebnisse nicht. Die Gründe waren strukturell, keine Bugs:

| Befund | Folge |
|---|---|
| **5-Minuten-Scheduler statt Datenstrom.** Der Scan sah den Markt in Momentaufnahmen; zwischen zwei Scans passierte alles Unbeobachtete. | Stops griffen bis zu fünf Minuten zu spät, Signale drehten im Scan-Takt. |
| **Yahoo-Daten, Alpaca-Broker.** Zwei Quellen mit verschiedenen Kursen, Zeitstempeln und Lücken; Yahoo liefert 5-Minuten-Historie nur ~60 Tage. | Messung und Handel liefen auseinander; ein echter Backtest auf der Live-Zeitbasis war unmöglich. |
| **Stops im Buch, nicht beim Broker.** Erst spät (06.08.) kam ein broker-seitiger Schutz-Stop als „Stufe 1". | Bei jedem Ausfall (Deploy, 503, Scheduler-Aussetzer) waren Positionen ungeschützt. |
| **Gebühren > Bruttogewinn.** 514 Trades: Gebühren 3 049 $, netto −1 593 $, brutto +1 456 $ — 2,83 $ verdient, 5,93 $ bezahlt je Trade. Später: 471 Trades, brutto +122 $, Gebühren 2 865 $ (Verhältnis 23 : 1). | „Der Handel funktioniert; er wird zu Tode gehandelt." Echtgeld hätte einen Buchverlust in einen echten verwandelt. |
| **Der Backtest maß eine andere Strategie.** `backtest.ts` rechnete Long/Flat auf Tagesbars; live liefen 5-Minuten-Kerzen mit Shorts. | Jede „Verbesserung" aus dem Backtest sagte nichts über den Live-Pfad — und umgekehrt. |
| **Multi-User, Frontend, Charts, News, KI.** Über 80 % des Codes hatten mit der Handelsentscheidung nichts zu tun. | Jede Änderung an der Engine zog Frontend, Firestore-Regeln und Deploy-Pipelines mit. |

Die Konsequenz: nicht reparieren, sondern auf das reduzieren, was Geld
verdient oder verliert — und das eine Mal richtig messen.

## 2. Zielbild

- **Ein Kern** (Node 22, TypeScript strict) in zwei Betriebsarten: als
  eigener Prozess (Zustand als Dateien in `AUTOTRD_HOME`, Streams) und als
  Firebase-Function je Minute für die Nutzer der Plattform (Zustand in
  Firestore, keine Streams; PLATTFORM.md). Beide bauen dieselbe Engine mit
  injizierten Adaptern — was nur in einer Betriebsart gilt, ist ein Fehler.
- **Nur Alpaca** — Broker **und** Daten, derselbe Feed (`iex` oder `sip`)
  für Backtest und Live. Was der Backtest nicht sehen konnte, darf die Engine
  nicht handeln.
- **Streaming-Bars.** 1-Minuten-Bars kommen über den Datenstrom; alle
  höheren Zeitrahmen entstehen **lokal** aus 1-Minuten-Bars (`core/bars.ts`
  `aggregate()`), im Backtest wie live mit derselben Funktion. Strategien
  sehen ausschließlich **geschlossene** Bars.
- **EIN Entscheidungspfad.** `core/logic.ts` `decide()` bekommt von Backtest
  und Engine dieselbe Sicht (Snapshot, Konto, Positionen, Halt, Session)
  und gibt dieselben `OrderIntent`s zurück. Alles, was nur in einer Welt
  gilt, ist ein Messfehler.
- **Bracket-Orders.** Jeder Einstieg trägt seinen Stop (Pflicht — ohne Stop
  kein Einstieg) und optional ein Ziel als Beine der Order. Der Stop liegt
  beim Broker und schützt auch, wenn der Prozess nicht läuft.
- **Reconciliation.** Alle `engine.reconcileEverySec` wird das Buch gegen
  Broker-Positionen und -Orders abgeglichen. Fremde Positionen ⇒ `halt`
  (Default) oder `adopt` mit Schutz-Stop. Drift ist ein Messergebnis, kein
  Schalter.
- **Kill-Switch.** Datei `HALT` im State-Verzeichnis (oder `autotrd halt`)
  ⇒ keine neuen Einstiege; Exits laufen immer. `autotrd flatten` ⇒ alles
  glatt + HALT.
- **Walk-Forward-Optimierer mit Champion-Datei.** Nachts sucht
  `autotrd optimize` über die Strategien und schreibt nur dann ein neues
  `champion.json`, wenn ein Kandidat alle Gates besteht **und** den
  amtierenden Champion um die Marge schlägt. Ohne Champion wird nicht
  gehandelt (`strategy.allowWithoutChampion: false`).

## 3. Modulkarte (`src/`)

| Modul | Aufgabe |
|---|---|
| `core/types.ts` | Gemeinsame Verträge: Bars, Strategie, `Decision`, `OrderIntent`, `Trade`, `Metrics`, Konto- und Halt-Zustand. |
| `core/config.ts` | zod-Schema der YAML-Config, `.env`-Parser, **Doppel-Guard** (`resolveMode`), `homeDir`. |
| `core/time.ts` | ET-Zeitlogik ohne Abhängigkeit (DST-sicher), NYSE-Kalender-Fallback, Sitzungsgrenzen, Bucket-Arithmetik. |
| `core/bars.ts` | Kolumnare `BarSeries` (Float64Array), `prefix()`-Sicht, `aggregate()` aus 1-Minuten-Bars. |
| `core/session.ts` | Sitzungs-Sicht je geschlossener Bar (Minuten bis Schluss, letzte Bar des Tages). |
| `core/logic.ts` | **Der** Entscheidungspfad: Halt-Prüfung, Exits (nie gesperrt), Tore für Einstiege, Sizing ⇒ Intents. |
| `core/log.ts` | JSON-Log mit Schwärzung registrierter Secrets und Alpaca-Header-Muster. |
| `core/journal.ts` | Append-only-Journal (JSONL), atomarer State-Snapshot, `homePaths`. |
| `risk/` | `sizing.ts` (Stückzahl aus Risiko je Trade, Deckel, Exposure, Cash), `limits.ts` (Tages-Notbremse, Drawdown-Halt, `resume`), `pdt.ts` (Pattern-Day-Trader-Gate). |
| `alpaca/` | `types.ts` Vertrag; `rest.ts` Trading + Market-Data (Timeout, Retry, geschwärzte Fehler); `stream.ts` Daten- und Order-Streams; `symbols.ts` Schreibweisen; `raw.ts` Rohformat → Zahlen. |
| `data/` | Bars-Cache (1-Minuten- und Tagesbars je Symbol), inkrementelles Nachladen, Broker-Kalender. |
| `strategy/` | Strategien mit Parameterraum: `trend_donchian`, `momentum_pullback`, `mean_reversion`, `orb_breakout`; `indicators.ts` (kausal), `params.ts` (Validierung, Gitter). |
| `backtest/` | Simulator über geschlossene Bars mit Präfix-Snapshots, Kostenmodell, Fills an Stop/Ziel, Metriken. |
| `optimize/` | Walk-Forward (`walkForward.ts`), Zufallssuche (`search.ts`), Zielfunktion (`objective.ts`), Gates (`robustness.ts`: Stress, Nachbarschaft, Deflated Sharpe), Beförderung (`promote.ts` ⇒ `champion.json`), Bericht (`report.ts`). |
| `engine/` | Live-Schleife: Streams, Bucket-Schluss + Karenz, Snapshot-Bau, `decide()`, Order-Routing (Bracket, idempotente Client-IDs), Trade-Updates, Reconciliation, Kill-Switch, State. |
| `notify/` | `Notifier` (Log immer; Telegram bei `notify.telegram: true` + Token/Chat). Wirft nie, drosselt auf 20/min. |
| `status/` | `GET /health`, `GET /status` auf 127.0.0.1 — JSON durch die Schwärzung. |
| `readiness.ts` | Live-Reife aus dem Journal: Trades, Tage, Profit-Faktor, Gebührenanteil, Netto. |
| `app.ts`, `cli.ts` | Bootstrap (Config, Env, Modus, Pfade, Client, Champion) und Kommandos `doctor · fetch · backtest · optimize · run · status · flatten · halt · resume · readiness`. |

## 4. Datenfluss

```
                 ┌────────────────────────── Alpaca ───────────────────────────┐
                 │  Market Data (REST + WSS)          Trading (REST + WSS)     │
                 └───────┬───────────────┬────────────────┬───────────┬────────┘
            historische  │     1-Min-Bars│ (Stream)       │ Orders    │ trade_updates
            1-Min-Bars   │               │                │ (Bracket) │ (fill, cancel …)
                         ▼               ▼                ▲           ▼
                   ┌──────────┐    ┌───────────────┐      │     ┌───────────────┐
   autotrd fetch ─►│ data/    │───►│ core/bars     │      │     │ engine/       │
                   │ Cache    │    │ aggregate()   │      │     │ Trade-Updates │
                   └────┬─────┘    │ tf aus 1-Min  │      │     │ → Positionen  │
                        │          └───────┬───────┘      │     │ → Journal     │
                        │        geschlossene Bar          │     └───────┬───────┘
                        │                  ▼               │             │
                        │        ┌─────────────────┐       │             │
                        │        │ SymbolSnapshot  │       │             │
                        │        │ + SessionInfo   │       │             │
                        │        │ + Position/Konto│       │             │
                        │        └────────┬────────┘       │             │
                        │                 ▼                │             │
                        │  ┌──────────────────────────┐    │             │
                        │  │ core/logic.ts decide()   │    │             │
                        │  │ Strategie ▸ Tore ▸ Sizing│    │             │
                        │  └───────┬──────────┬───────┘    │             │
                        │  OrderIntent[]      │ OrderIntent[]            │
                        ▼          ▼          ▼            │             │
                 ┌────────────────────┐ ┌──────────────────┴───┐         │
                 │ backtest/ Simulator│ │ engine/ Order-Routing │◄────────┘
                 │ füllt Intents selbst│ │ Bracket + Stop beim  │  reconcile alle N s
                 └─────────┬──────────┘ │ Broker, Kill-Switch  │◄──── HALT-Datei
                           │            └──────────┬───────────┘
                           ▼                       ▼
                 ┌────────────────────┐ ┌──────────────────────┐   ┌──────────────┐
                 │ optimize/          │ │ journal.jsonl        │──►│ readiness    │
                 │ Walk-Forward, Gates│ │ state.json           │   │ status/ HTTP │
                 │ ⇒ champion.json ───┼─┼─► Engine lädt Champion│   │ notify/      │
                 └────────────────────┘ └──────────────────────┘   └──────────────┘
```

Links der Backtest, rechts die Engine — beide hängen am selben `decide()`.
Der Optimierer läuft über den Cache, nie über den Stream; die Engine lädt
den Champion beim Start (und nach Beförderung beim nächsten Neustart).

## 5. Sicherheitsregeln (nicht verhandelbar)

1. **Doppel-Guard für Echtgeld.** `broker.mode: live` **und**
   `ALPACA_ALLOW_LIVE=1` **und** ein Live-Key (`AK…`). Fehlt eines ⇒ Paper.
   Ein Live-Key gegen Paper wird abgelehnt (`ConfigError`), damit niemand
   mit dem falschen Konto arbeitet. Umgesetzt in `core/config.ts`
   `resolveMode()`; `doctor` zeigt den aufgelösten Modus und die Gründe.
2. **Keys nie im Log.** Beim Start werden Key, Secret und Bot-Token
   registriert (`registerSecret`); jede Log-Zeile, jedes Journal-Ereignis
   und der Status-Endpunkt laufen durch `redact()`. Alpaca-Fehlertexte
   werden zusätzlich generisch nach Header-Mustern geschwärzt.
3. **Exits sind nie gesperrt.** Halt, fehlende Datenfrische, PDT,
   Positionslimit — alles blockiert nur Einstiege. Stop, Ziel, Signal-Exit
   und EOD-Flatten laufen immer (`core/logic.ts`, Abschnitt „Position offen").
4. **Sperren nur über die Ursache.** Tages-Notbremse endet am nächsten
   Handelstag von selbst; Drawdown-, Fehler- und Abgleich-Halts enden nur
   durch ein bewusstes `resume`, das den Grund ins Journal schreibt und den
   Peak neu setzt. Es gibt keinen Schalter „Sperre ignorieren".
5. **PDT-Gate.** Unter 25 000 $ Equity höchstens drei Daytrades in fünf
   Handelstagen; die Broker-Zahl ist die Wahrheit, lokal wird ergänzend
   gezählt, geplante Einstiege im selben Zyklus werden mitgerechnet — auch
   für Übernacht-Strategien, weil ein Stop am Einstiegstag ein Daytrade ist.
6. **Kein Einstieg ohne Stop.** `Decision.enter` ohne plausiblen Stop (auf
   der Verlustseite, Mindestabstand) wird verworfen; die Stückzahl leitet
   sich aus der Stop-Distanz ab, nicht aus dem Bargeld.
7. **Keine Netzwerkzugriffe in Tests**, keine Secrets im Repo, State nie im
   Repo (`var/`, `.env` in `.gitignore`).

## 5a. Messbefunde 08.09.2026 — drei Zeitrahmen, dieselbe Antwort

Derselbe Korb aus 30 liquiden US-Werten, dieselben Kosten, dasselbe Risiko,
dieselben Gates. Nur der Zeitrahmen ist verschieden. Jeweils der Kandidat mit
dem besten OOS-Ergebnis:

| Zeitrahmen | Bester Kandidat | Gates | Gebührenanteil | OOS-Netto | **Holdout (ungesehen)** |
|---|---|---|---|---|---|
| 5 min | `orb_breakout` | 3/9 | 65,5 % | +280 | −534 (55 Trades) |
| 60 min | `trend_donchian` | **8/9** | 43,4 % | +3 864 | **−1 886 (185 Trades)** |
| Tagesbars | `momentum_pullback` | **9/9** | 25,4 % | +3 109 | −572 (23 Trades) |

Zwei Dinge stehen darin, und das zweite ist das wichtigere.

**Erstens: Der Zeitrahmen löst die Kostenfrage.** Der Gebührenanteil fällt von
65,5 % über 43,4 % auf 25,4 %. Das bestätigt die Rechnung — Kosten fallen je
Round-Trip an, nicht je Zeiteinheit, also hilft nur ein größerer erwarteter Zug
je Trade. Die 5-Minuten-Bar war für Aktien der falsche Takt.

**Zweitens: Die Auswahl sagt den Holdout nicht vorher.** In zwei von drei
Zeitrahmen kehrt sich die Rangfolge zwischen OOS und Holdout vollständig um:

| Zeitrahmen | Rang 1 auf OOS → Holdout | Letzter auf OOS → Holdout |
|---|---|---|
| 60 min | `trend_donchian` +3 864 → **−1 886** | `mean_reversion` +506 → **+1 286** |
| Tagesbars | `momentum_pullback` +3 109 → **−572** | `trend_donchian` −2 983 → **+2 816** |

Das ist kein Pech an einer Stelle, sondern dreimal dasselbe Bild — und bei 185
Holdout-Trades im Stundenfall auch keine Stichprobenfrage mehr. Die
Walk-Forward-Auswahl hat auf diesem Korb mit diesen vier Vorlagen **keine
Vorhersagekraft**. Den Bestplatzierten zu nehmen ist nicht besser als zu
würfeln.

**Die naheliegende Erklärung, und sie ist prüfbar:** Alle vier Vorlagen sind
gerichtete Strategien auf 30 stark korrelierten Großwerten — und sie laufen
alle NUR LONG. `risk.allowShort: false` steht in `config/platform.yaml` und in
jeder Erkundungs-Config, und `src/core/logic.ts` sperrt damit jeden
Short-Einstieg. Der Strategie-Parameter `allowShort` war in allen bisherigen
Messungen also wirkungslos: Der Optimierer hat eine Dimension durchsucht, die
nichts bewirkt, und die Trial-Zahl im Deflated Sharpe ist entsprechend zu hoch
angesetzt.

Long-only auf einem Korb, dessen Werte fast im Gleichschritt laufen, ist der
Sache nach eine Wette auf den Markt mit Zusatzkosten. Ob ein Fold positiv ist,
hängt dann vor allem daran, ob der Markt in diesem Fold gestiegen ist — und
Marktregime halten nicht bis zum nächsten Fenster. Genau das würde die
Umkehrung erzeugen.

**Was daraus folgt:** Der nächste Hebel ist nicht ein weiterer Zeitrahmen und
nicht mehr Parametersuche, sondern eine Kante, die vom Marktfaktor unabhängig
ist — Shorts wirksam machen (Risikoentscheidung des Owners) und/oder eine
querschnittliche Strategie, die den Korb RANGIERT (die stärksten long, die
schwächsten short), statt jedes Symbol einzeln zu fragen, ob es steigt. Letzteres
braucht eine Erweiterung des Strategie-Vertrags: `SymbolSnapshot` sieht heute
genau ein Symbol.

Bis dahin gilt weiter, was das Dashboard zeigt: kein Handel. Das ist das
gemessene Ergebnis.

## 6. Was bewusst fehlt

Keine Charts, keine News, kein Sentiment, keine KI-Erklärung, keine
Prognose, keine Strategie-Parameter je Nutzer. Nichts davon hat im
Vorgänger einen messbaren Beitrag zur Kante nach Kosten geleistet; alles
davon hat Zeit gekostet. Wer eines davon zurückholt, muss zuerst zeigen,
dass es out-of-sample nach Kosten etwas ändert — siehe VALIDIERUNG.md.

Multi-User und Frontend bleiben — aber nur als Hülle: Login, Broker-Keys,
Risiko-Einstellungen, Positionen, Historie, Status. Die Handelsentscheidung
kommt für alle Nutzer aus demselben Champion und demselben `decide()`.
