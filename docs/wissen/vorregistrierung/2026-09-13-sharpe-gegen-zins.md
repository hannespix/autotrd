# Vorregistrierung: Sharpe und PSR gegen den risikolosen Zins

**Datum:** 13.09.2026 · **Auslöser:** Befund B2 aus
`analysen/2026-09-12-vigilant-erstmessung.md` · **Status vor dem Lauf:** offen
**Geschrieben, BEVOR ein einziger Wert mit Zins nachgerechnet wurde.**

Dies ist eine Vorregistrierung über die **Messung**, nicht über eine
Strategie. Sie ist nach §4a genauso pflichtig wie eine neue Familie: Wer die
Latte verschiebt, während er schon Zahlen sieht, misst sich selbst.

---

## 1. Der Messfehler

`probabilisticSharpe` rechnet mit `sr0 = 0` (`src/backtest/metrics.ts`), und
`beats_market` vergleicht zwei so gerechnete Sharpe-Werte. Beide messen
damit **Ertrag über NULL je Schwankung**, nicht Ertrag über den risikolosen
Zins. Der Lehrbuch-Sharpe ist `E[r − r_f] / σ(r − r_f)`; mit `r_f = 0`
gemessen ist jede Zahl um `r_f / σ` zu gut.

Solange nur Aktien im Korb sind, ist der Fehler klein gegen die eigene
Schwankung und für alle Kandidaten gleich. Seit dem 12.09.2026 steht **BIL**
(Geldmarkt, 1–3 Monate T-Bills) im Kandidatenpool und im Korb des Sleeves
`vigilant_allocation`. Ein Geldmarktpapier trägt bei `broker.adjustment: all`
genau den kurzen Zins samt Ausschüttungen und schwankt fast nicht. Gegen
einen risikolosen Zins von null gemessen hat reines Halten von Bargeld damit
einen **hohen Ertrag je Schwankung — Bargeld wird als Kante verbucht.**

Heute fällt das kaum auf: Der Sleeve ist im Alpha-Pfad nur zu rund einem
Zehntel investiert, und der Simulator verzinst freie Kasse nicht. Es kippt,
sobald das Volatilitätsziel (`src/risk/volziel.ts`) den Sleeve hochskaliert:
Dann bekommt der Sharpe einen Anteil geschenkt, den es nicht gibt — niemand
leiht sich Geld zum risikolosen Satz.

## 2. Der Mechanismus der Änderung

1. **Zinsreihe aus eigenen Daten.** Keine externe Quelle, keine neue
   Abhängigkeit: Die Tagesrendite des Geldmarkt-Symbols (BIL) **ist** der
   kurze Zins je Tag. `riskFreeFromBars()` in `src/backtest/metrics.ts`
   bildet daraus eine Abbildung Tagesschlüssel → Satz, über die GANZE
   Bar-Reihe (nicht nur das Fenster), damit auch der erste Tag eines Fensters
   einen Vortagesschluss hat.
2. **Ausrichtung taggenau.** `alignRiskFree(tagesachse, reihe)` legt die
   Sätze auf die Tagesachse der zu bewertenden Renditen — gleiche Tage,
   gleiche Länge. `excessReturns()` **wirft** bei Längenversatz, statt still
   um einen Tag zu verrutschen. Ein Versatz um einen Tag wäre ein neuer,
   subtilerer Messfehler als der behobene.
3. **Konfigurierbar, Vorgabe unverändert.** `optimizer.riskFreeSymbol`,
   Default `null`. Per Vorgabe ändert sich NICHTS — sonst verschieben sich
   alle bisherigen Messergebnisse still.
4. **Fehlt die Reihe, wird es laut gesagt.** Ohne konfiguriertes Symbol, ohne
   Kurse oder bei zu vielen Lücken (> 2 % der Tage) fällt die Rechnung auf
   `sr0 = 0` zurück, und die Notiz des Gates sagt das wörtlich. Ein stiller
   Rückfall wäre derselbe Fehler noch einmal.
5. **Beide Seiten gleich.** `beats_market` rechnet Strategie-Sharpe und
   Markt-Sharpe entweder beide mit Zins oder beide ohne. Kann nur eine Seite
   mit Zins gerechnet werden, rechnen BEIDE ohne — und die Notiz nennt den
   Grund. Eine gemischte Rechnung wäre schlimmer als der heutige Zustand.

## 3. Erwartete Wirkung — Richtung und Größenordnung

Analytisch gilt für den annualisierten Sharpe

> ΔSharpe ≈ − (r_f p. a.) / (σ p. a. der bewerteten Reihe)

Über den Messzeitraum 2020-07 … 2026-09 liegt der kurze Zins grob bei 0,05 %
(2020–2021), ~2 % (2022), ~5 % (2023–2024), ~4 % (2025–2026) — im
Durchschnitt der Fenster in der **Größenordnung 2,5 %**. Die genaue Zahl
kommt aus BIL selbst und wird erst im Lauf gemessen; die Vorhersagen unten
sind mit 2,5 % gerechnet und als Größenordnung zu lesen, nicht als Punkt.

Entscheidend ist die **eigene** Schwankung der Reihe. Unsere Kandidaten
werden auf Kontoebene gemessen, und die Konten stehen die meiste Zeit in
Kasse — ihre σ ist winzig, also ist ihr Abschlag riesig:

| Kandidat (Stand 12.09.) | Sharpe heute | σ p. a. (implizit) | Sharpe mit Zins (Erwartung) | Richtung |
|---|---:|---:|---:|---|
| `vigilant_allocation` (#44) | 0,73 | ≈ 0,9 % | **stark negativ**, −2 … −3 | strenger |
| `index_reversal` (#45) | 0,37 | ≈ 1,0 % | **stark negativ**, −2 … −3 | strenger |
| `turn_of_month` (#45) | −0,07 | ≈ 2,0 % | **negativ**, −1 … −1,5 | strenger |
| `momentum_pullback` (#42/#43) | 0,64 | ≈ 7 % (MaxDD 6,67 %) | 0,2 … 0,4 | strenger |
| SPY als Latte (#44/#45) | 0,67 / 0,68 | ≈ 18 % | **0,52 … 0,58** | Latte sinkt |

Daraus folgen die beiden Richtungen, die diese Änderung ausdrücklich hat:

- **Strenger für fast alle.** `probabilistic_sharpe_oos` misst P(wahrer
  Sharpe > 0) auf der OOS-Kette. Mit Zins fällt der Sharpe jeder selten
  investierten Reihe unter null, also fällt der PSR unter 0,5 und reißt die
  Schwelle 0,9 deutlich. Erwartung: **`vigilant_allocation` verliert
  `probabilistic_sharpe_oos` UND `beats_market`** und steht damit bei 7 von
  10 statt 9 von 10. Dasselbe für jeden anderen kassenlastigen Kandidaten.
- **Die Latte sinkt auch.** SPY verliert denselben Abschlag, nur geteilt
  durch seine große σ — also nur rund 0,13 Punkte. Für eine Strategie mit
  σ ≥ σ_Markt wäre `beats_market` danach LEICHTER zu nehmen (sie verliert
  weniger als die Latte). Kein solcher Kandidat existiert heute; entstünde
  einer, siehe Abbruchbedingung 4.

Sicher unverändert bleiben: `oos_trades`, `fold_positive_share`,
`oos_net_profit`, `fold_concentration`, `stress_costs`,
`neighborhood_plateau`, `fee_share` — sie rechnen nicht mit Sharpe. Der
`deflated_sharpe_is` (IS) bleibt in dieser Änderung **ohne Zins**: Er
deflationiert eine Auswahl gegen Auswahlrauschen; die Zinsfrage gehört zur
OOS-Kette und zur Markt-Latte. Wer ihn später auch auf Überschussrenditen
stellt, braucht dafür eine eigene Vorregistrierung.

## 4. Die zweite Hälfte der Wahrheit: unverzinste Kasse

Der Simulator verzinst freie Kasse nicht (geprüft, #44). Solange gegen
`r_f = 0` gemessen wurde, war das eine kleine, konservative Ungenauigkeit.
Mit Zins auf der Messseite wird sie **erstrangig**: Ein Konto, das zu 90 %
in Kasse steht, verdient im Simulator 0 und bekommt zugleich 2,5 % abgezogen.

Zwei Lesarten, beide vertretbar, und es ist ausdrücklich NICHT Teil dieser
Änderung, zwischen ihnen zu entscheiden:

1. **Realistisch:** Der Broker verzinst Bargeld tatsächlich nicht. Dann ist
   die neue Zahl die ehrliche: Wer Kasse hält, verliert real gegen T-Bills,
   und die richtige Antwort ist, die Kasse in BIL zu legen (eine
   Strategie-Änderung), nicht die Messung zu drehen.
2. **Buchhalterisch:** Wer die Messung auf Überschussrenditen stellt, sollte
   die Kasse konsequenterweise mit `r_f` verzinsen. Dann heben sich beide
   Effekte für unverzinste Phasen auf, und übrig bleibt genau die Kante.

**Festgelegt vor dem Lauf:** Diese Änderung macht (1). Lesart (2) wäre eine
Änderung am Simulator (`src/backtest/simulator.ts`) und braucht eine eigene
Vorregistrierung mit eigener Nachmessung. Wer die Zahlen dieses Laufs liest,
liest sie unter (1) — und die Notiz jedes betroffenen Gates nennt den Satz
und seine Quelle, damit niemand das später verwechselt.

## 5. Was als Verschlechterung gilt (Abbruchbedingungen)

Die Änderung gilt als **fehlerhaft** (und wird zurückgenommen oder
korrigiert), wenn eine der folgenden Bedingungen eintritt:

1. **Vorgabe nicht inert.** Mit `riskFreeSymbol: null` weicht irgendein
   Gate-Wert eines bisherigen Laufs ab. Erwartung: bitgleich.
2. **Versatz.** Der gemessene Abschlag eines Kandidaten weicht um mehr als
   den Faktor 2 von `r_f / σ` ab, oder Strategie- und Marktseite verschieben
   sich in verschiedene Richtungen. Beides wäre ein Ausrichtungsfehler.
3. **Der Zins misst sich nicht selbst zu null.** Eine Reihe, die exakt die
   Geldmarktreihe ist, muss mit Zins einen Sharpe von ~0 haben (Beweistest,
   §6). Weicht das ab, ist die Ausrichtung falsch.
4. **Ein Kandidat besteht NEU**, der vorher an `beats_market` scheiterte,
   und zwar allein, weil die Latte gefallen ist (seine eigene σ ist größer
   als die des Marktes). Das ist keine Kante, sondern der Hebel. Ein solcher
   Fall wird im Bericht namentlich genannt und **blockiert die Beförderung**,
   bis geklärt ist, ob die Strategie das Marktrisiko nur gehebelt hat.
5. **Stille Lücken.** Ein Lauf rechnet mit Zins, obwohl die Deckung der Tage
   unter 98 % liegt, oder eine Notiz nennt den Satz nicht.

Ausdrücklich KEINE Verschlechterung ist: dass alle bisherigen Kandidaten
danach schlechter dastehen und `vigilant_allocation` von 9/10 auf 7/10
fällt. Das ist der Zweck. Ein Gate, das Bargeld als Kante durchgelassen hat,
war zu locker; „wir sollten nicht handeln" bleibt ein zulässiges Ergebnis
(§0.9).

## 6. Der Beweis, der vor dem Lauf feststeht

Ein Test auf einer konstruierten Reihe, der beide Zahlen nennt:

> Eine Strategie, die NUR den Geldmarkt hält (Rendite = Zinsreihe, plus
> Rundungsrauschen), hat gegen `sr0 = 0` einen Sharpe **> 5** und gegen den
> Zins einen Sharpe von **≈ 0** (|Sharpe| < 0,1).

Die Zahl steht im Testnamen. Besteht dieser Test nicht, ist die Änderung
nicht gebaut, sondern nur behauptet.

## 7. Was diese Vorregistrierung NICHT erlaubt

- Keine Schwellenänderung. `minPsrOos` bleibt 0,9, `beats_market` bleibt
  „größer als die Latte". Dass mehr Kandidaten fallen, ist das Ergebnis,
  nicht der Anlass für eine neue Schwelle.
- Keine Ausnahme für Sleeves mit Geldmarkt. Wer BIL hält, wird mit Zins
  gemessen wie alle anderen.
- Kein Herausrechnen von Geldmarktpapieren aus der Sharpe-Rechnung (die
  zweite in B2 genannte Möglichkeit). Sie wird hiermit verworfen: Sie
  behandelte ein Symbol im Korb anders als die anderen und wäre ein
  Owner-Pfad in der Messung.
