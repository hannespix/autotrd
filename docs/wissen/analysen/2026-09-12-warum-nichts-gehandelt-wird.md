# Warum seit dem Umbau nichts gehandelt wurde (12.09.2026)

Owner-Befund: „seit dem Umbau passiert gar nichts … das Tool ist meiner
Meinung nach Schrott, so wie es ist. es muss aktiv handeln … wie die Trades
am besten verlaufen, bzw. wie man am wenigsten Verlust fährt."

Er hat recht, und die Antwort ist nicht „es gibt eben keine Kante". Fünf
Ursachen, vier davon behebbar, alle vier ohne eine einzige gelockerte
Schwelle. Diese Datei hält fest, was gemessen ist und was Vermutung bleibt.

## Die Ausgangslage: Lauf #9, 10.09.2026

Über 9 OOS-Fenster (Daten ab 2022-11-10, Korb je Fold aus 139 Kandidaten):

| Strategie | OOS-Sharpe p. a. | MaxDD | Rendite | Trades/Monat | Gates |
|---|---|---|---|---|---|
| cross_sectional_momentum | 0,90 | 7,20 % | +12,69 % | 10,4 | 8/10 ✘ fold_concentration, beats_market |
| mean_reversion | 0,75 | **1,84 %** | +3,57 % | 7,5 | 7/10 |
| regime_allocation | 0,07 | 5,46 % | +0,39 % | 1,4 | 6/10 |
| trend_donchian | 0,16 | 9,89 % | +1,65 % | 9,0 | 6/10 |
| momentum_pullback | −0,32 | 7,62 % | −4,00 % | 12,4 | 4/10 |
| _SPY kaufen und halten_ | _1,17_ | _19,85 %_ | — | — | — |

## Ursache 1 — Das Messfenster enthält keine Krise (der große Fund)

`config/platform.yaml` messe mit `optimizer.lookbackDays: 1400`. Damit
beginnen die Daten am **2022-11-10** — dem Tiefpunkt des Bärenmarkts 2022.
Danach kommt fast nur Aufschwung. Die Latte des Gates `beats_market` ist
deshalb ein SPY-Sharpe von **1,17**.

Dieselbe Latte in allen anderen gemessenen Fenstern:

| Fenster | Datenbeginn | SPY-Latte |
|---|---|---|
| Plattform nächtlich (1400 Tage) | 2022-11 | **1,17** |
| Stichtag 2026-03-06 (2000 Tage) | 2020-09 | 0,63 |
| Stichtag 2025-09-05 | 2020-07 | 0,46 |
| Stichtag 2025-03-07 | 2020-07 | 0,48 |

Die Plattform verlangt also, den besten Vierjahresabschnitt des Marktes seit
Jahren je Risikoeinheit zu schlagen. `cross_sectional_momentum` liefert
Sharpe 0,90 bei 7,20 % Drawdown gegen 19,85 % des Marktes und fällt daran
durch — in jedem anderen gemessenen Fenster hätte es bestanden.

**Das Gate ist richtig, das Fenster ist falsch.** §5a.10 hat genau diesen
Befund schon gezogen („Vier gemessene Halbjahre waren allesamt Bullenmarkt …
einem defensiven System dort vorzuwerfen, dass es den Markt nicht schlägt,
misst nichts") und die ERKUNDUNG auf 2900 Tage umgestellt. `platform.yaml`
blieb bei 1400. Die Erkenntnis wurde in der Probe umgesetzt und im Betrieb
vergessen.

Ein kurzes Fenster erzeugt dabei **vier** Symptome aus einer Ursache:

1. `beats_market` misst gegen eine Ausnahmeperiode.
2. `probabilistic_sharpe_oos` (≥ 0,9) hat nur 555 Beobachtungen — csm lag mit
   0,907 haarscharf darüber, mit mehr Daten wäre es komfortabel.
3. `fold_concentration` (max/Summe) ist bei 9 Folds instabil: Ist die Summe
   klein, explodiert der Quotient (regime_allocation: 325 %).
4. `oos_trades` (≥ 60) ist für eine Monatsstrategie in 2,25 Jahren OOS kaum
   erreichbar (regime_allocation: 36).

Gegenprobe: `config/diagnose-fenster.yaml` — Zeichen für Zeichen die
Produktion, nur `lookbackDays: 2900`. Lauf #42 vom 12.09.2026.

## Ursache 2 — Das System fährt mit angezogener Handbremse

`risk.riskPerTradePct: 0,5` bei höchstens 4 Positionen. Ergebnis:
mean_reversion riskiert **1,84 %** Drawdown, wo der Markt 19,85 % riskiert —
ein Zehntel. Daraus werden 3,57 % Rendite in vier Jahren.

Der Sharpe ist in Ordnung; der Ertrag ist mickrig, weil kaum Kapital
arbeitet. Die Antwort ist nicht mehr Risiko je Trade, sondern ein **Ziel für
die Schwankung des Gesamtdepots** (`src/risk/volziel.ts`): Liegt die
realisierte Vola unter dem Ziel, werden die Positionen größer, liegt sie
darüber, kleiner. Der Sharpe bleibt davon unberührt — das Gate wird also
nicht geschmeichelt —, aber aus „Sharpe 0,75 bei 1,84 % Drawdown" wird ein
nutzbarer Ertrag bei einem Drawdown, den man vorher festgelegt hat.

## Ursache 3 — Fünf Varianten derselben Wette

`trend_donchian`, `momentum_pullback`, `mean_reversion`,
`cross_sectional_momentum`, `regime_allocation`: alle long-only, alle
US-Aktien, alle Tagesbars, alle direktional. Im Kern fragen alle „steigt das
hier?". Sie sind fünf Varianten von SPY mit Zusatzkosten — und können den
SPY-Sharpe darum kaum schlagen.

Was fehlt, sind Renditequellen mit anderem Mechanismus: eine Rotation, die im
Bärenmarkt in Anleihen geht statt flach zu stehen; eine kurzfristige Umkehr
auf Index-ETFs; ein Kalendereffekt. Drei Sleeves, vorregistriert in
`vorregistrierung/2026-09-12-drei-sleeves.md`, Parameter aus der Literatur,
keine Suche.

## Ursache 4 — Die Architektur kann kein Portfolio messen

Der Optimierer messe jede Familie EINZELN und verwerfe jede EINZELN. Aber
Diversifikation ist das einzige kostenlose Mittagessen der Finanzwelt: Zwei
unkorrelierte Sleeves mit Sharpe 0,90 und 0,75 ergeben zusammen rechnerisch
√(0,90² + 0,75²) ≈ 1,17 — genau die Latte, an der beide einzeln scheitern.
Mit einer dritten Quelle darüber.

Das ist keine Anpassung und kein Fitting, das ist Arithmetik. Der Kern kann
heterogene Sleeves bereits fahren (`SymbolInput` trägt Strategie und
Parameter je Symbol, `korbSchluessel` trennt die Körbe) — nur die
**Messung** kennt nur eine Familie auf einmal. Deshalb eine
Ensemble-Einheit: mehrere Sleeves, kausale Gewichte (gleichgewichtet bzw.
inverse Vola, nichts gefittet), EINE Simulation, durch dieselben zehn Gates.

Wichtig, damit daraus kein Selbstbetrug wird: Die Korrelationen müssen
**gemessen** sein, bevor das Ensemble gebaut wird. Deshalb steht die
Korrelationsmatrix ab jetzt im Bericht.

## Ursache 5 — Der Orderpfad ist nie gelaufen

Seit dem Umbau: **null Trades, je.** Damit ist unbewiesen, ob Bracket-Orders,
GTC-Stops, Fills, Abgleich, Exit-Idempotenz und PDT-Prüfung im echten
Paper-Betrieb funktionieren. Das ist kein Strategieproblem, sondern ein
Betriebsrisiko: Der erste echte Trade wäre sonst der erste Test.

## Was NICHT die Ursache ist

- **Die Gates sind nicht zu streng.** `beats_market` vergleicht den Sharpe,
  also Ertrag je eigener Schwankung; eine selten investierte Strategie wird
  dadurch nicht bestraft. Ein System, das je Risikoeinheit weniger liefert
  als stumpfes Halten, hat keine Kante, sondern Gebühren. Kein Gate wird
  angefasst.
- **Es liegt nicht am Zeitrahmen.** Auf 5-Minuten-Bars frassen die Gebühren
  271–2438 % des Bruttogewinns (§5a.10). Tagesbars bleiben.
- **Es liegt nicht am Korb je Fold.** Der Punkt-in-Zeit-Korb hat am 09.09. ein
  Urteil gekippt (§5a.15) und bleibt.

## Offene Befunde (nicht behoben, bewusst)

- `fold_concentration` als max/Summe ist nicht skaleninvariant: Bei kleiner
  Summe explodiert der Wert. Robuster wäre der Anteil am Netto der positiven
  Folds oder ein Vergleich mit dem Median-Fold. Das Gate irrt in Richtung
  streng und bleibt deshalb unverändert, bis es vorregistriert geändert wird.
- Der Kandidatenpool ist von heute; wer im Messzeitraum verschwand, fehlt
  (§5a.13). Bekannt, in Richtung optimistisch.
