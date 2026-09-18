# Vorregistrierung: Zeitreihen-Momentum je Symbol mit Totband (`time_series_momentum`)

**Datum:** 18.09.2026 · **These:** T23 (neu) · **Config:** `config/tsmom-1440.yaml`
**Status vor dem Lauf:** offen. Geschrieben und committet **vor** jeder
Messung dieser Familie; das Commit-Datum ist der Beleg. **Keine Zahl unten
stammt aus einem Lauf mit dieser Strategie — es gibt noch keinen.**
**Owner-Entscheidung** vom 18.09.2026 auf die Frage, wo nach der Kante zu
suchen ist: „Neue Familie" — nicht Zeitrahmen, nicht anderer Maßstab.

## Der Befund, der das auslöst

`docs/wissen/analysen/2026-09-15-die-erprobung-handelt-selten-und-verliert-beim-handeln.md`:
Die gemessenen Familien holen sich Bewegungen von 1,5–2,5 % über zwei bis
drei Handelstage (MFE-Median der Gewinner 2,43 %, Netto 1,56 %). Bei den
Kosten dieses Kontos ist das strukturell zu klein. `fee_share` sinkt nicht
durch selteneres Handeln — Gebühren und Bruttogewinn skalieren beide mit der
Trade-Zahl —, sondern nur durch einen **größeren Bruttogewinn je Trade**.

Und: Bei ALLEN fünf Familien reißen in Lauf #17 `probabilistic_sharpe_oos`
und `beats_market`. Die naheliegenden Hebel (Exit-Regel, Ziel, Stop,
Trailing) stehen in jedem der fünf Gitter und sind mit je 2 850 Trials
durchsucht. Wer sie „neu" vorschlägt, durchsucht dasselbe Gitter zweimal.

## Was AUSSERHALB der durchsuchten Räume liegt — der Beweis

| Familie | Horizont | Rang? | Ausstieg | Stop |
|---|---|---|---|---|
| `trend_donchian` | Kanal 10–60 Bars | nein | Kanaltief 5–30 Bars, ATR-Trail 0–5 | ATR 1,5–4 |
| `momentum_pullback` | EMA 10–200, RSI 2–14 | nein | RSI/EMA-Kreuz, ATR-Trail 0–5 | ATR 1,5–4 |
| `mean_reversion` | RSI 2–6, SMA 100–200 | nein | Rückkehr zum Mittel, Zeitstopp 3–15 | ATR 2–5 |
| `cross_sectional_momentum` | 20–120 Bars | **ja** | Rang > exitPct, ATR-Trail 0–5 | ATR 1,5–4 |
| `regime_allocation` | 63–126 (+21) | **ja** | Monatsfenster, Rang/Regime/Vorzeichen | 10–25 % |
| **`time_series_momentum`** | **63–126 (+21)** | **nein** | **Vorzeichen mit Totband, täglich** | **10–30 %** |

Drei Dinge zugleich sind neu: (1) rein symbolweise auf Monatshorizonten —
`cross_sectional_momentum` und `regime_allocation` brauchen den Rang, die
drei Signalfamilien enden bei 60-Bar-Kanälen; (2) der Ausstieg über das
**Vorzeichen des Momentums mit Totband** — nicht ATR-Trail, nicht Kanaltief,
nicht Monatsfenster, nicht Kursziel; (3) täglich bewertet, aber mit einem
Filter, der bauartbedingt Monate hält. Das ist die Mechanik, die eine
Bewegung laufen lässt, welche die anderen Familien nach drei Tagen
abschneiden.

Literatur: D2 (Moskowitz/Ooi/Pedersen 2012, Hurst/Ooi/Pedersen 2017 —
Vertrauen **hoch**), D3 (Faber 2007, mittel-hoch), D7 (Novy-Marx 2012,
hoch — daher `skip`). D2 sagt selbst: Die Kante liegt in der BREITE über
unkorrelierte Märkte, nicht in 30 US-Aktien. **Das ist das stärkste
Argument gegen diese Vorregistrierung, und es steht hier, bevor gemessen
wird.**

## Die Familie

`src/strategy/timeSeriesMomentum.ts`, ID `time_series_momentum`, nur
Tagesbars, long-only, `holdsOvernight`.

- **Einstieg:** eigenes Momentum `c[i−skip] / c[i−skip−lookback] − 1 > 0`
  UND `Close > SMA(regimeLen)`.
- **Ausstieg:** Momentum `< −exitBandPct`. Sonst nichts — kein Regime-Exit
  (nur Einstiegsbedingung), kein Trailing, kein Ziel, kein Zeitstopp.
- **Stop:** Katastrophen-Stop `stopPct` unter dem Einstand, beim Broker, nie
  nachgezogen; über ihn bemisst das Risiko-Budget die Stückzahl.
- **Gitter** (360 Kombinationen, 150 Stichproben je Fold decken es fast):
  `lookback` {63, 84, 105, 126} · `skip` {0, 21} · `regimeLen` {50, 100, 150}
  · `exitBandPct` {0, 2,5, 5} · `stopPct` {10, 15, 20, 25, 30}.
  Defaults 126 / 21 / 100 / 2,5 / 20.

**Bekannte Grenze, vor dem Lauf benannt:** Ein echtes Zwölf-Monats-Momentum
(D2) ist mit der Plattform-Geometrie **nicht messbar**. Das Embargo ist
`warmup + 20` Bars und wird vom Ende des IS-Fensters (~252 Bars)
abgeschnitten (`embargoBarsFor`, walkForward.ts); Warmup 275 verschluckte
das Fenster — der Fehler der ersten `regime_allocation`-Fassung. Die Decke
ist **152 Bars Warmup** (regimeLen 150 + 2; das Momentum selbst braucht
126 + 21 + 2 = 149) und lässt ~80 Entscheidungs-Bars je IS-Fenster.
*(Korrektur vor dem Lauf: Mein erster Entwurf schrieb 149 — der Wächter in
`test/strategy/timeSeriesMomentum.test.ts` hat die Zahl gefunden, nicht ich.)* **Nicht getan, absichtlich:** `optimizer.embargoBars` auf einen
festen kleinen Wert zu setzen, um 252 Bars zu ermöglichen — das wäre eine
Lockerung der Messhygiene zugunsten meiner eigenen Idee. Scheitert die
Sechsmonats-Fassung, ist die Zwölfmonats-Frage eine Owner-Frage zur
Fold-Geometrie, kein stiller Umbau.

## Config und Regelwerk

`config/tsmom-1440.yaml` ist `config/platform.yaml` Zeichen für Zeichen —
Universum (nächtliche Auswahl aus demselben Pool), Risiko, Kosten, Tore,
Zinsmaßstab BIL, Parken, bereinigte Bars, Fold-Geometrie —, mit genau drei
Unterschieden: `optimizer.strategies: [time_series_momentum]`, ein eigener
`paths.home`, und dieser Verweis. Nichts wird veröffentlicht; eine Probe
schreibt keinen Champion.

**Latte:** die zehn Alpha-Gates, unverändert. Keine dritte Latte (§0.9).

## Was ich VOR dem Lauf erwarte

| # | Erwartung | widerlegt, wenn |
|---|---|---|
| 1 | Der Lauf läuft durch: kein Embargo-Abbruch, ≥ 3 Folds, 18 Folds wie #17 | `candidateRange` wirft — dann ist die Decke falsch berechnet, nicht die Familie |
| 2 | **≥ 60 OOS-Trades** über die Kette (Gate `oos_trades`) | weniger — dann ist die Familie für diese Geometrie zu langsam; das ist ein gemessenes Nein, kein Grund, das Gate zu lockern |
| 3 | Trades je Monat **3–8** über den 30er-Korb (Maßstab-Zeile) — über der Erprobungs-Untergrenze 4 liegt sie damit vermutlich, sicher ist das nicht | < 2 oder > 12 |
| 4 | **`fee_share` ≤ 0,25** — die Hälfte des Gates; der ganze Zweck der Familie | > 0,5 (Gate reißt) — dann holt auch dieser Horizont keine größere Bewegung, und T23 ist widerlegt |
| 5 | Mittlere Haltedauer **≥ 20 Handelstage** (Maßstab-Zeile) | < 10 — dann wirkt das Totband nicht |
| 6 | In den fünf Bärenmarkt-Folds (Okt. 2021 – Dez. 2022) liegt die mittlere Exposure unter 40 % — der Filter hält die Familie draußen | die Familie ist dort voll investiert und verliert wie der Markt |
| 7 | `neighborhood_plateau` hält: Das Gitter ist klein und glatt, benachbarte Punkte handeln fast dasselbe | es reißt — dann hängt das Ergebnis an einem Gitterpunkt |

**Nicht erwartet und nicht behauptet:** dass `beats_market` oder
`probabilistic_sharpe_oos` bestehen. Beide sind bei allen fünf Familien
gerissen; ob ein Monatshorizont daran etwas ändert, ist die eigentliche
Messung. **Eingebauter Selbstzweifel:** Besteht die Familie im ersten Lauf
alle zehn Gates, wird sie NICHT in `platform.yaml` aufgenommen, bevor ein
Prüfer (Engine-Red-Team, §6) die Messung zu widerlegen versucht hat —
Lookahead im `momentum`-Index, Survivorship im Korb, Fold-Konzentration.

## Abbruchkriterien

- Erwartung 1 reißt ⇒ Config korrigieren, neuer Lauf, neue Zeile in
  `befunde.md`; keine Zahl aus dem Abbruch wird gewertet.
- Erwartung 2 oder 4 reißt ⇒ T23 gilt als widerlegt für diesen Korb. Kein
  zweiter Anlauf mit engerem Band, kürzerem Stop oder anderem Gitter — das
  wäre die Suche auf denselben Daten wiederholt (§2).

## Was danach kommt — festgelegt, bevor das Ergebnis da ist

- Alle zehn Gates bestanden ⇒ Prüfer, dann Owner-Frage zur Aufnahme in
  `platform.yaml` (dort würde sie nächtlich mitgemessen und könnte Champion
  werden — das ist die einzige Beförderungsstraße).
- Durchgefallen, aber Erwartungen 2–5 gehalten ⇒ Owner-Frage, ob sie in
  `optimizer.strategies` der Plattform aufgenommen wird, damit die
  Erprobung sie wählen KANN (nach Score unter ≥ 4 Trades je Monat) — auch
  das ist keine Beförderung.
- Erwartung 2 oder 4 gerissen ⇒ Familie bleibt registriert, in keiner
  Produktions-Config, Zeile in `befunde.md`, Konsequenz in `thesen.md`.

## Bezug

- Owner-Entscheidung 18.09.2026 (Frage 2 von 2).
- `docs/wissen/literatur.md` D2, D3, D7; `docs/wissen/taktiken.md`
- `docs/wissen/analysen/2026-09-15-die-erprobung-handelt-selten-und-verliert-beim-handeln.md`
- Lauf #17 (35169670191) als Vergleichslauf derselben Geometrie
- Aufgaben #49, #42
