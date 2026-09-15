# Die Papier-Erprobung handelt selten — und würde beim Handeln verlieren

**Gefunden am 15.09.2026**, nachdem die Plattform zwei Handelstage lang keinen
Einstieg gemacht hatte und der Owner zweimal nachfragte. Kein neuer Lauf
nötig: Die veröffentlichten Parameter (`meta/champion`, Artefakt aus Lauf
34916636083) und die Exit-Anatomie desselben Berichts beantworten beides.

## Frage 1 — warum kein Einstieg?

Der Kandidat der Erprobung, Parameter wörtlich aus `champion.erprobung`
(für alle 30 Symbole derselbe Satz):

```
momentum_pullback   fast 30 · slow 100 · rsiLen 6 · rsiEntry 35
                    rsiExit 65 · exitOnRsi 1 · atrMult 4 · rrMult 2.5
                    trailMult 1 · useBenchmarkFilter 0 · allowShort 0
```

Ein Einstieg verlangt an derselben Bar `EMA30 > EMA100`, `Close > EMA100`
UND einen RSI(6), der von unter 35 auf ≥ 35 kreuzt. Die zwei Bedingungen
stehen gegeneinander: In einem sauberen Aufwärtstrend fällt RSI(6) selten
unter 35, und wenn er es tut, liegt der Kurs oft schon unter der EMA100.

Der Bericht misst die Folge für genau diesen Satz: **9,7 Trades je Monat**
über den ganzen 30er-Korb — einer alle zwei Handelstage. **Zwei stille Tage
sind der Normalfall, kein Defekt.** Belegt ist das inzwischen auch direkt:
kein Fehler, keine Einstiegssperre, Takt fehlerfrei über sechseinhalb
Stunden (Cloud Logging, 15.09., 13:30–20:00 UTC).

Damit das nie wieder eine Blackbox ist, sagt das Symbolprofil seit PR #506 je
Symbol, ob heute ein Einstieg anliegt — das Urteil wörtlich aus `decide()`.

## Frage 2 — und wenn er handelt?

Exit-Anatomie derselben OOS-Kette, 516 Trades über 4,5 Jahre:

| Ausstiegsgrund | Trades | Anteil | Trefferquote | Netto Σ ($) | Ø je Trade ($) | Ø Bars |
|---|---|---|---|---|---|---|
| Ziel (Limit) | 51 | 10 % | 90 % | +2 253,96 | +44,20 | 2,4 |
| Signal (Strategie sagt raus) | 286 | 55 % | 76 % | +6 252,69 | +21,86 | 3,1 |
| Trailing-Stop | 104 | 20 % | 34 % | −959,68 | −9,23 | 5,8 |
| **Stop (Erstmarke)** | **75** | **15 %** | **0 %** | **−8 155,77** | **−108,74** | 3,8 |
| **Summe** | **516** | | | **−608,80** | | |

**Die geschlossenen Trades verlieren.** Das OOS-Netto des Laufs (+814,55 $)
ist positiv, die Summe der Trade-Ergebnisse ist es nicht — die Differenz
stammt nicht aus dem Handel.

Die Asymmetrie ist das Problem, nicht die Trefferquote: Der mittlere Gewinner
bringt +16 bis +44 $, der mittlere gestoppte Verlierer kostet −109 $. Bei
76–90 % Treffern auf den gewinnenden Ausstiegsgründen reicht das trotzdem
nicht.

Dazu `fee_share = 219,2 %`: Die Gebühren fressen mehr als den doppelten
Bruttogewinn — wörtlich die Krankheit des Vorgängersystems (CLAUDE.md §2).

## Der Denkfehler, den ich fast aufgeschrieben hätte

Mein erster Reflex war „dann eben seltener handeln". Das repariert
`fee_share` **nicht**:

```
fee_share = Gebühren gesamt / Bruttogewinn gesamt
```

Beide Größen skalieren mit der Zahl der Trades. Halbiert man die Trades bei
gleicher Verteilung der Bewegungsgrößen, halbieren sich Zähler und Nenner —
das Verhältnis bleibt. **Nur ein größerer Bruttogewinn JE TRADE senkt den
Gebührenanteil**, also eine größere mitgenommene Bewegung.

Was die Messung dazu sagt (MFE/MAE über dieselben 516 Trades):

| Kennzahl | Median |
|---|---|
| Gewinner: größter Buchgewinn (MFE) | 2,43 % vom Einstand |
| Gewinner: Netto | 1,56 % vom Einstand |
| Gewinner: mitgenommener Anteil | 0,75 |
| Verlierer: größter Buchverlust (MAE) | −3,26 % vom Einstand |

Die Taktik holt sich also Bewegungen von rund 1,5–2,5 % über 2–3 Handelstage.
Bei den Kosten dieses Kontos ist das strukturell zu klein — unabhängig davon,
wie gut das Einstiegssignal trifft.

## Warum „Parameter nachziehen" hier keine Erkenntnis wäre

Die naheliegenden Hebel stehen ALLE bereits im Suchraum von
`momentum_pullback` (`src/strategy/momentumPullback.ts`, `paramSpace`):
`exitOnRsi` (der Signal-Exit, der Gewinner abschneidet), `rrMult` (Ziel),
`atrMult` (Erststop), `trailMult` (Trailing). Der Optimierer hat darüber
**2 850 Trials** gefahren und sich für `exitOnRsi: 1`, `atrMult: 4`,
`rrMult: 2.5`, `trailMult: 1` entschieden.

Wer jetzt „den RSI-Exit abschalten" als neue Idee vorschlägt, durchsucht
dasselbe Gitter ein zweites Mal und nennt das Ergebnis Einsicht. Genau
dagegen ist der Neubau gebaut (§2: „Auswahl auf denselben Daten
wiederholt").

**Ein echter Hebel muss AUSSERHALB des durchsuchten Raums liegen.** Übrig
bleiben:

1. **Der Zeitrahmen.** Tagesbars sind gesetzt; Wochenbars sind kein
   Suchparameter. Eine längere Haltedauer entstünde bauartbedingt, nicht
   durch Nachziehen.
2. **Die Familie.** Eine Taktik, die von vornherein auf größere Bewegungen
   zielt, statt Rücksetzer im Drei-Tage-Takt zu handeln.
3. **Die Risikoseite** (`maxPositions`, `riskPerTradePct`) — sie steht in der
   Config, nicht im Suchraum. Sie ändert die Größe je Trade, aber nicht die
   Größe der BEWEGUNG, also auch nicht `fee_share`.

Punkt 3 ist damit ebenfalls erledigt. Es bleiben 1 und 2.

## Status

- **These:** Der Gebührenanteil ist nur über größere mitgenommene Bewegungen
  zu senken, und die sind innerhalb dieser Familie und dieses Zeitrahmens
  nicht zu holen. **Offen** — belegt ist die Rechnung, nicht die Folgerung.
- **Nicht getan:** kein Gate angefasst, keine Schwelle, keine Auswahlregel
  der Erprobung. Der Kandidat bleibt durchgefallen und in `noTrade`.
- **Nächster Schritt:** gehört dem Owner — Zeitrahmen oder Familie. Beides
  wird vorregistriert, bevor gemessen wird (docs/wissen/README.md).

**Lauf:** 34916636083 (18 Folds, 2020-07-27 … 2026-09-14, Korb je Fold).
**Bezug:** Aufgabe #42.
