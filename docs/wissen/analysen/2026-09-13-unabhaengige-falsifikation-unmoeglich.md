# Die unabhängige Falsifikation ist nicht schwer — sie ist unmöglich, um 18 Tage

**Lauf:** #64 (`--as-of 2022-10-01`, abgebrochen) ·
**Vorregistrierung:** `2026-09-13-basis-v4-unabhaengige-falsifikation.md`

## Ergebnis: Abbruchkriterium 1

Vorregistriert stand: „Reicht der IEX-Feed nicht so weit, ist das Ergebnis
*nicht messbar*, und es wird NICHTS über die Basis geschlossen."

Genau das ist eingetreten. Der Optimierer brach ab:

> Walk-Forward braucht mindestens 3 Folds, möglich: 2. Daten: 795 Tage
> (Holdout 180); je Fold 365 IS + 90 OOS Tage, Schritt 90 ⇒ mindestens
> 815 Tage nötig.

**Über die Basis ist aus diesem Lauf nichts gesagt.** Er sagt etwas über den
Datenbestand.

## Der Anker-Fix hat funktioniert

Nebenbefund, und ein guter: Der `fetch`-Anker aus PR #488 tat im ersten
Einsatz genau, was er sollte.

```
Fenster: 2000 Tage ab 2017-04-09 (Anker: letzter Handelstag 2022-09-30)
Backfill 1Day (all, vollständig): 50 Symbole, 2017-04-09 → 2026-09-11
```

Angefragt wurde ab 2017-04-09, sauber am letzten Handelstag vor dem Stichtag
ausgerichtet. Geliefert hat der Feed trotzdem erst ab **2020-07-27** — das
ist keine Frage des Ankers, sondern die Grenze der Daten.

## Die Rechnung

Bereinigte IEX-Tagesbars gibt es für diesen Korb ab **2020-07-27**, also
2 237 Tage bis zum Datenende. Die OOS-Kette des Hauptlaufs (#63) beginnt am
**2022-04-05**. Eine zweite Kette, die sie nicht berührt, braucht:

* einen Stichtag **≤ 2022-10-02**, damit ihr OOS vorher endet
  (`selectionEnd = dataEnd − 180`), und
* einen Stichtag **≥ Datenbeginn + 365 IS + N×90 OOS + 180 Holdout**, damit
  die Daten reichen.

| Folds | braucht | Stichtag müsste | |
|---:|---:|---|---|
| 2 | 725 Tage | ≥ 2022-07-22 und ≤ 2022-10-02 | möglich |
| **3** | **815 Tage** | ≥ 2022-10-20 und ≤ 2022-10-02 | **unmöglich, es fehlen 18 Tage** |
| 4 | 905 Tage | ≥ 2023-01-18 und ≤ 2022-10-02 | unmöglich, 108 Tage |
| 8 | 1 265 Tage | ≥ 2024-01-13 und ≤ 2022-10-02 | unmöglich, 468 Tage |

Der Optimierer verlangt mindestens 3 Folds; meine Vorregistrierung verlangt
mindestens 8. Beides ist mit diesem Feed nicht zu haben.

**Prüferbefund M4 ist auf dieser Datenquelle nicht erfüllbar.** Nicht teuer,
nicht aufwendig — arithmetisch ausgeschlossen, und bei 3 Folds um ganze
18 Tage.

## Was das für die Basis heißt

Nichts Gutes, und zwar unabhängig davon, wie gut die Zahlen aus #63 aussehen.

Die Basis hat ihre Latte **auf genau einem Zeitfenster** genommen. Dass sie
sie genommen hat, ist sauber gemessen (Vergleich mit einer Änderung,
Abbruchkriterium vorher festgelegt, alle vier Erwartungen gehalten). Aber es
gibt auf dieser Datenquelle keine Möglichkeit zu prüfen, ob das Ergebnis ein
Zeitfenster oder eine Eigenschaft ist — und das Fenster enthält weder den
Corona-Crash noch den Einbruch von 2018 vollständig.

Nach §0.9 und nach der Vorregistrierung selbst ist das ein Argument **gegen**
eine Aktivierung, nicht dafür. „Wir konnten es nicht widerlegen" und „wir
konnten nicht versuchen, es zu widerlegen" sind nicht dasselbe.

## Die Wege, die es gäbe

Keiner davon ist eine Messentscheidung, alle drei sind Owner-Entscheidungen:

1. **Mehr Historie kaufen.** Mit dem SIP-Feed (`broker.feed: sip`) reicht die
   Historie weit genug zurück; das ist ein bezahltes Datenabo. Damit wäre M4
   normal erfüllbar — und nebenbei jede künftige Messung belastbarer.
2. **Anders unabhängig prüfen: anderer Korb, gleiches Fenster.** Dieselbe
   Regel auf einen zweiten, disjunkten Satz Anlageklassen-ETFs. Das ist keine
   zeitliche Unabhängigkeit, aber eine echte — und sie ist mit den
   vorhandenen Daten möglich. Zählt als eigener Versuch (§4a) und gehört
   vorher registriert.
3. **Es dabei belassen.** Die Basis bleibt aus, der Befund steht in der
   Bibliothek, und das Thema ruht, bis eine der ersten beiden Optionen
   kommt.

Was NICHT infrage kommt: die Fold-Geometrie verkleinern (IS kürzer, OOS
kürzer), bis die zweite Kette „passt". Das würde die Latte senken, um ein
Ergebnis zu bekommen — genau der Fehler, gegen den der ganze Neubau gebaut
ist.
