# Vorregistrierung: die Basis auf einem zweiten, disjunkten Korb

**Datum:** 14.09.2026 · **Vor dem Lauf geschrieben.**
**Config:** `config/basis-1440-korb2.yaml` · **Owner-Entscheidung:** „anderer
Korb, gleiches Fenster" (13.09.2026, nachdem M4 auf diesem Feed als
unerfüllbar nachgewiesen war)

## Was das prüft — und was ausdrücklich nicht

Die Basis hat ihre Latte auf genau einem Zeitfenster UND genau einem Korb
genommen. Zeitliche Unabhängigkeit ist mit dem IEX-Feed arithmetisch
unmöglich (`analysen/2026-09-13-unabhaengige-falsifikation-unmoeglich.md`).
Was bleibt, ist die andere Achse: **hängt das Ergebnis an den neun konkreten
Fonds?**

**Diese Probe ersetzt M4 nicht.** Sie misst dieselbe Marktgeschichte —
dieselben Crashs, dieselbe Zinswende, dieselbe Rally. Besteht die Basis auch
hier, ist das ein Beleg gegen Instrument-Zufall und **kein** Beleg für
zeitliche Robustheit. Wer das eine für das andere nimmt, hat den Befund von
gestern nicht gelesen.

Ich sage das vorweg, weil die Probe eine bekannte Schwäche hat: Wählt man je
Klasse einfach den zweitgrößten Fonds, sind die beiden Körbe fast dasselbe
(VOO statt SPY misst nichts). Die Regel unten ist so gebaut, dass die Probe
scheitern KANN.

## Die Regel für den zweiten Korb — vor der Auswahl festgelegt

> Dieselben neun GTAA-Klassen wie in V2. Je Klasse das größte US-ETF, das
> einen **anderen Index** abbildet als das des ersten Korbs. Findet sich
> keines, wird der nächstgrößte Fonds derselben Klasse genommen und hier
> ausdrücklich als **Beinahe-Klon** ausgewiesen.

| Klasse | Korb 1 (Index) | Korb 2 (Index) | |
|---|---|---|---|
| US Large | SPY (S&P 500) | **VTI** (CRSP US Total Market) | breiter, anderer Index |
| US Small | IWM (Russell 2000) | **IJR** (S&P SmallCap 600) | Qualitätsfilter statt reiner Größe |
| Industrieländer ex-US | EFA (MSCI EAFE) | **VEA** (FTSE Developed ex-US) | andere Länderabgrenzung |
| Schwellenländer | EEM (MSCI EM) | **VWO** (FTSE EM) | ohne Korea |
| Treasuries mittel | IEF (ICE 7–10 J.) | **GOVT** (ICE breit) | anderes Durationsprofil |
| Treasuries lang | TLT (ICE 20+ J.) | **VGLT** (Bloomberg Long) | anderer Index |
| IG-Kredit | LQD (iBoxx Liquid IG) | **VCIT** (Bloomberg 5–10 J.) | kürzer, anderer Index |
| Gold | GLD (Goldpreis) | **IAU** (Goldpreis) | **Beinahe-Klon** — dieselbe Ware |
| Immobilien | XLRE (S&P RE Select) | **VNQ** (MSCI US REIT) | deutlich breiter |

Neun gegen neun. Das ist Absicht: `topPct 0,4` und `exitPct 0,6` rechnen über
`(rank−1)/(of−1)`, ergeben also nur bei neun Mitgliedern wieder genau vier
Berechtigte und Austritt ab Rang 6. Mit acht Mitgliedern wären es drei — dann
hätte ich die Breite der Strategie mitverändert und der Lauf wäre nicht mehr
auswertbar. **Eine Änderung, nicht zwei** — der Fehler, der heute dreimal
Zeit gekostet hat.

Gold trägt zur Unabhängigkeit dieser Probe **nichts** bei. Eine von neun
Klassen ist damit blind; das ist der Preis dafür, die Geometrie gleich zu
lassen, und er steht hier, statt später entdeckt zu werden.

## Der Lauf

`config/basis-1440-korb2.yaml` = `config/basis-1440-v4.yaml` mit genau ZWEI
Unterschieden: `optimizer.basisUniverse` (die neun oben) und `paths.home`.
Parameter, Gate-Schwellen, Bremsen, Kosten, Fold-Plan, Alpha-Korb: unberührt.

Kein Stichtag. Ein Lauf. Der Maßstab (`Korb liegenlassen, gleichgewichtet`)
bildet sich aus dem NEUEN Korb — die Latte wandert mit, wie sie soll.

## Abbruchkriterien

1. **Der Datenbereich weicht vom Hauptlauf ab.** Dann ist es wieder kein
   Vergleich mit einer Änderung. Erwartet: `2021-…` bzw. derselbe Beginn wie
   #63 nach dem Anker-Fix — die Zeile wird VOR der Auswertung gelesen.
2. **Ein Symbol ohne Bars.** Fehlt einem der neun die Historie, fällt der
   Korb auf acht und die Geometrie ändert sich mit — dann ist der Lauf nicht
   auswertbar, und es wird kein Ersatzsymbol nachgeschoben.

## Erwartungen

| # | Erwartung | Woran sie scheitert |
|---|---|---|
| 1 | Alle neun Symbole haben Bars, Datenbereich wie im Hauptlauf | Abbruch |
| 2 | Die Basis besteht ihre vier Gates auch auf Korb 2 | Ein einziges rotes Gate |
| 3 | Der Bericht nennt als Basis-Korb genau die neun oben | Ein anderer Korb ⇒ die Config wirkte nicht |

## Bekannte Nebenwirkung auf das Alpha — vor dem Lauf benannt

Ein erster Entwurf dieser Vorregistrierung hatte als Erwartung 3 „der
Alpha-Teil ist zeichengleich mit #63". Das geht nicht, und der Grund ist ein
Wächter, den ich selbst gebaut habe: `core/config.ts` lehnt einen
`basisUniverse` ab, der nicht im Kandidatenpool steht („muss aus dem Pool
stammen, den nur ein Commit ändert") — gegen genau den Fall, dass jemand
einen Korb von Hand zusammenstellt, der gut aussieht.

Also müssen die neun in `universe.candidates`. Damit wächst der Pool um neun
sehr liquide ETFs, und VTI, VEA und VWO liegen weit über der Kappungsgrenze
des 30er-Korbs (Rang 30 lag zuletzt bei 107 Mio. $ Median-Tagesumsatz). **Der
Alpha-Korb dieses Laufs verschiebt sich.**

Für die BASIS ist das gleichgültig: Sie ist eine eigene Simulation über
`basisUniverse`, ihr Maßstab ist derselbe Korb liegengelassen, und der
Alpha-Korb geht in keine ihrer Zahlen ein.

Für das ALPHA ist es nicht gleichgültig: **Der Alpha-Teil dieses Berichts ist
nicht mit #63 vergleichbar und wird nicht zitiert.** Wer ihn doch vergleicht,
vergleicht zwei Änderungen.

Das kostet mich den eingebauten Wächter, den Erwartung 3 sein sollte. Ersatz
ist der direkte Weg: Der Bericht nennt den Basis-Korb im Kopf, und diese
Zeile wird vor der Auswertung gelesen.

## Die Folge, beide Richtungen

**Besteht die Basis:** Das Ergebnis hängt nicht an den neun konkreten Fonds.
Vor einer Aktivierung stünden dann noch: M2 (`tiers` in `platform.yaml`,
Owner) und die weiterhin **offene** zeitliche Unabhängigkeit (M4) — die
bleibt offen, bis es mehr Historie gibt.

**Besteht sie nicht:** Die Basis-Stufe wird nicht aktiviert, und das Urteil
aus #63 ist als das zu lesen, was es dann ist — ein Ergebnis von neun
bestimmten Fonds in einem bestimmten Fenster. Kein dritter Korb, keine
Nachbesserung, keine Suche nach der Besetzung, in der es doch klappt.

**Versuchszählung (§4a):** EIN Versuch. Er variiert eine gesuchte Größe (die
Besetzung des Korbs) und wird gezählt, egal wie er ausgeht.
