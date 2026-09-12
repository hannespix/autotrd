# Erstmessung `vigilant_allocation` (Lauf #44, 12.09.2026)

16 Folds, 2020-07-27 … 2026-03-15, 987 OOS-Tage, 9 ETFs mit BIL als
Geldmarkt-Pol, feste Parameter aus der Vorregistrierung, keine Suche.

## Das Gate-Bild — und warum es weniger wert ist, als es aussieht

| Gate | | Wert | Schwelle |
|---|---|---|---|
| oos_trades | ✘ | **27** | 60 |
| fold_positive_share | ✔ | 0,625 (10 von 16) | 0,600 |
| oos_net_profit | ✔ | +432,08 (1,74 %), MaxDD **0,75 %** | > 0 |
| fold_concentration | ✔ | 0,378 | 0,500 |
| stress_costs | ✔ | +419,73 | > 0 |
| neighborhood_plateau | ✔ | — | — |
| probabilistic_sharpe_oos | ✔ | 0,920 | 0,900 |
| deflated_sharpe_is | ✔ | nicht anwendbar (Festkandidat) | — |
| fee_share | ✔ | nicht berechenbar | 0,500 |
| beats_market | ✔ | Sharpe 0,73 gegen 0,67 | — |

Neun von zehn. Es ist der erste Kandidat überhaupt, der
`fold_positive_share` nimmt — das Gate, das für alle fünf Aktienfamilien
strukturell unerreichbar war. Trotzdem ist das Ergebnis **kein Erfolg**,
sondern eine widerlegte Vorhersage mit zwei offenen Messfragen.

## B1 — Die vorregistrierte Kernerwartung ist WIDERLEGT

Die Vorregistrierung sagte für die Folds des Bärenmarkts 2022:
„vigilant: **≥ 3 von 5 positiv**, kein Fold schlechter als −2 %."

Gemessen:

| Fold | OOS-Fenster | Trades | Netto | in % vom Startkapital |
|---|---|---:|---:|---:|
| 1 | 2022-04-05 … 2022-07-04 | 3 | −7,23 | −0,029 % |
| 2 | 2022-07-04 … 2022-10-02 | 3 | −29,32 | −0,117 % |
| 3 | 2022-10-02 … 2022-12-31 | 2 | −28,29 | −0,113 % |
| 4 | 2022-12-31 … 2023-03-31 | 3 | −31,52 | −0,126 % |

**Null von vier positiv.** Die Rotation hat im Bärenmarkt nicht verdient, sie
hat weniger verloren. Das ist Risikominderung, nicht die Renditequelle, für
die der Sleeve gebaut wurde.

Die zweite Hälfte der Erwartung („kein Fold schlechter als −2 %") ist
eingehalten — aber wertlos, weil der Sleeve mit 0,75 % Maximaldrawdown
praktisch nicht investiert ist. Eine Schranke, die eine fast flache Kurve
nicht reißen kann, prüft nichts. **Das ist ein Fehler in meiner
Vorregistrierung, nicht im Sleeve:** Ich habe eine Schranke in Prozent
formuliert, ohne den Investitionsgrad zu binden.

Das Gate `fold_positive_share` besteht der Sleeve also **nicht wegen des
Bärenmarkts, sondern trotz seiner** — die zehn positiven Folds liegen fast
alle in den Jahren 2023 bis 2026.

## B2 — Der Sharpe misst gegen NULL, nicht gegen den risikolosen Zins

`probabilisticSharpe` rechnet mit `sr0 = 0` (`src/backtest/metrics.ts:170`),
und `beats_market` vergleicht zwei so gerechnete Sharpe-Werte. Solange nur
Aktien im Spiel sind, ist das harmlos.

Mit einem **Geldmarktpapier im Korb** ist es das nicht mehr: BIL trägt den
kurzen Zins, bei `adjustment: all` samt Ausschüttungen, und schwankt dabei
fast nicht. Ein Halten von BIL liefert damit einen hohen Ertrag je
Schwankung, ohne dass irgendeine Kante im Spiel wäre. Gegen einen
risikolosen Zins von null gemessen, **wird Bargeld als Kante verbucht**.

Warum der gemessene Wert trotzdem nur 0,73 beträgt: Unverzinste Kasse
außerhalb der Position bringt im Simulator nichts (geprüft — er verzinst
Kasse nicht), und der Sleeve ist im Alpha-Pfad nur zu rund einem Zehntel
investiert. Die Mischkurve wird also von den Aktienbeinen dominiert.

**Aber genau das kippt, sobald das Volatilitätsziel den Sleeve hochskaliert.**
Dann wächst der Anteil der Geldmarktphasen an der Kurve, und der Sharpe
bekommt einen Anteil geschenkt, den es in Wirklichkeit nicht gibt — Geld
leiht sich niemand zum risikolosen Satz.

**Konsequenz: Kein Kandidat, der ein Geldmarktpapier halten kann, wird
befördert, bevor diese Frage geklärt ist.** Zu klären ist, ob `sr0` auf den
kurzen Zins gesetzt wird (dann braucht die Messung eine Zinsreihe) oder ob
Geldmarktpapiere aus der Sharpe-Rechnung herausgehalten werden. Beides ist
eine Änderung an der Messung und damit vorregistrierungspflichtig. **Kein
Gate wird dabei gelockert — es geht in die strengere Richtung.**

## B3 — Das Trade-Gate misst die falsche Einheit für diese Bauart

Der Sleeve macht 0,6 Trades je Monat; 60 OOS-Trades entsprächen rund 100
Monaten OOS, also über acht Jahre. `oos_trades` verlangt damit von einer
Monatsrotation eine Historie, die es bei IEX-Tagesdaten (ab 2020-07-27)
nicht gibt.

Die statistische Evidenz steckt hier in 987 Tagesrenditen, nicht in 27
Trades — der PSR von 0,920 rechnet auf genau diesen 987. **Das Gate wird
trotzdem nicht angefasst** (§0.9). Der legitime Weg ist das Ensemble: Eine
Einheit aus mehreren Sleeves hat die Trades ihrer Summe, und genau dafür ist
E1 in `vorregistrierung/2026-09-12-ensemble.md` vorgesehen — vor dieser
Messung festgeschrieben.

## Was daraus folgt

1. These T16 (`vigilant_allocation` verdient im Bärenmarkt): **widerlegt**.
2. Der Sleeve bleibt als Baustein interessant — er ist der einzige mit
   geringer Korrelation zu den Aktienfamilien und mit einem Drawdown von
   0,75 % gegen 22,12 % des Marktes. Als **eigenständiger Champion** kommt er
   nicht in Frage.
3. B2 blockiert jede Beförderung eines geldmarktfähigen Kandidaten, bis die
   Zinsfrage entschieden ist.
4. Meine Vorregistrierung bekommt eine Lehre: Schranken in Prozent sind
   wertlos ohne eine Bindung des Investitionsgrads. Künftige Erwartungen
   nennen beides.
