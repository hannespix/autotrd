# Der Zins deckt den eigentlichen Defekt auf: brachliegende Kasse (13.09.2026)

Läufe #46 und #47 sind dieselbe Config, dieselben 16 Folds, dieselben
Parameter, dieselbe Simulation — **einziger Unterschied: `riskFreeSymbol`**.
Dass es wirklich dieselbe Simulation ist, belegen identische Drawdowns und
identische Trades je Monat in beiden Läufen.

| Kandidat | Sharpe ohne Zins | Sharpe mit Zins | Δ | eigener MaxDD |
|---|---:|---:|---:|---:|
| `regime_allocation` | 0,75 | **−1,06** | −1,81 | 2,60 % |
| `cross_sectional_momentum` | 0,73 | 0,12 | −0,61 | 9,18 % |
| `momentum_pullback` | 0,16 | −0,91 | −1,07 | 8,26 % |
| `mean_reversion` | 0,28 | −1,26 | −1,54 | 4,34 % |
| `trend_donchian` | 0,12 | −0,75 | −0,87 | 12,27 % |
| Ensemble E1 | 0,30 | −0,78 | −1,08 | 6,81 % |
| **SPY (Maßstab)** | 0,67 | **0,44** | **−0,23** | 22,12 % |

Der Zusammenhang ist eindeutig und war vorhergesagt: **ΔSharpe ≈ −r_f/σ.**
Je kleiner die eigene Schwankung, desto größer der Abzug. SPY schwankt mit
22 % Drawdown und verliert 0,23. `regime_allocation` schwankt mit 2,60 % und
verliert 1,81 — das Achtfache.

## Was das wirklich heißt

Der Zins ist nicht das Problem, er ist das Fieberthermometer. Er macht einen
Defekt sichtbar, der die ganze Zeit da war:

> **Jeder Kandidat wird in einer Aufstellung gemessen, in der 85 bis 97
> Prozent des Kapitals nichts verdienen**, während der Maßstab zu 100 Prozent
> investiert ist.

`regime_allocation` mit 2,60 % Maximaldrawdown benutzt grob ein Zehntel des
Kontos. Die anderen neun Zehntel liegen als Kasse da — und der Simulator
verzinst Kasse nicht, weil der Broker es auch nicht tut. Gegen einen kurzen
Zins von rund vier Prozent sind das etwa −3,5 % pro Jahr Schleifspur auf das
GESAMTE Konto, für eine Strategie, die davon nur ein Zehntel benutzt.

Die Messung beantwortet damit die Frage: „Was passiert, wenn ich mein ganzes
Konto zu diesem Broker trage und die Strategie ein Zehntel davon anfassen
lasse, während der Rest tot herumliegt?" Das ist eine **reale, aber
schlechtestmögliche** Aufstellung — und niemand würde so handeln.

## Die Konsequenz — und sie ist gebaut, nur ausgeschaltet

Zwei Hebel, die beide schon im Code stehen:

1. **Das Volatilitätsziel** (`src/risk/volziel.ts`, seit heute im Baum,
   Vorgabe aus). Es skaliert die Positionen so, dass das Depot eine gewählte
   Schwankung anstrebt. Aus „Sharpe 0,75 bei 2,60 % Drawdown" wird ein
   nutzbarer Ertrag bei einem Drawdown, den man vorher festgelegt hat — der
   Sharpe bleibt dabei unberührt, das Gate wird also nicht geschmeichelt.
2. **Brachliegende Kasse in den Geldmarkt legen.** Was die Strategie nicht
   braucht, gehört nicht auf ein unverzinstes Konto, sondern in BIL. Das ist
   keine Messkorrektur, sondern das, was ein Allokator tatsächlich tut.

Der zweite Punkt ist ein Eingriff in die Strategie und damit
**vorregistrierungspflichtig und eine Owner-Entscheidung**. Die Alternative
wäre, im Simulator die Kasse rechnerisch zu verzinsen — das ist die übliche
akademische Konvention, weicht die Messung aber von der Wirklichkeit ab, in
der das Geld wirklich nichts verdient. Ich halte den ersten Weg für richtig:
nicht die Messung weichzeichnen, sondern das Kapital arbeiten lassen.

## Was NICHT gilt

- **Der Zins wird nicht zurückgenommen.** Ohne ihn wird Bargeld als Kante
  verbucht (Beweiszahl: reiner Geldmarkt zeigt gegen null einen Sharpe von
  46,7). Die Zahlen aus Lauf #47 sind die geschmeichelten, nicht die wahren.
- **Kein Kandidat wird jetzt befördert.** Auch ohne Zins besteht keiner alle
  zehn Gates: `regime_allocation` fällt an `oos_trades` (9/10),
  `cross_sectional_momentum` an Beständigkeit und Konzentration (8/10).
- **Das Ensemble ist als vorregistriert widerlegt** (T14). Die Korrelation
  war mit 0,39 unter der Schwelle, Diversifikation war also möglich — es
  reichte trotzdem nicht: sechs Gates rot, Gebühren 198 % des Bruttogewinns,
  und der defensive Sleeve verlor im Verbund 232 $, während der Aktien-Sleeve
  das Ergebnis trug. In den Bärenmarkt-Folds handelte der Aktien-Sleeve gar
  nicht, und der defensive verlor.

## Offene Entscheidung

Bis sie fällt, ist jede Sharpe-Zahl dieses Repos für gering investierte
Strategien nach unten verzerrt, und für sie alle in gleicher Richtung. Die
Rangfolge unter ihnen bleibt aussagekräftig, der Vergleich mit dem Markt
nicht.
