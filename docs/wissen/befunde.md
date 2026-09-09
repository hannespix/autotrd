# Befunde — Protokoll aller Messläufe

Eine Zeile je Lauf. `Lauf` ist die Nummer des Probe-Workflows (`probe.yml`)
oder „Nacht" für den nächtlichen Optimierer. Sharpe-Werte sind OOS-Sharpe
p. a. der besten Strategie und die SPY-Latte über dieselben OOS-Fenster;
Details in `docs/ARCHITEKTUR.md` §5a und in `docs/wissen/thesen.md`.

| Datum | Lauf | Config | Datenbereich | Korb | Beste Strategie (OOS-Sharpe) | Latte SPY | Urteil | Bezug |
|---|---|---|---|---|---|---|---|---|
| 09.09.2026 | 20 | equity-1440, heute | 2021-03 … 2026-09 | Endkorb | csm 0,53 | 0,64 | kein Handel | §5a.12 |
| 09.09.2026 | 28 | equity-1440, Stichtag 2026-03-06 | 2020-09 … 2026-03 | Endkorb | csm 0,71 ✔ 10/10 | 0,63 | promote (Probe) — später als Korb-Survivorship erkannt | §5a.12, T3 |
| 09.09.2026 | 29 | equity-1440, Stichtag 2025-09-05 | 2020-07 … 2025-09 | Endkorb | td −0,02 | 0,46 | kein Handel | §5a.12 |
| 09.09.2026 | 30 | equity-1440, Stichtag 2025-03-07 | 2020-07 … 2025-03 | Endkorb | mp 0,23 | 0,48 | kein Handel | §5a.12 |
| 09.09.2026 | 31 | equity-1440, heute, 5 Familien | 2021-03 … 2026-09 | je Fold | regime 0,61 | 0,64 | kein Handel | §5a.15 |
| 09.09.2026 | 32 | equity-1440, Stichtag 2026-03-06, 5 Familien | 2020-09 … 2026-03 | je Fold | mr 0,83 ✔ 10/10 | 0,63 | promote (Probe) — hängt am Raster (T4) | §5a.15 |
| 09.09.2026 | 33 | equity-1440, Stichtag 2025-09-05, 5 Familien | 2020-07 … 2025-09 | je Fold | mr 0,49 (8/10) | 0,46 | kein Handel | §5a.15 |
| 09.09.2026 | 34 | equity-1440, Stichtag 2025-03-07, 5 Familien | — | je Fold | nicht bewertbar (Streuner-Bar SO 2019-11-11) | — | rot, Exit 3 | §5a.11 Nachtrag |
| 09.09.2026 | 35 | equity-1440, Stichtag 2025-03-07, 5 Familien | 2020-07 … 2025-03 | je Fold | mp 0,39 | 0,48 | kein Handel | §5a.15 |
| 09.09.2026 | Nacht (07:53 UTC) | platform.yaml | — | je Fold | mp (Score 2,119) fällt durch | — | 0 Symbole, 30 noTrade veröffentlicht | Wachhund 11:09: Takt schlägt |
| 08./09.09.2026 | Krypto 60 / 1440 | crypto-60, crypto-1440 | 2025-08 … 2026-09 / 2022-11 … 2026-09 | fest (BTC, ETH, SOL) | alle negativ bis 0,19 | — | kein Handel | T12 |
| 08.09.2026 | 5-Minuten-Bars | pooled-us30 (5 Min) | — | Endkorb | Gebühren 271–2 438 % des Bruttogewinns | — | kein Handel; Plattform auf Tagesbars | §5a.10, T1 |
| 09.09.2026 | 36 | basis-1440 (V1, Festkandidat) | 2021-03 … 2026-09 | fest (11 ETFs) | Basis V1 0,49 (B1–B3 ✔, B4 ✘: Gebührenanteil 67 % realisiert, 0,6 Trades/Monat) | 0,63 | nicht einsetzen; V2 nach Prüfer-Befund | V1, T5 |

## Offen (vorregistriert)

| Vorregistrierung | These | Lauf | Ergebnis |
|---|---|---|---|
| V1 Basis-Allokation (`vorregistrierung/2026-09-09-basis-allokation.md`) | T5 | Probe #36 | B1–B3 ✔, B4 ✘ — nicht einsetzen; Prüfer: B3 nicht verfehlbar, Kriterien ohne Code-Pfad ⇒ V2 |
| V2 Basis-Allokation (`vorregistrierung/2026-09-09-basis-allokation-v2.md`) | T5 | Hauptlauf + zwei Falsifikationsläufe (−15/−30 Tage), ausstehend | — |
