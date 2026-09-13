# Vorregistrierung: Reservierte Plätze für Diversifizierer im Korb

**Datum:** 13.09.2026 · **These:** T21 (neu) · **Status vor dem Lauf:** offen
**Folgt aus:** `analysen/2026-09-12-warum-nichts-gehandelt-wird.md` (Ursache 3
und 4) und Lauf #43 (`vorregistrierung/2026-09-12-kurzlaeufer-im-pool.md`).

## Der Befund, der das auslöst

Kein Kandidat besteht `fold_positive_share ≥ 0,6` über ein Fenster, das einen
Bärenmarkt enthält. Der bisher beste (`regime_allocation`, Lauf #49) kam auf
12 von 16; die roten Folds sind die Quartale, in denen Aktien fielen.

Das ist kein Zufall, sondern Bauart: **Alle fünf Familien handeln denselben
Korb, und der Korb ist eine einzige Long-only-Aktienwette.** Fällt der Markt,
fällt jede Familie mit — es gibt nichts, worin sie ausweichen könnte.

Warum der Korb so aussieht, steht in der Auswahlregel: Er wird nach
Median-Dollarumsatz gewählt und bei Rang 30 abgeschnitten. Lauf #49 zeigt die
Ränge:

| Papier | Rolle | Rang | im Korb? |
|---|---|---:|---|
| LQD | Investment-Grade-Kredit | 12 | **ja** |
| HYG | High-Yield-Kredit | 21 | **ja** |
| **TLT** | **lange Treasuries (Duration)** | **32** | **nein — um zwei Ränge** |
| GLD | Gold | 56 | nein |
| SLV | Silber | 121 | nein |
| IEF | mittlere Treasuries | 128 | nein |
| BIL | Geldmarkt | 138 (Lauf #43) | nein |

**Die frühere Formulierung „der Korb enthält kein defensives Papier" war zu
stark und ist hiermit korrigiert.** Er enthält zwei — aber die falschen.
Kredit fällt im Aktien-Crash MIT den Aktien (es ist Unternehmensrisiko in
anderer Verpackung); Duration und Gold tun das nicht verlässlich. Der Korb
hat damit den *Anschein* von Streuung ohne ihre Substanz.

Dass ausgerechnet TLT auf Rang 32 bei einem Schnitt bei 30 liegt, ist der
schärfste Teil des Befundes: Es fehlt nicht, weil es unhandelbar wäre,
sondern weil zwei Halbleiterwerte mehr Umsatz hatten.

## Die Änderung

`universe.reserve`: eine Liste von Gruppen, jede mit einem Namen, einer
Symbolliste und einer Zahl reservierter Plätze. Die Plätze werden mit
**derselben Liquiditätsregel** besetzt — nur innerhalb der Gruppe statt über
alle. Alles andere bleibt: dieselbe Kennzahl, dieselben Filter
(`minPreis`, `minDollarVolumen`, `maxAlterTage`), dieselbe Hysterese,
dieselbe Gesamtzahl `max`.

Vorregistrierte Gruppe für diesen Lauf, **nach Assetklasse definiert, nie
nach Ergebnis**:

| Gruppe | Symbole | Plätze |
|---|---|---:|
| `diversifizierer` | TLT, IEF, GLD, SLV | 2 |

Zwei Plätze von 30, besetzt aus vier Papieren nach ihrem eigenen
Dollarumsatz. Die zwei umsatzstärksten dieser vier bekommen sie; welche das
sind, entscheidet die Regel je Fold neu (Punkt-in-Zeit, wie der übrige Korb).

Warum genau diese vier: Es sind alle Papiere des BESTEHENDEN Kandidatenpools,
die weder Aktien noch Unternehmenskredit sind. Es kommt kein Symbol hinzu,
und keines wird ausgesucht — die Gruppe ist die vollständige Restmenge einer
Assetklassen-Einteilung. BIL bleibt draußen: Es ist in diesen Läufen
Park- und Zinssymbol, also Infrastruktur (§0.6, Doppelführung).

Warum zwei und nicht drei oder fünf: Zwei Plätze sind der kleinste Eingriff,
mit dem die Gruppe überhaupt vertreten sein kann, und sie kosten den Korb
6,7 % seiner Plätze. Die Zahl ist NICHT gesucht und wird in diesem Lauf nicht
variiert; wer sie später variiert, zählt die Versuche.

## Was die Änderung NICHT ist

- **Kein Gate wird angefasst.** Keine Schwelle, keine Kostenzeile, keine
  Gate-Gruppe. Wenn danach immer noch nichts besteht, bleibt es dabei.
- **Keine Auswahl nach Ergebnis.** Die Gruppe ist nach Assetklasse definiert,
  die Plätze werden nach Dollarumsatz besetzt. Die Funktion sieht weiterhin
  kein PnL, keine Trades, keinen Champion (`src/universe/select.ts`).
- **Keine Strategie-Änderung.** Keine Familie erfährt, dass ein Symbol
  „defensiv" ist. Sie sehen einen Korb, wie immer. Ob eine von ihnen im
  Bärenmarkt dorthin ausweicht, entscheidet ihre eigene Logik — und genau
  das wird gemessen.
- **Per Vorgabe aus.** `universe.reserve` ist leer, wenn nichts dasteht; ohne
  ausdrückliche Config ändert sich am Betrieb nichts.

## Was ich VOR dem Lauf erwarte

| # | Erwartung | widerlegt, wenn |
|---|---|---|
| 1 | Die zwei Plätze gehen an TLT und GLD (die zwei umsatzstärksten der vier) | ein anderes Paar gewinnt — dann ist die Liquiditätsordnung in der Gruppe anders als heute |
| 2 | `fold_positive_share` steigt bei den Korb-Kandidaten (`cross_sectional_momentum`, `regime_allocation`), weil sie in fallenden Quartalen ausweichen können | es steigt nicht oder fällt — dann weichen sie nicht aus, und die Rangliste hilft im Bärenmarkt nicht |
| 3 | Die symbolweisen Familien (`trend_donchian`, `momentum_pullback`, `mean_reversion`) ändern sich wenig: Sie handeln Symbol für Symbol, nicht den Korb als Ganzes | sie ändern sich stark — dann wirkt der Eingriff über einen Weg, den ich nicht verstanden habe |
| 4 | Der MaxDD der Korb-Kandidaten sinkt | er steigt |
| 5 | **Kein Kandidat besteht plötzlich alle zehn Gates** | einer besteht alle zehn — dann ist zu prüfen, ob zwei reservierte Plätze wirklich eine Kante erzeugt haben, bevor irgendetwas befördert wird |

**Erwartung 5 ist der eingebaute Selbstzweifel**, und Erwartung 3 ist die
Kontrollgruppe: Wirkt der Eingriff auch dort, wo er mechanisch nichts zu
suchen hat, ist nicht der Korb die Ursache, sondern etwas anderes hat sich
mitverändert.

## Die Falle, die ich sehe und nicht wegdefinieren kann

**Ich wähle die Gruppe heute, mit dem Wissen, dass Duration und Gold in den
letzten Jahrzehnten diversifiziert haben.** Das ist Hindsight, und keine
Formulierung macht es zu etwas anderem. Drei Dinge begrenzen den Schaden,
heben ihn aber nicht auf:

1. Die Gruppe ist die vollständige Restmenge des bestehenden Pools nach einer
   Assetklassen-Einteilung — nicht eine Auswahl daraus. Es gibt nichts
   auszusuchen.
2. Innerhalb der Gruppe entscheidet Liquidität, nicht mein Urteil.
3. Die Zahl der Plätze steht vorher fest und wird nicht variiert.

Was NICHT begrenzt ist: Dass „Anleihen und Gold streuen" überhaupt meine
Erwartung ist, stammt aus der Vergangenheit dieser Papiere. 2022 haben
Aktien und lange Treasuries GEMEINSAM verloren — das Gegenbeispiel ist im
Messfenster enthalten, und wenn die Erwartung daran scheitert, ist das ein
Befund und keine Panne.

## Messlauf

Config: `config/korb-breite-1440.yaml` — Zeichen für Zeichen
`config/parken-1440.yaml` (Lauf #49) mit genau zwei Unterschieden:
`universe.reserve` mit der obigen Gruppe, und `paths.home`. Derselbe
Fold-Plan, dieselben Kosten, dieselben zehn Gates, dasselbe Parken, dasselbe
Zinssymbol. Die Differenz zu #49 ist damit die Wirkung der reservierten
Plätze — plus der üblichen Rückkopplung über die Equity.
