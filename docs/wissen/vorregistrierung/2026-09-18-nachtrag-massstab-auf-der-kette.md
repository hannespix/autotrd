# Nachtrag zur Vorregistrierung „durchgehende OOS-Kette": Maßstab auf derselben Tagesachse, Beträge der Scheiben auf E₀

**Datum:** 18.09.2026, nach Lauf #22 und dem Prüfbericht
`pruefungen/2026-09-18-red-team-durchgehende-kette.md` (M2, G5, G6, G8) ·
**Art:** Messung, keine Strategie, keine Schwelle · **Status vor dem Lauf:** offen
**Geschrieben, BEVOR ein Lauf mit dieser Rechnung stattfand** (erster Lauf:
der nächtliche #23, 18.09.2026 23:00 UTC).

## 1. Was der Prüfer gefunden hat

- **M2:** Seit die Strategie-Kette durchgehend läuft, hat sie an jedem
  Fold-Übergang eine echte Tagesrendite; der Maßstab für `beats_market`
  (`marktKette`/`marktReihe`) kauft weiter JEDES Fenster frisch und kennt
  diese Übergangstage nicht (18 von 1 112 Tagen fehlen ihm). Zwei
  Sharpe-Werte über verschiedene Tagesmengen stehen in einem Gate; die
  Größenordnung liegt bei ±0,06 Sharpe p. a., csms Abstand zur Latte in #22
  war 0,096.
- **G5:** Die Trades der Scheiben stehen in Dollar des einen Buchs, das
  Fold-Netto daneben ist auf E₀ normiert. `fee_share` (Σ Gebühren / Σ Brutto
  der Trades) ist damit equity-gewichtet — ein Kandidat, der spät gewinnt,
  bekommt einen größeren Nenner als einer, der früh gewinnt, bei gleichen
  Renditen. Klein, aber pfadabhängig; ein Gate sollte nicht davon abhängen,
  in welcher Reihenfolge die Folds kamen.
- **G6/G8:** Lesefallen im Bericht (echte Dollar neben normierten Summen;
  Fold-Tabelle „OOS-Trades" zählt nach Ausstiegszeit; Fußnote der Aktivität
  veraltet; `unmanaged`-Trades nicht ausgewiesen).

## 2. Was sich ändert

1. **Maßstab auf der Tagesachse der Kette** (`marktKetteAufAchse` in
   `backtest/marktbezug.ts`): Unter `oosChain: continuous` wird der
   Benchmark auf GENAU den Handelstagen der Strategie-Kette (`wfa.oos.dayKeys`)
   gerechnet — ein Kauf zum Schluss des ersten Tages (Tag 1: Kasse, Rendite 0,
   wie die Strategie an ihrem ersten aktiven Tag: entschieden wird am
   Schluss, gefüllt am nächsten Open), danach nichts; fehlt dem Benchmark ein
   Tag der Achse, gilt sein letzter Kurs (Rendite 0). Gleiche Länge, gleiche
   `dayKeys`, gleiche Zinsreihe — Wächter im Gate: Weicht die Achse des
   Maßstabs von der Kette ab, gilt `beats_market` als nicht berechenbar und
   durchgefallen (fail-closed, laut). `per_fold` behält den Maßstab je
   Fenster (Spiegelbild der alten Kette).
2. **Beträge der Scheiben auf E₀** (`kettenScheiben`): `grossPnl`, `fees`,
   `netPnl` jedes Trades und `unrealisiert` der am Kettenende offenen
   Positionen werden mit demselben Faktor E₀/E_Start skaliert wie die
   Equity der Scheibe. Damit sind Fold-Netto, Trades, Exit-Anatomie,
   K4-Zeile und `fee_share` EINE Rechnung („jeder Fold ab E₀"). Stückzahlen
   und Kurse bleiben, was gehandelt wurde. Bei `per_fold` ist der Faktor 1.
3. **Bericht:** K4-Zeile nennt die ganze Kette (E₀ × Rendite) und dass die
   Beträge je Fold ab E₀ zählen; Fold-Tabelle „OOS-Trades (Exit im Fold)";
   Fußnote der Aktivität je Modus; `oos_trades` nennt die `unmanaged`-Trades.

**Unverändert:** alle zehn Gates und Schwellen, Regel 2, Suche, Korb je
Fold, Stress, Nachbarschaft, DSR, Erprobung. Die Tagesrenditen der Kette
(PSR, Sharpe, `fold_positive_share`, `oos_net_profit`, `fold_concentration`,
`stress_costs`) ändern sich durch Punkt 2 NICHT — Renditen sind Quotienten.

## 3. Erwartungen — vor dem Lauf, falsifizierbar (Lauf #23, Raster −1 hat die Fold-Fenster von #22 Raster −0)

1. **Gleiche Kette:** csm auf #23 Raster −1 hat denselben OOS-Sharpe p. a.
   wie auf #22 Raster −0 (0,55, Überschuss) und dieselben Fold-Parameter —
   Punkt 1 und 2 ändern keine Rendite. (Erwartung 5 der Regel 2 mitgeprüft.)
2. **Latte:** Die SPY-Latte von csm auf #23 Raster −1 weicht von 0,456 (#22
   Raster −0, je Fenster) um höchstens 0,10 ab, und ihre Notiz nennt
   „über die OOS-Kette (1112 Handelstage, durchgehend)" mit derselben Tagezahl
   wie die Zinsnotiz.
3. **`fee_share`:** csm 15,7 % → Δ höchstens 3 Prozentpunkte; regime 6,7 %,
   td 23,0 % ebenso. Kein `fee_share` kippt allein durch die Skalierung.
4. **Kein Gate wird durch diesen Nachtrag zusätzlich bestanden, außer
   `beats_market` könnte in beide Richtungen kippen** — Richtung nicht
   vorhergesagt. Kippt es bei csm (0,552 gegen neue Latte), steht das im
   Ergebnis, ohne Bewertung.
5. **`per_fold`:** unverändert (Wächter im Code).

## 4. Wächter (jeder einmal absichtlich gebrochen)

- Maßstab: Achse = Achse der Kette (Länge und `dayKeys`), Tag 1 = 0, Sharpe
  der Achsenreihe = Sharpe der Kursreihe mit führender Null; Gate fällt laut,
  wenn die Achsen abweichen; `per_fold` behält `marktReihe` je Fenster.
- Scheiben: Σ `netPnl` der skalierten Trades einer Scheibe = Netto der
  Scheibe (Fake, dessen Equity nur durch Trades wächst); `per_fold`
  unskaliert; mit dem echten Simulator Fold 1 bitgleich (Faktor 1).

## 5. Abbruch

Reißt Erwartung 1, ist der Nachtrag fehlerhaft (er hätte Renditen geändert)
und wird zurückgenommen. Erwartung 2 gerissen ⇒ Prüfer: die 18 Übergangstage
wären größer als die Abschätzung.
