# Ensemble E1: die Korrelation hielt, die Umsetzung hat beide Sleeves ausgehungert

**Lauf:** #67 (`config/ensemble-1440.yaml`, E1 gleichgewichtet) ·
**Vorregistrierung:** `2026-09-12-ensemble.md` · **Versuch 1 von 6**

## Ergebnis: nicht bestanden, 7 von 10 Gates rot

`fold_positive_share`, `oos_net_profit`, `stress_costs`,
`neighborhood_plateau`, `probabilistic_sharpe_oos`, `fee_share`,
`beats_market`.

Das ist nicht knapp. Es ist deutlich schlechter als **jeder der beiden
Sleeves allein**.

| | Aktien-Sleeve (`momentum_pullback`) | Defensiv-Sleeve (`vigilant_allocation`) |
|---|---|---|
| allein | +2 240,51 · 496 Trades · **8/10** Gates | +432,08 · 27 Trades · **9/10** Gates |
| in E1 | **+160,66 · 71 Trades** · Gebühren 139,73 | **−231,56 · 21 Trades** |

E1 gesamt: roh +1 072,86 (4,26 % über die ganze Kette), Sharpe −0,78,
1,9 Trades je Monat, **Gebührenanteil 188 %**.

Zum Maßstab, damit nichts durcheinandergeht: Diese Config misst die Gates auf
dem ÜBERSCHUSS über BIL, die Solo-Läufe #42/#44 auf dem rohen Netto. Der
Vergleich oben ist trotzdem sauber, weil er die ROHEN Zahlen beider Seiten
nimmt: +1 072,86 für das Ensemble gegen +2 240,51 für seinen eigenen besten
Sleeve allein. **Das Ensemble halbiert den Gewinn seiner besten Komponente.**

## Was NICHT die Ursache ist

Die vorregistrierte Kernannahme hat gehalten:

> Erwartung 2: Die Durchschnittskorrelation der Sleeves liegt unter 0,5.

Gemessen: **0,39.** Die beiden Quellen sind tatsächlich weitgehend
unabhängig. Die Diversifikationsthese ist nicht widerlegt — sie kam gar
nicht zum Tragen.

## Was die Ursache ist

Der Bericht benennt sie selbst:

> „In EINER Simulation trägt ein Symbol genau EINE Strategie — live genauso,
> eine Position mit einem Stop (§0.6)."

Drei Engpässe, die alle aus „ein Konto, ein Positionslimit" folgen:

1. **Symbolentzug.** Das feste Universum des defensiven Sleeves (SPY, QQQ,
   EFA, EEM, IEF, TLT, LQD, GLD, BIL) überschneidet sich mit dem
   30er-Korb in **sechs** Symbolen: EFA, GLD, LQD, QQQ, SPY, TLT. Die gehören
   im Ensemble dem defensiven Sleeve — der Aktien-Sleeve läuft also auf einem
   kleineren Korb als in seiner Solo-Messung.
2. **Kapitalhalbierung.** Gleichgewichtung heißt 50 % je Sleeve. Die
   Positionen des Aktien-Sleeves sind halb so groß, die Gebühren je Trade
   aber nicht halb so hoch — daher der Gebührenanteil von 188 %.
3. **Platzteilung.** Vier Plätze, zwei Sleeves, im Mittel zwei Plätze je
   Sleeve statt vier. Der Aktien-Sleeve kommt auf 71 statt 496 Trades.

Jeder Engpass für sich wäre verkraftbar. Zusammen machen sie aus einem
Kandidaten mit 8/10 Gates einen mit 15 % Netto-Anteil und einem
Gebührenanteil über 100 %.

## Die vorregistrierten Erwartungen

| # | Erwartung | Ergebnis |
|---|---|---|
| E1 | `fold_positive_share` steigt von 0,500 auf ≥ 0,61 | **widerlegt** — 0,313 im Überschuss (roh 8 von 16, also 0,50: unverändert) |
| 2 | Durchschnittskorrelation < 0,5 | **bestätigt** — 0,39 |
| 3 | Ensemble-Sharpe über dem besten Einzel-Sleeve | **widerlegt** — −0,78 gegen 0,73 |
| 4 | Ensemble-MaxDD unter dem schlechtesten Einzel-Sleeve | **widerlegt** — 6,80 % gegen 6,31 % |
| 5 | `fold_concentration` fällt | nicht aussagekräftig (Überschuss nicht positiv) |

Vier von fünf auswertbaren Erwartungen widerlegt, und die eine, die hielt,
ist ausgerechnet die, auf der die ganze These steht.

## Warum ich E2 und E3 NICHT einfach hinterherfahre

Die Vorregistrierung nennt sechs Einheiten als Obergrenze, nicht als Pflicht.
Und die drei Engpässe oben werden mit jedem weiteren Sleeve **schlimmer, und
zwar bauartbedingt**:

* E2 (3 Sleeves) teilt dieselben vier Plätze durch drei, dasselbe Kapital
  durch drei, und `index_reversal` läuft auf Index-ETFs — also noch mehr
  Überschneidung mit dem 30er-Korb.
* E3 (4 Sleeves) nimmt zusätzlich `turn_of_month`, dessen Solo-Messung schon
  einen Gebührenanteil von **244 %** hatte (Lauf #45).

Fünf weitere Läufe zu fahren, deren Ergebnis aus dem gerade gemessenen
Mechanismus folgt, wäre Beschäftigung, keine Messung. **Versuch 1 von 6 ist
gezählt; 2 bis 6 bleiben ungefahren, bis der Engpass beseitigt ist** — sonst
messe ich dreimal dasselbe.

## Was zu entscheiden wäre, bevor es weitergeht

Keiner dieser Punkte ist eine Parameterfrage; alle drei ändern, was live
passiert, und gehören deshalb vorregistriert und vom Owner entschieden:

1. **Mehr Plätze für eine Ensemble-Einheit** (`maxOpenPositions` je Sleeve
   statt je Konto). Ändert das Risiko des Kontos — mehr gleichzeitige
   Positionen bei gleichem Brutto-Deckel.
2. **Disjunkte Universen erzwingen.** Der defensive Sleeve bekäme Symbole,
   die im 30er-Korb nicht vorkommen können (z. B. nur Anleihen und
   Geldmarkt). Dann entfällt der Symbolentzug.
3. **Gebührenschwelle je Trade.** Eine Position, deren erwartete Gebühren
   einen festen Anteil ihres Risikobudgets überschreiten, wird nicht
   eröffnet. Das ist die direkteste Antwort auf „zu Tode gehandelt"
   (CLAUDE.md §2) und wirkt auch außerhalb von Ensembles.

Mein Vorschlag wäre (2) zuerst — es ist der einzige der drei, der nichts am
Risiko des Kontos ändert und den Engpass trotzdem an der Wurzel trifft.
