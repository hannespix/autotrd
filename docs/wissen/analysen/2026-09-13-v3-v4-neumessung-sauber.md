# V3 gegen V4, diesmal auf denselben Daten — alle vier Erwartungen gehalten

**Läufe:** #62 (V3) und #63 (V4), 13.09.2026 nachts, nacheinander auf dem
gemeinsamen Cache-Schlüssel `us_equity-iex-all` ·
**Vorregistrierung:** `vorregistrierung/2026-09-13-basis-v4-neumessung.md`

## Das Abbruchkriterium zuerst

Vorregistriert stand: Nennen die beiden Berichte nicht denselben
`Datenbereich`, wird aus dem Vergleich NICHTS geschlossen.

```
V3: Datenbereich: 2021-03-24 … 2026-09-11
V4: Datenbereich: 2021-03-24 … 2026-09-11
```

Erfüllt. Der Vergleich zählt.

## Die vier Erwartungen

| # | Erwartung | Ergebnis |
|---|---|---|
| 1 | Beide Berichte nennen denselben Datenbereich | ✔ |
| 2 | Das ALPHA ist zwischen V3 und V4 **ziffernidentisch** | ✔ — der einzige Unterschied im ganzen Alpha-Teil sind zwei Zeilen `konto:` gegen `alpha:` |
| 3 | Die Basis löst in V3 `konto:daily_loss` aus, in V4 keinmal | ✔ — V3: 3×, erste 2024-08-05, letzte 2026-03-03. V4: keine einzige |
| 4 | Die Basis besteht in V4 ihre vier Gates und scheitert in V3 | ✔ |

### Erwartung 2 im Wortlaut des Berichts

Der Alpha-Teil beider Berichte, Zeile für Zeile verglichen, unterscheidet
sich in **genau zwei** Zeilen:

```
< **Notbremsen** — konto:daily_loss 1× … Erste 2024-04-25
> **Notbremsen** — alpha:daily_loss 1× … Erste 2024-04-25
< **Notbremsen** — konto:daily_loss 1× … Erste 2024-01-31
> **Notbremsen** — alpha:daily_loss 1× … Erste 2024-01-31
```

Gleicher Tag, gleiche Zahl, anderes Etikett. Alle fünf Kandidaten, alle
Trades, alle Gate-Urteile, alle Kennzahlen: gleich.

**Damit ist Erwartung 4 der Vorregistrierung V4 bestätigt** — „Das ALPHA
ändert sich um exakt null." Ich hatte sie am Nachmittag für widerlegt
erklärt; das war der Bars-Cache, nicht die Bremse. Jetzt ist sie gemessen,
und sie hält.

### Erwartung 4 in Zahlen

| Gate | Latte | V3 | V4 |
|---|---|---|---|
| `basis_net_profit` | > 0 | 3 298,12 ✔ | **6 137,45** ✔ |
| `basis_drawdown` | ≤ 14,29 % | 15,99 % ✘ | **11,24 %** ✔ |
| `basis_sharpe` | ≥ 0,649 | 0,51 ✘ | **0,81** ✔ |
| `basis_costs` | ≤ 10 % | 6,9 % ✔ | **3,3 %** ✔ |

V4 reproduziert dabei #59 auf die Nachkommastelle (6 137,45 · 11,24 % ·
0,81 · 3,3 %) — erwartbar, denn #59 lief schon auf einem frischen Eimer und
damit auf demselben Datenbeginn. V3 weicht leicht von #40/#56 ab (15,99 %
statt 15,95 %, Sharpe 0,51 statt 0,48): genau die zwei Tage Unterschied.

## Was jetzt belegt ist — und was nicht

**Belegt:** Die Tagesbremse von 2 % ist die Ursache des V3-Einbruchs, und
mit `risk.tiers.basis` (5 %/30 %) nimmt die Basis ihre Latte. Das ist jetzt
ein Vergleich mit EINER Änderung, auf denselben Daten, mit vorher
festgelegtem Abbruchkriterium.

**Ebenfalls belegt:** Die Stufen-Bremse hat auf das Alpha keine Wirkung.
Es gibt keine „Nebenwirkung", über die jemand entscheiden müsste.

**Nicht belegt, und daran ändert dieser Lauf nichts:**

1. Es ist derselbe Datenzeitraum wie V2 und V3. Ein bestandener V4-Lauf
   bestätigt die Ursachenanalyse; er ist **kein neuer Beleg für die Basis**.
2. `config/platform.yaml` setzt weiter keine `tiers` (Prüferbefund M2). Die
   bestandene Latte gilt für ein VORGESCHLAGENES Regelwerk.
3. Die `--as-of`-Falsifikationen sind nicht unabhängig — über 90 %
   Fold-Überlappung (Prüferbefund M4).

**Die Basis-Stufe wird nicht aktiviert.** Die Liste davor ist um einen Punkt
kürzer geworden, nicht leer.

## Eine Einschränkung, die dieser Lauf selbst trägt

Beide Läufe messen ein Fenster, das am Anfang um zwei Tage zu kurz ist — der
`fetch`-Anker hing an der Wanduhr statt am Datenende (eigener Befund,
behoben in `core/time.ts` `datenAnker`). Für DIESEN Vergleich ist das
gleichgültig: Beide Seiten sind gleich kurz. Eine Wiederholung nach dem Fix
sieht das volle Fenster und wird leicht andere Zahlen zeigen — die Urteile
sollten stehen bleiben, aber das ist eine Erwartung, keine Messung.
