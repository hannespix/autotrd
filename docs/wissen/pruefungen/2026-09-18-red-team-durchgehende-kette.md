# Red-Team über die durchgehende OOS-Kette — A/B #21 (je Fold) gegen #22 (durchgehend)

**Prüfer:** eigener Agent, hat nicht gebaut, Auftrag zu WIDERLEGEN (§6) ·
**Gegenstand:** PR #523 (`f19728c`, merge `a285765`), Vorregistrierung
`vorregistrierung/2026-09-18-durchgehende-oos-kette.md`, Lauf #22
(`reports/optimize-2026-09-18.md`, 10:08 UTC, `oosChain: continuous`) gegen
Lauf #21 (08:44 UTC, Code vor #523, de facto `per_fold`) — gleicher Anker
2026-09-18, gleiche Daten, gleiche Lose (alle fünf Familien: 18/18 gleiche
Fold-Parameter, identische IS-Objectives, Fold 1 zeichengleich) ·
**Leitfrage:** „Beweise, dass die neue Rechnung falsch ist." Die
Vorregistrierung (§4 Erwartung 3, §7) hatte selbst den Auslöser gesetzt:
„steigt die Zahl bestandener Gates bei einer Familie um zwei oder mehr, ist
das ein Befund über die Rechnung" — csm 7/10 → 9/10, regime 5/10 → 7/10.

**Kurzfassung.** Die Rechnung ist arithmetisch richtig: Scheiben, Normierung,
Zuordnung, Stress und Zins habe ich Zeile für Zeile nachvollzogen und mit dem
echten Simulator gegengeprüft; einen Lookahead gibt es nicht (G10). Falsch war
das **Modell des alten Fehlers** in der Vorregistrierung: Sie hielt die
Fold-Läufe für einseitig optimistisch (Buchgewinne an Fold-Enden, K4) und
übersah, dass jeder Fold-Neustart einen **eigenen, gegenläufigen Preis** hat —
leeres Buch, unverzinste Kasse, Park-Kauf mit Kosten, frische Stops und ein
Trade-Set, das die laufenden Gewinner systematisch ausschließt (M1). Genau
dieses Trade-Set war der Nenner von `fee_share` (K5 war ein Symptom von K4):
Von den fünf Gate-Gewinnen zwischen #21 und #22 sind drei `fee_share`
(csm, regime, td), einer ist `fold_positive_share` um genau einen Fold
(regime 10 → 11 von 18), einer ist `beats_market` (csm). Roh verlieren drei
von fünf Familien in der Kette (mr, mp, td), zwei gewinnen — ein Rechenfehler
in der Kette hätte alle in dieselbe Richtung geschoben. Was bleibt, sind vier
mittlere Befunde: der nicht mitgezogene Maßstab (M2), die neue
Pfadabhängigkeit der Messung (M3), die unerklärte Laufzeit (M4) — und M1
selbst, weil der Anteil des Pfades am csm-Zuwachs (≈ 1 000 $ von 1 302 $)
ohne eine Gegenprobe nicht abgrenzbar ist.

Was ich vorab geprüft und **nicht** gefunden habe: `per_fold` ist der alte
Pfad (`walkForward` ruft ohne Fahrplan dieselben Funktionen; Simulator ohne
`wechsel` bitgleich, `test/backtest/fahrplan.test.ts`); die Fold-Suche ist
unberührt (Fold-Parameter, IS-Objectives und Trials in #21 und #22 für alle
fünf Familien identisch — meine Tabelle unten); Erwartung 1 gilt (jede
K4-Zeile in #22 sagt „Offen am Kettenende", 0–4 Positionen, nirgends mehr
18 Fenster).

---

## Die Zahlen, um die es geht (Raster −0, #21 → #22)

| Familie | Gates | roh Σ Fold-Nettos | Überschuss | Trades | Trades-Netto (Anatomie) | `fee_share` | PSR | `beats_market` | Folds besser / schlechter |
|---|---|---:|---:|---:|---:|---:|---:|---:|:-:|
| cross_sectional_momentum | 7 → **9** | +5 568 → +6 871 | +1 505 → +2 798 | 394 → 424 | **−178 → +3 849** | 144,9 % → 15,7 % ✔ | 0,742 → 0,876 | 0,31 → 0,55 ✔ (Latte 0,456) | **15 / 2** |
| regime_allocation | 5 → **7** | +4 446 → +4 918 | +386 → +854 | 71 → 93 | **−2 528 → +990** | vakant → 6,7 % ✔ | 0,607 → 0,729 | 0,13 → 0,29 | 10 / 7 |
| mean_reversion | 5 → 5 | +4 505 → +4 363 | +455 → +314 | 397 → 424 | +2 117 → +1 684 | 28,1 → 35,9 % | 0,623 → 0,586 | 0,15 → 0,10 | 11 / 6 |
| momentum_pullback | 4 → 4 | +1 019 → +399 | −3 010 → −3 622 | 458 → 483 | −1 067 → −1 783 | 3 400,8 % → vakant | 0,086 → 0,054 | −0,64 → −0,75 | 7 / 10 |
| trend_donchian | 4 → **5** | +4 415 → +4 264 | +356 → +207 | 328 → 317 | +542 → +2 265 | 55,2 % → 23,0 % ✔ | 0,569 → 0,543 | 0,08 → 0,05 | 6 / 11 |

Quellen: Gate-Tabellen, Exit-Anatomie („n Trades, Netto …") und Fold-Tabellen
beider Berichte; „Folds besser/schlechter" aus den Spalten OOS-Netto je Fold
(Fold 1 in allen fünf Familien zeichengleich, wie es die Konstruktion
verlangt — Scheibe 1 = Fold-Lauf 1). Über alle Familien: 49 Folds besser,
36 schlechter, 5 gleich.

---

## M1 — Erwartung 2 und 3 sind gerissen, weil der alte Fehler zwei Seiten hatte: Der Fold-Neustart kostet, und er beschneidet das Trade-Set (BESTÄTIGT; Anteil des Pfades NICHT abgrenzbar)

**Ort:** `src/backtest/simulator.ts:649–650` (`range`: Bars vor `start`
sind Warmup ohne Fills, das Buch ist am Fold-Beginn leer und die Kasse
unverzinst), `:684–691, 926` (Tagesrendite = Schluss zu Schluss; der erste
aktive Tag rechnet gegen `initialEquity`), `:724–726, 780–787` (Park-Kauf
füllt am Open der FOLGEBAR, mit vollen Kosten), `src/optimize/walkForward.ts:554–618`
(`aggregateOos`: `feeShare = Σ fees / Σ grossPnl` über die TRADES),
Vorregistrierung §1 („Für eine Trailing-Strategie … heißt das: 18 Fold-Enden,
an denen Buchgewinne in die Kette gehen") und §4 Erwartung 2.

**Beleg 1 — der Neustart hat einen Preis, auch wenn niemand handelt.**
`test/optimize/redteam-neustart.test.ts` lässt einen Kandidaten, der NIE
handelt (`decide` ⇒ `hold`), mit Geldmarkt-Parken (BIL, 0,02 % je Handelstag,
Kosten aus den Config-Vorgaben) je Fold und als Kette laufen. Je Fold-Lauf ist
Tag 1 exakt 0,0000 % (leer, unverzinst), Tag 2 −0,0489 % (Park-Kauf, 5 bp auf
98 % der Equity), erst Tag 3 +0,0196 %; Scheibe k ≥ 2 der Kette beginnt mit
+0,0196 %. Über 13 Folds: Σ je Fold 4 300,59 $, Σ Kette 5 363,59 $ —
**88,58 $ je Grenze bei 100 000 $**, für einen Kandidaten ohne einen einzigen
Trade. Mit der Plattform-Config (E₀ 25 000 $, ≈ 80 % Kasse geparkt, 5 bp,
BIL ≈ 4,5 % p. a., 17 Grenzen): Park-Kauf ≈ 10 $ + zwei Tage Zins ≈ 7 $ ⇒
≈ 17 $ je Grenze ⇒ **≈ 250–350 $ je Kette**, bevor die Strategie etwas getan
hat; im Überschuss kommt der `r_f`-Abzug des Null-Tages dazu. Dazu je Grenze
die frischen Einstiege (≈ 3 × 1,4 $) und der eine verlorene Handelstag im
Markt.

**Beleg 2 — das Trade-Set der Fold-Läufe war das Artefakt hinter K5.** Ein
Trade zählt in `per_fold` nur, wenn er INNERHALB seines 63-Tage-Fensters
schließt. Verlierer schließen schnell (Stop, 0 % Trefferquote, 5 Bars),
Gewinner laufen — und waren am Fold-Ende „Offen am Ende", nie ein Trade.
Deshalb war das Trade-Set der Fold-Läufe verliererlastig, und `fee_share`
(Σ Gebühren / Σ Brutto DIESER Trades) hatte einen Nenner nahe null oder
darunter: csm 144,9 % (Σ brutto ≈ 396 $ bei 394 Trades), regime „vakant"
(Σ brutto ≤ 0), mp 3 400,8 %. In der Kette schließen dieselben Positionen
später als Trade: csm Trailing-Exits 273 → 296 mit +2 988 → +5 472 $;
regime Signal-Exits 59 → 77 Trades, **Trefferquote 15 % → 48 %**,
−1 228 → +1 890 $. Der frühere Prüfbericht hat K5 als „Nenner nahe null"
beschrieben, ohne die Ursache zu nennen: **K5 ⊂ K4** — der Nenner war nahe
null, weil die Gewinner nie Trades wurden. Dass es die Zusammensetzung des
Trade-Sets ist und nicht eine Richtung der Rechnung, zeigt mp: dort kippt
`fee_share` in der Kette von 3 400 % auf „vakant" (schlechter) und td
verbessert `fee_share` (55 → 23 %), obwohl seine Kette roh VERLIERT
(+4 415 → +4 264).

**Beleg 3 — was von csms +1 302 $ übrig bleibt.** 15 von 17 vergleichbaren
Folds sind in der Kette besser (Fold 1 gleich). Der mechanische Neustart
(Beleg 1) erklärt ≈ 250–350 $ davon, gleichmäßig über die Grenzen verteilt —
das allein kippt bei csm das Vorzeichen von Folds mit |Δ| < 100 $ (Folds 3, 6,
8, 9, 11, 12, 16, 18). Der Rest (≈ 1 000 $, Folds 2/4/5/7/13/14/17 mit +115
bis +280 $) ist **Pfad**: Die Kette führt am Fold-Beginn die geerbten
Positionen mit nachgezogenem Trailing-Stop und altem Hochwasser weiter,
der Fold-Lauf kauft dieselben Ränge frisch mit Katastrophen-Stop und
`highWater = Einstand`; welche Variante im jeweiligen Quartal besser fährt,
hängt vom Kursverlauf ab. Aus zwei Läufen ist dieser Anteil nicht vom
Neustart-Preis zu trennen. Dass er kein Rechenfehler der Kette ist, folgt aus
den anderen Familien (mr 11/6, mp 7/10, td 6/11, roh drei von fünf
schlechter): Ein Fehler in Schneiden oder Normieren träfe alle gleich.

**Wirkung.** Erwartung 2 („Überschuss fällt unter +1 505 $, PSR unter
0,742") war die Erwartung eines Modells, das nur K4 kannte. Sie ist
gerissen, und die Vorregistrierung §7 hat daraus zu Recht „Verdacht auf die
Rechnung" gemacht — der Verdacht ist geprüft und bezieht sich auf die
ALTE Rechnung: `per_fold` war für Trailing-/Rang-Strategien mit langer
Haltedauer nicht optimistisch, sondern in Summe pessimistisch (csm, regime),
für kurze Haltedauer neutral bis optimistisch (mr, mp, td). Die +2 Gates
sind: einmal `fee_share` (Artefakt des alten Nenners), einmal ein Gate an der
Schwelle (regime `fold_positive_share` 0,556 → 0,611 durch EINEN Fold; csm
`beats_market` 0,552 gegen 0,456 — siehe M2 zur Latte).

**Gegenprobe / Wächter.** (1) `test/optimize/redteam-neustart.test.ts`
(steht, grün; bricht rot, wenn ein Fold-Lauf an Tag 1 nicht bei 0 beginnt
oder die Kette an einer Grenze neu kauft). (2) Für die Abgrenzung des Pfades
eine dritte Variante `optimizer.oosChain: flatten` NUR für Vergleichsläufe:
durchgehend, aber an jeder Fold-Grenze alle Positionen `unmanaged`
geschlossen und die Kasse geparkt gelassen. Kette − flatten = Wert der
Vererbung; flatten − per_fold = Neustart-Preis plus K4-Buchgewinn. Vorher
vorregistrieren; keine Schwelle, kein Gate. (3) In die Maßstab-Zeile je
Kandidat: „Neustart-Preis ≈ n Grenzen × (Park-Kauf + 2 Tage Zins)" als
Größenordnung, damit ein Leser weiß, wie viel von einem Δ zu #21 mechanisch
ist.

## M2 — `beats_market`: Die Strategie läuft jetzt durch, der Maßstab kauft weiter je Fenster — 18 Übergangstage fehlen der Latte (BESTÄTIGT, Höhe ≈ ±0,06 Sharpe)

**Ort:** `src/backtest/marktbezug.ts:87–111` (`marktKette`: „Jedes Fenster
startet frisch gleichgewichtet"), `:199–212` (`wertreihe`: Renditen ab
`d = 1`, also je Fenster Handelstage − 1), `src/optimize/run.ts:464–478`
(`marktReihe`, dieselbe Regel), `:1291–1311` (`marktLatteMit`, Fenster =
OOS-Fenster der Folds), `src/optimize/robustness.ts:860–884` (`beats_market`
vergleicht `srAnnual` der 1 112 Strategie-Renditen mit der Latte aus dieser
Marktreihe), `:608–644` (`zinsEntscheidung` richtet die Zinsreihe auf die
Markt-Tagesachse aus — der Versatz löst KEINEN Fehler aus).

**Beleg.** `test/optimize/redteam-kette-massstab.test.ts`: dieselbe Kursreihe
als Strategie (kaufen und halten durch den echten Simulator, Kette) und als
Maßstab (`marktReihe`) über 13 Folds — Strategie 278 Tagesrenditen, Markt
265 = 278 − 13; die fehlenden Tage sind genau die ersten Handelstage jedes
Fensters. Der Sharpe des Gates aus `marktKette` ist bei diesem Pfad 1,77, der
Sharpe derselben Kursreihe durchgehend 1,18. Bei der Plattform: Strategie
1 112 Renditen („BIL über dieselben Tage (1112 von 1112 belegt)"), SPY-Latte
aus 1 094 (nicht im Bericht ausgewiesen). Größenordnung: 18 SPY-Tage mit
σ ≈ 1 % je Tag ⇒ Σ ≈ ±4,2 % (1 σ) ⇒ Mittelwertversatz ±0,0038 % je Tag über
1 112 Tage ⇒ **±0,06 Sharpe p. a. auf der Latte** — csms Abstand zur Latte
in #22 ist 0,096, auf Raster −1 fällt `beats_market` ohnehin.

**Wirkung.** In `per_fold` bestand die Asymmetrie auch, aber spiegelbildlich
harmlos: Die Strategie hatte an jedem Fold-Anfang eine Null-Rendite (leeres
Buch), der Markt gar keine. Jetzt trägt die Strategie an diesen 18 Tagen die
echte Übernacht-Rendite ihres geerbten Buchs, der Markt nichts. Zwei Sharpe-
Werte über verschiedene Tagesmengen stehen in einem Gate, dessen Latte laut
Vorbericht M6 schon ±0,10 rasterempfindlich ist. Richtung offen; die
Vorregistrierung §3 („`beats_market` auf der Kette … unverändert") hat den
Maßstab nicht mitgezogen.

**Vorschlag.** `marktKette`/`marktReihe` mit einem Schalter „durchgehend":
Ein Kauf am ersten Tag des ersten Fensters, danach nichts — die Renditen
über die Fold-Grenzen hinweg gehören dann dazu (bei EINEM Benchmark-Symbol
ist das schlicht dessen Tagesrenditereihe über die Kette). Wächter: Länge der
Marktreihe = Länge der Strategie-Kette, gleiche `dayKeys`. Die
`zinsEntscheidung` bleibt, sie prüft dann beide Seiten auf dieselben Tage.

## M3 — Die Suche misst kalt, die Kette bewertet warm: Fold k hängt jetzt von den Parametern der Folds 1 … k−1 ab (BESTÄTIGT; Richtung unbestimmt)

**Ort:** `src/optimize/walkForward.ts:879–906` (`searchWindow` ⇒
`simulateWindow` je Kandidat: leeres Buch ab `isStart`, das Objective enthält
den Kaltstart), `:646–681` (`durchgehendeKette`: der Fold-Beste übernimmt
das Buch des Vorgängers), `:762–776` (`kettenBewertung` ersetzt
`oosMetrics`/`oosObjective` jedes Folds durch die Scheibe), CLAUDE.md §0.9
Regel 2 (die Plattform handelt einen Champion mit FESTEN Parametern; ein
Wechsel gibt es nur bei Beförderung/Absetzung).

**Beleg.** Gleiche Parameter, gleicher Korb, gleiche Tage — anderes Ergebnis
allein durch das geerbte Buch: td Fold 13 +381 → **+1 341 $** bei 19 → 9
Trades, td Fold 10 +1 493 → +890 $, csm Fold 15 +299 → −46 $ bei 9 → 14
Trades, regime Fold 7 +1 326 (0 Trades, per_fold −∞) → +993 $ (2 Trades,
Sortino 11,07). Der Score eines Folds ist nicht mehr „Params_k auf OOS_k",
sondern „Params_k auf dem Buch, das Params_1 … Params_k−1 hinterlassen
haben" — jede dieser Parametrisierungen ist eine Ziehung aus 150 Losen (K3
des Vorberichts). Die Suche sieht diese Situation nie: Sie wählt den Besten
aus dem Kaltstart. Und die Begründung der Vorregistrierung §2 („genau das,
was die Plattform nachts tut") gilt nur für den Champion-WECHSEL; im Betrieb
unter Regel 2 laufen feste Parameter — die saubere Entsprechung ist die
Kette des Amtsinhabers/Festkandidaten (`fixedParamsWfa`, ein Parametersatz,
ein Buch), nicht die Kette der Familiensuche.

**Wirkung.** Die Familienkette misst weiterhin die Prozedur (T4), jetzt mit
einer zusätzlichen Kopplung zwischen den Folds. Das erhöht die Streuung der
Messung; ein Bias ist nicht belegbar (Vorzeichen je Familie verschieden).
Regel 2 (drei Raster) ist der Wächter dagegen und hat in #22 gehalten (csm
9/8/6 Gates auf −0/−1/−2, Scores 2,26 / 2,53 / 1,12 — dieselbe Spreizung wie
in #21).

**Vorschlag.** Im Bericht je Familie eine Zeile „Kopplung": Σ |Δ OOS-Netto
je Fold| zwischen den Rastern, und der Hinweis, dass Fold-Scores der
Familienkette pfadabhängig sind. Keine Änderung der Messung ohne
Vorregistrierung; die Erprobung (§0.9) wählt weiter den Score-besten
Durchgefallenen — in #22 ist das durch die Umstellung `regime_allocation`
(3,468) statt `mean_reversion` (#21: 3,979, jetzt 2,758): Die Papier-Konten
wechseln den Kandidaten wegen der Messänderung, nicht wegen neuer Daten.

## M4 — Laufzeit 18,0 → 10,5 min: aus dem Code nicht erklärbar, Erwartung 4 taugt nicht als Beleg (OFFEN)

**Ort:** `src/optimize/run.ts:1474–1532` (`bewerte`: je Kandidat und Raster
Stress + Nachbarschaft + Auswertung), `:1519–1524` (Auswertung liest jetzt
die Scheiben), `src/optimize/robustness.ts:235–246` (Stress: ein Lauf statt
18), `src/optimize/walkForward.ts:924–948` (die Fold-Suche: unverändert 150
Kandidaten × 18 Folds + 150 final = 2 850 Läufe je Familie und Raster).

**Beleg.** Was wegfällt, ist klein: je Familie und Raster 18 OOS-Läufe + 18
Stress-Läufe (+ 18 Auswertungsläufe auf Raster 0), jeder mit ≈ 63 aktiven
Handelstagen ≈ 3 400 Tagesentscheidungen, gegen 2 850 Suchläufe mit ≈ 250
aktiven Tagen ≈ 712 000. Hinzu kommen 2 Kettenläufe mit 1 112 Tagen. Die
Entscheidungsarbeit sinkt um ≈ 0,2 %, die Indikator-Vorberechnung bleibt
gleich (54 × 30 Symbole gegen 2 × ≈ 45 Symbole × 18 Parametersätze). Der
einzige weitere Unterschied zwischen #21 und #22: #21 hatte einen
Amtsinhaber (csm, Altbestand) und prüfte ihn nachts auf drei Rastern
(`fixedParamsWfa` + Stress + Nachbarschaft, ≈ 225 Läufe, ≈ 1 %); #22 hatte
keinen (abgesetzt in #21). Zusammen erklärt das 1–2 %, gemessen sind −42 %.

**Wirkung.** Entweder Runner-Varianz, oder in #22 fehlt Arbeit, die ich nicht
sehe. Für die zweite Möglichkeit habe ich keinen Beleg: Suche, Raster
(Tabellen für alle fünf Familien auf −0/−1/−2), Stress, Nachbarschaft und
Holdout stehen in #22 mit Werten. Erwartung 4 („höchstens +15 %") ist erfüllt,
aber sie war als Sicherung gegen MEHR Arbeit gedacht, nicht als Beleg für
weniger.

**Gegenprobe.** Zwei lokale Läufe auf demselben Cache (`--as-of 2026-09-18`,
`oosChain: per_fold` gegen `continuous`) mit Zeit je Phase (Suche, Raster,
Stress, Auswertung, Amtsinhaber). Erst dann ist die Zahl ein Befund.

## G5 — `fee_share` ist in der Kette equity-gewichtet, das Netto daneben ist auf E₀ normiert

**Ort:** `src/optimize/walkForward.ts:694–753` (`kettenScheiben`: Equity ×
E₀/E_Start, `trades` unverändert in Dollar des einen Buchs), `:591–596, 616`
(`aggregateOos`: Σ fees / Σ grossPnl über alle Trades), `src/backtest/metrics.ts:524`.

**Beleg.** Die csm-Kette wächst von 25 000 auf 32 722 $ (Rendite 30,89 %);
Trades in Fold 18 wiegen im Nenner 1,31-mal so viel wie Trades in Fold 1,
im normierten Fold-Netto wiegen beide Folds gleich. Definition formal
dieselbe, Gewichtung neu pfadabhängig: Ein Kandidat, der früh gewinnt und
spät verliert, bekommt einen kleineren Nenner als in `per_fold`, einer, der
spät gewinnt, einen größeren — bei gleichen Renditen. Beispiel: Fold A brutto
−100 $, Fold B +300 $, je 5 $ Gebühren; bei E₀-Gewicht 10/200 = 5,0 %, mit
10 % Kapitalverlust vor Fold B (5 + 4,5)/(−100 + 270) = 5,6 %. Gering, aber
ein Gate sollte nicht davon abhängen, in welcher Reihenfolge die Folds kamen.

**Vorschlag.** Trades je Scheibe für die Gate-Rechnung mit demselben Faktor
E₀/E_Start skalieren (nur Zähler UND Nenner, nur für `fee_share`/`profitFactor`
der Kette) — oder die Equity-Gewichtung in der Gate-Notiz nennen.

## G6 — Zuordnung, Grenzen und Bericht: konsistent für Tagesbars, zwei Lesefallen

**Ort:** `src/optimize/walkForward.ts:700–725` (Tag ⇒ Fold über die erste
Bar des Tages; Trade ⇒ Fold über `exitTime`), `src/backtest/simulator.ts:649–650,
657` (`t >= range.start`, `ab <= t`), `src/backtest/marktbezug.ts:172–173`,
`src/optimize/report.ts` (K4-Zeile, Fold-Tabelle), `src/backtest/aktivitaet.ts:43–44`.

**Beleg.** Bei Tagesbars sind Tag, Trade-Exit und Bar dieselbe Zeit — Tag und
Trade landen im selben Fold; `ueberschussKette` bestätigt es in #22 für alle
Kandidaten ohne Rückfall auf „rohes Netto". Die DST-Kante (Fold-Grenzen bei
`t_last + 1 − k·Tage` = 13:30:00.001 UTC; die Bar des Grenztags gehört im
Sommer zum früheren, im Winter zum späteren Fold) gilt für Strategie, Maßstab
und beide Modi gleich — nicht neu, nur kosmetisch in der Fold-Tabelle. Bei
Intraday-Bars fielen Tag (erste Bar) und Trade (spätere Bar) an einer
Grenze auseinander; `ueberschussKette` würde laut scheitern (kein stiller
Fehler), die Plattform läuft auf Tagesbars. Zwei Lesefallen im Bericht: (a)
Die Fold-Tabelle stellt „OOS-Trades" (nach Ausstiegszeit) neben „OOS-Netto"
(Equity der Scheibe) — regime Fold 7 hat 2 Trades und +993 $, die aus
Positionen von Fold 6 stammen. (b) Die K4-Zeile stellt Trades in echten
Dollar („+3 849,18 $ aus geschlossenen Trades", „Σ unrealisiert +462,87 $")
neben „roh 6 870,62" in E₀-normierten Fold-Summen; die echte Kette ist
25 000 × 1,3089 ⇒ +7 722 $, die Lücke 7 722 − 4 312 = 3 410 $ ist der
Zins auf geparkter Kasse (roh − Überschuss = 4 073 $ auf 100 % der Equity,
darunter ≈ 20 % gebundenes Kapital, das keinen Zins verdient). Und die
Fußnote „Gleichzeitige Positionen … (Positionen, die am Fensterende offen
blieben, fehlen)" gilt jetzt nur für das Kettenende.

**Vorschlag.** In der K4-Zeile „Kette gesamt +7 722 $ (E₀ × Rendite)" und den
Zins ausweisen; Fold-Tabelle mit „Trades (Exit im Fold)"; Fußnote der
Aktivität an den Modus koppeln.

## G7 — Stress symmetrisch, Nachbarschaft und Holdout je Fenster, Holdout startet leer

`stressTest` (`src/optimize/robustness.ts:235–237`) ist derselbe
`durchgehendeKette`-Aufruf mit `costMultiplier` und `membership` aus
`common` (`run.ts:1344–1357, 1402`; `test/optimize/korbJeFold.test.ts` prüft
den Fahrplan des Stress-Laufs) — symmetrisch. Nachbarschaft und DSR messen
die Suche auf dem finalen Fenster: unverändert, richtig so. Der Holdout
(`walkForward.ts:968–972`) startet weiter mit leerem Buch am Holdout-Beginn
— die einzige Stelle, an der die Plattform-Semantik der Kette NICHT gilt;
nur Bericht, aber die Holdout-Zahlen sind damit die Fold-Lauf-Zahlen mit dem
Neustart-Preis aus M1 (csm 30 Trades, +1 653 $, in #21 und #22 identisch).

## G8 — Semantik Simulator = Engine beim Parameterwechsel; die Rundreise an der Korbgrenze

**Ort:** `src/core/logic.ts:796–799` (nur bei ANDERER Strategie-ID wird eine
Position nicht geführt; bei Parameterwechsel derselben Strategie führt
`decide()` sie mit den neuen Parametern), `:806–815` (`move_stop` nur enger
und auf der Verlustseite), `:1042–1045` (`advancePosition` behält
`highWater`), `src/backtest/simulator.ts:657–671` (der Fahrplan tauscht
`params`/`ind`, nie `pos`), `:805–815` (`gesperrt` ⇒ `unmanaged`),
`src/engine/engine.ts:700–718, 1547–1553` (Engine: Indikatoren je
`paramsKey` neu, Position bleibt), `:788–799` (`ohneFuehrung` ⇒ `unmanaged`).

**Beleg.** `test/backtest/redteam-fahrplan-position.test.ts`: Über zwei
Wechsel (Trailing 5 → 20 → 1) bleiben Erstmarke 90, Einstiegszeit und
Hochwasser erhalten; der weitere Abstand greift nicht (Stop bleibt 100), der
engere zieht nach (108, 109). Beides ist das Verhalten von `decide()`, das
Engine und Simulator teilen — §0.1 hält. Zweiter Fall: Ein Einstieg, der an
der letzten Bar vor `params: null` entschieden wird, füllt am Open der
Grenz-Bar und wird am nächsten Open `unmanaged` geschlossen (`barsHeld` 1);
die Engine täte dasselbe (Order nach Schluss, Fill am Open, im nächsten Takt
ohne Führung). In #22 sind die `unmanaged`-Trades keine Rundreisen (csm 4
Trades, Ø 21 Bars, +389 $; regime 6, Ø 18 Bars). Sie zählen in `oos_trades`
und in der Anatomie — Korbrotation, keine Strategie-Exits; ihre Zahl gehört
in die Notiz von `oos_trades`.

## G9 — Wächter: Der Fake beweist nur die Normierungsarithmetik; drei Lücken jetzt geschlossen; Erwartung 5 nur am Fake geprüft

`test/optimize/kette.test.ts:54–79` („normierte Scheiben = Fold-Läufe") kann
mit einem Fake, dessen Trade-Ergebnis proportional zur Equity ist und der an
jeder Grenze flat ist, nur bestehen — er prüft, dass Schneiden und Normieren
rechnen, nicht, was die Kette misst. Die Wächter mit dem echten Simulator
(`test/backtest/kette.test.ts`) treffen die drei richtigen Fälle (flat und
bei E₀ ⇒ bitgleich; Trade über die Grenze ⇒ Scheibe des Exits; offen nur am
Ende). Gefehlt haben: Stop/Hochwasser über den Wechsel (jetzt
`redteam-fahrplan-position.test.ts`), der Neustart-Preis der Fold-Läufe
(`redteam-neustart.test.ts`), die Tagesmenge des Maßstabs
(`redteam-kette-massstab.test.ts`). Erwartung 5 („`per_fold` reproduziert
#21 bitgleich") wurde auf echten Daten nicht ausgeführt; indirekt spricht
alles dafür (18/18 gleiche Fold-Parameter und IS-Objectives, Fold 1
zeichengleich in allen fünf Familien; Simulator ohne Fahrplan per
`JSON.stringify` bitgleich). Ein Rauchtest mit dem Schalter steht aus.

## G10 — Lookahead: keiner gefunden (was geprüft wurde)

- Fahrplan `ab = fold.oosStart` (`walkForward.ts:664–665`): Der Fold-Beste
  stammt aus der IS-Suche bis `isEnd − Embargo = oosStart − Embargo`
  (`:926`, `candidateRange`); er gilt ab `oosStart`. Nichts nach `oosStart`
  geht in seine Wahl ein.
- `korbZum(…, fold.oosStart)` (`:656`) ⇒ `membership(at)` liefert den
  jüngsten Stand `≤ at` (`korbJeFold.ts:91–99`), gewählt mit Daten bis `at`.
- Indikatoren des neuen Satzes: `precompute` auf der ganzen Serie
  (`simulator.ts:666`) — kausal (Präfix-Wächter je Strategie), wie schon in
  jedem Fold-Lauf; `decide()` bekommt `series.prefix(i+1)` (`:818`).
- Vereinigung der Körbe: gesperrte Symbole stehen nicht in `inputs`
  (`:805–815`), also nicht in der Rangliste (`korbRaenge` rangiert nur
  `inputs`); ihre Positionen bleiben bis zum `unmanaged`-Fill im Buch
  (`ctx.positions`) — Plattform-Semantik, kein Blick nach vorn.
- Kettenende `range.end = last.oosEnd` (`:649`), Holdout getrennt.
- Ein echter Kanal, der KEIN Lookahead ist, aber genannt gehört: Params_k+1
  wurden auf IS = [oosStart_k+1 − 365 d, oosStart_k+1 − Embargo] gewählt,
  also auf der Haltezeit der geerbten Positionen; sie führen Positionen
  weiter, deren Buchgewinn in ihrem eigenen IS entstand. Jede Entscheidung
  nutzt nur Vergangenheit; die Plattform hätte denselben Effekt.

## Offen, mit Absicht

- Anteil des Pfades an csms +1 302 $ (M1, Beleg 3): braucht die Variante
  „flatten" — vorregistrieren, dann messen.
- Laufzeit (M4): lokaler A/B mit Phasenzeiten.
- Erwartung 5 auf echten Daten: `optimize --as-of 2026-09-18` mit
  `oosChain: per_fold` gegen den Bericht #21.
- Höhe von M2 auf den Plattform-Daten: SPY-Renditen an den 18 Grenztagen
  aufsummieren — aus den Berichten nicht ableitbar.

## Urteil

**Die Rechnung hält, mit Einschränkungen (M1–M4).** Ich habe keinen
Rechenfehler, keinen Lookahead und keine Asymmetrie im Stress gefunden;
Scheiben, Normierung, Zuordnung und Zins sind korrekt und mit dem echten
Simulator belegt. Das Falsifikationskriterium der Vorregistrierung hat
gefeuert, weil ihr Modell des alten Fehlers unvollständig war: Die
Fold-Läufe waren nicht nur an ihren Enden zu großzügig, sie waren an ihren
Anfängen zu hart (leer, unverzinst, frisch gestoppt) und in ihren Trades
blind für die Gewinner — `fee_share` hat vier Nächte lang diesen blinden
Fleck gemessen (K5 ⊂ K4). Mit der Kette misst das Gate erstmals das, was auf
dem Etikett steht. Was die Kette NICHT heilt: Sie misst weiter die Prozedur
(18 Ziehungen, jetzt gekoppelt, M3), ihr Maßstab läuft nicht mit (M2), und ob
csms Zuwachs Neustart-Preis oder Pfad ist, weiß niemand, bis eine
Gegenprobe existiert (M1). Kein Kandidat hat in #22 3/3 bestanden; nichts
hängt heute an diesen Einschränkungen — vor der ersten Beförderung an einer
Kette mit Trailing-Exits gehören M1 und M2 abgeräumt. Wegloben lässt sich
weder das eine noch das andere: Die Kette ist die richtige Rechnung, und sie
sagt für keine Familie „Kante".

## Angelegte und geänderte Dateien

- `docs/wissen/pruefungen/2026-09-18-red-team-durchgehende-kette.md` (dieser Bericht)
- `test/optimize/redteam-neustart.test.ts` (neu, M1 — grün)
- `test/optimize/redteam-kette-massstab.test.ts` (neu, M2 — grün)
- `test/backtest/redteam-fahrplan-position.test.ts` (neu, G8 — grün)
- Kein Code in `src/` geändert; nichts committet, nichts gepusht.
