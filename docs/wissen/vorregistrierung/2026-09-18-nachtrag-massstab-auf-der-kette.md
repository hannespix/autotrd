# Nachtrag zur Vorregistrierung „durchgehende OOS-Kette": Maßstab auf derselben Tagesachse, Beträge der Scheiben auf E₀

**Datum:** 18.09.2026, nach Lauf #22 und dem Prüfbericht
`pruefungen/2026-09-18-red-team-durchgehende-kette.md` (M2, G5, G6, G8) ·
**Art:** Messung, keine Strategie, keine Schwelle · **Status vor dem Lauf:** offen
**Geschrieben, BEVOR ein Lauf mit dieser Rechnung stattfand** (erster Lauf:
der nächtliche #23, 18.09.2026 23:00 UTC).

## 1. Was der Prüfer gefunden hat

- **M2:** Seit die Strategie-Kette durchgehend läuft, hat sie an jedem
  Fold-Übergang eine echte Tagesrendite; der Maßstab für `beats_market`
  (`marktKette`/`marktReihe`) kauft weiter JEDES Fenster frisch und kennt
  diese Übergangstage nicht (18 von 1 112 Tagen fehlen ihm). Zwei
  Sharpe-Werte über verschiedene Tagesmengen stehen in einem Gate; die
  Größenordnung liegt bei ±0,06 Sharpe p. a., csms Abstand zur Latte in #22
  war 0,096.
- **G5:** Die Trades der Scheiben stehen in Dollar des einen Buchs, das
  Fold-Netto daneben ist auf E₀ normiert. `fee_share` (Σ Gebühren / Σ Brutto
  der Trades) ist damit equity-gewichtet — ein Kandidat, der spät gewinnt,
  bekommt einen größeren Nenner als einer, der früh gewinnt, bei gleichen
  Renditen. Klein, aber pfadabhängig; ein Gate sollte nicht davon abhängen,
  in welcher Reihenfolge die Folds kamen.
- **G6/G8:** Lesefallen im Bericht (echte Dollar neben normierten Summen;
  Fold-Tabelle „OOS-Trades" zählt nach Ausstiegszeit; Fußnote der Aktivität
  veraltet; `unmanaged`-Trades nicht ausgewiesen).

## 2. Was sich ändert

1. **Maßstab auf der Tagesachse der Kette** (`marktKetteAufAchse` in
   `backtest/marktbezug.ts`): Unter `oosChain: continuous` wird der
   Benchmark auf GENAU den Handelstagen der Strategie-Kette (`wfa.oos.dayKeys`)
   gerechnet — ein Kauf zum Schluss des ersten Tages (Tag 1: Kasse, Rendite 0,
   wie die Strategie an ihrem ersten aktiven Tag: entschieden wird am
   Schluss, gefüllt am nächsten Open), danach nichts; fehlt dem Benchmark ein
   Tag der Achse, gilt sein letzter Kurs (Rendite 0). Gleiche Länge, gleiche
   `dayKeys`, gleiche Zinsreihe — Wächter im Gate: Weicht die Achse des
   Maßstabs von der Kette ab, gilt `beats_market` als nicht berechenbar und
   durchgefallen (fail-closed, laut). `per_fold` behält den Maßstab je
   Fenster (Spiegelbild der alten Kette).
2. **Beträge der Scheiben auf E₀** (`kettenScheiben`): `grossPnl`, `fees`,
   `netPnl` jedes Trades und `unrealisiert` der am Kettenende offenen
   Positionen werden mit demselben Faktor E₀/E_Start skaliert wie die
   Equity der Scheibe. Damit sind Fold-Netto, Trades, Exit-Anatomie,
   K4-Zeile und `fee_share` EINE Rechnung („jeder Fold ab E₀"). Stückzahlen
   und Kurse bleiben, was gehandelt wurde. Bei `per_fold` ist der Faktor 1.
3. **Bericht:** K4-Zeile nennt die ganze Kette (E₀ × Rendite) und dass die
   Beträge je Fold ab E₀ zählen; Fold-Tabelle „OOS-Trades (Exit im Fold)";
   Fußnote der Aktivität je Modus; `oos_trades` nennt die `unmanaged`-Trades.

**Unverändert:** alle zehn Gates und Schwellen, Regel 2, Suche, Korb je
Fold, Stress, Nachbarschaft, DSR, Erprobung. Die Tagesrenditen der Kette
(PSR, Sharpe, `fold_positive_share`, `oos_net_profit`, `fold_concentration`,
`stress_costs`) ändern sich durch Punkt 2 NICHT — Renditen sind Quotienten.

## 3. Erwartungen — vor dem Lauf, falsifizierbar (Lauf #23, Raster −1 hat die Fold-Fenster von #22 Raster −0)

1. **Gleiche Kette:** csm auf #23 Raster −1 hat denselben OOS-Sharpe p. a.
   wie auf #22 Raster −0 (0,55, Überschuss) und dieselben Fold-Parameter —
   Punkt 1 und 2 ändern keine Rendite. (Erwartung 5 der Regel 2 mitgeprüft.)
2. **Latte:** Die SPY-Latte von csm auf #23 Raster −1 weicht von 0,456 (#22
   Raster −0, je Fenster) um höchstens 0,10 ab, und ihre Notiz nennt
   „über die OOS-Kette (1112 Handelstage, durchgehend)" mit derselben Tagezahl
   wie die Zinsnotiz.
3. **`fee_share`:** csm 15,7 % → Δ höchstens 3 Prozentpunkte; regime 6,7 %,
   td 23,0 % ebenso. Kein `fee_share` kippt allein durch die Skalierung.
4. **Kein Gate wird durch diesen Nachtrag zusätzlich bestanden, außer
   `beats_market` könnte in beide Richtungen kippen** — Richtung nicht
   vorhergesagt. Kippt es bei csm (0,552 gegen neue Latte), steht das im
   Ergebnis, ohne Bewertung.
5. **`per_fold`:** unverändert (Wächter im Code).

## 4. Wächter (jeder einmal absichtlich gebrochen)

- Maßstab: Achse = Achse der Kette (Länge und `dayKeys`), Tag 1 = 0, Sharpe
  der Achsenreihe = Sharpe der Kursreihe mit führender Null; Gate fällt laut,
  wenn die Achsen abweichen; `per_fold` behält `marktReihe` je Fenster.
- Scheiben: Σ `netPnl` der skalierten Trades einer Scheibe = Netto der
  Scheibe (Fake, dessen Equity nur durch Trades wächst); `per_fold`
  unskaliert; mit dem echten Simulator Fold 1 bitgleich (Faktor 1).

## 5. Abbruch

Reißt Erwartung 1, ist der Nachtrag fehlerhaft (er hätte Renditen geändert)
und wird zurückgenommen. Erwartung 2 gerissen ⇒ Prüfer: die 18 Übergangstage
wären größer als die Abschätzung.

---

## 6. Ergebnis — Lauf #23 (19.09.2026 00:22 UTC, `main` 040a6da, Daten bis 2026-09-18)

**Nachgetragen am 19.09.2026, NACH dem Lauf.** Der Zeitplan (`0 23 * * 1-5` UTC) erzeugte über eine Stunde lang keinen Lauf; um 00:04 UTC von Hand gestartet. Inhaltlich ist das folgenlos: Der Markt schloss um 20:00 UTC, die Daten reichen bis Freitag, und **Raster −1 dieses Laufs ist datengleich mit Raster −0 von #22**.

### Erwartungen

1. **✔ gehalten, bitgenau.** Raster −1 von #23 reproduziert Raster −0 von #22 in ALLEN fünf Familien, Zeichen für Zeichen — und Raster −2 ebenso das Raster −1:

   | Familie | #23 Raster −1 | #22 Raster −0 | #23 Raster −2 | #22 Raster −1 |
   |---|---|---|---|---|
   | cross_sectional_momentum | 2,258 · 424 · +6 870,62 | 2,258 · 424 · +6 870,62 | 2,525 · 474 · +6 812,45 | 2,525 · 474 · +6 812,45 |
   | regime_allocation | 3,468 · 93 · +4 917,86 | 3,468 · 93 · +4 917,86 | 3,850 · 96 · +4 668,89 | 3,850 · 96 · +4 668,89 |
   | mean_reversion | 2,758 · 424 · +4 362,56 | 2,758 · 424 · +4 362,56 | 1,697 · 479 · +4 229,68 | 1,697 · 479 · +4 229,68 |
   | trend_donchian | 1,234 · 317 · +4 264,14 | 1,234 · 317 · +4 264,14 | 0,926 · 313 · +3 244,67 | 0,926 · 313 · +3 244,67 |
   | momentum_pullback | 1,385 · 483 · +399,39 | 1,385 · 483 · +399,39 | 1,451 · 466 · +3 127,57 | 1,451 · 466 · +3 127,57 |

   Damit ist zweierlei belegt: Der Nachtrag hat **keine Rendite verändert** (Erwartung 1 dieser Vorregistrierung), und **Erwartung 5 der Regel 2** (`2026-09-18-befoerderung-auf-drei-rastern.md`) hält auf echten Daten — die Raster sind deterministisch, der Generator je Strategie und Fenster (K2) trägt.
2. **✔ gehalten.** Die `beats_market`-Notiz nennt jetzt „SPY kaufen und halten **über die OOS-Kette (1111 Handelstage, durchgehend)**" — dieselbe Tagezahl wie die Zinsnotiz („BIL über dieselben Tage (1111 von 1111 belegt)"). Damit ist M2 geschlossen: Strategie und Maßstab stehen auf derselben Achse, die 18 Übergangstage fehlen der Latte nicht mehr. Die Latte auf Raster −0 ist 0,448 gegen 0,456 in #22 (anderes Raster, alter Maßstab) — Δ 0,008, weit innerhalb der erwarteten ±0,10.
3. **✘ nicht prüfbar, wie formuliert.** Die Erwartung verlangte `fee_share` von Raster −1; der Bericht druckt die Gate-Tabelle nur für Raster −0 und nennt für −1/−2 bloß die gerissenen Gates. Belegbar ist: Auf Raster −1 steht `fee_share` **nicht** unter den gerissenen Gates, hat also bestanden — wie in #22 Raster −0 (15,7 %). Der Zahlenvergleich bleibt offen; das ist eine Lücke des BERICHTS, keine der Rechnung. (Die Werte auf Raster −0 — csm 41,8 %, regime 12,1 %, td 26,0 % — gehören zu einem anderen Raster und sagen über den Nachtrag nichts.)
4. **Eingetreten, Ursache ist das Raster, nicht der Nachtrag.** `beats_market` kippt bei csm zwischen den Rastern: auf −1 bestanden, auf −0 gerissen (0,047 gegen 0,448).
5. **✔ per Wächter im Code**, kein zweiter Lauf.

### Was der Lauf sonst zeigt

- **T4, so scharf wie noch nie.** EIN Handelstag (Freitag, 18.09.) verschiebt alle 18 Fold-Grenzen — und bei identischer Maschinerie fällt csm von Raster −1 auf Raster −0: Score 2,258 → 2,177, OOS-Netto **+6 870,62 → +4 280,83 $**, Sharpe p. a. **0,55 → 0,05**, bestandene Gates **9/10 → 6/10** (neu gerissen: `fold_concentration`, `stress_costs`, `beats_market`). Kein Fehler, keine Messänderung — nur ein Tag Anker. Genau dagegen ist Regel 2 gebaut.
- **Die neue zweite Maßstab-Zeile (M6) liefert sofort einen Befund.** „Korb je Fold liegenlassen (57 Symbole, 18 Stände, durchgehend), Überschuss: Sharpe 0,52, MaxDD 37,33 %" gegen SPY 0,45 und csm 0,05 bzw. regime 0,18: **Beide Familien bleiben weit unter ihrem eigenen liegengelassenen Korb**, und der Korb schlägt SPY. Der Momentum-Tilt des Korbs ist real (T7); die Strategien fügen ihm nichts hinzu, sie kosten. Einschränkung: Der liegengelassene Korb trägt 37,33 % MaxDD gegen 9,46 % bei csm — Sharpe misst Schwankung, nicht Drawdown; die Zeile ist ein Maßstab, kein Vorschlag.
- **Symbol-Konzentration (M9) bestätigt den Verdacht.** csm: NVDA +754,71 $ (80 % des Σ Netto von +939,93 $), XOM +722,82 $ (77 %), LLY +617,97 $ (66 %) — die drei größten summieren über 200 %, der Rest ist in Summe negativ; 42 von 139 Poolsymbolen handelten überhaupt. regime: NVDA +518,16 $ = 101 % des Σ Netto. Die Kette hängt an einer Handvoll Namen.
- **Kein Champion.** Raster 0/3 für jede Familie, `stay_notrade`. Veröffentlicht: `meta/champion` (0 Symbole, 30 noTrade, 30 Papier-Erprobung), `meta/symbolProfile`, 662 indizierbare Werte.
- **Die Erprobung wechselt auf csm** (Score 2,177, 8,6 Trades je Monat); regime_allocation wurde trotz höherem Score übersprungen (1,8 je Monat unter der Untergrenze 4). Der nächtliche Wechsel des Erprobungs-Kandidaten ist damit erneut belegt (T4/T22).

### Kleine Berichtslücken, notiert statt behoben

- Die Konzentrationszeile zählt „42 von 139 Symbolen" (Kandidatenpool), die Korb-Zeile „57 Symbole" (je gehalten). Beide Nenner sind richtig, nebeneinander aber verwirrend.
- Gate-Werte je Raster: Der Bericht druckt die Tabelle nur für Raster −0. Für einen sauberen A/B über Raster hinweg fehlen die Zahlen (siehe Erwartung 3).

Beides ändert keine Messung; beides gehört in die nächste Berichtsrunde, nicht in einen Schnellschuss.
