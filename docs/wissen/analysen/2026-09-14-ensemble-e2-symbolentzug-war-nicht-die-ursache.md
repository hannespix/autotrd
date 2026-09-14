# Ensemble E2: disjunkte Universen wirken — und widerlegen meine Diagnose

**Läufe:** Probe #69 (Kontrolle, `main`, `--as-of 2026-09-11`) und #70
(Messung, Branch, derselbe Stichtag) ·
**Vorregistrierung:** `2026-09-14-ensemble-disjunkte-universen.md` inkl.
Nachtrag · **Ensemble-Versuch 2 von 6**

## Die Messung ist diesmal eine Messung

Probe #68 hatte beide Abbruchkriterien ausgelöst (Datenende von 2026-09-11
auf 2026-09-14 gewandert, weil Montag). Der Nachtrag zur Vorregistrierung
hat daraufhin den Stichtag gepinnt und ein **viertes Abbruchkriterium**
hinzugefügt: Der Kontrolllauf auf `main` muss E1 (#67) reproduzieren.

Er tut es — Zeile für Zeile:

```
diff <ohne Titel/Zeitstempel> #67  #69
1a2
> - **Stichtag 2026-09-11** — der Lauf sieht nichts danach
```

Eine einzige Abweichung, und das ist die Zeile, die `--as-of` selbst
einfügt. 778 gegen 779 Zeilen. **Der Apparat reproduziert.** Erst damit ist
der Vergleich #69 ↔ #70 einer.

| Abbruchkriterium | Ergebnis |
|---|---|
| 1 · Alpha verschiebt sich | **nein** — 575 von 575 Zeilen identisch, null Abweichung |
| 2 · Datenbereich weicht ab | **nein** — beide 2020-07-27 … 2026-09-11 |
| 3 · `entzogen` nicht leer | **nein** — leer, der Absatz fehlt im Bericht |
| 4 · Kontrolle reproduziert E1 nicht | **nein** — sie reproduziert ihn |

## Die Änderung wirkt genau wie gebaut

```
Korb (30 Symbole) Ensemble „E1 Aktien plus Defensive": disjunkte Universen
— 9 Symbole den Sleeves zugeteilt, Korb wählt aus 131 statt 140 Kandidaten
```

`entzogen` ist leer, der Korb-Sleeve führt wieder volle 30 Symbole statt 24.
Erwartung 1 bestätigt.

## Und trotzdem passiert nichts

| | A = E1 (#69, Symbolentzug) | B = E2 (#70, disjunkt) |
|---|---|---|
| Korb des Aktien-Sleeves | 24 von 30 (6 entzogen) | **30 von 30** |
| Aktien-Sleeve Trades | 71 | **77** |
| Aktien-Sleeve Netto | +160,66 | −265,54 |
| Aktien-Sleeve Gebühren | 139,73 | 153,56 |
| Defensiv-Sleeve | 21 · −231,56 | 21 · −248,02 |
| OOS-Trades gesamt | 92 | 98 |
| Netto roh | +1 072,86 (4,26 %) | +712,88 (2,71 %) |
| OOS-Sharpe p. a. | −0,78 | −0,90 |
| Folds positiv (roh) | 8/16 | 7/16 |
| Gebührenanteil | 188,1 % ✘ | nicht berechenbar |
| Gates rot | 7 | 6 |
| Korrelation | 0,39 | 0,40 |

**Sechs Trades.** Der Korb wächst um ein Viertel (24 → 30 Symbole), und der
Sleeve handelt sechs Mal mehr. Die vorregistrierte Widerlegungsschwelle lag
bei 150.

## Die Netto-Differenz ist Rauschen, nicht „schlechter"

Es wäre bequem, aus −426,19 $ zu schließen, die Änderung habe geschadet.
Das gibt die Streuung nicht her. Je Fold:

- 7 von 16 Folds sind **ziffernidentisch** (2, 3, 6, 8, 12, 13, 16)
- 9 Folds ändern sich, im Mittel um **304,17 $**
- grösste Einzelverschiebung: **−749,87 $** (Fold 11)
- Standardfehler der Summe: **1 144,22 $**

Die Gesamtverschiebung von −426,19 $ liegt damit bei **0,37
Standardfehlern**. Das ist nicht „schlechter", das ist nicht unterscheidbar.
Wer hier eine Verschlechterung liest, betreibt dieselbe Rosinenpickerei wie
jemand, der aus +426 $ eine Verbesserung gelesen hätte.

Die **Trade-Zahl** dagegen ist ein Zähler, kein Erwartungswert: 71 gegen 77
ist belastbar. Und sie sagt: der Symbolentzug hat den Sleeve nicht
ausgehungert.

## Was daran mein Fehler war — und er sitzt tiefer

Der E1-Befund nannte drei Engpässe. Zwei davon sind mit Zahlen **aus
demselben Bericht** widerlegt, die ich hätte lesen können, statt gegen
einen fremden Lauf zu vergleichen.

### Engpass 1 (Symbolentzug) — widerlegt durch diesen Lauf

Vollständig beseitigt, Wirkung: +6 Trades, 0,37 σ im Netto.

### Engpass 2 (Kapitalhalbierung ⇒ Gebührenanteil 188 %) — widerlegt durch Lauf A selbst

Ich schrieb, 50 % Gewicht halbiere die Positionen, während die Gebühren je
Trade nicht mitskalieren, und daher komme der Gebührenanteil von 188 %.
In **derselben Berichtstabelle** steht `momentum_pullback` als
Einzelkandidat — volle Kasse, voller Korb, alle vier Plätze, dieselben 16
Folds:

| | Gebührenanteil | Trades | Netto | OOS-Sharpe | Gates |
|---|---|---|---|---|---|
| `momentum_pullback` SOLO (volle Kasse) | **254,4 %** | 291 | +593,13 | −0,91 | 4/10 |
| E1 Ensemble (halbe Kasse je Sleeve) | **188,1 %** | 92 | +1 072,86 | −0,78 | 3/10 |

Bei **voller** Kasse ist der Gebührenanteil **höher**. Die Halbierung kann
die 188 % also nicht erklären — die Erklärung war eine Erzählung, die zur
Zahl passte, nicht eine, die sie prüfte.

### Der Vergleichsmaßstab selbst war falsch

Der E1-Befund stellte „allein: +2 240,51 · 496 Trades · 8/10 Gates" gegen
„in E1: +160,66 · 71 Trades" und nannte als Quelle die Solo-Läufe #42/#44.

- Die **defensive** Zeile stimmt: #44 zeigt 27 Trades, +432,08, 9/10. ✔
- Die **Aktien**-Zeile steht so in #42/#43 nicht: dort sind es 572 Trades und
  +3 012,24 — und vor allem über **18 Folds**, nicht über 16.

Der Unterschied in der Foldzahl ist kein Detail, sondern die Ursache: Sobald
ein Ensemble konfiguriert ist, bestimmt der längste Sleeve den Warmup
(`vigilant_allocation`, 12 Monate ⇒ Warmup 255 Bars, Embargo 275). Die Kette
verliert zwei Folds und verschiebt sich. **Ein Solo-Lauf ohne Ensemble misst
eine andere Kette.** Ich habe zwei Zahlen verglichen, die nie denselben
Zeitraum gesehen haben — derselbe Fehlertyp wie beim Bars-Cache am 13.09.,
nur eine Ebene höher.

Auf der Kette, die das Ensemble wirklich läuft, ist der Aktien-Sleeve solo
schon ein Kandidat mit **4 von 10 Gates, Sharpe −0,91 und 254 %
Gebührenanteil**.

## Der Befund

**Das Ensemble hungert seine Sleeves nicht aus. Es erbt eine Strategie, die
auf dieser Kette selbst verliert.** Kein Verteilungsmechanismus — weder
Plätze noch Kapital noch Symbole — macht aus −0,91 Sharpe etwas
Handelbares.

Zu Erwartung 3 und 5 ausdrücklich, weil beide formal anders aussehen als
sachlich:

- `fee_share` steht in B auf ✔, aber die Notiz sagt „nicht berechenbar (kein
  Bruttogewinn) — kein Urteil". Ein **vakantes** Gate ist kein bestandenes.
  Erwartung 3 ist nicht bestätigt, sie ist **nicht auswertbar**.
- Damit stehen formal 4/10 statt 3/10 Gates. Der Zugewinn ist genau dieses
  vakante Gate. **Auf Sachgehalt hat sich kein einziges Gate bewegt** —
  Erwartung 5 gilt als nicht erfüllt. Ich zähle sie nicht als Erfolg, weil
  ich sonst eine kaputte Zahl als Fortschritt verbuchen würde.

| # | Erwartung | Ergebnis |
|---|---|---|
| 1 | `entzogen` leer, Korb wieder voll | **bestätigt** — leer, 30 von 30, aus 131 Kandidaten |
| 2 | Aktien-Sleeve deutlich über 71 Trades (Widerlegung < 150) | **widerlegt** — 77 |
| 3 | Gebührenanteil unter 100 % | **nicht auswertbar** — Gate vakant |
| 4 | Fünf Einzelkandidaten ziffernidentisch | **bestätigt** — 575/575 Zeilen |
| 5 | Mehr Gates als E1 | **formal ja (4 statt 3), sachlich nein** |

## Was jetzt NICHT passiert

Die Vorregistrierung hat den Fall geschrieben, bevor er eintrat:

> Trifft sie nicht zu: Dann war der Symbolentzug nicht die Ursache, meine
> Diagnose war falsch, und das gehört genauso aufgeschrieben. **Kein zweiter
> Anlauf an derselben Stelle, kein Nachbessern an den Zahlen.**

Also: kein E3 mit Plätzen je Sleeve, keine Gebührenschwelle je Trade, keine
dritte Gewichtsregel. Zwei der sechs Ensemble-Versuche sind verbraucht, und
beide sagen dasselbe: Die Ensemble-Frage ist nicht die Frage, an der es
hängt.

## Was mit dem Code passiert — und warum das keine Nachbesserung ist

Die Änderung **bleibt**, obwohl sie nichts verbessert hat. Der Grund ist
nicht das Ergebnis, sondern die Korrektheit der gemessenen Einheit:

- Die Config sagt `maxSymbols: 30`. Vorher wählte die Auswahl 30 Symbole
  nach Liquidität und **strich danach** sechs — gemessen wurden 24. Der
  Bericht warnte selbst davor („Dann ist die gemessene Einheit nicht die
  geplante").
- Jetzt entscheidet dieselbe Auswahlregel auf dem kleineren Pool und liefert
  30. Was die Config verspricht, ist das, was läuft.
- Für die Plattform ist der Unterschied folgenlos: `config/platform.yaml`
  konfiguriert kein Ensemble, und der Alpha-Teil ist ziffernidentisch
  bewiesen.

Wäre das Ergebnis besser ausgefallen, stünde hier dieselbe Begründung. Sie
hängt nicht am Vorzeichen.

## Offen, ausdrücklich nicht beantwortet

Warum der Sleeve mit festen Parametern 71–77 Trades macht, während die
gesuchte Variante auf derselben Kette 291 schafft, ist **nicht geklärt**.
Naheliegend sind die festen gegen die je Fold gesuchten Parameter, aber ich
habe es nicht gemessen, und drei falsche Diagnosen in zwei Tagen sind genug:
Ich schreibe hier keine vierte Vermutung hin, die morgen wie ein Befund
gelesen wird.

Ebenso ungeklärt: Die Sleeve-Zurechnung (+160,66 und −231,56) summiert sich
nicht auf das Gesamt-Netto (+1 072,86). Für die Aussagen oben ist das ohne
Belang — alle verglichenen Grössen sind gleich definierte Grössen desselben
Berichts —, aber es ist eine offene Stelle im Bericht und keine, die ich
wegerkläre.
