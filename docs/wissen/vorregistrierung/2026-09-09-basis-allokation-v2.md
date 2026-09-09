# Vorregistrierung V2 — Basis-Allokation, gemessen mit der Latte im Code

Geschrieben am 09.09.2026 **vor** dem Lauf, nach Probe #36 (V1) und dem
Prüfer-Befund `../pruefungen/2026-09-09-redteam-basis-v1.md`. V1 bleibt
unverändert stehen; V2 ersetzt sie nicht rückwirkend, sondern misst neu.

## Was V1 nicht konnte (Eingeständnis)

V1 hat T5 nicht bestätigt. Ihre Kriterien wurden von Hand aus dem Bericht
gelesen (K1), B3 war bei ≤ 80 % Exposure und Peak-Reset je Fold gegen den
SPY-MaxDD nicht verfehlbar (K2), B2 lag mit 0,16 Marge innerhalb der
Streuung (K2), und 90-Tage-Folds zählen für eine Monatsstrategie weder
Trades noch Kosten richtig (M6). Dazu: Universum gegen die eigene Regel
(M10), Rang-Schwellen falsch gelesen (M5), Preisbars ohne Ausschüttungen
(M7). Was V1 gezeigt hat und bleibt: Die Familie verliert auf dieser Kette
kein Geld (B1), und sie lag in den Fenstern, in denen sie verlieren muss
(F4 Rally Jan. 2023, F7 Okt.-2023-Dip, F13 April 2025), hinter SPY — die
Messung ist nicht offensichtlich kaputt.

## Hypothese (T5, unverändert)

Trend auf Anlageklassen-ETFs mit Regimefilter, absolutem Momentum und Rang
nach volatilitätsnormiertem Momentum, monatlich in einem Fenster von drei
Handelstagen, mit weitem Katastrophen-Stop, hält den Ertrag je Risiko des
liegengelassenen Korbs annähernd (≥ 90 %) und senkt dessen Drawdown je
Einheit Exposure um mindestens ein Viertel, nach Kosten. Keine
Alpha-Behauptung; kein Vergleich gegen SPY als Kriterium — SPY ist ein
anderer Korb (K2), er wird berichtet.

## Änderungen gegenüber V1, je mit Prüfbefund

| Befund | Änderung in V2 |
|---|---|
| K1 Kriterien ohne Code-Pfad | Gate-Gruppe `basis` in `src/optimize/robustness.ts`, Schwellen in `optimizer.basis` (Config = ausführbare Form dieser Vorregistrierung); `meta/champion.basis.pass` entscheidet, nicht eine Hand. |
| M6, M11 90-Tage-Folds, IS-Embargo | EINE durchgehende Simulation über die OOS-Kette (bei 2000 Tagen: 2022-04 … 2026-03), Positionen über Fold-Grenzen, Warmup aus der Historie, kein IS-Fenster. Die 90-Tage-Scheiben werden nur berichtet. |
| K2 Latte SPY, MaxDD unverfehlbar | Latte ist **Kaufen und Halten des Korbs, gleichgewichtet, ohne Kosten, dieselbe Range**. MaxDD **je Einheit mittlerer Exposure**. SPY nur Bericht. |
| M10 Universum gegen die Regel | Nur Klassen der GTAA-13-Liste mit ETF im Pool: **9** — SPY, IWM, EFA, EEM, IEF, TLT, LQD, GLD, XLRE. HYG (keine Klasse) und XLE (kein Rohstoff) raus. Es gibt KEINE zweite Variante mit 11; wer nach dem Lauf eine will, schreibt V3. |
| M5 Rang-Schwellen | `pct = (rank−1)/(of−1)`: bei 9 ETFs ergibt `topPct 0,4` genau vier Berechtigte (= `maxPositions`), `exitPct 0,6` Austritt ab Rang 6 von 9. V1 hatte mit 0,8 praktisch keinen relativen Austritt. |
| M7 Preisbars ohne Ausschüttungen | `broker.adjustment: all` — ausschüttungsbereinigte Tagesbars, eigener Cache. Gilt für Signale und Latte gleichermaßen. |
| M8, M9 Notbremsen | `maxDailyLossPct 5`, `maxDrawdownPct 30`. In der durchgehenden Simulation gibt es kein `resume`: Löst der Drawdown-Halt aus, bleibt die Basis in Kasse und fällt durch — das ist gewollt, nicht Messfehler. |
| K4 Gemessenes Risiko handelt niemand | Die Probe misst 20 % je Position (Risiko 4 % bei Stop 20 %). Die Basis-Stufe der Plattform (Task #33) muss genau das tun: Position = 20 % der Equity, unabhängig vom Risiko je Trade der Nutzer; Nutzer schalten die Basis an oder aus. Ohne diese Semantik wird nichts aktiviert. `readiness` für die Basis-Stufe: Entscheidung des Owners (Vorschlag: ≥ 90 Tage Paper, MaxDD ≤ 10 %, Netto ≥ 0 — statt 200 Trades). |
| K3 Familienwahl auf derselben Kette | Bekannt und nicht korrigierbar: `regime_allocation` war in Lauf 31 die beste von fünf auf fast derselben Kette. Die Kriterien sind keine statistischen Tests; die Gegenmittel sind die Falsifikationsläufe (M13) und der Vorwärtstest auf Paper (T9). |
| M12 Vergleichsvariante misst Rauschen | Die gesuchte Variante bleibt aus Schema-Gründen in `strategies`, ihr Ergebnis ist ohne Bedeutung und wird nicht zitiert. |
| M13 Kettenbeginn ist Raster-Glück | Zwei Falsifikationsläufe mit `--as-of` 15 und 30 Tage vor dem Hauptlauf, gleiche Config. Kriterium: dasselbe Urteil der Gruppe in allen drei Läufen. |
| G16 Drei Zahlen für Aktivität | Eine Erwartung: 1–4 Trades je Monat, mittlere Haltedauer ≥ 40 Handelstage, mittlere Exposure 40–80 %. Berichtet, nicht bewertet. |

Parameter (fest, im Raster; die Literatur-Horizonte 10/12 Monate liegen
außerhalb des Suchrasters und folgen als V3, sobald Festkandidaten eigene
Grenzen haben — V2 ist die kurze Variante, sechs Monate Momentum, sieben
Monate Regime):

| Parameter | Wert |
|---|---|
| lookback | 126 |
| skip | 21 |
| regimeLen | 150 |
| topPct | 0,4 (⇒ 4 von 9) |
| exitPct | 0,6 (⇒ Austritt ab Rang 6) |
| stopPct | 20 |

Config: `config/basis-1440-v2.yaml`; Tagesbars, 2000 Tage, Korb fest,
Kettenbeginn = OOS-Beginn des ersten Folds des Standardplans (IS 365 /
OOS 90), Holdout 180 Tage wie bisher (Bericht).

## Kriterien — Gate-Gruppe `basis` (alle vier müssen bestehen)

| Gate | Kriterium | Schwelle (`optimizer.basis`) |
|---|---|---|
| basis_net_profit | Netto > 0 nach Kosten UND bei Kosten ×1,5 | `stressCostMultiplier 1.5` |
| basis_drawdown | MaxDD / mittlere Exposure ≤ (1 − 0,25) × MaxDD Korb liegenlassen | `minDrawdownReduction 0.25` |
| basis_sharpe | Sharpe p. a. ≥ 0,9 × Sharpe Korb liegenlassen (Korb ≤ 0 ⇒ Basis > 0) | `minSharpeRatio 0.9` |
| basis_costs | Gebühren gesamt / \|Netto\| ≤ 0,10 | `maxCostShare 0.10` |

Berichtet, kein Kriterium: SPY-Sharpe und -MaxDD über dieselbe Range;
Scheiben-Tabelle (Basis, Korb, SPY je 90 Tage) mit den drei Fenstern, in
denen die Basis verlieren muss; Holdout mit Maßstab; Trades je Monat,
Haltedauer, Exposure, Tage ohne Position; PSR gegen den Korb-Sharpe.

## Entscheidungsregeln

- Alle vier Gates bestanden im Hauptlauf UND dasselbe Urteil in beiden
  Falsifikationsläufen ⇒ die Basis-Stufe (Task #33) darf gebaut und für
  Paper-Konten aktiviert werden — mit der Sizing-Semantik aus K4, sonst
  nicht. Echtgeld bleibt hinter Doppel-Guard und `readiness`.
- Ein Gate verfehlt, oder die drei Läufe widersprechen sich ⇒ nicht
  einsetzen. Dann V3 erst nach einer neuen Prüfer-Runde; keine
  Parametersuche „bis es passt".
- Ein Ergebnis, das die zehn Alpha-Gates bestünde, ist hier ohne Bedeutung:
  Die Basis läuft nicht durch die Alpha-Gates und wird nie Alpha-Champion.

## Bekannte Verzerrungen (vor dem Lauf)

1. Periode 2022-04 … 2026-03: enthält den Bond-Bär 2022 und den Goldlauf
   2024/25 — trendfreundlich für diese Klassen. Die Falsifikationsläufe
   ändern daran wenig (gleiche Jahre); nur der Vorwärtstest ändert es.
2. Neun ETFs bei `MIN_KORB 8`: Fehlt an einem Tag eine Reihe, gibt es
   keinen Rang. Der Bericht nennt die Zahl der Tage ohne Rang.
3. Fillkurs = nächste Eröffnung, IEX-Tagesbars; Ganzstück-Rundung bei
   25 000 $ Startkapital (M14) kostet SPY-Positionen bis zu 4 % der
   Sollgröße — gegen die Basis, nicht für sie.
4. Kurze Horizonte (6/7 Monate) sind nicht Faber/Antonacci. V2 testet die
   kurze Variante; ein Erfolg wäre kein Beleg für die lange, ein Misserfolg
   kein Urteil über sie.
5. Die gleichgewichtete Latte hat keine Kosten und wird nie rebalanciert;
   sie ist ein Maßstab, kein handelbares Produkt.

## Ergebnis

_Wird nach den drei Läufen eingetragen: Lauf-Nummern, Range, die vier
Gates mit Zahlen in allen drei Läufen, Urteil, Konsequenz._
