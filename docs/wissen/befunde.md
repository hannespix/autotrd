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
| 10.09.2026 | Nacht #8 (Cron 23:00, gefeuert 00:55 UTC) | platform.yaml, Korb 30 aus 139 | 2022-11 … 2026-09 | je Fold (10 Stände) | csm OOS-Median 1,99, Folds positiv 78 %, 277 Trades — fällt durch (fold_concentration, beats_market); alle fünf Familien ✘ beats_market | — | 0 Symbole, 30 noTrade, keine Basis veröffentlicht; engineConfig geschrieben | wie 09.09.; Symbolprofil ab PR #477 |
| 10.09.2026 | Nacht #9 (von Hand, 01:20 UTC, nach Merge von PR #477) | platform.yaml, Korb 30 aus 139 | 2022-11 … 2026-09 | je Fold (10 Stände) | wie #8 (dieselben Daten, dasselbe Urteil) | — | 0 Symbole, 30 noTrade; **erstes `meta/symbolProfile`** (30 Symbole, 45 kB, alle „keine Taktik", `championUpdatedAt` = Champion) — Kette Champion → Config → Profil einmal echt durchlaufen | PR #477, `docs/wissen/symbolprofile.md` |
| 08./09.09.2026 | Krypto 60 / 1440 | crypto-60, crypto-1440 | 2025-08 … 2026-09 / 2022-11 … 2026-09 | fest (BTC, ETH, SOL) | alle negativ bis 0,19 | — | kein Handel | T12 |
| 08.09.2026 | 5-Minuten-Bars | pooled-us30 (5 Min) | — | Endkorb | Gebühren 271–2 438 % des Bruttogewinns | — | kein Handel; Plattform auf Tagesbars | §5a.10, T1 |
| 09.09.2026 | 36 | basis-1440 (V1, Festkandidat) | 2021-03 … 2026-09 | fest (11 ETFs) | Basis V1 0,49 (B1–B3 ✔, B4 ✘: Gebührenanteil 67 % realisiert, 0,6 Trades/Monat) | 0,63 | nicht einsetzen; V2 nach Prüfer-Befund | V1, T5 |
| 09.09.2026 | 37 | basis-1440-v2 (Basis-Latte im Code, durchgehend) | 2021-03 … 2026-09 | fest (9 ETFs) | Basis V2: Netto +23,8 %, Sharpe 0,79 (Korb 0,68), MaxDD/Exposure 12,1 % (Latte 15,5 %), Kosten 3,3 % | SPY 0,71 (Bericht) | **Basis-Latte bestanden** | V2 |
| 09.09.2026 | 38 | basis-1440-v2, Stichtag 2026-08-25 | 2021-03 … 2026-08 | fest (9 ETFs) | Basis V2: +30,8 %, Sharpe 1,01 (Korb 0,83), MaxDD/Exposure 12,2 % (15,5 %), Kosten 2,4 % | SPY 0,82 | bestanden (Falsifikation 1) | V2 |
| 09.09.2026 | 39 | basis-1440-v2, Stichtag 2026-08-10 | 2021-02 … 2026-08 | fest (9 ETFs) | Basis V2: +28,8 %, Sharpe 0,96 (Korb 0,79), MaxDD/Exposure 12,4 % (15,6 %), Kosten 2,6 % | SPY 0,86 | bestanden (Falsifikation 2) | V2 |
| 10.09.2026 | 40 | basis-1440-v3 (= platform.yaml + Basis; Bremsen 2 %/10 %) | 2021-03 … 2026-09 | Alpha je Fold + Basis fest (9 ETFs) | Basis: +12,5 %, Sharpe 0,48 (Korb 0,68), MaxDD/Exposure 15,95 % (Latte 15,48 %), Kosten 7,2 %; Alpha td 1,195 fällt durch | SPY 0,71 | **Basis nicht bestanden** — Tagesbremse 2 % stellt in Aug. 2024 und Apr. 2025 glatt | V3 |
| 10.09.2026 | 41 | basis-1440-v3, Stichtag 2026-08-25 | 2021-03 … 2026-08 | Alpha je Fold + Basis fest (9 ETFs) | Basis: +18,2 %, Sharpe 0,69 (Korb 0,83), MaxDD/Exposure 16,16 % (Latte 15,55 %), Kosten 4,4 % | — | nicht bestanden (Falsifikation 1, dasselbe Urteil) | V3 |

## Offen (vorregistriert)

| Vorregistrierung | These | Lauf | Ergebnis |
|---|---|---|---|
| V1 Basis-Allokation (`vorregistrierung/2026-09-09-basis-allokation.md`) | T5 | Probe #36 | B1–B3 ✔, B4 ✘ — nicht einsetzen; Prüfer: B3 nicht verfehlbar, Kriterien ohne Code-Pfad ⇒ V2 |
| V2 Basis-Allokation (`vorregistrierung/2026-09-09-basis-allokation-v2.md`) | T5 | #37, #38 (−15 Tage), #39 (−30 Tage) | **bestanden, dreimal dasselbe Urteil** — Basis-Stufe darf gebaut und auf Paper aktiviert werden |
| V3 Basis-Allokation unter dem Regelwerk der Plattform (`vorregistrierung/2026-09-09-basis-allokation-v3.md`) | T5 | Hauptlauf #40 (Falsifikation #41 mitgelaufen, −30 nicht gestartet) | **nicht bestanden** (basis_drawdown 15,95 % gegen 15,48 %, basis_sharpe 0,48 gegen 0,61) — Ursache Tagesbremse 2 %; keine Aktivierung; Owner-Entscheidung zum Regelwerk |
