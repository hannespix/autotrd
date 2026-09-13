# Vorregistrierung: EIN Maßstab für alle Gates — Überschuss über dem Zins

**Datum:** 13.09.2026 · **Auslöser:** Lauf #48 (Parken an, `config/parken-1440.yaml`)
**Status vor dem Lauf:** offen · **Art:** Messung, keine Strategie
**Geschrieben, BEVOR ein Wert mit der neuen Rechnung nachgemessen wurde.**

Diese Vorregistrierung ist nach §4a genauso pflichtig wie eine neue Familie:
Wer ändert, WAS gemessen wird, während er schon Zahlen sieht, misst sich
selbst. Sie ändert **keine einzige Schwelle**.

---

## 1. Der Messfehler, den wir heute selbst eingebaut haben

Seit dem Parken brachliegender Kasse im Geldmarkt
(`vorregistrierung/2026-09-13-kasse-in-den-geldmarkt.md`) sehen in Lauf #48
alle Kandidaten dramatisch besser aus. Der Beweis steht in der Fold-Tabelle
von `mean_reversion`:

| Fold | OOS-Trades | OOS-Netto |
|---|---:|---:|
| 2 | **0** | **+95,93** |
| 11 | **0** | **+134,31** |
| 13 | **0** | **+227,50** |

Drei Quartale **ohne einen einzigen Trade** zählen als positive Folds;
`fold_positive_share` steht bei 16 von 16. Das Gate fragt „hat die Strategie
in diesem Quartal verdient?" und beantwortet seit heute „hat das KONTO
verdient?". Das Konto verdient den Geldmarktzins, egal was die Strategie tut.

Der Beleg, dass es ein Artefakt und keine Kante ist, steht im selben Lauf:
`probabilistic_sharpe_oos` und `beats_market` rechnen seit dem 13.09.2026 auf
Überschussrenditen und fallen bei JEDEM Kandidaten weiterhin durch. Die
Gates, die den Überschuss messen, lehnen ab; die Gates, die das rohe Netto
messen, bestehen plötzlich.

## 2. Das Prinzip

> **Jede Gate-Kennzahl misst den Überschuss über dem risikolosen Zins.**
> Was ein Geldmarktpapier ohnehin abwirft, ist keine Leistung der Strategie
> und darf in keiner Kennzahl als solche erscheinen.

Der Überschuss einer Reihe ist `r_i − r_f,i` **derselben Tage**
(`excessReturns`, `alignRiskFree` — beide seit 13.09.2026 im Baum). Aus ihr
entsteht eine Überschuss-Kurve `E₀ · Π(1 + r_i − r_f,i)`; ihr Endstand minus
`E₀` ist das **Überschuss-Netto** eines Fensters. Alle Geld-Kennzahlen der
Gates entstehen ab jetzt daraus.

Drei Regeln, die dabei nicht verhandelbar sind:

1. **Ohne Zinsreihe bleibt alles wie heute.** Per Vorgabe
   (`optimizer.riskFreeSymbol: null`) ändert sich nichts — bitgleich.
2. **Parken AN und Zinsreihe FEHLT ist ein Abbruch, kein Rückfall.** Das ist
   der gefährlichste Zustand überhaupt: Der Simulator schreibt dem Konto den
   Zins gut, und keine Kennzahl zieht ihn ab. Der Lauf scheitert dann laut.
3. **Beide Seiten oder keine.** Wo eine Kennzahl einen Maßstab hat
   (`beats_market`, `basis_sharpe`), wird der Maßstab aus SEINER Reihe neu
   gerechnet, nie aus einem fertigen Wert korrigiert. Eine gemischte Rechnung
   wäre schlimmer als der heutige Fehler.

## 3. Was umgestellt wird — und was ausdrücklich nicht

### Umgestellt (Geld-Kennzahlen der Gates)

| Gate | bisher | ab jetzt |
|---|---|---|
| `fold_positive_share` | Anteil Folds mit rohem Netto > 0 | Anteil Folds mit **Überschuss-Netto** > 0 |
| `oos_net_profit` | Σ rohes Fold-Netto | **Σ Überschuss-Netto je Fold** |
| `fold_concentration` | größtes rohes Fold-Netto / Σ | **größtes Überschuss-Netto / Σ Überschuss** |
| `stress_costs` | Σ rohes Fold-Netto bei Kosten ×1,5 | **Σ Überschuss-Netto** bei Kosten ×1,5 |
| `neighborhood_plateau` (Anteil positiver Nachbarn) | rohes Netto > 0 | **Überschuss-Netto > 0** |
| `basis_net_profit` | rohes Netto und Stress-Netto > 0 | **beide im Überschuss** > 0 |
| `basis_costs` | Gebühren / \|rohes Netto\| | Gebühren / **\|Überschuss-Netto\|** |
| `basis_sharpe` | roher Sharpe gegen rohen Korb-Sharpe | **Überschuss-Sharpe gegen Überschuss-Korb** |

### Unverändert, mit Begründung

- **`probabilistic_sharpe_oos`, `beats_market`** — rechnen bereits auf
  Überschuss (Vorregistrierung vom 13.09.2026).
- **`oos_trades`, `fee_share`** — zählen Trades bzw. Gebühren gegen
  Bruttogewinn AUS TRADES. Eine Treasury-Umschichtung ist kein `Trade`
  (`src/risk/parken.ts`), also stecken weder Parkkosten noch Zinsertrag
  darin. **Erwartung: beide Zahlen ändern sich um exakt 0.** Das ist eine
  Vorhersage und wird geprüft (Abbruchbedingung 3).
- **Profitfaktor** (Bericht, kein Gate) — dieselbe Begründung: Er entsteht
  aus `Trade.netPnl`, nicht aus der Equity. Unverändert.
- **`deflated_sharpe_is`** — bleibt ohne Zins, wie in der Vorregistrierung
  vom 13.09.2026 festgelegt: Er deflationiert eine AUSWAHL gegen
  Auswahlrauschen; die Zinsfrage gehört zur OOS-Kette. Er ist ohnehin nur
  informativ (`dsrIsGate: false`).
- **Die Zielfunktion `objectiveValue`** (Score, OOS-Median, Nachbar-Median) —
  bleibt roh. Sie ist das SUCHkriterium, kein Gate; sie umzustellen änderte,
  welche Parameter gewählt werden, und wäre eine eigene Vorregistrierung.
  Gegen das Artefakt dieses Befundes ist sie bereits immun: `objectiveValue`
  liefert für `trades === 0` **−∞**, ein Quartal ohne Trade kann den Median
  also nie heben.
- **`maxDrawdownPct` — die bewusste Ausnahme.** Siehe §4.

## 4. Der Drawdown bleibt roh (Entscheidung, vor dem Lauf)

`maxDrawdownPct` und damit `exposureNormMaxDD` (`basis_drawdown`) rechnen
weiter auf der **rohen** Equity-Kurve. Begründung:

1. **Ein Drawdown ist eine Kapitalfrage, keine Ertragsfrage.** Er beantwortet
   „wie viel vom Konto war im schlimmsten Moment weg". Genau das messen die
   Notbremsen live (`risk.maxDrawdownPct`, Drawdown-Halt, `risk/limits.ts`) —
   auf echter Equity. Ein Gate, das etwas anderes misst als die Bremse, die
   es absichern soll, ist ein zweiter Entscheidungspfad (§0.1).
2. **Einen Überschuss-Drawdown erlebt niemand.** In einer langen flachen
   Phase fällt die Überschuss-Kurve stetig, obwohl das Konto unverändert
   dasteht. Das wäre das Spiegelbild des heutigen Fehlers, nicht seine
   Behebung: erst wurde Zins als Kante verbucht, dann Stillstand als Verlust.
3. **Der Maßstab zieht sonst nicht mit.** `basis_drawdown` vergleicht gegen
   den MaxDD des liegengelassenen Korbs — eine rohe Kursgröße aus
   `backtest/marktbezug.ts`. Beide Seiten roh ist konsistent; eine Seite
   umzustellen wäre genau die verbotene Mischung.

**Was das für die Vergleichbarkeit heißt** (und im Bericht stehen muss): Der
Drawdown ist ab jetzt die EINZIGE Gate-Größe in roher Kapitalrechnung. Er ist
deshalb nicht mit den Überschuss-Zahlen desselben Berichts verrechenbar —
insbesondere ist „Überschuss-Netto je Einheit Drawdown" keine zulässige
Ableitung. Eine Strategie, die meistens in Kasse steht, zeigt weiter einen
kleinen rohen Drawdown; dagegen hilft nicht der Zins, sondern die
Exposure-Normierung (`exposureNormMaxDD`, Prüfbefund K2), und die bleibt
unangetastet. Zins-Defekt und Exposure-Defekt sind zwei verschiedene Fehler;
dieser Lauf behebt den ersten.

## 5. Erwartete Wirkung — Richtung und Größenordnung

Analytisch: Für ein Fenster von `d` Handelstagen sinkt das Netto um rund
`E₀ · r_f · d/252`. Bei `E₀` = 100 000 $, `r_f` ≈ 4 % p. a. und einem
90-Tage-Fold (≈ 62 Handelstage) sind das **≈ 985 $ je Fold**. Genau in dieser
Größenordnung liegen die drei Artefakt-Folds oben (+96 … +228 $) — sie
kippen also mit Sicherheit ins Negative, nicht knapp.

### Je Gate

| Gate | Richtung | Größenordnung |
|---|---|---|
| `fold_positive_share` | **strenger** | jeder Fold verliert ≈ 1 % des Startkapitals p. a. anteilig; Folds ohne Trade fallen sicher |
| `oos_net_profit` | **strenger** | −(Zahl der Folds) × ≈ 985 $ gegenüber heute |
| `fold_concentration` | **strenger** | Zähler verliert 1×, Nenner k× denselben Abzug ⇒ Quotient steigt |
| `stress_costs` | **strenger** | wie `oos_net_profit` |
| `neighborhood_plateau` | **strenger oder gleich** | nur der Anteil positiver Nachbarn sinkt; der Median-Objective bleibt |
| `basis_net_profit`, `basis_costs` | **strenger** | dieselbe Rechnung auf der durchgehenden Simulation |
| `basis_sharpe` | **richtungsoffen** | beide Seiten verlieren `r_f/σ`; σ_Basis > σ_Korb ⇒ leichter, sonst strenger (derselbe Hebel-Vorbehalt wie in `beats_market`, §5 der Zins-Vorregistrierung) |
| `oos_trades`, `fee_share`, `deflated_sharpe_is`, `basis_drawdown`, `probabilistic_sharpe_oos`, `beats_market` | **unverändert** | exakt 0 |

**Keine Latte wird verschoben.** Die Messung wird strenger, weil sie das
misst, was gemeint war — nicht, weil eine Schwelle steigt.

### Je bisher gemessenem Kandidaten (Lauf #48, Parken an)

Grundlage sind die 16 Folds und die Zahlen, die #48 heute zeigt.

| Kandidat | heute | Erwartung nach der Umstellung |
|---|---|---|
| `mean_reversion` | 16/16 Folds positiv, mindestens 3 davon ohne Trade | **höchstens 13/16**, also ≤ 0,81 — Gate 0,6 evtl. noch bestanden; `oos_net_profit` deutlich kleiner, evtl. negativ |
| `regime_allocation` | selten investiert (MaxDD 2,6 % in #47) | **am stärksten betroffen**: fast das ganze Netto ist Zins ⇒ `oos_net_profit` und `fold_positive_share` kippen, `stress_costs` ebenfalls |
| `cross_sectional_momentum` | am meisten investiert (MaxDD 9,2 %) | **am wenigsten betroffen**, verliert aber ebenfalls ≈ 985 $ je Fold |
| `momentum_pullback`, `trend_donchian` | dazwischen | Fold-Anteil und Netto sinken, Konzentration steigt |
| **Gesamtzahl bestandener Gates** | — | **kein Kandidat besteht nach der Umstellung MEHR Gates als vorher** — das ist die Kernvorhersage |
| **Beförderung** | keiner (PSR/beats_market rot) | **weiterhin keiner.** Die zwei roten Gates bleiben rot; es kommen welche dazu |

## 6. Woran diese Änderung SCHEITERT (Abbruchbedingungen)

Sie gilt als fehlerhaft und wird zurückgenommen oder korrigiert, wenn:

1. **Die Vorgabe ist nicht inert.** Mit `riskFreeSymbol: null` weicht
   irgendein Gate-Wert eines bisherigen Laufs ab. Erwartung: bitgleich.
2. **Irgendein Gate wird leichter**, außer `basis_sharpe` (dort ist die
   Richtung oben ausdrücklich als offen deklariert). Ein Kandidat, der nach
   der Umstellung MEHR Gates besteht als vorher, ist ein Fehler in der
   Rechnung — nicht ein Befund.
3. **`oos_trades` oder `fee_share` bewegen sich.** Sie dürfen sich um exakt 0
   ändern; jede Abweichung hieße, dass Parkfills doch als Trades gebucht
   werden (§0.6) oder dass die Umstellung an eine Trade-Kennzahl gerät.
4. **Ein Fold ohne Trade zählt weiterhin als positiv.** Der Wächter dazu
   trägt genau die Zahlen der Tabelle in §1.
5. **Ein Lauf rechnet still weiter**, obwohl das Parken an ist und keine
   Zinsreihe vorliegt. Dieser Zustand muss laut scheitern.
6. **Strategie und Maßstab werden verschieden gerechnet.** Eine einzige
   Kennzahl, bei der eine Seite Überschuss und die andere roh ist, macht die
   Änderung schlimmer als den behobenen Fehler.

Ausdrücklich KEINE Verschlechterung ist: dass alle Kandidaten aus #48 danach
schlechter dastehen und mehr Gates rot sind. Das ist der Zweck. „Wir sollten
nicht handeln" bleibt ein zulässiges Ergebnis (§0.9).

## 7. Was diese Vorregistrierung NICHT erlaubt

- Keine Schwellenänderung. `minFoldPositiveShare`, `maxFoldNetShare`,
  `minOosTrades`, `minPsrOos`, `FEE_SHARE_MAX`, `optimizer.basis.*` bleiben,
  wie sie sind.
- Kein Umstellen der Zielfunktion (`objectiveValue`) und des
  `deflated_sharpe_is` — beide bräuchten eine eigene Vorregistrierung.
- Kein Umstellen des Drawdowns (§4). Wer ihn später doch auf Überschuss
  stellen will, schreibt dafür eine eigene Vorregistrierung und misst neu.
- Keine Ausnahme für eine Strategie, die selten investiert ist. Wer die
  Kasse hält, wird mit Zins gemessen wie alle anderen.
