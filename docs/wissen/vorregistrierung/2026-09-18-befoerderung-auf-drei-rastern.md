# Vorregistrierung: Beförderung auf drei Rastern, Amtsinhaber-Prüfung jede Nacht, Absetzung nach drei Nächten (Regel 2)

**Datum:** 18.09.2026 · **These:** T4 (Konsequenz in den Code) · **Art:** Regel
der Beförderung, keine Strategie, keine Schwelle · **Status vor dem Lauf:** offen
**Owner-Entscheidung** vom 18.09.2026 (zwei Fragen, beide mit der Empfehlung
beantwortet): „Ja, drei Raster — csm einmalig nachprüfen" und „Drei
Folgenächte mit gerissenen Gates".
**Geschrieben, BEVOR die Regel lief.** Jede Zahl unten stammt aus Läufen, die
es schon gab (#16, #17, #18); keine aus einem Lauf mit der Regel.

---

## 1. Der Befund, der das auslöst

Prüfbericht `pruefungen/2026-09-18-red-team-erster-champion.md` (K1, K3, M7):

| Nacht | Anker | Gates | OOS-Sharpe (Überschuss) | SPY-Latte |
|---|---|---:|---:|---:|
| #16 | 2026-09-15 | 6/10 | 0,56 | 0,53 |
| #17 | 2026-09-16 | 5/10 | 0,20 | 0,56 |
| #18 | 2026-09-17 | **10/10** | 0,69 | 0,46 |

Dieselbe Familie (`cross_sectional_momentum`), derselbe Korb, dieselben
Regeln, je ein Handelstag mehr. Die Beförderung in #18 war das Maximum von
drei Ziehungen; die Bibliothek verlangte seit T4 „Falsifikationslauf (Raster
+ Seed) für jeden Treffer, bevor er zählt" — der Code kannte das nicht:
`decidePromotion` befördert nach EINER Nacht. Und mit Amtsinhaber gilt bis
≈ 2027-06 „zu wenig sauberes OOS, Beförderungs-Score gilt weiter" — eine
Rausch-Nacht wäre neun Monate nicht absetzbar.

## 2. Die Regel (Regel 2)

### R1 — Drei Raster in einem Lauf

Jede Alpha-Einheit wird auf **k = `optimizer.promotionGrids` = 3 Rastern**
gemessen. Raster j (j = 0, 1, 2) ist dieselbe Einheit, bei der ALLE Serien
(Korb, Kandidatenpool, Benchmark, Parkpapier) so geschnitten sind, dass die
letzten j Handelstage der Zeitachse der Einheit fehlen. Fold-Plan, Korb je
Fold, Suche, Gates und Latte entstehen je Raster neu — nichts wird aus
Raster 0 übernommen. Mit dem entkoppelten Generator (PR #518) sieht eine
Familie auf Raster −1 heute dieselben Gitterpunkte wie auf Raster −0 gestern:
Die drei Raster EINES Laufs sind die letzten drei Nächte, ohne den
Freiheitsgrad „welche Nacht zählt".

Score, Parameter, Holdout und die Auswertung (Anatomie, Aktivität) eines
Kandidaten stammen von Raster 0 — dem jüngsten Stand. Die Raster −1 und −2
liefern nur ihr Gate-Urteil (und Score, Trades, Netto für den Bericht).

### R2 — Beförderung nur mit 3/3

Ein Kandidat (gesuchte Familie oder Festkandidat) **besteht** genau dann,
wenn er auf ALLEN k Rastern alle zehn Gates nimmt (`rasterPass`). Nur ein
bestehender Kandidat kommt in die Beförderungsfrage; alles Weitere
(Marge, Vergleich mit dem Amtsinhaber, `keep`) bleibt unverändert. Die zehn
Gates, ihre Schwellen, der Überschuss-Maßstab, die Latte: unverändert.

### R3 — Der Amtsinhaber wird jede Nacht geprüft

Der Amtsinhaber wird jede Nacht mit seinen **festen Parametern** über ALLE
Folds jedes Rasters gerechnet (`fixedParamsWfa`, wie ein Festkandidat; DSR
„nicht anwendbar") und durch dieselben zehn Gates geschickt. Die Nacht gilt
als **bestanden**, wenn er auf allen k Rastern besteht. Der Champion-Eintrag
trägt einen Zähler `pruefung.gerisseneNaechte`: +1 je gerissener Nacht,
zurück auf 0 bei einer bestandenen. Erreicht der Zähler
**`optimizer.incumbentFailNights` = 3**, wird der Amtsinhaber abgesetzt
(`demote_to_notrade`) — es sei denn, ein Kandidat besteht nach R2, dann
`promote`. Der bisherige Re-Score auf sauberem OOS nach Fit-Ende bleibt
daneben bestehen; er wird ab ≈ 2027-06 wirksam.

Der letzte Fold enthält das Fit-Fenster des Amtsinhabers; diese Prüfung ist
dort nicht sauber und im Bericht so benannt. Sie ist die einzige, die es
vor sauberem OOS gibt, und sie ist strenger als „ungeprüft".

### R4 — Altbestand wird einmalig nachgeprüft

Ein Amtsinhaber, der unter Regel 1 befördert wurde (Eintrag ohne
`regel: 2` — heute: csm aus #18/#20), wird im ERSTEN Lauf unter Regel 2 durch
dieselbe Prüfung geschickt wie ein Kandidat: Seine Familie muss in diesem
Lauf nach R2 bestehen (3/3 Raster mit frischer Suche). Besteht sie, bleibt
er (Eintrag erhält `regel: 2`, R3 gilt ab dann); besteht sie nicht, wird er
sofort abgesetzt (`demote_to_notrade`, Grund nennt „Nachprüfung unter
Regel 2"). Kein Bestandsschutz — Owner-Entscheidung.

### Unverändert, mit Begründung

- **Papier-Erprobung (T22, §0.9):** unverändert. „Durchgefallen" heißt ab
  jetzt „nicht 3/3"; der Score-beste über der Untergrenze läuft auf Papier.
  Ein Live-Konto erreicht die Erprobung weiterhin nie.
- **Basis-Latte, Ensembles:** nur Raster 0 — sie konkurrieren nicht um den
  Alpha-Champion; die Basis hat ihre eigene Latte (heute nicht aktiv).
- **Zehn Gates, Schwellen, Überschuss, Latte, DSR-Informativ:** unverändert.

## 3. Konfiguration und Persistenz

- `optimizer.promotionGrids` (ganzzahlig 1–5, **Vorgabe 3**; Plattform 3).
  `1` ist die alte Regel und existiert nur für Rauchtests — die Plattform
  setzt sie nie.
- `optimizer.incumbentFailNights` (ganzzahlig 1–10, **Vorgabe 3**; Plattform 3).
- `champion.json` (additiv, `meta/champion` reicht sie durch):
  `symbols.*.regel = 2`, `symbols.*.raster[] = { anker, pass, failed, score }`
  bei Beförderung; `symbols.*.pruefung = { gerisseneNaechte, zuletzt, raster[] }`
  aus R3. Leser ohne diese Felder (Engine, Frontend) bleiben unverändert.

## 4. Erwartungen — vor dem Lauf, falsifizierbar

1. **Laufzeit** des nächtlichen Laufs unter 60 min (drei Suchen statt einer;
   heute ≈ 7 min Suche in ≈ 12 min Lauf ⇒ erwartet ≈ 30 min). Timeout 90 min
   bleibt. Reißt sie, wird die Laufzeit behoben — nie die Rasterzahl auf der
   Plattform gesenkt.
2. **Keine Familie besteht 3/3** im ersten Lauf unter Regel 2. Für csm:
   #16 6/10, #17 5/10, #18 10/10 — auch mit den neuen Losen (K2) erwartet
   „nein". Besteht eine Familie doch, ist sie befördert; das ist die Regel,
   nicht ihr Scheitern — aber dann steht ein zweiter Prüfer an.
3. **csm fällt in der Nachprüfung (R4) durch** ⇒ `demote_to_notrade`,
   Grund nennt „Nachprüfung unter Regel 2"; `symbols` leer, 30 `noTrade`.
4. **Die Erprobung übernimmt csm auf Papier:** Score-bester ≥ 4 Trades je
   Monat war in #20 csm (3,358; ≈ 8 je Monat). Journalzeile
   `Papier-Erprobung — cross_sectional_momentum`. Aktivität der Papier-Konten
   unverändert; die Trades zählen nicht für die Live-Reife.
5. **Raster −1 des Laufs N+1 reproduziert Raster −0 des Laufs N** je Familie
   (Fold-Parameter identisch) — messbar ab dem zweiten Lauf. Eine Abweichung
   ist ein Befund über die Bars (rückwirkende Bereinigung), nicht über die
   Regel.

## 5. Was das NICHT ist

- **Keine dritte Latte, keine Schwelle.** Dieselben zehn Gates, dreimal
  angewandt — strenger, wie §0.9 es erlaubt; milder an keiner Stelle.
- **Kein Owner-Pfad.** csm wird nicht von Hand abgesetzt; er wird durch die
  Messung geschickt, die für jeden Kandidaten gilt.
- **Keine Änderung an der Erprobung, an der Engine, am Sizing.** Die
  Papier-Konten handeln so oder so denselben Kandidaten — es geht um den Weg
  zum Echtgeld.

## 6. Wächter (jeder einmal absichtlich gebrochen)

- Raster-Schnitt: genau j letzte Handelstage fehlen, auf jeder Serie.
- Ein Kandidat, der nur auf Raster 0 besteht, wird NICHT befördert (Fake:
  Kante nur mit den letzten Bars) — rot, sobald `promote` nur Raster 0 liest.
- Altbestand ohne `regel: 2` und ohne 3/3 ⇒ `demote_to_notrade` im ersten
  Lauf; mit 3/3 ⇒ Eintrag erhält `regel: 2`.
- Zähler: zwei gerissene Nächte ⇒ `keep` mit `gerisseneNaechte: 2`; die
  dritte ⇒ `demote_to_notrade`; eine bestandene setzt auf 0 zurück.
- Plattform-Config: `promotionGrids: 3`, `incumbentFailNights: 3`.
- Bericht: Raster-Tabelle je Kandidat; Amtsinhaber-Zeile mit Zähler.

## 7. Abbruch und Umkehr

Fällt ein Lauf unter Regel 2 an der Laufzeit oder an einem Fehler im
Raster-Schnitt, gilt der alte Champion-Stand weiter (kein Lauf, keine
Entscheidung — wie bei jeder Datenpanne). Die Regel wird nicht gelockert;
was gelockert werden müsste, braucht eine neue Vorregistrierung und den
Owner.

## Ergebnis des ersten Laufs (#21, 18.09.2026 08:26 UTC, `main` = `a924849`) — nach dem Lauf geschrieben

| # | Erwartung | Ergebnis |
|---|---|---|
| 1 | Laufzeit < 60 min | **✔** 18,6 min gesamt, Walk-Forward-Schritt 18,0 min (vorher ≈ 6,5) |
| 2 | Keine Familie 3/3 | **✔** alle fünf Familien 0/3 — td, mp, mr, csm, regime |
| 3 | csm fällt in der Nachprüfung (R4) ⇒ `demote_to_notrade` | **✔** „Altbestand aus Regel 1 — Nachprüfung unter Regel 2 NICHT bestanden"; csm-Familie mit frischer Suche 0/3 (Raster −0: PSR 0,742, `fee_share` 144,9 %, `beats_market` 0,31 < 0,46; −1: PSR, `beats_market`; −2: dazu `fold_concentration`, `fee_share`). `symbols` leer, 30 `noTrade`, veröffentlicht (752 indizierbare Werte). |
| 4 | Erprobung übernimmt **csm** auf Papier | **✘ im Kandidaten, ✔ im Mechanismus.** Score-bester ≥ 4 Trades je Monat ist `mean_reversion` (3,979; 7,5 je Monat), nicht csm: Mit den neuen Losen (K2, PR #518) fiel csm von 3,358 auf 2,091, `mean_reversion` stieg von 2,884 auf 3,979. Die Papier-Konten handeln weiter — nur einen anderen Durchgefallenen. |
| 5 | Raster −1 des Laufs N+1 reproduziert Raster −0 des Laufs N | erst ab Lauf #22 messbar |

**Nebenbefund A — die feste Parametrisierung besteht, die Familie nicht.** Die
nächtliche Prüfung (R3) mit csms FESTEN Parametern
`{100,2,0.1,0.6,0,7,3.5,1}` über alle 18 Folds nahm alle zehn Gates auf
allen drei Rastern (Score 3,570 / 4,158 / 3,990; 494 / 507 / 502 Trades;
roh +8 259 / +9 791 / +9 486 $; Zähler 0/3). Die frische Suche derselben
Familie nahm sie auf keinem. R4 verlangt — wie vorregistriert — die Familie,
nicht den Parametersatz: Ein Altbestand muss dieselbe Latte nehmen, die ihn
heute befördern würde. Was daraus folgt, steht in `befunde.md` (Weg über
einen Festkandidaten NACH K4, nicht vorher).

**Nebenbefund B — K4 live gesehen.** Die csm-Kette der frischen Suche zeigt
roh +5 568 $, im Überschuss +1 505 $ — und die Exit-Anatomie derselben Kette
**−178,47 $** über 394 geschlossene Trades. Der Überschuss besteht aus
Buchgewinnen offener Positionen an Fold-Enden (Prüfbefund K4), nicht aus
Handel. `fee_share` 144,9 % ist die Folge (K5): Nenner ≈ 396 $.

**Nebenbefund C — der Erprobungs-Kandidat verliert unter Stress.**
`mean_reversion` Raster −0: `fold_concentration` 166 % (ohne den besten Fold
−299 $), `stress_costs` −167 $, DSR 0,000. Er handelt auf Papier (7,5 je
Monat); die Erwartung aus §0.9 gilt: Ein Durchgefallener verliert
wahrscheinlich auch dort.
