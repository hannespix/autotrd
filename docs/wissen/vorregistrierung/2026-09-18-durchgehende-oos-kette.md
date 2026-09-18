# Vorregistrierung: Die OOS-Kette als EINE durchgehende Simulation (Prüfbefund K4)

**Datum:** 18.09.2026 · **Auslöser:** Prüfbericht
`pruefungen/2026-09-18-red-team-erster-champion.md` (K4) und Lauf #21
(`befunde.md`, Nebenbefund B) · **Art:** Messung, keine Strategie, keine
Schwelle · **Status vor dem Lauf:** offen
**Geschrieben, BEVOR ein Wert mit der neuen Rechnung nachgemessen wurde.**

Diese Vorregistrierung ändert, WAS die OOS-Kette misst. Sie ist nach §4a
genauso pflichtig wie eine neue Familie. Sie ändert **keine Schwelle**.

---

## 1. Der Messfehler

Jeder Fold der OOS-Kette ist heute eine eigene Simulation: leeres Buch am
OOS-Beginn, Startkapital E₀, und am OOS-Ende werden offene Positionen zum
letzten Schluss bewertet — ohne Exit-Kosten, ohne dass sie je ein Trade
werden. Der nächste Fold beginnt wieder leer. Für eine Trailing-Strategie
mit 98 % Zeit im Markt heißt das: 18 Fold-Enden, an denen Buchgewinne in die
Kette gehen, die der Trailing-Exit im Median zu 55 % wieder hergegeben hätte
(Anatomie #18).

| Lauf | csm-Kette roh | Überschuss über BIL | geschlossene Trades |
|---|---:|---:|---:|
| #18 (Champion) | +7 476 $ | +3 388 $ | +1 471 $ |
| #21 (Raster −0) | +5 568 $ | +1 505 $ | **−178 $** |

Die Basis-Stufe hat denselben Fehler am 09.09.2026 (Prüfbefund M6)
bekommen und läuft seitdem durchgehend (`basisSimulation`). Die Alpha-Kette
hat ihn noch — und auf ihr steht jede Beförderung.

## 2. Das Prinzip

> **Die OOS-Kette ist EINE Simulation:** ein Buch, ein Peak, ein Konto von
> `oosStart` des ersten bis `oosEnd` des letzten Folds. Positionen laufen
> über Fold-Grenzen weiter. An der OOS-Grenze eines Folds wechseln die
> Parameter auf den Fold-Besten seiner IS-Suche und der Korb auf den Stand
> zu diesem Zeitpunkt (Korb je Fold) — genau das, was die Plattform nachts
> tut: neue Parameter, offene Positionen bleiben, ein Symbol ohne führende
> Strategie wird geschlossen (`unmanaged`).

Die Suche je Fold ist davon unberührt: IS-Fenster, Embargo, Kandidaten,
Fold-Beste bleiben, wie sie sind. Nur die BEWERTUNG der Kette ändert sich.

## 3. Was sich ändert — und was ausdrücklich nicht

### Simulator (`src/backtest/simulator.ts`)

`strategyFor(symbol)` darf einen Fahrplan `wechsel: { ab, params }[]`
mitgeben: Ab `ab` gelten die Parameter des Eintrags; Indikatoren werden je
Parametersatz vorberechnet (kausal — dieselbe Präfix-Regel wie bisher).
`params: null` heißt: Das Symbol hat ab hier keine führende Strategie — kein
neuer Einstieg, eine offene Position wird am nächsten Open als `unmanaged`
geschlossen. Ohne Fahrplan verhält sich der Simulator bitgleich wie heute.

### Kette (`src/optimize/walkForward.ts`)

`durchgehendeKette`: ein Lauf über die OOS-Kette mit Fahrplan (Fold-Beste)
und Korbständen (Korb je Fold). Das Ergebnis wird an den Fold-Grenzen in
Scheiben geschnitten und **je Scheibe auf E₀ normiert** (Equity × E₀/E_Start,
Trades nach Ausstiegszeit, Tagesrenditen der Scheibe). Damit gelten
unverändert: `aggregateOos` (Produkt der Scheibenfaktoren = Gesamtfaktor),
die Invariante von `ueberschussKette` (aufgezinst = Netto je Fold), PSR und
`beats_market` auf der Kette, `fold_positive_share`, `fold_concentration`.
`stress_costs` ist ein zweiter durchgehender Lauf bei Kosten ×1,5, ebenso
geschnitten. Die Nachbarschaft bleibt auf dem finalen Fenster, der DSR auf
der IS-Zahl — beide messen die Suche, nicht die Kette.

Gilt für gesuchte Kandidaten, Festkandidaten, die nächtliche Prüfung des
Amtsinhabers (Regel 2, R3) und alle drei Raster.

### Schalter

`optimizer.oosChain`: `continuous` (**Vorgabe, Plattform**) · `per_fold`
(die Rechnung bis heute — nur für Vergleichsläufe und Rauchtests; die
Plattform setzt sie nie).

### Unverändert, mit Begründung

- **Zehn Gates, Schwellen, Überschuss-Maßstab, Latte, Regel 2.**
- **Suche je Fold, Embargo, Korb je Fold, Generator je Fenster.**
- **Basis-Latte** (läuft schon durchgehend), **Ensembles** (eigene Messung).
- **Erprobung** (§0.9): wählt weiter den Score-besten Durchgefallenen — der
  Score ist der OOS-Median der Scheiben, jetzt der durchgehenden.

## 4. Erwartungen — vor dem Lauf, falsifizierbar

Erster Lauf: `optimize.yml` von Hand am 18.09.2026 (Anker 2026-09-18 —
dieselben Daten und dieselben Lose wie #21, also der direkte A/B-Vergleich
je-Fold gegen durchgehend).

1. **Die K4-Zeile jedes Kandidaten zeigt offene Positionen nur im LETZTEN
   Fold** (Σ unrealisiert = Stand am Kettenende); in #21 waren es bis zu 18
   Fenster.
2. **csm (Familie, Raster −0):** Überschuss fällt unter +1 505 $ und PSR
   unter 0,742; geschlossene Trades und Kettenergebnis rücken zusammen (die
   Differenz ist nur noch das Kettenende).
3. **Keine Familie besteht 3/3.** Die Zahl bestandener Gates je Familie sinkt
   oder bleibt; steigt sie bei einer Familie um zwei oder mehr, ist das ein
   Befund über die Rechnung, nicht über die Familie — dann Prüfer.
4. **Laufzeit:** höchstens +15 % gegenüber #21 (18,6 min) — ein durchgehender
   Lauf je Kandidat und Raster ersetzt 18 Fold-Läufe, dazu ein Stress-Lauf.
5. **`per_fold` reproduziert #21 bitgleich** (Score, Trades, Netto je Familie
   auf Raster −0 — Wächter im Code, Rauchtest mit dem Schalter).

## 5. Was das NICHT ist

- Keine Schwelle, keine dritte Latte, kein Owner-Pfad.
- Kein Urteil über csms festen Parametersatz (Nebenbefund A, #21): Er wird
  erst gemessen, wenn er als Festkandidat vorregistriert ist — NACH diesem
  Lauf, mit dieser Rechnung, Owner-Entscheidung.
- Keine Änderung an Engine, Sizing, Erprobung.

## 6. Wächter (jeder einmal absichtlich gebrochen)

- Simulator: Ohne Fahrplan bitgleich; mit Fahrplan gelten ab `ab` die neuen
  Parameter (Indikatoren des neuen Satzes); `params: null` schließt
  `unmanaged` am nächsten Open und lässt keinen Einstieg zu.
- Kette: Bei einer Strategie, die an jedem Fold-Ende flat ist, sind die
  Scheiben der durchgehenden Kette bitgleich zu den Fold-Läufen; Produkt der
  Scheibenfaktoren = Faktor der ganzen Kette; Trades der Scheiben = Trades
  der Kette.
- Gates: `ueberschussKette` nimmt die normierten Scheiben ohne Fehler.
- Schalter: `per_fold` = alte Zahlen (Snapshot-Test auf dem Fake).
- Plattform-Config: `oosChain: continuous`.

## 7. Abbruch und Umkehr

Reißt Erwartung 4 (Laufzeit), wird die Laufzeit behoben, nie die Rechnung.
Reißt Erwartung 5, ist der Umbau fehlerhaft und wird nicht veröffentlicht.
Eine Familie, die durchgehend BESSER aussieht als je Fold, ist zuerst ein
Verdacht auf die Rechnung (Erwartung 3).

---

## 8. Ergebnis — Lauf #22 (Dispatch 18.09.2026 09:57 UTC, `main` a285765, Anker 2026-09-18)

**Nachgetragen am 18.09.2026, NACH dem Lauf.** A/B gegen #21 (per_fold, 08:26 UTC, `main` a924849 — gleicher Anker, gleiche Daten, gleiche Lose; die Fold-Parameter der IS-Suche sind in beiden Läufen dieselben, geändert ist nur die Bewertung der Kette). Bericht: Artefakt `optimize-report-35332213303`.

| Familie (Raster −0) | #21 Gates | #22 Gates | Überschuss #21 → #22 | PSR #21 → #22 | fee_share #21 → #22 | geschl. Trades netto #21 → #22 | Kettenende #22 |
|---|---|---|---|---|---|---|---|
| cross_sectional_momentum | 7/10 | **9/10** (nur PSR) | +1 505 → **+2 798 $** | 0,742 → **0,876** | 144,9 % → 15,7 % | −178 → **+3 849 $** | 4 Positionen, +463 $ |
| regime_allocation | 5/10 | **7/10** | +386 → +854 $ | 0,607 → 0,729 | vakant → 6,7 % | −2 528 → +990 $ | 4 Positionen, +693 $ |
| trend_donchian | 4/10 | 5/10 | +356 → +207 $ | 0,569 → 0,543 | 55,2 % → 23,0 % | +542 → +2 265 $ | keine |
| mean_reversion | 5/10 | 5/10 | +455 → +314 $ | 0,623 → 0,586 | 28,1 % → 35,9 % | +2 117 → +1 684 $ | 4 Positionen, −103 $ |
| momentum_pullback | 4/10 | 4/10 | −3 010 → −3 622 $ | 0,086 → 0,054 | 3 400 % → vakant | −1 067 → −1 783 $ | 1 Position, −2 $ |

Raster (Regel 2): weiter **0/3 für jede Familie**; csm reißt auf −0 nur noch PSR (0,876), auf −1 PSR + beats_market, auf −2 vier Gates. Entscheidung `stay_notrade`, kein Champion (csm war in #21 abgesetzt; ohne Amtsinhaber gab es keine nächtliche Prüfung mit festen Parametern — Nebenbefund A aus #21 ist unter der neuen Rechnung damit noch nicht gemessen). Papier-Erprobung: mean_reversion (Score 2,758, 8,0 Trades je Monat); regime_allocation (Score 3,468) übersprungen wegen 1,7 je Monat. Veröffentlicht: `meta/champion` (0 Symbole, 30 noTrade, 30 Erprobung), `meta/symbolProfile`.

### Erwartungen

1. **✔ gehalten.** Die K4-Zeile jedes Kandidaten zeigt offene Positionen nur am Kettenende („Offen am Kettenende": csm 4 / +463 $, regime 4 / +693 $, mean_reversion 4 / −103 $, momentum_pullback 1 / −2 $, trend_donchian keine). In #21 gab es diese Zeile noch nicht (Schritt 1 kam nach #21); dort standen die Positionen an bis zu 18 Fold-Enden als Notiz je Fenster.
2. **✘ GERISSEN — in die andere Richtung.** csm-Überschuss stieg von +1 505 auf +2 798 $, PSR von 0,742 auf 0,876; geschlossene Trades und Kettenergebnis rückten zusammen (roh +6 871 $, davon +3 849 $ aus 424 geschlossenen Trades und +463 $ Buchgewinn am Kettenende — in #21: roh +5 568 $ neben −178 $ aus geschlossenen Trades). Der zweite Teil der Erwartung (Differenz nur noch das Kettenende) hielt; der erste (weniger Überschuss, kleinere PSR) nicht. Die Vorregistrierung hatte den Trailing-Exit auf den Buchgewinnen gesehen (im Median 55 % hergegeben) und den Preis der Fold-Neustarts übersehen: Je Fold begann das Buch leer, jede Position musste neu einsteigen — Kosten, Tage ohne Exposition und eine frische Erstmarke (in #22 kosten die 31 Erstmarken-Stops −3 841 $, die 296 Trailing-Exits bringen +5 472 $). Ob das die ganze Erklärung ist, sagt nicht diese Vorregistrierung, sondern der Prüfer (unten).
3. **✘ GERISSEN.** Die Zahl bestandener Gates stieg bei drei Familien: csm +2 (fee_share, beats_market), regime_allocation +2 (fee_share, fold_positive_share), trend_donchian +1 (fee_share); mean_reversion und momentum_pullback unverändert. Nach dem Wortlaut der Erwartung ist +2 „ein Befund über die Rechnung, nicht über die Familie — dann Prüfer": **Prüfer beauftragt und fertig** (Engine-Red-Team, Bericht `pruefungen/2026-09-18-red-team-durchgehende-kette.md`, Urteil unten).
4. **✔ gehalten — als Beleg aber wertlos (Prüfer M4).** Walk-Forward-Schritt 10,5 min statt 18,0 min in #21. Der Prüfer rechnete nach: Die Kette spart je Familie und Raster nur 36 kurze Läufe von ≈ 2 900 (≈ 0,2 % der Entscheidungsarbeit) — das erklärt keine −42 %. Aufgeklärt aus den Job-Logs beider Läufe: Auch die UNVERÄNDERTE IS-Suche je Familie war in #22 um 39–45 % schneller (td 50 → 30 s, mp 35 → 22 s, mr 39 → 24 s, csm 70 → 41 s, regime 123 → 68 s; Raster −1/−2 gleichermaßen). Das ist der Runner, nicht der Code. Erwartung 4 war eine Sicherung gegen MEHR Arbeit; sie hat gehalten und beweist nichts anderes.
5. **✔ gehalten (Wächter im Code, kein zweiter Lauf).** `test/optimize/kette.test.ts`: `per_fold` ist bitgleich zu `simulateWindow` je Fold und trägt den Snapshot des alten Pfads; die IS-Suche ist unter beiden Schaltern identisch (Fold-Beste, Trials, Lieferparameter). Sichtbar im Bericht #22: Kopfzeile „OOS-Kette: EINE durchgehende Simulation".


### Prüfer-Urteil (Engine-Red-Team, `pruefungen/2026-09-18-red-team-durchgehende-kette.md`)

**„Die Rechnung hält, mit Einschränkungen M1–M4."** Kein Rechenfehler, kein Lookahead (G10), Scheiben/Normierung/Zuordnung/Zins Zeile für Zeile nachvollzogen und mit dem echten Simulator belegt; Stress symmetrisch (G7); Simulator = Engine beim Parameterwechsel (G8). Das Falsifikationskriterium hat gefeuert, weil das Modell des ALTEN Fehlers in §1 unvollständig war:

- **M1 — der Fold-Neustart hatte einen eigenen, gegenläufigen Preis:** leeres Buch, unverzinste Kasse (Tag 1 = 0), Park-Kauf mit Kosten am Tag 2, frische Erstmarken — 88,58 $ je Grenze bei 100 000 $ für einen Kandidaten, der NICHTS tut (`test/optimize/redteam-neustart.test.ts`); Plattform-Größenordnung ≈ 250–350 $ je Kette. Und das Trade-Set der Fold-Läufe schloss die laufenden Gewinner systematisch aus (nur Trades, die im 63-Tage-Fenster schließen) — **K5 war ein Symptom von K4:** Der Nenner von `fee_share` war nahe null, weil Gewinner nie Trades wurden (regime Signal-Exits: Trefferquote 15 % → 48 %). Von fünf Gate-Gewinnen sind drei `fee_share`, einer `fold_positive_share` um EINEN Fold, einer `beats_market`. Roh verlieren drei von fünf Familien in der Kette (mr, mp, td), zwei gewinnen — ein Rechenfehler hätte alle gleich getroffen. Bei csm sind 15/17 Folds besser; mechanisch erklärbar ≈ 250–350 $, der Rest (≈ 1 000 $) ist Pfad (geerbte Positionen mit nachgezogenem Trailing-Stop gegen frische mit Katastrophen-Stop) — aus zwei Läufen nicht abgrenzbar. Vorschlag des Prüfers: eine dritte Variante `oosChain: flatten` (durchgehend, aber an jeder Grenze alles `unmanaged` geschlossen) NUR für Vergleichsläufe — nicht gebaut, Owner-Frage.
- **M2 — der Maßstab lief nicht mit:** Die Strategie-Kette hat 1 112 Renditen, die SPY-Latte je Fenster 1 094 — die 18 Übergangstage fehlen ihr (≈ ±0,06 Sharpe; csms Abstand zur Latte 0,096). **Behoben mit Nachtrag** `2026-09-18-nachtrag-massstab-auf-der-kette.md` (Maßstab auf der Tagesachse der Kette, Wächter im Gate).
- **M3 — die Suche misst kalt, die Kette bewertet warm:** Fold k hängt jetzt von den Parametern der Folds 1…k−1 ab (td Fold 13: +381 → +1 341 $ bei 19 → 9 Trades). „Wie die Plattform nachts" gilt für den Champion-WECHSEL; unter Regel 2 laufen feste Parameter — die saubere Entsprechung ist `fixedParamsWfa` (Amtsinhaber, Festkandidat). Regel 2 hat gehalten (csm 9/8/6 Gates auf −0/−1/−2). Bleibt als Einschränkung dokumentiert (T4); keine Messänderung ohne Vorregistrierung.
- **M4 — Laufzeit:** aus den Job-Logs geklärt, siehe Erwartung 4.
- **G5** (`fee_share` equity-gewichtet) und **G6** (Lesefallen: echte Dollar neben normierten Summen; Fold-Tabelle; Fußnote) **behoben im Nachtrag**: Beträge der Scheiben auf E₀, K4-Zeile nennt die ganze Kette, Fold-Tabelle „OOS-Trades (Exit im Fold)", `oos_trades` nennt `unmanaged`-Trades (G8).
- **G9:** Die Fake-Wächter beweisen nur die Normierungsarithmetik; die entscheidenden Fälle stehen mit dem echten Simulator (drei neue Wächter des Prüfers übernommen). Erwartung 5 auf echten Daten steht aus (`optimize --as-of 2026-09-18` mit `per_fold` gegen #21 — bei Gelegenheit, kein Blocker: 18/18 gleiche Fold-Parameter und IS-Objectives in allen fünf Familien sind der indirekte Beleg).

### Was daraus folgt

- **Keine Schwelle, kein Gate, keine Beförderung.** Kein Kandidat besteht 3/3 — auch unter der neuen Rechnung handelt die Plattform nichts außer der Papier-Erprobung (mean_reversion, 8,0 Trades je Monat).
- **Die K4-These bleibt richtig, ihre Vorzeichen-Erwartung war falsch:** Buchgewinne an Fold-Enden gab es (bis zu 18 Fenster), und sie sind weg. Dass Familien mit langen Haltedauern (csm, regime) DURCHGEHEND besser aussehen, ist nach dem Prüfbericht der Preis des alten Fold-Neustarts plus Pfad, kein Rechenfehler — und **kein Befund über eine Kante**: csm reißt auf −0 die PSR (0,876), auf −1 PSR und beats_market, auf −2 vier Gates.
- **`per_fold` war für Trailing-/Rang-Strategien in Summe pessimistisch, für kurze Haltedauern neutral bis optimistisch** (Prüfer M1). Die `fee_share`-Befunde unter `per_fold` (K5, E2, tsmom) sind damit teilweise Artefakt des Trade-Sets — nachgemessen ist das nur für die fünf Familien in #22 (T23 trägt den Vermerk).
- **Nebenbefund A (#21: csm feste Parameter 3/3 auf drei Rastern)** ist unter der durchgehenden Kette ungemessen, weil kein Amtsinhaber mehr steht. Er wird erst als vorregistrierter Festkandidat messbar — Owner-Entscheidung; der Prüfer (M3) nennt genau diese Kette (ein Parametersatz, ein Buch) die saubere Entsprechung des Betriebs unter Regel 2.
- **Nächster Lauf:** der nächtliche #23 mit dem Nachtrag (Erwartungen dort); Raster −1 von #23 hat die Fenster von #22 Raster −0.
