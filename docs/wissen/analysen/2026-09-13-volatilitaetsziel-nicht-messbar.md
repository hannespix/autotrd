# Das Volatilitätsziel ist in diesem Walk-Forward nicht messbar

**Läufe:** #50 (`config/parken-volziel-1440.yaml`) und #51 (derselbe Lauf,
nachdem der Bericht die Verteilung des Faktors ausweist — zeichengleiche
Zahlen, siehe unten) · **Vergleich gegen:** #49 (nur Parken) ·
**Vorregistrierung:** `vorregistrierung/2026-09-13-volatilitaetsziel.md`

## Kurz

Vier von fünf vorregistrierten Erwartungen sind widerlegt, und das
Abbruchkriterium greift — aber aus einem tieferen Grund als vorhergesagt.
Der Faktor stand nicht nur „überwiegend am Deckel": Er war in der
**OOS-Bewertung zu 97,3 % überhaupt nicht aktiv**, weil seine Aufwärmphase
länger ist als das nutzbare OOS-Fenster. In der **IS-Suche war er zu 84 %
aktiv**. Gesucht wurde also unter einem anderen Sizing-Regime als bewertet.

Das Ergebnis von #50 ist damit **nicht auswertbar** — weder positiv noch
negativ, genau wie vorregistriert. Das Volatilitätsziel wird für dieses
System als **nicht anwendbar** vermerkt, solange die Messarchitektur
unverändert ist.

## Die Zahl, die alles erklärt

Aus dem Bericht von #51, Zeile je Kandidat:

> Faktor 1–2, Mittel 1.03 über 987 Zyklen der OOS-Kette. Verteilung: 2.7 % am
> Deckel 2, 0.0 % am Boden 0.25, **97.3 % Aufwärmphase**, 0.0 % frei.
> **Ohne Aufwärmphase: 100.0 % am Deckel.**

987 Zyklen über 16 Folds sind 61,7 Handelstage je Fold. `minBeobachtungen`
steht auf 60. 97,3 % von 987 sind 960 — geteilt durch 16 Folds exakt **60**.

Das ist kein Zufall, sondern die ganze Ursache: **`simulate()` beginnt in
jedem Fold mit leerer Renditereihe** (`src/backtest/simulator.ts`,
`const dailyReturns: number[] = []`), und jeder Fold ist ein eigener
Aufruf. Die Aufwärmphase von 60 Handelstagen frisst deshalb ein OOS-Fenster
von 90 Kalendertagen (≈ 62 Handelstagen) fast vollständig auf. Übrig bleiben
je Fold etwa zwei Tage.

## Warum daraus ein Messfehler und nicht nur eine Nullwirkung wird

| Fenster | Länge | Handelstage | Aufwärmphase | Faktor aktiv |
|---|---:|---:|---:|---:|
| IS-Suche | 550 Kalendertage | ≈ 378 | 60 | **≈ 84 %** |
| OOS-Bewertung | 90 Kalendertage | ≈ 62 | 60 | **2,7 %** |

Die Suche hat ihre Parameter unter aktivem Vola-Ziel bewertet, die OOS-Kette
hat sie fast ohne bewertet. IS und OOS sind damit nicht dieselbe Welt — und
das ist der Fehler, gegen den dieses Repo gebaut ist (§0.1: ein
Entscheidungspfad; „was nur in einer Welt gilt, ist ein Messfehler").

Genau das erklärt auch, warum sich trotz eines Faktors von im Mittel 1,03
alles verschoben hat: Nicht die Trades wurden skaliert, sondern **die Suche
hat andere Parameter gewählt**.

## Was gegenüber #49 herauskam

| Kandidat | Gates #49 | Gates #50 | Trades | Netto | MaxDD | Gebührenanteil |
|---|---:|---:|---|---|---|---|
| `regime_allocation` | **6/10** | **4/10** | 41 → 45 | +4854,67 → +4325,90 | 1,62 → 1,93 % | – → – |
| `mean_reversion` | 4/10 | **5/10** | 139 → 159 | +3838,51 → +3469,69 | 1,47 → 1,47 % | 24,0 → 33,2 % |
| `cross_sectional_momentum` | 6/10 | 5/10 | 436 → 413 | +5372,62 → +5206,37 | 7,65 → 7,08 % | 48,7 → **84,6 %** |
| `momentum_pullback` | 5/10 | 5/10 | 255 → 272 | +1861,70 → +1209,01 | 3,89 → 4,03 % | – → – |
| `trend_donchian` | 5/10 | 4/10 | 282 → 318 | +2814,31 → +2591,21 | 7,49 → **10,86 %** | – → **732,3 %** |

Der bisher beste Kandidat verliert `beats_market` (Überschuss-Sharpe 0,51 →
0,18) und `fold_positive_share` (0,750 → 0,563); `fold_concentration`
verschlechtert sich von 0,551 auf 1,566 — ein einzelner Fold trägt 157 % des
OOS-Überschusses, ohne ihn bliebe −160,89.

**Der Gebührenanteil von 732,3 % bei `trend_donchian` ist die Krankheit des
Vorgängersystems** (CLAUDE.md §2: „Der Handel funktioniert; er wird zu Tode
gehandelt"). Sie kam hier nicht durch eine schlechtere Strategie zurück,
sondern durch eine Suche, die unter verändertem Sizing eine handelsfreudigere
Parameterwahl bevorzugte.

## Die fünf Erwartungen

| # | Erwartung | Ergebnis |
|---|---|---|
| 1 | Sharpe ändert sich um < 0,15 | **widerlegt** — `regime_allocation` 0,51 → 0,18 (Δ 0,33) |
| 2 | Rendite und MaxDD steigen proportional zum mittleren Faktor | **widerlegt** — die Rendite FIEL bei allen fünf, der MaxDD stieg bei zweien |
| 3 | Kein Kandidat besteht MEHR Gates | **widerlegt** — `mean_reversion` 4/10 → 5/10 |
| 4 | `oos_trades` ändert sich um exakt null | **widerlegt** — alle fünf ändern sich (41→45, 139→159, 436→413, 255→272, 282→318) |
| 5 | Der Faktor steht überwiegend am Deckel | **bestätigt, aber irreführend** — ohne Aufwärmphase 100 % / 96,3 % / 70,4 % / 55,6 % / 100 %; die Aufwärmphase selbst ist der eigentliche Befund |

Erwartung 4 war schlicht falsch gedacht: Der Faktor ändert Stückzahlen,
Stückzahlen ändern Kosten und Equity, und die Equity entscheidet mit, ob eine
weitere Position noch bezahlbar ist. Ein Sizing-Faktor kann sehr wohl
Trades entstehen und verschwinden lassen.

Erwartung 1 war der eingebaute Selbstzweifel („springt der Sharpe, hat das
Vola-Ziel keine Kante gefunden, sondern ein Deckel beisst asymmetrisch oder
eine Kostenzeile fehlt"). Er hat gegriffen — die Ursache war eine dritte, die
dort nicht stand: die Suche selbst.

Nach Erwartung 3 gilt für `mean_reversion` ausdrücklich: **nicht befördern.**
Der Grund für das zusätzlich bestandene Gate (`neighborhood_plateau`) ist
nicht geklärt und mit einem nicht auswertbaren Lauf auch nicht klärbar.

## Was das über die Messarchitektur sagt (der allgemeine Teil)

Der Befund gilt nicht nur für das Vola-Ziel:

> **Jede Größe, die eine lange Historie des eigenen Kontos braucht, ist in
> 90-Tage-OOS-Folds nicht bewertbar, solange jeder Fold das Konto neu
> beginnt.**

Betroffen wäre alles, was aus der Equity-Kurve selbst schätzt — ein
Vola-Ziel, eine Kelly-artige Skalierung, ein Drawdown-Zustand über
Foldgrenzen hinweg. Die Notbremsen (`maxDailyLossPct`, `maxDrawdownPct`)
sind schwächer betroffen, weil sie ohne Mindestbeobachtung auskommen, aber
ihr Peak beginnt je Fold ebenfalls neu.

Drei mögliche Auswege, keiner davon heute gegangen, alle
vorregistrierungspflichtig:

1. **Die Renditereihe über Foldgrenzen fortschreiben.** Kausal wäre das
   zulässig (sie enthält nur Vergangenheit), aber sie verbände die Folds zu
   einem Konto — dann ist der Fold-Plan kein Fold-Plan mehr, und die
   Unabhängigkeit der OOS-Fenster, auf der `fold_positive_share` und
   `fold_concentration` beruhen, ist dahin.
2. **Die Aufwärmphase mit Bars vor dem OOS-Beginn füllen** (dieselbe Rolle
   wie `embargoBars` für Indikatoren). Das ist die naheliegende Lösung und
   die einzige, die den Fold-Plan unangetastet lässt.
3. **Längere OOS-Fenster.** Ändert den Fold-Plan und damit jeden Vergleich
   mit allen bisherigen Läufen.

Bis eine davon vorregistriert, gebaut und mit einem gebrochenen Wächter
belegt ist, bleibt `risk.volTarget` aus — so, wie es im Schema steht.

## Was an diesem Lauf gut war

Der Lauf hat sich selbst überführt. Das Abbruchkriterium stand vor dem Lauf
fest, die Zahl dazu kam aus dem Lauf, und sie sagte etwas Schärferes als das
Kriterium verlangte. Dass sie überhaupt da war, ist dabei nicht
selbstverständlich: **#50 konnte sein eigenes Abbruchkriterium nicht prüfen**,
weil die Verteilung nur als Simulator-Notiz je Fold entstand und Notizen den
Optimierer-Bericht nie erreichen. Erst der Zusatz aus Commit 8750334 (die
Verteilung wandert strukturiert mit und wird über die Folds addiert) machte
#51 entscheidbar.

#51 reproduziert #50 dabei zeichengleich — der einzige Unterschied im Bericht
sind die neuen Zeilen. Das ist zugleich die Gegenprobe, dass der Zusatz reine
Diagnose ist und die Messung nicht verändert.
