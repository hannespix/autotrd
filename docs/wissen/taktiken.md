# Taktiken je Familie

Je Familie: Zweck, Eintritt, Austritt, erwartete Haltedauer, Aktivität,
Kostenempfindlichkeit, woran sie stirbt, Messstand. Die ausführbare Form
steht in `src/strategy/`; die Gates gelten für alle gleich.

## trend_donchian — Ausbruch aus dem Kanal
- **Zweck:** Zeitreihen-Trend je Symbol (D2), Ausbruch über das N-Tage-Hoch.
- **Eintritt:** Schluss über dem Donchian-Hoch, Regimefilter aufwärts.
- **Austritt:** Bracket (Stop/Ziel), Trailing nur enger und nur nach neuem
  Hoch; Signal-Exit nur als Trendbruch.
- **Haltedauer:** Tage bis Wochen. **Aktivität:** mittel.
- **Kosten:** empfindlich bei kurzen Kanälen (viele Fehlausbrüche).
- **Woran sie stirbt:** Seitwärtsmärkte, Bärenmärkte mit Long-only (2022).
- **Messstand:** in vier Fenstern unter der Latte (§5a.15); Gebührenanteil
  68 % im Fenster 2025-03. Kandidat, kein Standard.

## momentum_pullback — Rücksetzer im Trend
- **Zweck:** Kauf des Rücksetzers in einem intakten Aufwärtstrend.
- **Eintritt:** Trend aufwärts (langer Durchschnitt), Rücksetzer zum
  kurzen Durchschnitt, Wiederanstieg.
- **Austritt:** Bracket, Zeit-Exit.
- **Haltedauer:** Tage. **Aktivität:** mittel bis hoch.
- **Kosten:** empfindlich; Gebührenanteil 38–394 % je Fenster.
- **Messstand:** nie über der Latte; bester Score im nächtlichen Lauf vom
  09.09., fällt durch Fold-Positiv-Anteil, Fold-Konzentration, PSR.

## mean_reversion — kurzfristige Umkehr
- **Zweck:** Überverkauft kaufen (RSI-2/Bollinger), nach wenigen Tagen
  verkaufen (E1).
- **Eintritt:** RSI unter Schwelle bzw. unter dem Band, Regime aufwärts.
- **Austritt:** RSI-Erholung, Zeit-Exit (3–15 Bars), weiter ATR-Stop.
- **Haltedauer:** wenige Tage. **Aktivität:** hoch.
- **Kosten:** sehr empfindlich (86 % Gebührenanteil im Fenster 2025-03).
- **Woran sie stirbt:** an den Kosten und am Raster (T4).
- **Messstand:** ein voller Treffer (Fenster 2026-03, 0,83 gegen 0,63),
  der einer Rasterverschiebung um sechs Tage nicht standhält (§5a.15).
  Falsifikationslauf offen. Kandidat, kein Standard.

## orb_breakout — Opening-Range-Breakout (stillgelegt)
- **Zweck:** Intraday-Ausbruch aus der Eröffnungsspanne (B5).
- **Messstand:** auf 5-Minuten-Bars fraßen die Gebühren 271–2 438 % des
  Bruttogewinns (§5a.10). Nicht in `optimizer.strategies`. Bleibt im Code
  als Gegenprobe für T1.

## cross_sectional_momentum — Rang im Korb
- **Zweck:** Querschnitts-Momentum (D1): die stärksten x % des Korbs halten.
- **Eintritt:** Rang in den Top-x %, Regime aufwärts; Rangliste baut
  `decide()` aus geschlossenen Bars desselben Zeitpunkts (CLAUDE.md §0.2).
- **Austritt:** Rang fällt unter die Exit-Schwelle, Bracket.
- **Haltedauer:** Wochen. **Aktivität:** niedrig bis mittel.
- **Kosten:** moderat.
- **Woran sie stirbt:** an zu kleinen Körben (Literatur misst auf
  Tausenden Titeln) und am Korb-Survivorship (T3).
- **Messstand:** Treffer der ersten Reihe war der Endkorb (0,71 → 0,58);
  in der zweiten Reihe 0,02 / 0,58 / 0,24 / −0,09 gegen 0,64 / 0,63 / 0,46 /
  0,48.

## regime_allocation — Allokation nach Regime und Stärke
- **Zweck:** Dual Momentum (D4) im Monatsrhythmus: Regime (Kurs über
  Durchschnitt), absolutes Momentum > 0, relativer Rang nach `mom / rvol`
  (D5), Rebalance-Fenster von drei Handelstagen je Monat.
- **Eintritt:** im Fenster, Rang ≤ topPct, Regime aufwärts, Momentum > 0.
- **Austritt:** im Fenster bei Regimebruch, Momentum < 0 oder Rang >
  exitPct; dazu weiter Katastrophen-Stop beim Broker (T8), nie nachgezogen.
- **Haltedauer:** Monate. **Aktivität:** niedrig — 51–68 Trades über 12–16
  Folds, also 1–2 je Monat auf 30 Symbolen.
- **Kosten:** unempfindlich (Gebührenanteil nicht berechenbar oder klein).
- **Woran sie stirbt:** an der Trade-Zahl unter dem Gate (60) — Bauart —
  und daran, dass 30 korrelierte US-Aktien keine Breite haben (D2).
- **Messstand:** nie über der Latte (0,61 / 0,38 / 0,16 / −0,31); Holdout
  heute 1,77 aus 12 Trades. Auf diesem Korb kein Standard. Auf
  Anlageklassen-ETFs: Vorregistrierung V1.

## Basis-Allokation — Marktexposition mit Trendfilter (Vorregistrierung V1)
- **Zweck:** Der Standard statt „nichts": `regime_allocation` mit FESTEN,
  literaturnahen Parametern auf einem Korb aus Anlageklassen-ETFs (D2–D4).
  Keine Alpha-Behauptung; Anspruch ist Marktrendite bei kleinerem Drawdown.
- **Latte:** B1–B4 (siehe Vorregistrierung), nicht die zehn Alpha-Gates.
- **Haltedauer:** Monate. **Aktivität:** 1–6 Trades je Monat auf 4 Plätzen.
- **Woran sie stirbt:** an Seitwärtsmärkten mit Fehlsignalen im
  Monatsfenster, an einem Universum, das rückblickend gewählt wurde (Prüfer
  #32), und an Rebalance-Kosten, die bei 4 Positionen aber klein sind.
- **Messstand:** V1 (#36) verfehlte ihre Latte; V2 (#37–#39, Latte im Code,
  9 ETFs, durchgehende Simulation, Korb liegenlassen als Maßstab) bestand
  sie dreimal: Sharpe 0,79–1,01 gegen Korb 0,68–0,83, MaxDD je Einheit
  Exposure 12,1–12,4 % gegen Latte 15,5–15,6 %, Netto +23,8 bis +30,8 %,
  Kosten 2,4–3,3 %, 0,7–0,8 Trades je Monat, Haltedauer 68 Tage.
  V3 (#40, Regelwerk der Plattform, Tagesbremse 2 %): nicht bestanden —
  Sharpe 0,48, MaxDD je Einheit Exposure 15,95 % gegen 15,48 %. Die Stufe
  ist gebaut und schlafend; Aktivierung nur nach Owner-Entscheidung zu
  Bremsen je Stufe und V4.

## vigilant_allocation — Rang nach 13612W, Rotation in den Geldmarkt
- **Zweck:** Die erste Familie, die im fallenden Markt einen ORT hat.
  Momentum über vier Horizonte (12·r21 + 4·r63 + 2·r126 + r252, D8) auf
  einem gemischten Korb aus Risiko- und defensiven Papieren INKLUSIVE
  Geldmarkt-Surrogat (BIL). Fällt der Aktienteil, stehen die defensiven
  Papiere oben und sind die einzigen mit positivem Momentum — die Rotation
  fällt aus der Rangliste heraus.
- **Eintritt:** im Rebalance-Fenster (drei Handelstage je Monat, dieselbe
  Funktion wie `regime_allocation`), Rang ≤ `topN` UND eigenes 13612W > 0.
  Rangliste baut `decide()` (§0.2).
- **Austritt:** im Fenster bei negativem 13612W oder Rang > `exitRank`; dazu
  weiter Katastrophen-Stop beim Broker (20 %), nie nachgezogen, kein Ziel.
- **Haltedauer:** Monate (erwartet 40–90 Handelstage).
  **Aktivität:** niedrig — erwartet 0,7–1,5 Trades je Monat.
- **Kosten:** unempfindlich (wenige Entscheidungen, kein Trailing).
- **Warum nicht `regime_allocation` mit anderem Korb:** Deren Rangkennzahl
  ist `mom / rvol`. Ein Geldmarktpapier schwankt um 0,3 % p. a. und stünde
  damit IMMER auf Rang 1 — auch im Bullenmarkt. 13612W ist nicht
  volatilitätsnormiert und hat dieses Problem nicht. Wächter:
  `test/strategy/vigilantAllocation.test.ts`.
- **Was fehlt:** der Kanarienvogel. Kellers Wächterkorb verlangt den Blick
  auf fremde Zeitreihen; der Strategie-Vertrag gibt ihn nicht her. Die
  minimale Erweiterung (Breite im Korb-Rang) steht in der Vorregistrierung.
- **Woran sie stirbt:** an der Trade-Zahl unter dem Gate (60) — Bauart, wie
  bei `regime_allocation`; an einem Nullzinsumfeld, in dem der Geldmarkt
  nichts trägt; und daran, dass ihre Durchschnittskorrelation zu
  Aktien-Long-Familien hoch bleibt (niedrig ist sie nur dort, wo es zählt).
- **Messstand:** vorregistriert 12.09.2026 (T16), Config
  `config/vigilant-1440.yaml`. **Nichts gemessen.**

## index_reversal — Rücksetzer im Index, nicht in der Aktie
- **Zweck:** Der Aktivitäts-Sleeve. Kurzfristige Umkehr (E1) auf breiten
  Index-ETFs, wo ein Rücksetzer Liquiditätsnachfrage ist und keine
  Gewinnwarnung.
- **Eintritt:** `Close > SMA(200)` UND `RSI(2) < 10`. Der Trendfilter ist der
  Grund, warum die Sache überlebt.
- **Austritt:** was zuerst kommt — `RSI(2) > 70`, erster Schluss über dem
  Vortageshoch, Zeitstopp nach 5 Bars (Pflicht). Weiter ATR-Stop (4×), nie
  nachgezogen, kein Ziel (T8/F1).
- **Haltedauer:** Median 3 Handelstage (1–5).
  **Aktivität:** hoch — erwartet 2–5 Trades je Monat auf vier ETFs.
- **Kosten:** sehr empfindlich. Rund 10 bp je Round-Trip gegen einen
  erwarteten Bruttogewinn von 0,3–0,5 % je Trade; `fee_share` ist das
  bindende Gate, nicht die Trefferquote.
- **Besonderheit:** `crossScore` = −RSI. Bei knappen Plätzen gewinnt der
  tiefste Rücksetzer. Nebenwirkung: In gemischten Zyklen sortiert
  `core/logic.ts` rangierte Symbole vor unrangierte.
- **Woran sie stirbt:** an den Kosten; daran, dass der Effekt nach 2010
  nachgelassen hat (E2, Vertrauen niedrig); an starken Trends ohne
  Rücksetzer; und an Bärenmärkten, in denen der Trendfilter sie aus dem
  Markt hält — leere Quartale zählen bei `fold_positive_share` nicht als
  positiv.
- **Messstand:** vorregistriert 12.09.2026 (T17), Config
  `config/sleeves-1440.yaml`. **Nichts gemessen.**

## turn_of_month — der Monatswechsel
- **Zweck:** Marktrendite in rund einem Fünftel der Tage, aus Lohn-, Sparplan-
  und Pensionsflüssen zum Monatsende (H1–H3). Die orthogonalste Familie im
  Repo: Ihr Einstieg fragt keinen Kurs, sondern den Kalender — sie kann mit
  Trendfolge nicht korrelieren, weil sie nicht weiß, ob ein Trend besteht.
- **Eintritt:** Entscheidung am Schluss des Handelstags, auf den noch genau
  ein Handelstag des Monats folgt (Fill am Open des letzten). Genau EIN
  Einstieg je Symbol und Monat, kein Nachkauf.
- **Austritt:** Entscheidung am Schluss des dritten Handelstags des neuen
  Monats; Zeitstopp 8 Bars als Sicherheitsnetz. Weiter ATR-Stop (4×), kein
  Ziel, kein Trailing, kein Trendfilter (die Quellen finden den Effekt ohne
  einen).
- **Haltedauer:** 4 Handelstage, praktisch ohne Streuung.
  **Aktivität:** 4 Trades je Monat auf vier ETFs.
- **Kosten:** moderat; vier Round-Trips je Monat bei ~11 % Positionsgröße.
- **Die Stelle, an der sie falsch wird:** der Kalender. Handelstage kommen
  aus dem NYSE-Kalender (`core/time.ts`), nie aus der Bar-Zählung — Bars zu
  zählen wäre Lookahead. Wächter mit Neujahr, Karfreitag, vorgezogenem
  4. Juli, Monatsende am Wochenende und Zeitumstellung:
  `test/strategy/turnOfMonth.test.ts`.
- **Woran sie stirbt:** an H4 (Kalendereffekte überleben eine
  Mehrfachtest-Korrektur schlecht) und an C7 (Zerfall nach
  Veröffentlichung); an der Ausführungslücke (wir besitzen open-zu-open,
  gemessen wird in der Literatur Schluss-zu-Schluss, und ein großer Teil der
  Rendite fällt über Nacht an, B3); und daran, dass die Stop-Distanz die
  Positionsgröße klein hält — erwartet 0,9–1,7 % im Jahr.
- **Messstand:** vorregistriert 12.09.2026 (T18), Config
  `config/sleeves-1440.yaml`. **Nichts gemessen.**

## Kasse — nicht handeln
- **Zweck:** Das Ergebnis, wenn keine Taktik ihre Latte nimmt. Kostet 0 $.
- **Messstand:** in den vier Holdouts 2024–2026 hätte kaufen-und-liegenlassen
  jede Strategie geschlagen; Kasse hätte 3,7–15,7 % je Halbjahr verpasst.
  Kasse ist zulässig, aber sie ist kein Ziel — daher T13.
