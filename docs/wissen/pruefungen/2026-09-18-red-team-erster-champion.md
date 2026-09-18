# Red-Team über die erste Beförderung — `cross_sectional_momentum`, Lauf #18

**Prüfer:** eigener Agent, hat nicht gebaut, Auftrag zu WIDERLEGEN (§6) ·
**Gegenstand:** nächtlicher Optimierer-Lauf #18 (GitHub Actions Run
35294091567, 18.09.2026 01:08 UTC, Commit `cab6914`), Bericht
`optimize-2026-09-17.md` und `champion.json` aus Artefakt 10528025343 ·
**Vergleich:** Lauf #17 (35169670191, Artefakt 10475604946, Config-Commit
`dfaca57`) und Lauf #16 (35043069573, Artefakt 10426001718) — dieselbe
Familie, dasselbe Universum (30 von 139, „Zugang: — Abgang: —"), dieselben
Regeln, derselbe Seed 42, jeweils ein Handelstag mehr ·
**Leitfrage:** „Beweise, dass 3,357 falsch ist."

Die Zahl selbst ist nicht falsch gerechnet: Sie ist der Median der 18
Fold-Sortinos, die der Bericht zeigt, und ich habe im Code keinen Lookahead
gefunden (G10). Falsch ist, was aus ihr gemacht wurde. **Dieselbe Kette hat in
drei aufeinanderfolgenden Nächten 6/10, 5/10 und 10/10 Gates bestanden**, ihr
OOS-Sharpe lag bei 0,56 / 0,20 / 0,69 gegen eine SPY-Latte von 0,53 / 0,56 /
0,46 — im Mittel unter der Latte. Die Beförderung ist das Maximum von drei
Ziehungen, und der Weg dahin hat vier Fehler, die sich gegenseitig verdecken:
ein Zufallsgenerator, der Strategien aneinander koppelt (K2), eine
Fold-Kette, deren Überschuss zu vier Fünfteln aus nie geschlossenen Positionen
besteht (K4), ein Gebührengate mit einem Nenner nahe null (K5) und ein
Beförderungspfad, der jede Nacht von vorn entscheidet (M7). Vorab: Der
Champion ist auf der Plattform nie angekommen — der Lauf ist an Firestore
gescheitert (M7), die Plattform steht auf dem Stand von #17.

Was ich vorab geprüft und **nicht** gefunden habe: Zwischen `dfaca57` (#17)
und `cab6914` (#18) ändern sich nur `src/engine/engine.ts` und
`functions/src/engine/journal.ts` (Journal-Schreiben der Engine) — kein
Optimierer, keine Strategie, kein Gate, keine Config. Beide Läufe: 19
Korbstände aus 139 Kandidaten, `Kalender: 2029 Handelstage`, Backfill exakt
+1 Bar je Symbol (77112 → 77162, 76925 → 76975, 61626 → 61666), `Zinsreihe
BIL: 1528` → `1529 Handelstage`. Die Prämisse „einziger Unterschied ist der
Anker" stimmt für Code, Config und Universum. Sie stimmt **nicht** für die
Kandidatenlisten der Suche — das ist K2.

---

## K1 — Drei Nächte, drei Urteile: Die Beförderung ist das Maximum von drei Ziehungen (BESTÄTIGT)

**Ort:** `src/optimize/promote.ts` (`decidePromotion`: „erste Beförderung",
sobald EIN Lauf alle Gates nimmt), `src/optimize/run.ts` (Aufruf je Nacht),
`docs/wissen/thesen.md` T4 (Konsequenz: „Falsifikationslauf (Raster + Seed)
für jeden Treffer, bevor er zählt" — steht in der Bibliothek, nicht im Code).

**Beleg.** Dieselbe Familie auf demselben Korb unter denselben Regeln, aus den
drei Berichten (Gate-Tabellen wörtlich übernommen):

| Lauf (Anker) | OOS-Sharpe p. a. (Überschuss) | SPY-Latte | PSR | fold_positive_share | fold_concentration | fee_share | Gates | finalParams (lb/skip/top/exit/vol/atrLen/atrMult/trail) |
|---|---:|---:|---:|---:|---:|---:|---|---|
| #16 (2026-09-15) | 0,56 | 0,534 | 0,880 ✘ | 10/18 ✘ | 55 % ✘ | 132,7 % ✘ | **6/10** | 20/4/0.35/0.3/0/7/4/1 |
| #17 (2026-09-16) | 0,20 | 0,560 | 0,663 ✘ | 9/18 ✘ | 138 % ✘ | 276,4 % ✘ | **5/10** | 20/4/0.35/0.3/0/7/4/1 |
| #18 (2026-09-17) | 0,69 | 0,455 | 0,925 ✔ | 13/18 ✔ | 34 % ✔ | 28,4 % ✔ | **10/10** | 100/2/0.1/0.6/0/7/3.5/1 |

Logzeilen: #17 `Korb (30 Symbole) cross_sectional_momentum: OOS-Median 1.813,
Folds positiv 61 %, 505 Trades, netto 5094.41, 2850 Trials` → `Gates NICHT
bestanden (fold_positive_share, fold_concentration, probabilistic_sharpe_oos,
fee_share, beats_market)`; #18 `Korb (30 Symbole) cross_sectional_momentum:
OOS-Median 3.357, Folds positiv 83 %, 424 Trades, netto 7476.09, 2850 Trials`
→ `Gates bestanden (–)` → `Korb (30 Symbole): promote — erste Beförderung:
cross_sectional_momentum besteht alle Gates (Score 3.357)`.

**Wirkung, quantitativ.**

1. *Die Latte liegt innerhalb des Rauschens.* Der Standardfehler eines
   annualisierten Sharpe über T = 1112/252 = 4,4 Jahre ist ≈ √((1 + SR²/2)/T)
   ≈ 0,53. Der Abstand 0,69 − 0,455 = 0,23 ist **0,4 Standardfehler**. Die
   Nacht-zu-Nacht-Streuung der gemessenen Kette (0,56 / 0,20 / 0,69; drei
   Punkte, also nur eine Größenordnung) ist 0,25 — die Latte (0,52 im Mittel)
   liegt eine halbe Nacht-Streuung neben dem Mittel der Kette (0,48).
2. *`beats_market` ist ein Punktvergleich; die Wahrscheinlichkeit dahinter ist
   ein Münzwurf.* Mit der PSR-Formel aus `backtest/metrics.ts` und den Werten
   der Gate-Notiz (SR/Periode 0,043, n = 1112, Schiefe −0,07, Kurtosis 5,54)
   reproduziere ich den berichteten PSR gegen null (0,924 ≈ 0,925). Setzt man
   als `sr0` die Latte selbst ein (0,455/√252 = 0,0287 je Tag), ergibt sich
   **P(wahrer Sharpe > SPY) = Φ(0,477) = 0,68.** Für #17 (SR 0,013) gibt
   dieselbe Rechnung 0,667 ≈ berichtete 0,663 — die Formel stimmt.
3. *Die PSR-Schwelle 0,9 heißt bei n = 1112: Sharpe p. a. ≥ 0,61.* #18 liegt
   mit 0,69 um 0,08 darüber, #16 mit 0,56 um 0,05 darunter. Die Gates PSR,
   `beats_market`, `fold_positive_share` und `fold_concentration` hängen an
   derselben Fold-Kette und kippen gemeinsam: In der Nacht mit dem höchsten
   Sharpe bestehen alle, in der mit dem niedrigsten fallen fünf.
4. *Der nächtliche Neu-Lauf ist ein ungezählter Freiheitsgrad.* Der DSR
   deflationiert die 2 850 Trials EINER Nacht (und sagt selbst „würde als Gate
   durchfallen", G11). Er zählt weder die fünf Familien je Nacht noch die
   Nächte. Von drei vergleichbaren Nächten (seit dem BIL-Maßstab, #16) hat
   eine bestanden; mit einer Bestehenswahrscheinlichkeit von einem Drittel je
   Nacht ist die erste Beförderung binnen fünf Nächten zu 87 % zu erwarten —
   **ohne dass die Kette im Mittel die Latte nimmt.** Genau das ist eingetreten.

**Vorschlag.** T4 in den Code holen, nicht als dritte Latte, sondern als
strengere Anwendung der bestehenden (§0.9 erlaubt strenger ausdrücklich):
`promote` erst, wenn derselbe Kandidat auf k Rastern (z. B. Anker −0/−1/−2
Handelstage, ein zweiter Seed) alle zehn Gates nimmt — im Lauf selbst, mit
`--as-of`, das es schon gibt. Bis dahin gilt: Ein Bestehen in einer Nacht ist
eine Ziehung, kein Urteil. Vorregistrieren, bevor es läuft.

## K2 — Der Kandidat von #18 wurde mit anderen Losen gezogen als der von #17: Der Zufallsgenerator koppelt die Strategien (BESTÄTIGT)

**Ort:** `src/optimize/search.ts` `sampleParams` (Zeilen 122–158),
`src/optimize/run.ts:1105` (`const rng = mulberry32(optimizer.seed)` — EIN
Generator für den ganzen Lauf, Reihenfolge der Strategien wie in der Config:
td → mp → mr → csm → regime), `src/optimize/walkForward.ts` `walkForward`
(finale Suche mit `finalInclude = [...include, ...foldResults.map(f =>
f.best.params)]`).

**Beleg.** `sampleParams` schiebt zuerst die Seeds (`for (const p of include)
push(snapToGrid(p, space))`) und zieht dann Zufallspunkte, **bis `out.length`
die Stichprobe erreicht** (`while (out.length < n …)`). Die Seeds zählen mit.
In der finalen Suche sind die Seeds Defaults ∪ 18 Fold-Beste; wie viele davon
einzigartig sind, bestimmt, wie viele Zufallszüge verbraucht werden — und
damit den Zustand des Generators für die NÄCHSTE Strategie.

Aus den drei Berichten (Fold-Tabellen, Parameter je Fold):

| Strategie (Suchreihenfolge) | gleiche Fold-Parameter #16↔#17 | gleiche Fold-Parameter #17↔#18 | Fold-Bester = Defaults |
|---|---:|---:|---|
| trend_donchian | 13/18 | 13/18 | nie |
| momentum_pullback | 13/18 | 12/18 | nie |
| mean_reversion | 15/18 | 14/18 | **#16 und #17: Fold 17 (`{200,2,10,65,20,2,0,3,7}`); #18: keiner** |
| cross_sectional_momentum | 10/18 | **0/18** | nie |
| regime_allocation | 16/18 | **2/18** | — |

In #16 und #17 hat die finale `mean_reversion`-Suche 18 einzigartige Seeds
(die Defaults fallen mit dem Fold-17-Besten zusammen), in #18 hat sie 19. Ein
Seed mehr heißt ein Zufallspunkt weniger — und danach ist der Generator um
einen Zug versetzt: **Alle 2 850 Kandidaten von `cross_sectional_momentum` in
#18 sind andere Gitterpunkte als in #17.** Die Tabelle zeigt genau diesen
Bruch: bis `mean_reversion` 12–15 von 18 Folds gleich (die Abweichungen sind
die Tagesverschiebung), ab `cross_sectional_momentum` null.

Dass es nicht die Daten sind, zeigen die Folds mit identischen Handelstagen:
`trend_donchian` Fold 4 steht in beiden Berichten mit `7.860 | 0.387 | 10 |
+74.99`, Fold 10 mit `12.489 | 1.733 | 66 | +585.34` — zeichengleich. Bars und
Korb waren dort also identisch. `cross_sectional_momentum` Fold 4, dieselben
Tage, derselbe Korb: #17 `{120,1,0.35,0.3,0,14,3.5,1}` IS 5,970 → +42,57 $ (44
Trades); #18 `{120,1,0.05,0.4,0,21,3.5,1}` IS 5,622 → +189,88 $ (21 Trades).
Andere Kandidaten, anderer Bester, anderes Ergebnis.

**Wirkung.** Die 150 Stichproben je Fold sind 0,05 % eines Gitters von
6·6·7·6·2·3·6·6 = 326 592 Punkten. Welche 0,05 % ein Kandidat bekommt, hängt
davon ab, ob eine ANDERE Strategie in einem ihrer Folds zufällig ihre Defaults
gewählt hat. Der Kommentar in `run.ts` („gleiche Config + gleicher Seed ⇒
identisches Ergebnis") gilt für den Lauf als Ganzes, nicht für den Kandidaten:
Die Beförderungsnacht hat mit einem anderen Los gespielt als die Nacht davor.
Ein Vergleich „#17 gegen #18" misst deshalb nicht die Wirkung eines Tages,
sondern die Wirkung eines Tages **plus** einer neuen Stichprobe.

**Vorschlag.** Generator je Strategie und Fenster ableiten (Seed ⊕ Hash der
Strategie-ID, optional ⊕ Fold-Index), und Seeds nicht gegen die Stichprobe
zählen (n Zufallspunkte ziehen, Seeds davorstellen). Wächter: zwei Läufe mit
gleichen Bars, in denen nur die Strategieliste anders geordnet ist, müssen je
Strategie dieselben Fold-Parameter liefern — rot vor dem Fix.

## K3 — Raster: 0 von 18 gleiche Parameter, 4 Vorzeichenwechsel, +2 382 $ aus drei Folds (BESTÄTIGT; Anteil K2 nicht abgrenzbar)

**Ort:** `src/optimize/walkForward.ts` `buildFolds` (am Ende verankert),
`searchWindow` (Argmax über 150 Kandidaten), `src/backtest/simulator.ts`
(Portfolio mit 4 Plätzen, Rangordnung: pfadabhängig).

**Beleg — Fold für Fold, beide Logs nebeneinander** (OOS-Fenster von #18;
`IS … → OOS … (n Trades, netto …)` wörtlich aus den Zeilen `Korb (30 Symbole)
cross_sectional_momentum Fold k/18`):

| Fold | OOS (#18) | #17 OOS-Obj. | #17 n | #17 netto | #18 OOS-Obj. | #18 n | #18 netto | Δ netto | Vorz. |
|---:|---|---:|---:|---:|---:|---:|---:|---:|:-:|
| 1 | 2021-10-13 … 2022-01-11 | −3,189 | 18 | −682,98 | 0,961 | 6 | +217,36 | +900,34 | ≠ |
| 2 | 2022-01-11 … 2022-04-11 | −2,114 | 37 | −484,51 | −1,262 | 23 | −513,01 | −28,50 | = |
| 3 | 2022-04-11 … 2022-07-10 | −2,849 | 24 | −608,46 | −2,689 | 26 | −695,48 | −87,02 | = |
| 4 | 2022-07-10 … 2022-10-08 | 0,271 | 44 | +42,57 | 1,897 | 21 | +189,88 | +147,31 | = |
| 5 | 2022-10-08 … 2023-01-06 | 2,086 | 20 | +325,28 | 3,888 | 27 | +544,88 | +219,60 | = |
| 6 | 2023-01-06 … 2023-04-06 | 1,539 | 37 | +246,80 | 5,680 | **3** | +1110,59 | +863,79 | = |
| 7 | 2023-04-06 … 2023-07-05 | 7,760 | 6 | +1706,26 | 9,314 | 32 | +1001,99 | −704,27 | = |
| 8 | 2023-07-05 … 2023-10-03 | −1,050 | 22 | −128,89 | 1,606 | 14 | +233,65 | +362,54 | ≠ |
| 9 | 2023-10-03 … 2024-01-01 | 8,091 | 23 | +1110,74 | 2,986 | 35 | +451,67 | −659,07 | = |
| 10 | 2024-01-01 … 2024-03-31 | 7,190 | 36 | +1263,00 | 6,513 | 23 | +1470,23 | +207,23 | = |
| 11 | 2024-03-31 … 2024-06-29 | 3,413 | 31 | +789,12 | 3,775 | 20 | +567,78 | −221,34 | = |
| 12 | 2024-06-29 … 2024-09-27 | −0,201 | 40 | −80,53 | 0,198 | 29 | +22,41 | +102,94 | ≠ |
| 13 | 2024-09-27 … 2024-12-26 | 6,875 | 31 | +840,77 | 3,546 | 26 | +509,28 | −331,49 | = |
| 14 | 2024-12-26 … 2025-03-26 | −2,721 | 21 | −516,40 | −0,205 | 19 | −40,33 | +476,07 | = |
| 15 | 2025-03-26 … 2025-06-24 | 3,468 | 26 | +488,98 | 3,835 | 15 | +595,44 | +106,46 | = |
| 16 | 2025-06-24 … 2025-09-22 | 6,033 | 29 | +936,84 | 8,195 | 46 | +831,87 | −104,97 | = |
| 17 | 2025-09-22 … 2025-12-21 | 2,573 | 22 | +265,00 | 3,168 | 32 | +539,96 | +274,96 | = |
| 18 | 2025-12-21 … 2026-03-21 | −2,369 | 38 | −419,18 | 4,336 | 27 | +437,91 | +857,09 | ≠ |
| Σ | | Median 1,813 | 505 | +5094,41 | Median 3,357 | 424 | +7476,08 | +2381,67 | 14/18 |

Dazu:

- **Handelstage.** Mit den Grenzen „Datum 04:00:00.001 Z" (die Bar des
  Grenzdatums gehört zum früheren Fenster; meine Zählung trifft die
  berichteten 1113 bzw. 1112 OOS-Tage exakt) unterscheiden sich 14 Folds um
  je einen Tag am Rand; **Folds 4, 10, 11 und 18 haben identische
  OOS-Handelstage** und liefern trotzdem +42,57/+189,88, +1263/+1470,
  +789/+568 und −419/+438 $. Fold 18 (2025-12-22 … 2026-03-20, identisch in
  beiden Läufen): #17 `{20,4,0.25,0.4,0,21,3.5,1}` → −419,18 $, #18
  `{20,0,0.05,0.7,0,14,3.5,1}` → +437,91 $.
- **Parameter.** 0 von 18 Folds mit demselben Parametersatz (bei #16↔#17
  waren es 10). Der Lieferwert kippt von `{20,4,0.35,0.3}` (#16 = #17) auf
  `{100,2,0.1,0.6}`: aus „stärkstes Drittel, raus unter Rang 9, 20 Tage
  Rückblick" wird „stärkste drei, raus unter Rang 19, 100 Tage Rückblick" —
  eine andere Strategie mit demselben Namen.
- **Konzentration.** `fold_concentration` besteht mit 34 % (bester Fold
  1 136,96 von 3 387,79 $ Überschuss). Roh tragen die drei besten Folds 48 %
  (#17: 80 %). Die drei größten Zugewinne #17 → #18 (Folds 1, 6, 18: +2 621 $)
  übersteigen die gesamte Differenz (+2 382 $) — ohne sie wäre #18 nicht
  besser als #17. Fold 6 gewinnt 1 110,59 $ mit **3 Trades** (OOS-Sortino
  5,68); das Gate zählt Folds, nicht Trades.

**Wirkung.** Der Simulator ist ein Portfolio mit vier Plätzen und
Rangordnung: Ein Tag am Fensterrand ändert den ersten Einstieg, der den
zweiten verdrängt, und so den Pfad des ganzen Jahres — je Kandidat. Das
Argmax über 150 pfadabhängige Objectives ist eine Neuziehung, und die
OOS-Kette ist die Folge von 18 solchen Ziehungen (T4, §5a.15: „nicht EINE
Strategie, sondern sechzehn"). Wie viel davon der Tag und wie viel die neuen
Lose (K2) sind, lässt sich aus zwei Nächten nicht trennen; bei den drei
Familien ohne K2-Bruch bewegt der Tag allein 3–6 von 18 Folds.

**Vorschlag.** Wie K1: Raster-Falsifikation im Lauf. Im Bericht eine Zeile
„Parameter-Stabilität": Anteil gleicher Fold-Parameter zur Vornacht und
Distanz der finalParams — dann sieht man den Bruch, statt ihn zu suchen.

## K4 — Vier Fünftel des Überschusses sind kein Handel: offene Positionen an 18 Fold-Enden (BESTÄTIGT, Höhe geschätzt)

**Ort:** `src/backtest/simulator.ts:646` (`if (range && t >= range.end)
break;`), `:895–902` (Abschluss: `Offen am Ende: … (unrealisiert …, ohne
Exit-Kosten)` — Position bleibt, wird kein Trade), `src/optimize/walkForward.ts`
`walkForward`/`aggregateOos` (je Fold eigener `simulateWindow`-Lauf mit
`initialEquity`, leeres Buch), Bericht: „Gleichzeitige Positionen 2.60 …
(Positionen, die am Fensterende offen blieben, fehlen)".

**Beleg.** Zwei „Netto" im selben Block: `oos_net_profit` sagt `OOS Überschuss
3387.79 (roh 7476.09, 34.03 %)`; die Exit-Anatomie sagt `(424 Trades, Netto
+1470.75 $)`. Herleitung der Lücke aus den Berichtszahlen:

| Posten | $ | Quelle |
|---|---:|---|
| OOS-Kette roh | 7 476,09 | Gate `oos_net_profit` |
| davon Zinsrechnung der Gates (roh − Überschuss) | 4 088,30 | dieselbe Notiz |
| OOS-Kette im Überschuss | 3 387,79 | Gate-Wert |
| geschlossene Trades netto (424 Round-Trips) | 1 470,75 | Exit-Anatomie |
| Zins, den gebundenes Kapital (16,7 %) nicht verdient, im Überschuss aber abgezogen wird | ≈ −680 | 0,167 × 4 088 |
| **Rest: Buchgewinne offener Positionen an Fold-Enden, ohne Exit** | **≈ 2 600** | 3 388 − 1 471 + 680 |

Rund 2 600 $ von 3 388 $ Überschuss stammen aus Positionen, die nie ein Trade
wurden (18 Fold-Enden × 2,6 Positionen ≈ 47 Positionen, ≈ 55 $ je Position
≈ 3,8 % auf ~1 500 $ Positionsgröße — mehr als der Median-Gewinner der
geschlossenen Trades mit 2,63 %). Das ist bei DIESER Strategie kein Zufall:
Die Verlierer gehen schnell über Stop (40 Trades, Ø 5,3 Bars, 0 %
Trefferquote), die Gewinner laufen — und werden am Fold-Ende zum Schlusskurs
bewertet statt zum Trailing-Exit, der nach der eigenen Anatomie im Median
**55 % des Buchgewinns wieder hergibt** („Gewinner: mitgenommener Anteil des
Buchgewinns … Median 0.45"). Der nächste Fold beginnt leer. `stress_costs`
(3 080,49 $) trifft nur die Gebühren der geschlossenen Trades: 3 387,79 −
3 080,49 = 307 $ ≈ 0,5 × 584 $ (Gebühren, siehe K5).

Dieselbe Verzerrung hat der Prüfer der Basis-Stufe am 09.09. gefunden
(Prüfbefund M6: „offene Positionen am Fold-Ende zählten nicht als Trades,
Exit-Kosten fehlten, jedes Fenster begann mit leerem Buch") — die Basis wird
seitdem durchgehend simuliert (`basisSimulation`). **Die Alpha-Kette hat den
Fehler noch**, und für eine Trailing-Stop-Strategie mit 98 % Zeit im Markt ist
er nicht klein.

**Wirkung.** `oos_net_profit`, `fold_positive_share`, `fold_concentration`,
`stress_costs`, PSR und `beats_market` rechnen alle auf der Equity-Kette, also
mit den 2 600 $. Auf den geschlossenen Trades allein (+1 471 $ über 4,4 Jahre,
3,5 $ je Trade) wäre der Kandidat nichts. Die Höhe ist geschätzt; die exakte
Summe steht in den Simulator-Notizen („Offen am Ende"), die der Bericht nicht
druckt.

**Vorschlag.** (1) Σ „Offen am Ende" je Kandidat in die Maßstab-Zeile —
sofort, ohne Messänderung. (2) Die OOS-Kette durchgehend simulieren wie die
Basis: Parameterwechsel an der Fold-Grenze, Positionen laufen weiter, ein
Buch, ein Peak (der Simulator kann heterogene Wahl je Symbol; ein Wechsel je
Zeitpunkt fehlt). Vorregistrieren: Erwartung ist, dass Überschuss und PSR der
csm-Kette dabei deutlich fallen.

## K5 — `fee_share` ist nicht die dokumentierte Größe und kippt mit einem Nenner nahe null (BESTÄTIGT)

**Ort:** `src/optimize/walkForward.ts` `aggregateOos` (`gross += t.grossPnl`
über ALLE Trades; `feeShare: gross > 0 ? fees / gross : null`),
`src/optimize/robustness.ts` (Gate liest `oos.feeShare`), gegen
`src/backtest/metrics.ts` `computeMetrics` (`sumGrossPos` nur Gewinner —
das ist die Definition, die der Prüfauftrag und `befunde.md` #16 nennen und
die im Holdout-Block derselben Spalte steht).

**Beleg.** Nenner = Σ Brutto aller Trades = Trades-Netto + Gebühren. Daraus
mit `fees = feeShare · netto / (1 − feeShare)`:

| Lauf | Trades-Netto (Exit-Anatomie) | fee_share (Gate) | ⇒ Gebühren | ⇒ Nenner Σ Brutto |
|---|---:|---:|---:|---:|
| #16 | −180,45 $ | 132,7 % | ≈ 732 $ | ≈ 552 $ |
| #17 | −464,29 $ | 276,4 % | ≈ 727 $ | ≈ 263 $ |
| #18 | +1 470,75 $ | 28,4 % | ≈ 584 $ | ≈ 2 055 $ |

Die Gebühren sinken um 20 % (weniger Trades, ≈ 1,4 $ je Round-Trip auf
≈ 1 500 $ Position — plausibel für 10 bp), der Nenner wächst um den Faktor
7,8. Der Nenner ist die Differenz zweier Größen im Bereich von zehntausend
Dollar (Bruttogewinne der Gewinner minus Bruttoverluste der Verlierer); ein
einziger Trade von +500 $ verschiebt das Gate um ein Viertel. **In #18 besteht
`fee_share` nicht, weil weniger Gebühren anfielen, sondern weil die
Verlierer kleiner waren** — dieselbe Zahl, die schon `oos_net_profit` misst.
Zwei Definitionen unter einem Namen: Der Bericht #18 zeigt „Gebührenanteil
28.4 %" (Kette, Σ aller Trades) und im Holdout desselben Kandidaten
„Gebührenanteil 1.3 %" (Fenster, nur Gewinner) — als wäre der Holdout
zwanzigmal billiger. CLAUDE.md §2 („Gebühren 3 049 $ bei brutto +1 456 $")
meint die Ketten-Definition; `befunde.md` #16 („sumGrossPos") die andere.

**Vorschlag.** Eine Definition, wörtlich in der Gate-Notiz. Die
Gewinner-Definition ist stabil (Nenner ≈ 25 000–35 000 $, Anteil hier 2–3 %),
misst aber etwas anderes als der Vorgänger-Befund; die Ketten-Definition
misst „ist der Handel nach Gebühren positiv" — dann ist sie mit
`oos_net_profit` auf Trades redundant und ihre Rasterempfindlichkeit gehört
in den Bericht. Owner-Entscheidung; in jedem Fall die Holdout-Spalte
angleichen.

## M6 — `beats_market`: Die Latte ist selbst rasterempfindlich, der Vergleich kennt keine Unsicherheit, und er misst gegen SPY statt gegen den Korb, aus dem gewählt wird

**Ort:** `src/optimize/robustness.ts` (`pass: srAnnual > latte`),
`src/backtest/marktbezug.ts` `marktKette` (jedes Fenster startet frisch
gleichgewichtet), `src/optimize/run.ts` `marktLatteFuer` („Bewusst die
BENCHMARK (SPY), nicht der Korb").

**Beleg.** SPY-Latte über dieselben 18 Fenster: 0,534 (#16), 0,560 (#17),
0,455 (#18); MaxDD der SPY-Kette 22,11 / 22,11 / 23,89 %. Ein Tag Versatz an
19 Fensterrändern bewegt die Latte um 0,10 Sharpe — ein Fünftel ihres
Betrags. P(SR > Latte) = 0,68 (K1). Im Holdout schlägt der punkt-in-zeit
gewählte Korb SPY in der Rendite (+25,59 % gegen +16,67 %), nicht im Sharpe
(2,16 gegen 2,42); über die OOS-Kette zeigt der Bericht den Korb gar nicht.
T7 ist bestätigt („Dollarumsatz ist ein Momentum-Tilt"): Wer aus einem
Momentum-gekippten Korb die Stärksten kauft, erbt den Tilt — das Gate
schreibt ihn der Strategie zu.

**Vorschlag.** In der Notiz von `beats_market` den PSR gegen `sr0 = Latte`
ausweisen (dieselbe Formel, ein Parameter mehr; strenger, keine dritte
Latte). „Korb je Fold liegenlassen" als zweite Maßstab-Zeile über die
OOS-Kette (`marktKette` mit Membership) — nur Bericht.

## M7 — Der Champion kam nie an; der Amtsinhaber-Pfad hat nie gegriffen; die Korrektur macht eine Rausch-Nacht neun Monate lang unabsetzbar

**Ort:** `scripts/publish-champion.mjs` (Stand `cab6914`: `batch.set(…, {
...champion })` mit den vollen OOS-Ketten), `.github/workflows/optimize.yml`
(Stand `cab6914`: Cache-Pfad nur `var/bars` und `var/universe.json`),
`src/optimize/promote.ts` `decidePromotion`.

**Beleg, Log #18:** `Error: 3 INVALID_ARGUMENT: too many index entries for
entity /meta/champion` … `##[error]Process completed with exit code 1.` Die
`champion.json` des Artefakts hat 2 025 430 Bytes: 30 Einträge mit je 1 112
`dailyReturns` und 1 112 `dayKeys` (Firestore indiziert jedes Element). Die
Schritte Config-Sync und Symbolprofil liefen nicht, kein `Cache saved` (in #17:
`Cache saved with key: bars-us_equity-iex-all-35169670191`). **Die Plattform
steht auf #17:** `Veröffentlicht: meta/champion (0 Symbole, 30 noTrade, 30
Papier-Erprobung (durchgefallen, nur Papier), keine Basis)` — die Erprobung
handelt `regime_allocation`, der „Champion" handelt nirgends. (Parallel zu
dieser Prüfung wird genau das behoben — `championDoc.mjs`, Schritt
„Amtsinhaber aus Firestore holen"; ich habe die Dateien nicht angefasst.)

**Amtsinhaber.** Der Cache hielt `champion.json` nie; jede Nacht fand
`loadChampion` nichts, und `decidePromotion` schrieb „erste Beförderung". Mit
diesem Pfad wäre der Champion mit dem Raster geflackert: heute `promote`,
morgen `stay_notrade` (räumt `symbols`, Prüfbefund 4.1), übermorgen wieder
`promote` — jede Nacht eine andere Parametrisierung auf 30 Symbolen, deren
offene Positionen die neue Parametrisierung führt (`decide()` prüft
`pos.strategy`, nicht die Parameter). Der neue Workflow-Kommentar sagt es
selbst: „Ohne diesen Schritt fand der Optimierer jede Nacht keinen
Amtsinhaber, entschied von vorn („erste Beförderung")".

**Mit** Amtsinhaber kippt es ins Gegenteil: `fitEnd` = 2026-03-21, saubere
Folds brauchen `oosStart ≥ fitEnd`, und drei davon gibt es erst, wenn das
Datenende ≥ 2027-06 liegt. Bis dahin gilt „zu wenig sauberes OOS —
Beförderungs-Score gilt weiter", und ein durchfallender Kandidat führt zu
`keep` (`incumbentRescore > 0`). **Ein Kandidat, der in zwei von drei Nächten
fünf Gates reißt, wäre nach der ersten guten Nacht neun Monate lang durch die
Messung nicht absetzbar** — nur durch einen Besseren mit Score ≥ 3,69.

**Vorschlag.** Beförderung an K1 binden (mehrere Raster, nicht mehrere
Nächte). Für den Amtsinhaber ohne sauberes OOS eine Regel, die den Owner
braucht: z. B. Absetzung, wenn der Kandidat derselben Familie in N
Folgenächten die Gates reißt — vorregistrieren.

## M8 — Korb je Fold ist rasterempfindlich, der Bericht druckt keine Mitglieder, und der heute gehandelte Korb ist ein anderer als der gemessene

**Ort:** `src/optimize/korbJeFold.ts` (Hysterese Stand für Stand),
`src/universe/select.ts` (`haltePuffer 5`), Bericht „Korb je Fold".

**Beleg.** Von 19 Ständen unterscheiden sich 10 in Zugang/Abgang (u. a.
2023-01: BRK.B/EFA; 2023-04: INTC; 2023-07: SNOW/BRK.B; 2023-10: XLE/SNOW;
2025-03: UBER/INTU; 2025-06: XLV/INTU; 2025-09: XLV↔XOM; 2025-12: XLK/UBER;
2026-03: EEM/XLK) — ein Tag mehr Umsatzdaten kippt Ränge 30–35, die Hysterese
trägt es weiter. Für eine Rang-Strategie ist das keine Randnotiz: `pct =
k/(of − 1)` — jedes Mitglied verschiebt die Kennzahl aller. Welche 30 Namen
ein Stand enthält, steht nicht im Bericht; die Fortpflanzung ist damit nicht
nachlesbar. Und: „**Heute gehandelt wird ein anderer Korb** als der des
letzten Standes … Zugang AMAT, LRCX, MRVL, SOXX, XLE, Abgang EFA, GLD, SLV,
TLT, XOM" — die vier Diversifizierer raus, Halbleiter rein; unter den 30
heutigen Titeln sind mindestens zehn Halbleiter/Tech-Hardware. Die finalen
Parameter (`topPct 0.1`: die stärksten drei nach 100-Tage-Rohrendite,
`volAdjust 0`) wurden auf einem Korb mit Gold, Silber, Treasuries und EFA
gesucht und werden auf einem Korb ohne sie gehandelt.

**Vorschlag.** Mitgliederliste je Stand in Bericht oder `champion.json`;
Gegenprobe der finalen Parameter auf dem heutigen Korb (`foldMembership:
fixed`, nur Bericht).

## M9 — Survivorship: Der Kanal ist die Zusammensetzung des Pools von 2026, nicht die Delistings (VERMUTUNG mit Weg)

**Ort:** `config/platform.yaml` `universe.candidates` (139 Namen, von Hand,
37 davon Technologie/Halbleiter), `docs/ARCHITEKTUR.md` §5a.13.

**Was ich belegen kann:** Der Pool enthält keinen Namen, der 2021–2023 zu
den umsatzstärksten gehörte und heute klein oder verschwunden ist (u. a.
TWTR, ATVI, XLNX, SPLK, VMW, SIVB, FRC; ebenso BABA, NIO, PLTR, COIN, HOOD,
RIVN, GME, AMC, MRNA, ARKK, die 2021–22 Top-30-Umsätze hatten). Die Stände
2023–2025 sind AI-Boom-Körbe aus Namen, die 2026 groß sind.

**Was ich vermute:** Für eine Top-3-Momentum-Strategie ohne Vol-Anpassung
zählt weniger, wer delistet wurde, als wer im Pool steht: Die Gewinner
2023–2025 (NVDA, AVGO, META, TSLA, AMD, MU, LLY, ORCL) sind garantiert
Kandidaten; die Kandidaten des Hypes 2021–22 fehlen (Folds 1–4 sind ohnehin
negativ; mit ihnen vermutlich stärker). Richtung insgesamt optimistisch, Höhe
unbekannt.

**Weg zum Beleg.** Die zwanzig umsatzstärksten fehlenden Namen 2021–2023 mit
Delisting-Datum in den Pool, Lauf mit `--as-of`; und eine Symbol-Konzentration
in den Bericht (Anteil des OOS-Nettos aus dem besten Symbol — der Verdacht
sind die NVDA-Quartale: Fold 6 +1 110 $ aus 3 Trades, Fold 7, Fold 10).

## G10 — Lookahead: keiner gefunden (was geprüft wurde)

- `strategy/crossSectionalMomentum.ts`: `momentum` liest `close[i−skip]` und
  `close[i−skip−lookback]`; `stddev` über `windowMoments` emittiert bei `i`
  aus `[i−n+1, i]`; `atr` = `wilderSmooth(trueRange)`, rekursiv aus der
  Vergangenheit, `trueRange` mit `c[i−1]`; `indAt` liest genau `i`.
- `core/logic.ts` `korbRaenge`: rangiert nur Symbole, deren Bar die jüngste
  des Zyklus ist; `crossScore` sieht `snap.bars = prefix(i+1)`. Rang wird in
  `decide()` gebaut, nirgends sonst.
- `backtest/simulator.ts`: Entscheidung am Schluss von Bar i, Fill am Open von
  Bar i+1; Stop vor Ziel.
- `optimize/korbJeFold.ts` + `universe/select.ts` `bewerte`: `t <= jetzt` mit
  `jetzt` = OOS-Beginn; die Bar des Grenzdatums liegt VOR der Grenze
  (…04:00:00.001 Z) und gehört zum IS. Die IS-Suche läuft auf dem Korb zum
  OOS-Beginn — bewusst (Nachbildung der Nacht), im Modulkopf benannt.
- `walkForward.ts`: `finalInclude` enthält die Fold-Besten, `include` des
  Amtsinhabers geht nicht in die Fold-Suche.

Nicht prüfbar aus Logs: ob `Backfill 1Day (all, vollständig)` mit
`adjustment: all` zwischen zwei Nächten historische Kurse neu skaliert
(Ex-Dividende am 17.09.). Die zeichengleichen `trend_donchian`-Folds 4 und
10 sprechen dagegen — für die dort gehandelten Symbole.

## G11 — Die DSR-Zeile: der Lieferwert hat weniger Evidenz als jeder einzelne Fold

Wörtlich: `deflated_sharpe_is | ✔ | 0.371 | 0.950 | informativ
(dsrIsGate=false): DSR 0.371; IS-SR/Periode 0.189, n=179, Trials=2850 (alle
Folds), Schiefe 2.67, Kurtosis 25.20, varSr=3.51e-3 aus trial_sharpes …; DSR
bei nTrials=150 (nur finale Suche): 0.687 — würde als Gate durchfallen`.
Die finalen Parameter (lookback 100) haben einen Embargo von 100+2+7+2+20 =
131 Bars; von der finalen Suche bleiben **179 Handelstage** (#17: 258), und
auf denen hat die Zahl Schiefe 2,67 und Kurtosis 25 — ein Sharpe aus wenigen
Tagen. Das ist der Parametersatz, der auf der Plattform gehandelt würde; die
OOS-Kette sagt über ihn nichts (T4), der Holdout (26 Trades, ein Halbjahr,
Standardfehler eines Halbjahres-Sharpe ≈ 1,4) auch nichts Belastbares —
so wenig wie die Holdouts von #16 und #17 (Sharpe 3,62 und 3,70 bei 7,6 % und
7,7 % Rendite gegen SPY 17 % und 15 %).

## G12 — Haltedauer 5–6 Bars: Was gemessen wurde, ist kein Momentum

Exit-Anatomie #18: `Trailing-Stop (nachgezogene Marke) | 287 | 68 % | +3757.55
| +13.09 | +0.03 | 50 % | 6.2 | 5`; Stop 40 Trades −3 987 $; Signal 97
Trades +1 701 $. Median-Haltedauer 5 Bars, Median-Ergebnis des häufigsten
Exits drei Cent. `aktivitaet.md` verlangt Median-Haltedauer ≥ 10 Handelstage;
die Literatur-Momentum-Haltedauer sind Monate. Die Kante, die hier gemessen
wird, ist ein Ein-ATR-Trailing auf Rang-Einstiegen — nicht die These der
Familie. (T23 ist genau deshalb vorregistriert.)

## Offen, mit Absicht

- Höhe von K4 exakt: braucht die Summe der „Offen am Ende"-Notizen je Fold
  (Simulator liefert sie, Bericht druckt sie nicht).
- Anteil K2 gegen K3: braucht einen Lauf mit entkoppeltem Generator auf den
  Daten von #17 und #18.
- Ob die bereinigten Bars zwischen den Nächten identisch waren:
  `optimize --as-of 2026-09-16` auf dem Cache von #18 muss #17 reproduzieren.
- Symbol-Konzentration der Kette (NVDA-Verdacht, M9).

## Urteil

Diese Beförderung ist **eine Ziehung, kein Befund**: Dieselbe Kette bestand in
drei aufeinanderfolgenden Nächten 6, 5 und 10 von 10 Gates, ihr Sharpe lag im
Mittel unter der Latte, und die Nacht, die bestand, spielte nach einem Zufall
in einer anderen Strategie mit anderen Losen (K2). Der Überschuss, den die
Gates messen, ist zu vier Fünfteln kein Handel, sondern Buchgewinn offener
Positionen an Fold-Enden (K4); das Gebührengate hat das Vorzeichen eines
Nenners nahe null gemessen (K5); und der Pfad, der aus einem Bestehen einen
Champion macht, kannte bis gestern keinen Amtsinhaber und kennt ab morgen
keine Absetzung (M7). Der Score 3,357 ist korrekt gerechnet und sagt nichts,
was die Nacht davor nicht mit 1,813 widerlegt hätte. Bis ein Kandidat auf
mehreren Rastern und in einer durchgehenden Simulation dieselben zehn Gates
nimmt, bleibt das Urteil das der Nacht #17: kein Champion, kein Handel — und
die Plattform hat, ohne es zu wollen, genau das getan.
