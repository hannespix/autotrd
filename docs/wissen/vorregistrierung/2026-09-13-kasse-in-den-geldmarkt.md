# Vorregistrierung: Brachliegende Kasse in den Geldmarkt

**Datum:** 13.09.2026 · **These:** T19 (neu) · **Status vor dem Lauf:** offen
**Owner-Entscheidung** vom 13.09.2026 auf die Frage aus
`analysen/2026-09-13-zins-und-brachliegende-kasse.md`: nicht die Messung
verzinst die Kasse rechnerisch, sondern die Strategie legt sie wirklich an.

## Der Befund, der das auslöst

Läufe #46 und #47 (dieselbe Simulation, einziger Unterschied `riskFreeSymbol`):

| Kandidat | Sharpe ohne Zins | mit Zins | Δ | eigener MaxDD |
|---|---:|---:|---:|---:|
| `regime_allocation` | 0,75 | −1,06 | −1,81 | 2,60 % |
| `cross_sectional_momentum` | 0,73 | 0,12 | −0,61 | 9,18 % |
| SPY | 0,67 | 0,44 | −0,23 | 22,12 % |

ΔSharpe ≈ −r_f/σ. Der Abzug trifft die gering investierten Kandidaten
achtmal härter als den Markt, weil 85 bis 97 Prozent ihres Kapitals
unverzinst herumliegen, während der Maßstab voll investiert ist.

## Die Änderung

Kapital, das keine Strategie braucht, wird in ein Geldmarktpapier gelegt
(BIL) statt als Kasse zu liegen. Das ist **keine Handelsidee**, sondern eine
Treasury-Funktion: Sie erzeugt kein Signal, sie hat kein Kursziel, sie soll
keine Kante haben.

Nicht verhandelbare Eigenschaften, vor dem Bau festgeschrieben:

1. **Sie blockiert nie einen Einstieg.** Will eine Strategie Kapital, wird
   zuerst Geldmarkt verkauft. Eine Treasury-Funktion, die einen Trade
   verhindert, wäre ein Fehler, kein Schutz.
2. **Sie belegt keinen Positionsplatz** und zählt nicht gegen
   `risk.maxPositions`, und sie zählt nicht ins Exposure-Budget, das
   Einstiege deckelt — sonst sperrte sich das Konto selbst aus.
3. **Sie hat keinen Stop und kein Ziel.** Ein Katastrophen-Stop auf einem
   Geldmarktpapier wäre sinnlos und im Crash schädlich.
4. **Sie läuft über `decide()`**, in Backtest und Live identisch (§0.1), mit
   denselben Kosten. Kein Sonderweg im Simulator.
5. **Sie schichtet mit Band, nicht täglich.** Ein Umschichten bei jeder
   kleinen Abweichung wäre genau die Krankheit des Vorgängersystems
   („zu Tode gehandelt"). Vorgabe: erst ab einer Abweichung von 5
   Prozentpunkten der Zielquote, höchstens einmal je Handelstag.
6. **Sie ist per Vorgabe AUS.** Ohne ausdrückliche Config ändert sich nichts.

## Was ich VOR dem Lauf erwarte

| # | Erwartung | widerlegt, wenn |
|---|---|---|
| 1 | Mit Parken steigt der Sharpe jedes gering investierten Kandidaten deutlich, weil die Schleifspur verschwindet | der Anstieg bleibt unter 0,3 Sharpe |
| 2 | Der Sharpe nähert sich dem Wert, den derselbe Kandidat ohne Zins zeigte (dort fehlte die Schleifspur ebenfalls, nur aus dem falschen Grund) | er bleibt mehr als 0,3 darunter |
| 3 | Die Rangfolge der Kandidaten untereinander bleibt im Wesentlichen erhalten | sie kippt |
| 4 | Die Gebühren des Parkens bleiben unter 5 % des Bruttogewinns | darüber — dann frisst die Treasury-Funktion, was sie einbringt |
| 5 | `beats_market` wird für gering investierte Kandidaten fair, nicht leicht: **Kein Kandidat besteht allein durch das Parken alle zehn Gates** | einer besteht plötzlich alle zehn — dann ist zu prüfen, ob das Parken eine Kante vortäuscht |

**Erwartung 5 ist der eingebaute Selbstzweifel.** Das Parken darf eine
Verzerrung entfernen, aber keine Kante erzeugen. Besteht ein Kandidat nach
der Änderung plötzlich alles, ist er NICHT zu befördern, bevor geklärt ist,
warum.

## Warum das keine Schmeichelei ist

Der Sharpe misst Ertrag je Schwankung. Parken skaliert Ertrag und Schwankung
des Kontos gemeinsam — der Überschuss-Sharpe einer Strategie, die ein Zehntel
des Kontos benutzt, ist mit Parken derselbe wie der ihres investierten Teils
allein. Entfernt wird also genau die Verzerrung, die aus der Kontogröße
stammt, und nichts sonst. Die zehn Gates, ihre Schwellen, Kosten und der
Stress ×1,5 bleiben unangetastet.

## Messplan (zwei getrennte Läufe, damit zuordenbar bleibt, was wirkt)

1. **Nur Parken**, Volatilitätsziel aus. Differenz zu Lauf #46 ist sauber die
   Wirkung des Parkens.
2. **Parken plus Volatilitätsziel.** Differenz zu Lauf 1 ist sauber die
   Wirkung des Volatilitätsziels.

Zwei Änderungen gleichzeitig zu messen war der Fehler in Lauf #46; er wird
nicht wiederholt.

## Bekannte Schwächen

- BIL ist kein risikoloser Punkt: Es hat eine Duration von unter drei
  Monaten, einen Spread und einen Kurs, der springen kann. Das Parken kostet
  also echtes Geld und trägt ein kleines Risiko.
- In einem Nullzinsumfeld bringt das Parken nichts und kostet die Gebühren.
  Der Effekt ist zinsabhängig; das gehört zum Befund.
- Das Parken verändert `maxGrossExposurePct` in seiner Bedeutung: Brutto
  gemessen ist das Konto künftig fast immer voll. Deshalb Eigenschaft 2.
