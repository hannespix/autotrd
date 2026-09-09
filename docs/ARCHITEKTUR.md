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

## 5a. Messbilanz 08.09.2026 — was gemessen wurde und was es heißt

An einem Tag gemessen: **5 Strategien × 3 Zeitrahmen × 2 Short-Einstellungen**,
immer derselbe Korb aus 30 liquiden US-Werten, immer dieselben Kosten, dasselbe
Risiko, dieselben Gates. Ergebnis vorweg: **Nichts besteht die Gates UND
überlebt den Holdout.** Die Plattform steht zu Recht auf KEIN HANDEL.

### 1. Der Zeitrahmen löst die Kostenfrage (belastbar)

| Zeitrahmen | bester Kandidat | Gebührenanteil |
|---|---|---|
| 5 min | `orb_breakout` | 65,5 % |
| 60 min | `trend_donchian` | 43,4 % |
| Tagesbars | `momentum_pullback` | **25,4 %** |

Kosten fallen je Round-Trip an, nicht je Zeiteinheit — nur ein größerer
erwarteter Zug je Trade hilft. Die 5-Minuten-Bar war für Aktien der falsche
Takt. Die langsamste gemessene Variante (`cross_sectional_momentum` im
Holdout) kommt auf **3,7 %**. Das Kostenproblem des Vorgängersystems ist
damit strukturell lösbar.

### 2. Shorts helfen nicht (gemessen, nicht vermutet)

Der Strategie-Parameter `allowShort` war bis zum 08.09. **wirkungslos**, weil
`risk.allowShort: false` in `core/logic.ts:307` jeden Short-Einstieg sperrt —
der Optimierer durchsuchte eine tote Dimension, die halbe Suchfläche war
Duplikat, die DSR-Trial-Zahl zu hoch. Behoben mit dem MESS-Schalter
`--allow-short` (nur `backtest`/`optimize`; `run` lehnt ihn ab).

Mit wirksamen Shorts: `trend_donchian` auf 60 min fällt von +3 864 auf +106,
der Gebührenanteil steigt von 43,4 % auf 154,7 %; `mean_reversion` von +506
auf −1 967. Und die Suche selbst wählt Shorts seltener, sobald sie
Konsequenzen haben (8 von 24 statt 14 von 24). `risk.allowShort: false`
bleibt richtig.

### 3. Die Querschnitts-Strategie hat auch keine Kante

`cross_sectional_momentum` fragt „ist NVDA stärker als die anderen 29?" statt
„steigt NVDA?" — der Marktfaktor kürzt sich heraus. Auf Tagesbars: **OOS-Sharpe
p. a. 0,00** über 554 Beobachtungen, 4 von 9 Gates. Auf Stundenbars: 5 von 9
Gates, Gebührenanteil 162,8 %. Die Idee ist richtig gedacht; sie trägt auf
diesem Korb nicht.

### 4. KORREKTUR: Die „Umkehrung" ist EINE Marktperiode, nicht vier Belege

Auffällig ist, dass der Sieger der Auswahl im Holdout regelmäßig verliert,
während die Schlusslichter verdienen — auf Stundenbars zuletzt
`trend_donchian` (8 von 9 Gates, bester OOS-Score) mit **−1 886** gegen
`cross_sectional_momentum` (5 von 9 Gates) mit **+3 981**.

Das sieht nach mehrfacher Bestätigung aus und ist keine. **Alle Läufe teilen
denselben Holdout: 2026-03-08 … 2026-09-04.** Vier Strategien, zwei
Zeitrahmen — aber EIN Marktzeitraum, viermal betrachtet. Was wie ein Gesetz
aussieht, ist genauso gut ein einzelner Regimewechsel: Die letzten sechs
Monate haben bestraft, was das Jahr davor belohnt hat.

Daraus „dann nimm den Schlechtesten" abzuleiten wäre Data-Mining auf einer
Beobachtung — genau der Fehler, gegen den dieses System gebaut ist. Es wird
NICHT eingebaut.

### 5. Gates und Holdout messen verschiedene Objekte

Die Gates rechnen auf der Walk-Forward-Kette: 7 bis 9 Folds mit je EIGENEN
Parametern. `finalParams` stammt dagegen aus der Suche auf dem LETZTEN
IS-Fenster, und nur damit läuft der Holdout.

Die Gate-Aussage lautet also „diese Strategie-FAMILIE hätte mit laufend neu
gefitteten Parametern funktioniert", die Holdout-Aussage „dieser EINE
Parametersatz funktioniert". Das ist übliches Walk-Forward-Verfahren, aber es
heißt: Ein bestandenes Gate validiert nicht direkt die Parameter, die
befördert werden. Sichtbar wird das am Gebührenanteil von
`cross_sectional_momentum` auf 60 min — 162,8 % über die Kette, 5,4 % im
Holdout: zwei verschiedene Handelsverhalten.

### 6. Die Beweislast sinkt mit jeder Variante

An diesem Tag sind 5 Strategien × 3 Zeitrahmen × 2 Short-Einstellungen
gemessen worden. Der Deflated Sharpe deflationiert die PARAMETER-Trials
(1 200–1 500 je Lauf) und sagt schon dort, dass die IS-Kennzahlen von Zufall
nicht zu unterscheiden sind. Die Suche über Strategien, Zeitrahmen und
Einstellungen zählt er **gar nicht mit**.

Jede weitere Variante macht ein eventuelles „besteht alle Gates" also
unglaubwürdiger, nicht glaubwürdiger. Wer hier weitersucht, muss die Zahl der
Versuche mitzählen und den Holdout unangetastet lassen — sonst misst er nur
noch sich selbst.

### 7. Ohne Maßstab ist keine Holdout-Zahl lesbar

Bis zum 08.09. abends nannte kein Bericht, was **Nichtstun** im selben Fenster
gebracht hätte. +11.3 % Holdout-Rendite klingen großartig — gegen einen Korb,
der im selben Halbjahr +12 % gemacht hat, sind sie eine teure Null. Ohne diese
Gegenzahl misst der Bericht Marktbewegung und nennt sie Kante; das ist
derselbe Fehler wie im Vorgängersystem, nur eine Ebene höher.

Seitdem steht unter jeder Holdout-Tabelle ein Maßstab
(`src/backtest/marktbezug.ts`): gleichgewichtet kaufen, halten, nichts tun —
für den gehandelten Korb und für die Benchmark. Vergleichbar ist der
**Sharpe**, nicht die Rendite: Er ist Ertrag je Risiko und damit unabhängig
davon, wie oft eine Strategie im Markt stand. Eine selten investierte
Strategie DARF weniger Rendite haben; sie muss den besseren Sharpe haben.

Der Maßstab ist bewusst zu gut gerechnet (keine Kosten, durchgehend voll
investiert) — die richtige Richtung für eine Latte, über die gesprungen
werden soll. Er ist ausdrücklich **kein Gate**: Er entscheidet nichts,
er macht nur lesbar, was entschieden wurde.

### 8. Gemessen: Nichtstun war besser (vier Halbjahre, mit Maßstab)

Vier lückenlose Halbjahre, jedes (Auswahl → Holdout)-Paar in sich sauber,
je Fenster derselbe Maßstab. Rendite / Sharpe im Holdout:

| Fenster | Korb kaufen und halten | SPY | beste Strategie | schlägt den Korb? |
|---|---|---|---|---|
| Sep 24 – Mär 25 | +8.53 % / 1.09 | +5.37 % / 0.88 | cross_sectional +11.24 % / 1.61 | 2 von 4 |
| Mär – Sep 25 | +20.11 % / 1.57 | +15.41 % / 1.39 | cross_sectional +3.55 % / 2.20 | 2 von 4 |
| Sep 25 – Mär 26 | +2.14 % / 0.35 | +3.65 % / 0.69 | momentum_pullback +1.58 % / 0.78 | 1 von 4 |
| Mär – Sep 26 | +23.73 % / 2.57 | +15.92 % / 2.28 | trend_donchian +3.08 % / 2.40 | **keine** |

Über die zwei Jahre aufgezinst: **Korb +64.7 %, SPY +46.1 %** gegen
cross_sectional +17.4 %, momentum_pullback +10.0 %, mean_reversion +3.4 %,
trend_donchian −0.1 %. Der Korb ist survivorship-verseucht (heutige Top-30
rückwirkend angewandt); **SPY ist es nicht** — die ehrliche Zahl lautet also
+46 % fürs Nichtstun gegen +17 % für die beste der vier.

Das Muster ist konsistent: Der Korb-Sharpe schwankt zwischen 0.35 und 2.57,
und genau dann, wenn der Markt schwach ist, schlägt eine Strategie ihn; wenn
er stark ist, keine. Das ist das Profil eines defensiven Systems — relativ
gut in schlechten Phasen, absolut abgehängt in guten. Über einen Bullenzyklus
verliert es. mean_reversion schlägt den Korb in **keinem** der vier Fenster.

Der Auswahl-Rang sagt den Holdout-Rang weiterhin nicht vorher (Spearman
−0.20 / −0.80 / +0.40 / −0.80, Mittel −0.35). Nie gewinnt dieselbe Strategie
beides. Verführerisch ist dabei, dass die Auswahl mehrfach die spätere
Siegerin auf den letzten Platz setzte — bei vier Fenstern × vier Strategien
ist „dann nimm die Schlechteste" aber genau die Überanpassung, gegen die das
ganze System gebaut ist. Hypothese, keine Regel.

### 9. Die Lücke im Regelwerk: `beats_market`

Keines der neun Gates fragte, ob die Strategie besser ist als Nichtstun.
Deshalb konnte momentum_pullback am 08.09. zweimal mit **9/9** durchgehen und
im folgenden Halbjahr +1.9 % liefern, während der Korb +23.7 % machte — eine
Verfehlung um 21.8 Prozentpunkte, die kein Gate bemerkt hätte.

Seitdem gibt es ein zehntes Gate. Es misst auf der **OOS-Kette**, nie am
Holdout (der bleibt selektionsfrei), und vergleicht den **Sharpe**: Ertrag je
eigener Schwankung, also unabhängig davon, wie oft die Strategie investiert
war. Wer weniger Ertrag je Risiko liefert als stumpfes Halten, hat keine
Kante, sondern Gebühren.

Drei Festlegungen, jede gegen eine konkrete Falle:

- **Gegen SPY, nicht gegen den Korb.** Der Korb ist die heutige Auswahl,
  rückwirkend angewandt; seine Rendite enthält Survivorship und wäre eine
  unfair hohe Latte. SPY war damals kaufbar.
- **Die Latte gilt für DIESELBEN Fenster.** Der Amtsinhaber wird nur auf
  Folds nach seinem Fit-Ende nachgerechnet und bekommt deshalb seine eigene
  Latte — sonst verglichen wir eine Strategie auf Fenster X mit einem Markt
  auf Fenster Y. Diese Gegenprobe fehlte zuerst und rutschte durch.
- **Das Gate wird nie vakant.** Ohne konfigurierte Benchmark gilt die Kasse
  (Latte 0), nicht „kein Urteil" — sonst schaffte man das Gate ab, indem man
  eine Zeile aus der Config nimmt. Ein nicht berechenbarer Maßstab ist im
  Bericht vom nicht konfigurierten unterscheidbar: das eine ist ein
  Datenproblem, das andere eine Entscheidung.

Das Gate kann eine Beförderung nur verhindern, nie auslösen — es ist damit in
die falsche Richtung risikofrei.

### 10. Die Plattform maß im aussichtslosesten Zeitrahmen

Der nächtliche Produktivlauf lief auf **5-Minuten-Bars**. Der erste Lauf mit
dem neuen Gate (09.09., Run 34297873726) zeigte, was das kostet:

| Strategie | Gebührenanteil am Bruttogewinn |
|---|---|
| trend_donchian | **2 437,9 %** |
| orb_breakout | **271,2 %** |
| momentum_pullback, mean_reversion | nicht berechenbar — es gab keinen Bruttogewinn |

Dort kann kein Kandidat gewinnen, egal wie gut sein Signal ist. Wir haben also
jede Nacht 43 Minuten Rechenzeit auf den einen Zeitrahmen verwendet, in dem die
Reibung jede Kante verdeckt, während die Erkundungen längst zeigten, dass
langsamer die Kostenfrage entschärft (§5a.1).

**Korrektur (09.09., nach dem ersten Tagesbar-Produktivlauf).** Hier stand
zuerst „auf Tagesbars liegt derselbe Anteil bei 1,5–5,5 %". Das war falsch und
zu günstig: Verglichen wurde der Anteil der 5-Minuten-**OOS-Kette** mit dem der
Tagesbar-**Holdouts** — zwei verschiedene Größen. Der Holdout handelt EINEN
Parametersatz auf wenigen Trades, die OOS-Kette neun. Richtig ist:

| Zeitrahmen | Gebührenanteil der OOS-Kette |
|---|---|
| 5 min | 271 % – 2 438 % |
| Tagesbars | 23 % – 71 % |

Der Gewinn ist real und groß — etwa Faktor zehn. Aber er löst die Kostenfrage
NICHT: Im Lauf vom 09.09. riss `cross_sectional_momentum` das Gate `fee_share`
mit 71 %, und 38 % bis 41 % bei den anderen sind kein Komfort, sondern eine
Latte knapp unter der Schwelle. Wer hier weiter will, muss die Handelsfrequenz
senken, nicht nur den Zeitrahmen dehnen.

Seit dem 09.09. steht `config/platform.yaml` deshalb auf `timeframe: 1440`,
mit den Fenstern der bewährten Erkundung (365/90/90/180 statt 120/30/30/60 —
bei einer Bar je Tag statt 78 braucht ein Fold Jahre, nicht Monate).
`orb_breakout` fällt aus der Liste, weil es ausdrücklich nur Intraday kann;
`cross_sectional_momentum` kommt dazu.

**Das ist keine Kante.** Es räumt nur das Hindernis weg, das jede Kante
verdeckt hätte. Mit `beats_market` und der Tagesbar-Bilanz aus §5a.8 ist die
erwartete Folge weiterhin KEIN HANDEL — jetzt aber aus einem Grund, der etwas
über die Strategien sagt statt über die Gebührenordnung.

### 11. Wie tief wir überhaupt messen können

Der Versuch, acht Jahre zu messen, scheiterte am 09.09. nicht an der Config,
sondern an der Datenquelle — und das Protokoll sagt es genau:

```
SPY     1538   2018-11-01 … 2026-09-08
NVDA    1537   2020-07-27 … 2026-09-08
…alle 29 übrigen: 2020-07-27
```

Der Backfill holte 43 492 Bars, vollständig. Aber die **IEX-Historie dieses
Kontos beginnt am 27.07.2020**, für alle Symbole auf denselben Tag genau.
Einzig SPY trägt eine verirrte Bar vom 2018-11-01 — und genau die setzte den
gemeldeten Datenbereich auf „2018-11-01 … 2026-09-08".

Der Lauf brach ab, weil im ersten Fold-Fenster 2019-01-13 … 2020-01-13 **null**
Bars lagen und das Embargo es vollständig verschluckte.

**Die Lehre ist allgemein:** Ein Datenbereich nennt die erste und die letzte
Bar — nicht, ob dazwischen etwas liegt. Eine einzige Ausreißer-Bar genügt, um
ihn glaubwürdig aussehen zu lassen. Ich hatte den Bereich zuerst als Beleg
gelesen, dass die Tiefe angekommen sei.

Daraus folgt die harte Grenze: **höchstens rund 2230 Tage** messbar. Die
Erkundung steht auf 2000 — bis etwa März 2021, über den gesamten Abschwung
2022. Der Corona-Crash liegt VOR dem Datenbeginn und ist mit diesem Feed
unerreichbar. Wer ihn braucht, braucht den bezahlten SIP-Feed.

### Was das für den Betrieb heißt

Kein Handel. Der nächtliche Optimierer läuft weiter und sucht mit nächtlich
neu gewähltem Universum; findet er nichts, bleibt es dabei. Das ist ein
zulässiges Ergebnis (§0.9), und es ist deutlich billiger als das
Vorgängersystem, das nicht funktioniert, sondern nur viel gehandelt hat.

## 6. Was bewusst fehlt

Keine Charts, keine News, kein Sentiment, keine KI-Erklärung, keine
Prognose, keine Strategie-Parameter je Nutzer. Nichts davon hat im
Vorgänger einen messbaren Beitrag zur Kante nach Kosten geleistet; alles
davon hat Zeit gekostet. Wer eines davon zurückholt, muss zuerst zeigen,
dass es out-of-sample nach Kosten etwas ändert — siehe VALIDIERUNG.md.

Multi-User und Frontend bleiben — aber nur als Hülle: Login, Broker-Keys,
Risiko-Einstellungen, Positionen, Historie, Status. Die Handelsentscheidung
kommt für alle Nutzer aus demselben Champion und demselben `decide()`.
