# Vorregistrierung: Volatilitätsziel auf das Portfolio (Lauf 2 von 2)

**Datum:** 13.09.2026 · **These:** T20 (neu) · **Status vor dem Lauf:** offen
**Gehört zu:** `2026-09-13-kasse-in-den-geldmarkt.md`, Messplan Schritt 2
(„Parken plus Volatilitätsziel. Differenz zu Lauf 1 ist sauber die Wirkung
des Volatilitätsziels.")

Diese Datei existiert, weil der Messplan des Parkens den zweiten Lauf nur
benennt, seine Parameter aber nicht festlegt. Ohne Vorregistrierung wäre
`zielVolPct` nach dem Lauf frei wählbar — und damit kein Parameter, sondern
ein Freiheitsgrad, der sich das Ergebnis aussucht (§4a).

## Der Befund, der das auslöst

Steht seit dem 12.09.2026 im Modulkopf von `src/risk/volziel.ts`, Lauf #9
über neun OOS-Fenster:

| | Sharpe | MaxDD | Rendite (4 Jahre) |
|---|---:|---:|---:|
| `mean_reversion` | 0,75 | 1,84 % | 3,57 % |
| SPY kaufen-und-halten | 1,17 | 19,85 % | — |

Die Strategie riskiert ein Zehntel des Marktes und verdient entsprechend
nichts. Das ist ein **Deployment-Problem, kein Kanten-Problem**.

## Die Änderung

`risk.volTarget.enabled: true`. Der Faktor skaliert das Sizing-BUDGET mit
Ziel-Vola / realisierter Vola der eigenen Equity-Kurve. Die Deckel
(`maxPositionPct`, `maxGrossExposurePct`, `maxPositions`, Bargeld) bleiben
harte Obergrenzen, die der Faktor nie aushebelt.

**Kein Parameter wird gesucht, keiner variiert.** Es gelten Zeichen für
Zeichen die Vorgaben aus dem Config-Schema:

| Parameter | Wert | Warum genau dieser |
|---|---:|---|
| `zielVolPct` | 10 | Schema-Vorgabe |
| `halbwertszeitTage` | 20 | Schema-Vorgabe (≈ ein Handelsmonat) |
| `minFaktor` | 0,25 | Schema-Vorgabe |
| `maxFaktor` | 2 | Schema-Vorgabe |
| `minBeobachtungen` | 60 | Schema-Vorgabe |

Die Schema-Vorgaben sind der einzige Anker, der **vor** allen Messungen
dieses Projekts festgelegt wurde und deshalb nicht an sie angepasst sein
kann. Jeder andere Wert wäre eine Zahl, die ich heute wähle, während ich die
Ergebnisse schon kenne.

## Messlauf

Config: `config/parken-volziel-1440.yaml` — Zeichen für Zeichen
`config/parken-1440.yaml` (Lauf #49) mit genau zwei Unterschieden:
`risk.volTarget` von AUS auf AN mit der obigen Tabelle, und `paths.home`.
Der Fold-Plan, die Kosten, die zehn Gates, ihre Schwellen, der Korb je Fold
und das Parken bleiben unangetastet, damit die Differenz zuordenbar ist.

## Was ich VOR dem Lauf erwarte

| # | Erwartung | widerlegt, wenn |
|---|---|---|
| 1 | Der **Sharpe ändert sich kaum** (< 0,15 je Kandidat). Eine Skalierung aller Positionen mit demselben Faktor lässt Ertrag je Schwankung unberührt — bis auf Kosten, Stückelung und Deckel | er springt um mehr als 0,15 |
| 2 | Rendite und MaxDD steigen ungefähr proportional zum mittleren Faktor | einer der beiden steigt deutlich stärker als der andere |
| 3 | Kein Kandidat besteht MEHR Gates als in Lauf #49 | einer besteht mehr |
| 4 | `oos_trades` ändert sich um exakt null: der Faktor ändert Stückzahlen, nie ob ein Signal entsteht | die Zahl der Trades ändert sich |
| 5 | Der Faktor steht überwiegend am Deckel, weil diese Kandidaten 85–97 % der Zeit in Kasse sind und eine flache Kurve eine kleine Vola hat | er atmet — dann ist die Grenze aus dem Modulkopf weniger scharf als gedacht |

**Erwartung 1 ist der eingebaute Selbstzweifel.** Verbessert das Vola-Ziel
den Sharpe deutlich, hat es keine Kante gefunden — dann beißt ein Deckel
asymmetrisch oder eine Kostenzeile fehlt. Ein Kandidat, der danach plötzlich
mehr Gates besteht, wird NICHT befördert, bevor geklärt ist, warum.

## Abbruchkriterium (der Lauf kann an sich selbst scheitern)

Klebt der Faktor bei **mehr als 80 % der Zyklen außerhalb der Aufwärmphase
am Deckel**, dann ist er kein Volatilitätsziel, sondern ein konstanter Hebel
von `maxFaktor`. Der Lauf misst dann nicht, was auf dem Etikett steht.

In diesem Fall gilt das Ergebnis als **nicht auswertbar** — ausdrücklich
nicht als „positiv" und nicht als „negativ" —, und die Folge ist:

> Das Volatilitätsziel wird für dieses System in seinem jetzigen Zustand als
> **nicht anwendbar** vermerkt. Unterinvestition ist kein Vola-Problem. Wer
> selten im Markt ist, hat eine flache Kurve; der Faktor rechnet dann nicht
> Schwankung gegen Ziel, sondern läuft in seine Obergrenze. Die Antwort
> darauf ist mehr oder bessere Signale, nicht ein größerer `maxFaktor` — das
> wäre schlicht Hebel unter anderem Namen.

Damit dieses Kriterium überhaupt prüfbar ist, meldet der Simulator seit
diesem Commit die **Verteilung** des Faktors (Anteil am Deckel, am Boden, in
der Aufwärmphase, frei) und nicht mehr nur Spanne und letzten Wert. Vorher
war der Abbruchfall von seinem Gegenteil nicht unterscheidbar. Wächter:
`test/core/volzielPfad.test.ts`, WÄCHTER (e), zweimal absichtlich gebrochen.

**Ich sage vorher, dass dieses Kriterium greifen wird.** Es steht hier, damit
das Ergebnis nicht nachträglich als Erkenntnis verkauft werden kann, und
damit die Zahl, die es belegt, aus dem Lauf kommt und nicht aus einer
Schätzung.

## Bekannte Schwächen

- Die Schätzung kommt aus der EIGENEN Equity-Kurve, nicht aus dem Markt. Wer
  selten investiert ist, bekommt einen großen Faktor — genau dann, wenn die
  nächste Position wieder voll im Markt steht. Das ist prozyklisch und steht
  so im Modulkopf von `src/risk/volziel.ts`.
- EWMA überschätzt nach einem Sprung für einige Tage: direkt nach einem
  Crash-Tag fährt das Ziel stärker herunter, als die Folgewochen
  rechtfertigen (verkauft in die Panik, kauft in die Ruhe).
- Die Differenz zu Lauf #49 ist nicht rein: Der Faktor ändert Stückzahlen,
  damit Kosten, damit die Equity — und die Equity ist die
  Bemessungsgrundlage des Sizings. Wie beim Parken gilt
  „Δ = Vola-Ziel + Rückkopplung über die Equity".
- Der MaxDD bleibt roh gemessen (Kapitalfrage, §ders. Grund wie bei den
  Gates). Ein Faktor > 1 vergrößert ihn unmittelbar — das ist beabsichtigt
  und der Preis der Änderung, nicht ihr Fehler.
