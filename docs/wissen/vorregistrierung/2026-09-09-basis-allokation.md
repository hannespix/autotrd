# Vorregistrierung V1 — Basis-Allokation auf Anlageklassen-ETFs

Geschrieben am 09.09.2026 **vor** dem Lauf. Das Commit-Datum belegt das.
Kriterien, die nach dem Lauf geändert werden, gelten nicht; dann folgt V2.

## Hypothese (T5)

Trend auf Anlageklassen-ETFs mit Regimefilter, absolutem Momentum und Rang
nach volatilitätsnormiertem Momentum, monatlich in einem Fenster von drei
Handelstagen, mit weitem Katastrophen-Stop, hält über 2020–2026 die
Marktrendite bei kleinerem Drawdown als SPY kaufen-und-halten. Die Kante
liegt in der Breite über Anlageklassen (D2, D3, D4), nicht in der Titelwahl.

**Was die Basis nicht behauptet:** Alpha. Sie ist der Standard statt
„nichts" (T13). Ihre Latte sind B1–B4, nicht die zehn Alpha-Gates; die
Gates werden mitgemessen und berichtet.

## Universum (ex ante festgelegt)

Regel: Fabers GTAA-13-Klassen, abgebildet auf den Kandidatenpool der
Plattform (`config/platform.yaml`), eine ETF je Klasse; Klassen ohne ETF im
Pool entfallen. Keine Klasse wurde nach ihrer Rendite 2020–2026 gewählt.

| Klasse | ETF | Anmerkung |
|---|---|---|
| US-Aktien groß | SPY | zugleich Benchmark |
| US-Aktien klein | IWM | |
| Aktien Industrieländer ex US | EFA | |
| Aktien Schwellenländer | EEM | |
| US-Staatsanleihen mittel | IEF | |
| US-Staatsanleihen lang | TLT | |
| Unternehmensanleihen IG | LQD | |
| Hochzinsanleihen | HYG | |
| Gold | GLD | |
| Rohstoffe | XLE | kein breiter Rohstoff-ETF im Pool; Energie-Sektor als Ersatz — bekannte Schwäche, siehe Verzerrungen |
| Immobilien | XLRE | |

Ausgeschlossen durch die Regel: QQQ, DIA, SLV, Sektor-ETFs außer XLE/XLRE
(keine GTAA-Klassen). TIPS, Auslandsanleihen, Auslands-Immobilien: nicht im
Pool.

## Strategie und feste Parameter

`regime_allocation` (Taktiken: Allokation nach Regime und Stärke), Parameter
innerhalb des bestehenden Rasters, literaturnah, nicht gesucht:

| Parameter | Wert | Begründung |
|---|---|---|
| lookback | 126 | sechs Monate Momentum (D1: 3–12 Monate) |
| skip | 21 | jüngster Monat ausgelassen (D7) |
| regimeLen | 150 | rund sieben Monate; Fabers zehn Monate (≈ 210) liegen außerhalb des Rasters, das nach der Prüfung in §5a.14 gekürzt wurde — bewusste Abweichung |
| topPct | 0,4 | die stärksten 40 % von 11 ⇒ bis zu vier Positionen = `maxPositions` |
| exitPct | 0,8 | Austritt erst, wenn schwächer als 80 % des Korbs — wenig Umschlag |
| stopPct | 20 | Katastrophen-Stop weit (T8) |

Risiko (Probe-Config): `riskPerTradePct 4`, `maxPositionPct 25`,
`maxPositions 4`, `maxGrossExposurePct 100`, `maxDailyLossPct 3`,
`maxDrawdownPct 20`, Long-only. Bei 20 % Stop ergibt das Risiko-Budget eine
Position von 20 % der Equity; vier Positionen sind 80 % Exposure.

Config: `config/basis-1440.yaml`, Zeitrahmen Tagesbars, 2000 Tage,
Korb fest (`foldMembership: fixed`, kein Kandidatenpool), Walk-Forward
IS 365 / OOS 90 / Holdout 180 wie in `equity-1440.yaml`. Der Optimierer
bewertet zusätzlich die gesuchte Variante von `regime_allocation` als
Vergleich (informativ).

## Annahmekriterien (auf der OOS-Kette des Festkandidaten)

| # | Kriterium | Warum |
|---|---|---|
| B1 | Netto > 0 nach Kosten, auch bei Kosten ×1,5 | Ein Standard, der Geld verliert, ist schlechter als Kasse. |
| B2 | OOS-Sharpe p. a. ≥ 0,75 × SPY-Sharpe über dieselben OOS-Fenster | Die Basis darf Ertrag gegen Drawdown tauschen, aber nicht beliebig. |
| B3 | MaxDD der OOS-Kette ≤ MaxDD von SPY kaufen-und-halten über die verketteten OOS-Fenster | Der Zweck der Basis. Fällt B3, hat sie keinen. |
| B4 | Gebührenanteil ≤ 25 % und 1 ≤ Trades je Monat ≤ 8 | Aktiv, nicht hyperaktiv (`aktivitaet.md`). |

Berichtet, kein Kriterium: Holdout mit Maßstab (Korb, SPY); die zehn
Alpha-Gates; die gesuchte Variante.

## Entscheidungsregeln

- B1–B4 erfüllt ⇒ Basis-Stufe im Champion (Task #33) für Paper-Konten;
  Echtgeld bleibt hinter `readiness` und dem Doppel-Guard.
- B3 verfehlt ⇒ nicht einsetzen, unabhängig vom Rest; V2 mit anderem
  Regimefilter erst nach Prüfer-Befund.
- B1 verfehlt ⇒ nicht einsetzen.
- B2 verfehlt, B1/B3/B4 erfüllt ⇒ „Drawdown-Versicherung mit
  Ertragsverlust": Bericht an den Owner, Entscheidung dort.
- B4 verfehlt (zu viele Trades) ⇒ nicht einsetzen; zu wenige Trades ⇒
  Bericht, weil dann kein Journal entsteht (T9).

## Bekannte Verzerrungen (vor dem Lauf benannt)

1. **Periode:** 2020-07 … 2026-09 enthält 2022, ein Jahr, in dem Aktien und
   Anleihen zugleich fielen und Energie stieg — trendfreundlich. Und den
   Goldlauf 2024/25. Ein Erfolg in dieser Periode ist schwächer als er
   aussieht; deshalb B3 als Kern, nicht B2.
2. **Rohstoff-Ersatz XLE:** profitiert rückblickend von 2022. Der Prüfer
   (#32) soll sagen, ob XLE raus muss; dann V2, nicht nachträgliche Änderung.
3. **Vier Plätze auf elf ETFs:** konzentriert; ein einzelner Fehlgriff wiegt
   schwer. Gegenmaßnahme ist der Stop, nicht mehr Plätze.
4. **Regimelänge 150 statt 210:** mehr Fehlsignale als bei Faber; das kostet
   in Seitwärtsphasen.
5. **Kein Pool-Survivorship** (Universum fest), aber die Klassenliste selbst
   ist eine Wahl aus dem Jahr 2026.
6. **Fold-Raster:** T4 gilt auch hier; ein Festkandidat hat aber keine
   Parametersuche je Fold — die Rasterabhängigkeit ist kleiner, nicht null.

## Ergebnis (eingetragen nach dem Lauf, 09.09.2026 abends)

Probe #36, Lauf 34407093077, `main` 1095e3b. Datenbereich 2021-03-22 …
2026-09-09 (2000 Tage ab heute — nicht ab 2020-07, wie oben vermutet),
16 Folds, OOS-Kette 2022-04 … 2026-03, Holdout 2026-03-13 … 2026-09-09.

| # | Kriterium | Gemessen | Urteil |
|---|---|---|---|
| B1 | Netto > 0, auch bei Kosten ×1,5 | +3 431 $ (+14,2 %); Stress +3 300 $ | ✔ |
| B2 | OOS-Sharpe ≥ 0,75 × SPY-Sharpe | 0,485 gegen 0,75 × 0,635 = 0,476 | ✔ knapp |
| B3 | MaxDD der Kette ≤ MaxDD SPY über dieselben Fenster | 9,7 % gegen 24,1 % | ✔ deutlich |
| B4 | Gebührenanteil ≤ 25 % und 1–8 Trades je Monat | 67,3 % und 0,6 Trades je Monat | ✘ beides |

Nebenzahlen: 11 von 16 Folds positiv, bester Fold trägt 33 %, PSR 0,83,
Nachbarschaft 100 % positiv. Die zehn Alpha-Gates reißt sie an vier Stellen
(oos_trades 28, PSR, fee_share, beats_market 0,49 gegen 0,63). Holdout:
+8,7 %, MaxDD 3,4 %, Sharpe 1,48 aus 3 Trades — Korb liegenlassen 0,91,
SPY 2,03 (+14,0 %, MaxDD 5,8 %): In einem starken Halbjahr bleibt der
Trendfilter hinter dem Index, wie D3 es vorhersagt.

**Urteil nach den Entscheidungsregeln: nicht einsetzen.** B4 ist verfehlt,
in beiden Teilen. Die Regeln oben sahen für „zu wenige Trades" einen
Bericht vor, für den Gebührenanteil nichts — eine Lücke der
Vorregistrierung, keine Lizenz, sie nachträglich zu füllen. V1 steht als
verfehlt im Protokoll.

**Was der Lauf über die Messung sagt (für V2, nicht für V1):** Der
Gebührenanteil ist Gebühren geteilt durch den Bruttogewinn der
GESCHLOSSENEN Trades (`backtest/metrics.ts`). Eine Allokation, die Monate
hält, schließt in 90-Tage-Folds kaum Trades; sieben Folds enden mit
0 Trades und trotzdem mit Netto zwischen −320 $ und +1 130 $ — das ist
unrealisierter Gewinn offener Positionen am Fold-Ende. Realisiert werden
vor allem Verlierer (Stops, Regimebrüche), der Nenner wird klein, der
Anteil groß. Für eine Alpha-Familie mit Tagen Haltedauer ist das Maß
richtig; für die Basis misst es den Umschlag nicht. Der Prüfer-Befund
(`../pruefungen/2026-09-09-redteam-basis-v1.md`) geht weiter: B3 war auf
dieser Kette strukturell nicht verfehlbar, B2 ein Münzwurf, und B1–B4
hatten keinen Code-Pfad. V2 wird davon ausgehen.
