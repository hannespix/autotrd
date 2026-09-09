# Red-Team-Befund — Vorregistrierung V1 „Basis-Allokation" (09.09.2026)

Prüfer-Auftrag: widerlegen. Gegenstand: `docs/wissen/vorregistrierung/2026-09-09-basis-allokation.md`
(Commit ac461dd), `config/basis-1440.yaml`, `thesen.md` (T5, T13), `taktiken.md`, `aktivitaet.md`,
sowie der **uncommitted** Baustand von `fixedCandidates` in `src/core/config.ts`, `src/optimize/{run,walkForward,robustness,report,promote}.ts`,
`src/backtest/marktbezug.ts` (Stand: während dieser Prüfung in Arbeit).

Methode: Code gelesen, Rechnungen mit zwei Node-Skripten gegen die Repo-Funktionen
(`buildFolds`, `embargoedEnd`, `korbRaenge`, `neighbors`, `parseConfig`) — im Scratchpad
(`check1.ts`, `check2.ts`). **Kein Bars-Cache auf der Platte** (`var/`, `var-probe/` fehlen), also kein
Datenlauf; Marktzahlen (SPY-Tage, Renditeyields) sind Größenordnungen aus dem Gedächtnis und
als solche markiert — vor Verwendung in einer Entscheidung nachschlagen (README-Regel 4).

Schwere: **K** = das Urteil des Laufs wäre falsch oder unerzeugbar · **M** = verzerrt das Urteil
messbar oder verletzt eine CLAUDE.md-Regel · **G** = Unschärfe, die vor dem Lauf zu beheben ist.

---

## A. Befunde

### 1 (K) — B1–B4 haben keinen Code-Pfad; der Code misst und befördert nach den zehn Gates, die Vorregistrierung nach B1–B4

**Beleg.** Vorregistrierung Z. 67–89: „Annahmekriterien auf der OOS-Kette des Festkandidaten … B1–B4 erfüllt ⇒ Basis-Stufe
im Champion". Der Baustand sagt das Gegenteil: `src/core/config.ts` (Diff, `fixedCandidates`-Kommentar): „laufen durch
… dieselben Gates … und in derselben Liste um die Beförderung konkurrieren — kein Sonderweg nach oben";
`src/optimize/run.ts` `bewerte()`: `robustnessGates({... fixed: true ...})` mit **voller** `oos_trades`-Schwelle 60,
`results.sort(byScoreDesc)`, `bestPassed ?? bestAny` ⇒ Beförderung nur über zehn Gates. B1–B4 rechnet nirgends
eine Funktion; sie müssten von Hand aus der neuen Maßstab-Zeile (`massstabZeile`, report.ts) abgelesen werden.
Die Entscheidungsregeln der Vorregistrierung („Basis-Stufe im Champion", „Bericht an den Owner, Entscheidung dort")
sind damit **Hand-Entscheidungen nach Sicht der Daten** — genau das, was §0.9 („Niemand hilft nach") ausschließt.

**Folge.** Entweder das Ergebnisfeld der Vorregistrierung wird von Hand ausgefüllt und ein Mensch schreibt
`meta/champion` (Task #33) — dann ist die Basis ein Override —, oder der Optimierer befördert den Festkandidaten
zufällig über die zehn Gates (mit `beats_market` gegen SPY ×1,0 = **Alpha-Behauptung**, die die Vorregistrierung
ausdrücklich nicht erhebt). Beides widerspricht dem Dokument.

**Vorschlag.** Vor dem Lauf entscheiden und im Code festschreiben: B1–B4 als eigene Gate-Gruppe
(`robustnessGates` mit `tier: 'basis'`), Beförderung nur in eine eigene Champion-Stufe (`tier: 'basis'`,
nie als Alpha-Champion), ausgelöst nur vom Code, nie von Hand; die zehn Gates werden bei `tier: basis`
berichtet, nicht angewandt. Sonst: Vorregistrierung V1 auf „nur Bericht, keine Konsequenz im Champion" zurückstufen
und das ehrlich hinschreiben. Siehe auch Befund 15 (§0.9-Formulierung).

### 2 (K) — B3 ist auf diesen Daten nicht verfehlbar; B1 und der Gebührenteil von B4 sind Dekoration; die Obergrenze von B4 ist unerreichbar; das einzige Kriterium mit Zähnen (B2) hat die Hintertür

**Rechnung Fold-Plan** (`buildFolds`, `check1.ts`): Messfenster 2000 Tage ⇒ Daten ab 2021-03-19; 16 Folds; OOS-Kette
**2022-04-03 … 2026-03-13 (1440 Tage)**, Holdout 2026-03-13 … 2026-09-09. Die Kette ist lückenlos (Schritt = OOS),
aber sie beginnt am 3. April 2022 — **nach** dem Q1-2022-Rückgang: SPY ≈ −6 % vom Hoch, TLT/IEF/LQD unter ihrem
150-Tage-Mittel, IWM/EFA/EEM ebenso. Der Regimefilter ist zu Kettenbeginn bereits „aus". SPY fällt in der Kette
danach auf ≈ −21 % (Apr → Okt 2022; Gedächtniswert). Die Basis hält in F1–F3 bestenfalls XLE und (bis Juni) GLD,
also ≤ 40 % Exposure.

**Struktur.** Exposure ≤ 80 % (4 × 20 %), Zwangs-Kasse zu jedem Fold-Beginn (Befund 6: 9,4 % der OOS-Zeit),
Peak-Reset je Fold, Regimefilter ⇒ der verkettete MaxDD der Basis kann die ≈ 21 % von SPY nur reißen, wenn der
gehaltene Korb um > 26 % in ≤ 90 Tagen fällt. In der Kette gibt es keinen solchen Abschnitt, in dem der Filter
investiert wäre. **B3 misst Exposure, nicht Regel** — eine Zufalls-Allokation 4-aus-11 im Monatsrhythmus
bestünde B3 ebenfalls.

**B1:** Kosten einer Monatsstrategie: 10 bp je Round-Trip auf 20 % Equity = 2 bp Equity je Trade; ~40 Trades ⇒
≈ 0,8 % Equity über vier Jahre; Stress ×1,5 ⇒ +0,4 %. Netto > 0 in einer Kette, in der SPY ≈ +60 % macht,
ist keine Prüfung der Regel. **B4-Gebühren ≤ 25 %:** bei Bruttogewinn im zweistelligen Prozentbereich liegt der
Anteil bei 2–5 % — unverfehlbar. **B4-Obergrenze 8 Trades/Monat:** 4 Plätze × 3 Fenster je Fold ⇒ selbst bei
maximalem Umschlag ≈ 2–3 Round-Trips/Monat; 8 ist unerreichbar. Die **Untergrenze 1/Monat** ist die einzige
bindende Seite — und die hat als Konsequenz nur „Bericht".

**B2:** SPY-Latte über dieselbe Kette ≈ 0,64 (§5a.15, Lauf 31, Kette ±1 Tag identisch) ⇒ Schwelle 0,48.
Standardfehler eines Sharpe über T = 3,94 Jahre: √((1 + SR²/2)/T) ≈ 0,55 (Lo 2002). Die Marge 0,16 ist **weniger
als ein drittel Standardfehler**; auch die Differenz zweier korrelierter Sharpes hat SE ≈ 0,35–0,4. B2 ist auf 16
Quartalen ein Münzwurf — und genau dieses Kriterium hat die Regel „B2 verfehlt ⇒ Bericht an den Owner, Entscheidung dort".

**Vorschlag.** (a) B3 gegen den **gleichgewichteten 11-ETF-Korb liegenlassen** über dieselben Fenster messen
(Fabers eigentliche Behauptung: halber Drawdown gegenüber dem diversifizierten Buy-and-Hold), `marktKette` kann das
mit der Korb-Map heute schon; SPY nur als zweite Zeile. (b) B3 zusätzlich exposure-normiert: MaxDD der Basis
≤ 0,7 × MaxDD des Korbs ODER Calmar (Rendite/MaxDD) ≥ Korb. (c) B1 streichen oder relativ machen (Netto ≥ 50 % der
Korb-Rendite). (d) B4: Obergrenze 3/Monat, Untergrenze 0,75/Monat **mit** Konsequenz „nicht einsetzen"
(T13 fordert ein Journal; ohne Journal hat die Basis ihren Zweck verfehlt). (e) Ein statistisches Kriterium:
PSR der OOS-Kette mit `sr0 = 0,75 × SPY-Sharpe je Periode` ≥ 0,6 (`probabilisticSharpe` hat `sr0` bereits) —
und im Dokument ausdrücklich: „16 Quartale können T5 weder bestätigen noch widerlegen; V1 ist ein
Ausschlusstest, kein Beleg. T5 bleibt nach V1 `offen`." (f) Keine Hintertür: jedes verfehlte Kriterium heißt
„nicht einsetzen, V2".

### 3 (K) — Die Familie wurde auf derselben Kette ausgewählt, die jetzt als out-of-sample gilt

**Beleg.** §5a.15, Lauf 31 („heute", Datenende 2026-09-08): fünf Familien auf derselben Kette 2022-03 … 2026-03;
`regime_allocation` war mit 0,61 gegen 0,64 „die beste unter der Latte". Die Kette der Basis (Datenende 2026-09-09)
ist bis auf einen Tag dieselbe. Die Vorregistrierung nennt als Neues nur das Universum (11 ETFs) — die ETFs sind
Index-Körbe, die mit den 30 Großwerten hoch korrelieren. Damit ist die OOS-Kette **nicht out-of-sample bezüglich
der Wahl der Familie**; „Bekannte Verzerrungen" 1–6 erwähnen das nicht.

**Vorschlag.** Als Verzerrung 7 benennen. Einziger unberührter Zeitraum ist der Holdout 2026-03 … 2026-09 (ein
Halbjahr). Konsequenz für den Status: V1 bestätigt T5 nicht; erst der Paper-Vorwärtstest (T9) tut das.

### 4 (K) — Gemessen wird ein Risiko-Profil, das auf der Plattform niemand handelt; und `readiness` ist für die Basis unerreichbar

**Beleg.** Probe-Risiko: 4 / 25 / 4 Plätze / 100 / 3 / 20 (`basis-1440.yaml` Z. 31–38). Auf der Plattform kommt
`risk` **nur** aus `users/{uid}.settings.auto` (`functions/src/engine/config.ts` Z. 37 `NUR_JE_NUTZER`, Z. 77–106);
Default 0,5 / 20 / 4 / 100 / 2 / 10 (`shared/src/autoSettings.ts` Z. 59–63). Ein Standardnutzer handelt die Basis
mit 0,5 % / 20 % Stop = **2,5 % Equity je Position, 10 % Exposure** — ein Achtel des Gemessenen; Tages-Notbremse 2 %
statt 3 %, Drawdown-Halt 10 % statt 20 % ⇒ andere Halt-Häufigkeit. Sharpe ist gegen konstante Skalierung robust,
Notbremsen sind es nicht (Befund 8). Die Vorregistrierung sagt „Basis-Stufe im Champion für Paper-Konten", ohne
dass der Champion Risiko tragen kann.

`src/readiness.ts` Z. 37–40: `minTrades: 200`, `minDays: 30`. Bei 4 Plätzen und Monatsrhythmus (~1 Trade je
Monat je Konto, Befund 6) sind 200 Trades ≈ **17 Jahre**. Die Kette „Journal → Live-Reife → Echtgeld" (T13) ist für
die Basis per Bauart unterbrochen; die Basis erzeugt zwar ein Journal, aber nie eines, das `readiness` besteht.

**Vorschlag.** (a) Vorregistrieren, mit welchem Risiko-Profil die Basis auf der Plattform läuft — entweder trägt
die Basis-Stufe ein eigenes Profil (Änderung an `settings.auto`, Owner-Entscheidung, weil sie das Nutzerversprechen
berührt), oder die Messung läuft mit dem Plattform-Default (0,5 %), und die Kriterien werden darauf bezogen.
(b) `readiness` bekommt für `tier: basis` eigene Schwellen (z. B. ≥ 24 Monate, ≥ 20 Trades, Sharpe ≥ 0,75 × SPY
über die Journal-Periode) — oder die Vorregistrierung sagt ausdrücklich, dass die Basis nie Echtgeld sieht.

### 5 (M) — Rang-Schwellen: `topPct 0,4` heißt 5 von 11, `exitPct 0,8` heißt „Austritt erst als Rang 10 oder 11"; die Relativ-Momentum-Seite ist praktisch stillgelegt

**Rechnung** (`korbRaenge`, `src/core/logic.ts` Z. 209: `pct = k/(of−1)`, k 0-basiert ⇒ **(rank−1)/(of−1)**), `check1.ts`:

| of | pct je Rang | `pct ≤ 0,4` (Einstieg) | `pct > 0,8` (Austritt) |
|---|---|---|---|
| 11 | 0, 0,1, 0,2, …, 1,0 | Rang 1–5 (**fünf**) | Rang 10–11 |
| 10 | k/9 | Rang 1–4 | Rang 9–10 |
| 9 | k/8 | Rang 1–4 | Rang 8–9 |
| 8 | k/7 | Rang 1–3 | Rang 7–8 |

Die Vorregistrierung (Z. 52) schreibt „die stärksten 40 % von 11 ⇒ bis zu vier Positionen = maxPositions" — falsch:
fünf sind berechtigt, der vierte Platz geht per Rangordnung an Rang 1–4 (`decide()` Z. 294–299), Rang 5 wartet.
Ein gehaltenes Symbol steigt aus relativer Schwäche **nur** aus, wenn es zu den zwei schwächsten von elf gehört
(`rang.pct > 0,8`; 8/10 > 0,8 ist false). Ein Rang-9-ETF bleibt im Buch, während Rang 1 draußen wartet, solange
kein Platz frei wird. Effektiv: Faber-SMA-Filter + absolutes Momentum + „wer zuerst kam"; das „relative Momentum"
aus D4 wirkt fast nur bei freien Plätzen. Fehlt an einem Tag die IEX-Bar eines ETF (`of` = 10), rutschen beide
Schwellen (Einstieg Rang 1–4, Austritt Rang 9–10) — kausal, aber ein zweiter, ungeplanter Freiheitsgrad.

**Vorschlag.** Text korrigieren („bis zu fünf berechtigt, vier Plätze, Austritt ab Rang 10/11") und benennen, dass
die Basis de facto Faber ist, nicht Antonacci. Wer Antonacci will, braucht `exitPct` ≈ 0,5 — das wäre aber V2.

### 6 (M) — 90-Tage-Folds sind die falsche Messeinheit für eine Monatsstrategie: Zwangs-Kasse, abgeschnittene Trades, Peak-Reset

**Beleg.** `simulate()` startet je Fenster mit leerem Buch, `halt = NO_HALT`, `peakEquity = initialEquity`
(`simulator.ts` Z. 263–267); Einstiege nur in den ersten drei Handelstagen eines Monats (`rebalanceFenster`).
Rechnung (`check1.ts`): mittlere Wartezeit vom Fold-Beginn bis zum ersten Fenster **8,4 Tage = 9,4 % der OOS-Zeit**
(F1–F3 ≈ 0 Tage, F16 19 Tage — das Raster driftet 1,4 Tage je Fold). Offene Positionen am Fold-Ende werden zum
Schlusskurs bewertet, **ohne Exit-Kosten und nicht als Trade gezählt** (`simulator.ts` Z. 583–587); im nächsten
Fold wird dieselbe Position neu gekauft (Einstiegskosten doppelt). Bei Haltedauern von Monaten in 3-Monats-Folds
ist ein großer Teil der Positionen am Fold-Ende offen ⇒ **Trade-Zahl deutlich untererfasst** (B4-Untergrenze und
`oos_trades` 60 hängen daran), Gebührenanteil zu klein, Umsatz zu groß. Zwangs-Kasse von 9,4 % zufälliger Zeit
drückt den Sharpe um ≈ √0,906 ≈ −5 % (pro-SPY in B2) und den MaxDD (pro-Basis in B3). SPY kaufen-und-halten hat
keinen dieser Artefakte (`wertreihe`: ab Tag 1 voll investiert, kostenfrei).

**Vorschlag.** Für Festkandidaten gibt es keinen Grund für Folds — es wird nichts gesucht. **Eine** Simulation über
die ganze OOS-Spanne (2022-04-03 … 2026-03-13), ein Buch, ein Peak, Halt-Regeln wie live; Fold-Statistiken
(`fold_positive_share`, Konzentration) aus den Tagesrenditen dieser einen Kurve ableiten. Die Folds bleiben für
gesuchte Kandidaten. Bis das existiert: die Zahl offener Positionen je Fold-Ende in den Bericht.

### 7 (M) — Preisbars ohne Ausschüttungen: Anleihe-ETFs verlieren im Momentum- und Regimefilter systematisch; die SPY-Latte ist zu niedrig

**Beleg.** `src/alpaca/rest.ts` Z. 578: `adjustment = req.adjustment ?? 'raw'`; `src/data/backfill.ts` reicht
kein `adjustment` durch ⇒ raw (auch keine Split-Anpassung — im Fenster ohne Folgen, aber fragil). Live entscheidet
die Engine auf denselben Roh-Bars (`closedSeries`, 1Day-Feed) ⇒ der **Entscheidungspfad** ist paritätisch; die
**Messung** aber nicht: Ausschüttungen fehlen im Signal und im P&L, live landen sie als Bargeld im Konto.

**Größenordnung** (Ausschüttungsrendite p. a., aus dem Gedächtnis, 2021–2025; auf 126 Bars ≈ halb): HYG 4,5–6,5 %
⇒ 6-Monats-Momentum um 2,5–3,3 pp untererfasst; LQD 2,5–4,5 % ⇒ 1,3–2,3 pp; TLT 1,5–4,5 % ⇒ 0,8–2,2 pp;
IEF 1–4 % ⇒ 0,5–2 pp; XLE 3–4 % ⇒ 1,5–2 pp; XLRE 3–4 % ⇒ 1,5–2 pp; EFA ≈ 3 % ⇒ 1,5 pp; EEM ≈ 2,5 % ⇒ 1,3 pp;
SPY 1,3–1,6 % ⇒ 0,7 pp; IWM ≈ 1,2 % ⇒ 0,6 pp; GLD 0. Rang-Kennzahl `mom / rvol` (rvol annualisiert): HYG
(rvol ≈ 8 %) ⇒ Score um ≈ 0,35 zu klein, LQD (≈ 9 %) ≈ 0,2, IEF (≈ 7 %) ≈ 0,17, TLT (≈ 17 %) ≈ 0,1, SPY ≈ 0,04.
Bei einer typischen Score-Spanne von etwa −1 … +1,5 über elf ETFs ist das ein bis zwei Rangplätze — und vor allem
kippt es das Tor `mom > 0` (Z. 176 regimeAllocation.ts) für Anleihen, deren Preis-Momentum oft in (−3 %, 0) liegt,
und das Regime `close > SMA150` für HYG, dessen Preis per Bauart ≈ 5 %/Jahr driftet. **Die Anleihe-Klassen (4 von
11) sind damit strukturell benachteiligt; die „Breite über Anlageklassen" (T5) wird auf Aktien/Gold/Energie
verengt.** SPY-Latte: 1,3–1,5 %/Jahr fehlende Rendite ⇒ Sharpe ≈ 0,014/0,17 ≈ **0,08 zu niedrig** (≈ 12 % der Latte
0,64 — dieselbe Größenordnung wie der 0,75-Abschlag in B2), MaxDD ≈ 0,5 pp zu hoch. Beides pro Basis.

**Vorschlag.** (a) Im Bericht und in der Vorregistrierung: „Preisrendite, keine Ausschüttungen; Anleihen-ETFs
benachteiligt". (b) Für den **Maßstab** SPY eine Total-Return-Korrektur (Ausschüttungen als Tagesrendite
zurückrechnen) — der Maßstab entscheidet nichts am Entscheidungspfad. (c) Owner-Entscheidung, ob die Messung auf
`adjustment: 'all'` umgestellt wird; dann müsste live derselbe Datensatz laufen (§0.1), was den Stream betrifft.

### 8 (M) — Die Tages-Notbremse 3 % ist bei 80 % Exposure ein Portfolio-Stop bei −3,75 % Korb-Tag mit Wiedereinstieg erst im nächsten Monatsfenster — ein Regelbestandteil, den die Vorregistrierung nicht deklariert

**Beleg.** `risk/limits.ts` Z. 69–82: bei Tagesverlust ≤ −3 % alles glatt, Halt bis zum nächsten Handelstag;
`decide()` Z. 249–268: Exits für alle Positionen; Wiedereinstieg nur im Fenster (`rebalanceFenster`). §5a.14 (3) hat
genau das bei 2 % widerlegt; die Vorregistrierung antwortet mit 3 % ohne Begründung. Mit einem Buch aus vier
Aktien-/Energie-ETFs reißt das an Crash-Tagen: 03./04.04.2025 (SPY −4,8 % / −5,9 %, EFA/EEM −4…−5 %, XLE −7…−8 %;
Gedächtniswerte) ⇒ Konto ≈ −3 … −3,6 % ⇒ Liquidation am Folge-Open (Gap), Kasse bis zum Fenster 2.–4. Juni ⇒ die
Erholung (+10…+15 %) wird verpasst. F1 (Kaminski/Lo): Stops schaden bei Umkehr — das hier ist die schädlichste
Form (Stop + vier Wochen Sperre). Es widerspricht T8 auf Buchebene („weite Katastrophen-Stops"). Der Simulator
modelliert das treu (Halt prüft am Schluss; live ebenfalls nur bei neuer Tagesbar, `engine.ts` Z. 608 `if
(inputs.length > 0)` — Parität), aber **gemessen wird dann „regime_allocation + 3 %-Tages-Portfoliostop"**, nicht
Faber/Antonacci.

**Vorschlag.** Vorregistrieren, dass die Notbremse Teil der Regel ist, und ihre Auslösungen je Kette im Bericht
zählen (`haltNotes` existieren im Simulator, der Bericht zeigt sie nicht). Für die Basis-Stufe entweder
`maxDailyLossPct` auf ein Niveau, das nur echte Crashs erreichen (≥ 6 % bei 80 % Exposure), oder Wiedereinstieg
am Folgetag nach Notbremse (Strategieänderung ⇒ V2).

### 9 (M) — Drawdown-Halt: Simulator und Live sind zwei Regeln

**Beleg.** Simulator: Peak und Halt je 90-Tage-Fenster zurückgesetzt (Befund 6), Peak nur aus Schlusskursen
(`markEquity`), kein `resume` nötig. Live: `st.peakEquity = max(peak, equity)` **jeden Tick, intraday**
(`engine.ts` Z. 545, 277), Halt bis manuelles `resume` (`limits.ts` Z. 55–66, §0.5), auf der Plattform je Nutzer
(`engineCommand`). Ein 20 %-Drawdown über zwei Folds (12 % + 10 %) löst im Simulator nie aus, live schon — und live
bleibt die Basis dann in Kasse, bis jeder Nutzer einzeln `resume` ruft. Für einen „Standard statt nichts" auf
Paper-Konten passiver Nutzer heißt das: nach dem ersten großen Drawdown handelt die Basis nie wieder. In der
Messkette selbst ist der 20 %-Halt wahrscheinlich nie erreicht (Buch ≤ 80 %, Filter aus in 2022, Notbremse bei
−3 %), die Asymmetrie kostet also im Bericht nichts — sie kostet im Betrieb.

**Vorschlag.** In der Vorregistrierung benennen; für `tier: basis` eine Resume-Politik festlegen (Owner-Entscheidung,
weil §0.5 automatisches Aufheben verbietet — ein journalisiertes Auto-Resume zum nächsten Monatsfenster wäre eine
Regeländerung, keine Hintertür, wenn sie vorher steht). Simulator: Peak über die ganze Kette führen, wenn Befund 6
(eine Simulation) umgesetzt ist.

### 10 (M) — Universum weicht von seiner eigenen Regel zweimal ab: HYG ist keine GTAA-13-Klasse, XLE ist kein Rohstoff

**Beleg.** Regel (Z. 20–22): „Fabers GTAA-13-Klassen, eine ETF je Klasse; Klassen ohne ETF im Pool entfallen."
GTAA-13 (Faber 2013; nach meinem Kenntnisstand, nachschlagen): US Large, US Small, Foreign Developed, Emerging,
US 10Y, US 30Y, Foreign 10Y, Corporate Bonds, TIPS, Commodities, Gold, US REITs, Foreign REITs. **High Yield ist
nicht dabei** ⇒ HYG ist eine Zugabe außerhalb der Regel (aktienähnlicher Kredit, risk-on). Rohstoffe: kein Rohstoff-ETF
im Pool ⇒ nach der eigenen Regel entfällt die Klasse; stattdessen XLE (Energie-Aktien, Korrelation zu SPY ≈ 0,5).
Beides sind Wahlentscheidungen aus 2026 mit Kenntnis von 2020–2026. Regelkonform sind **9 ETFs**.

**XLE in der Kette (Frage 1):** XLEs großer Lauf (2021 ≈ +50 %, H1 2022 ≈ +30 %) liegt **vor** der OOS-Kette
(Beginn 2022-04-03). In der Kette liefert XLE Q2 2022 (+), die Rutschpartie Juni–Juli 2022 (≈ −25 %; ein Einstieg
am Juni-Fenster bei ≈ 88 wird bei 70,4 ausgestoppt = −4 % Equity, ein April-Einstieg bei ≈ 77 nicht), Q4 2022 (+),
2023–2025 seitwärts. Der Nettoeffekt in der Kette ist **nicht offensichtlich positiv**; das Argument der
Vorregistrierung („profitiert rückblickend von 2022") betrifft überwiegend einen Zeitraum, der gar nicht gemessen
wird. Das schwächt die Begründung für XLE, nicht die Sorge.

**Vorschlag.** Vor dem Lauf beide Universen vorregistrieren: V1a = 9 ETFs (regelkonform, primär), V1b = 11 ETFs
(sekundär, nur Bericht). Beide Läufe im selben Workflow; die Kriterien gelten für V1a. Kein nachträgliches Umsortieren.

### 11 (M) — „literaturnah" stimmt nicht: fünf von sechs Parametern liegen am oberen Gitterrand, erzwungen durch die Embargo/IS-Kopplung, nicht durch die Literatur

**Rechnung** (`check2.ts`): `lookback 126`, `skip 21`, `regimeLen 150`, `topPct 0,4`, `exitPct 0,8` = jeweils `max` des
`paramSpace`; nur `stopPct 20` liegt innen. Nachbarn des Festkandidaten: **7, alle einseitig**. Ursache: Warmup
= max(147, 150, 64) + 2 = **152 Bars**, Embargo automatisch 152 + 20 = **172 Bars** (`embargoBarsFor`), IS-Fenster 365
Tage ≈ 252 Bars ⇒ das Gitter wurde in §5a.14 so gekürzt, dass 172 < 252 bleibt. Faber: 10-Monats-SMA (≈ 210),
Antonacci: 12-Monats-Momentum (≈ 252) — beides außerhalb; die Vorregistrierung nennt nur `regimeLen`. Ein
Festkandidat braucht die Suche nicht — sein IS-Lauf ist reiner Bericht (`fixedParamsWfa` Z. „IS-Lauf für den
Bericht") — trotzdem gilt für ihn dieselbe `candidateRange`-Regel, die bei 233 + 20 = 253 > 252 Bars den Lauf
mit Fehler abbricht.

**Vorschlag.** Für Festkandidaten IS-Embargo und IS-Lauf abschaltbar machen (nur Bericht), und die Literaturwerte
(210 / 252 / skip 21) als V1-Parameter vorregistrieren. Sonst ehrlich: „Parameter = größte Werte, die der
Walk-Forward-Zuschnitt erlaubt; nicht Faber."

### 12 (M) — Die gesuchte Vergleichsvariante misst nichts: IS-Entscheidungsbereich 86–89 Bars, Fold 1 ohne eine einzige Entscheidung, `minIsTrades 15` unerreichbar ⇒ immer der Rückfall „meiste Trades"

**Rechnung** (`check2.ts`, `embargoedEnd`): IS-Fenster F6 2022-06-27 … 2023-06-27 ⇒ Entscheidungen nur bis
2022-10-28 = **≈ 86 Bars ≈ 4 Monate ≈ 3–4 Rebalance-Fenster**, endend acht Monate vor dem OOS. Fold 1: IS-Bereich
2021-04-03 … 2021-08-05 liegt **vollständig vor der ersten Entscheidungs-Bar** (Warmup 152 ab 2021-03-19 ⇒
2021-10-18) ⇒ 0 Trades für jeden Kandidaten ⇒ `fallback` = erster Kandidat (Defaults) per Gleichstand.
`minIsTrades = max(10, 60/4) = 15` (`walkForward.ts`) ist mit 4 Plätzen in 4 Fenstern unerreichbar ⇒ in **jedem**
Fold gewinnt die Variante mit den meisten Trades (`searchWindow`: `fallback`), also die umschlagsstärkste
(topPct 0,4 / exitPct 0,4 / regimeLen 50 / lookback 63 / stop 10). §5a.14 hat das gewarnt; auf 11 ETFs ist es sicher.
Die Vorregistrierung verspricht diese Variante als „Vergleich (informativ)" — sie vergleicht mit Rauschen.

Nebenbefund: Nachbarschaftstest des Festkandidaten läuft auf dem finalen Fenster 2024-12-13 … 2025-07-16
(153 Bars, 7 Fenster **inklusive April 2025**) — sieben einseitige Nachbarn auf einer Crash-Episode; als Gate-Wert
nicht belastbar, als Bericht mit dieser Einschränkung zu lesen.

**Vorschlag.** Vergleichsvariante aus V1 streichen oder mit `samples` und `minIsTrades` explizit als „Rückfall-
Variante" kennzeichnen; die 150 Samples × 16 Folds kosten nur Laufzeit.

### 13 (M) — Kettenbeginn und Fold-Raster sind Glückssache (T4 gilt auch hier): der Filter ist am 3. April 2022 schon „aus"

**Beleg.** Fold-Plan am Datenende verankert (`buildFolds`: `selectionEnd = dataEnd − holdout`, rückwärts in
90-Tage-Schritten). Ein Datenende 30 Tage früher/später verschiebt jede OOS-Grenze um 30 Tage und den Kettenbeginn
in den März 2022 (Filter teilweise noch „an", GLD/XLE-Einstiege anders) bzw. Mai 2022. §5a.15 (T4) zeigte für mr
±2 000 $ bei 6 Tagen Versatz. Für die Basis ist der Effekt kleiner (keine Suche), aber der **Zustand zu Kettenbeginn**
(in Kasse vs. investiert) ist eine Zufallsgröße, die B3 direkt prägt (Befund 2).

**Vorschlag.** Falsifikationslauf vorregistrieren: derselbe Lauf mit `--as-of` 2026-08-10 und 2026-08-25
(Raster −30 / −15 Tage). Kriterien müssen in allen drei Rastern halten. Kosten: dreimal ~Minuten.

### 14 (M) — Weitere Pfade, die die Vorregistrierung nicht nennt (Frage 8)

1. **Bar-Ausfall und `MIN_KORB = 8`** (`crossSectionalMomentum.ts` Z. 73, `regimeAllocation.ts` Z. 169/176): fehlen
   an einem Fenster-Tag 4 der 11 IEX-Tagesbars, gibt es keinen Rang ⇒ kein Einstieg, aber auch **kein**
   Relativ-Exit. Kausal, aber die Familie „hält still" und die Schwellen wandern (Befund 5). Bericht: Bar-Zahl je
   Symbol gegen SPY ausweisen.
2. **IEX-Open als Fillkurs**: `o` der IEX-Tagesbar ist der erste IEX-Print (bei dünnen ETFs Minuten nach 09:30,
   auch mal abseits des NBBO); live füllt Alpaca am NBBO. Richtung: Rauschen; das 5-bp-Kostenmodell deckt einen
   Teil. Benennen.
3. **Startkapital 25 000 $** (`cli.ts` Z. 459/508 Default): 20 % = 5 000 $; SPY ≈ 600 $ ⇒ 8 Stück = 4 800 $ ⇒ −4 %
   Exposure durch Ganzstück-Rundung, GLD ähnlich. Klein, aber im Bericht ausweisen (`Startkapital je Fenster`).
4. **Gebührenanteil hat zwei Definitionen**: Kette `fees / Σ grossPnl aller Trades` (`aggregateOos`), Fenster
   `fees / Σ positiver grossPnl` (`computeMetrics`). B4 nennt keine. Festlegen: `OosAggregate.feeShare` (Kette).
5. **Ergebnis-Feld wird nach Sicht der Zahlen geschrieben** — zulässig, aber die Kriterien müssen vorher
   numerisch eindeutig sein (Befund 2, 14.4) und die Auswertung sollte maschinell sein (Befund 1), sonst ist das
   „Commit-Datum belegt das" nur für den Text wahr, nicht für die Auswertung.
6. **Hypothesentext „über 2020–2026"** (Z. 10): gemessen wird 2022-04 … 2026-03 (16 Quartale); 2020-07 … 2022-03
   ist Warmup/IS. Nur 3 von 16 Folds berühren 2022, keiner Q1 2022. Korrigieren.
7. **Kein Lookahead in der Strategie gefunden** (in Ordnung): `rebalanceFenster` sieht `t[i−1]`, `momentum`/`sma`/
   `stddev` kausal, Rang aus Bars desselben `t` in `decide()`, Präfix-Suite läuft über alle registrierten
   Strategien (§5a.14). `foldMembership: fixed` ist ehrlich als „Auswahl von heute, rückwärts" berichtet.

### 15 (M) — §0.9 und die zweite Latte: so, wie es steht, ist es die Hintertür; so müsste es heißen

**Widerspruch.** §0.9: „Der Optimierer schreibt Symbole ohne bestandene Gates nach `noTrade`. Niemand hilft nach."
T13: „Zwei Latten … Keine dritte." Die Vorregistrierung schafft die zweite Latte **außerhalb des Optimierers**
(kein Code, Hand-Auswertung, „Entscheidung beim Owner") für **dasselbe Messobjekt** (OOS-Kette des Walk-Forward),
und zwar niedriger (kein PSR, kein Trade-Minimum mit Konsequenz, kein Fold-Positiv-Anteil). Das ist die Definition
von Nachhelfen, auch wenn die Absicht (Marktexposition statt Kasse) legitim ist. Der Präzedenzfall „zweite Latte
per Dokument" macht T13s „keine dritte" wertlos.

**Ehrliche Formulierung (Vorschlag für §0.9, Ergänzung):**

> Zwei Latten, beide im Code, keine von Hand. (a) Alpha-Kandidaten: die zehn Gates. (b) Basis (Marktexposition):
> nur für Festkandidaten ohne Parametersuche auf einem vorregistrierten, festen Korb; die Kriterien B1–B4 rechnet
> `robustnessGates` als eigene Gruppe (`tier: basis`), befördert wird ausschließlich in die Basis-Stufe des
> Champions (nie als Alpha), und die Basis-Stufe handelt nur, solange kein Alpha-Champion besteht. Jeder
> Basis-Eintrag trägt den Commit-Hash seiner Vorregistrierung. Kriterien, die nach dem Lauf geändert werden, sind
> V2 — nie eine Korrektur. Es gibt keinen „Bericht an den Owner"-Pfad, der ein verfehltes Kriterium ersetzt: Ein
> verfehltes Kriterium heißt „nicht einsetzen". Eine dritte Latte gibt es nicht; ein Test in `test/optimize/`
> prüft, dass `decidePromotion` nur aus Gate-Ergebnissen entscheidet.

Und in der Vorregistrierung: „B2 verfehlt ⇒ Bericht, Entscheidung dort" und „zu wenige Trades ⇒ Bericht" durch
„⇒ nicht einsetzen, V2" ersetzen.

### 16 (G) — Drei Dokumente, drei Zahlen für „Trades je Monat"

`aktivitaet.md` Z. 10: Ziel 2–10; Vorregistrierung B4: 1–8; `taktiken.md` Z. 80: 1–6. Am selben Tag geschrieben.
Eine Zahl, eine Definition (Round-Trips je 30,44 Tage über alle Symbole, aus `OosAggregate.trades` — mit dem
Vorbehalt aus Befund 6).

### 17 (G) — Kein Wächter für den neuen Pfad; `aktivitaet.md` beschreibt Code, der erst entsteht

`grep` in `test/`, `functions/test/`: keine Tests für `fixedCandidates`, `fixedCandidateWfa`, `festParams`,
`massstabFuer`. `aktivitaet.md` Z. 27 („Trades je Monat stehen je Kandidat in der Maßstab-Zeile —
Festkandidaten-Änderung, 09.09.") beschreibt uncommitted Code. §0.10: neuer Wächter, einmal absichtlich gebrochen —
mindestens: (a) Festkandidat mit Parameter außerhalb des Gitters ⇒ Fehler-Eintrag, kein Absturz; (b) Festkandidat
läuft über **alle** Folds (nicht nur „saubere"); (c) `deflated_sharpe_is` „nicht anwendbar" statt bestanden;
(d) `marktKette.maxDrawdownPct` gegen eine Handrechnung über zwei Fenster mit Verlust im ersten.

### 18 (G) — Wenn der Festkandidat zufällig alle zehn Gates besteht, befördert der Probe-Lauf ihn als Alpha

PSR-Rechnung: Sharpe 0,6 über ≈ 990 Tagesrenditen ⇒ z ≈ 0,038 × 31,4 ≈ 1,19 ⇒ PSR ≈ 0,88 (knapp unter 0,9);
bei 0,7 ⇒ 0,92. `oos_trades ≥ 60` bleibt der wahrscheinliche Fallstrick (Befund 6). Der Probe-Lauf schreibt nur
`var-probe/champion.json` — ungefährlich —, aber der Bericht würde „promote" sagen, und die Vorregistrierung hat
dafür keine Lesart. Vorab hinschreiben: „Ein 10-Gate-Pass des Festkandidaten ist ein Alpha-Befund gegen SPY ×1,0
und wird wie jeder Alpha-Treffer dem Falsifikationslauf (T4) unterzogen; er ist nicht das Ziel von V1."

---

## B. Antworten auf die neun Fragen

1. **Ex ante?** Die Regel (Faber 2007/2013) ist ex ante; die Instrumentenliste ist es nicht: Pool aus 2026, zwei
   Abweichungen von der eigenen Regel (HYG rein, XLE als „Rohstoff"; Befund 10), und die Familie wurde auf
   derselben Kette gewählt (Befund 3). XLEs Wirkung in der gemessenen Kette ist ambivalent (Juni–Juli 2022
   −25 %); sein berühmter Lauf liegt vor der Kette. Regelkonform: 9 ETFs; beides vorregistriert laufen lassen.
2. **B1–B4:** B3 unverfehlbar (Exposure + Kettenbeginn + Fold-Restarts), B1 und B4-Gebühren dekorativ,
   B4-Obergrenze unerreichbar, B2 statistisch ein Münzwurf (SE ≈ 0,55 bei 16 Quartalen) mit Hintertür. Die Kette
   hat **keine IS-Lücken** (Schritt = OOS), die Prämisse der Frage stimmt nicht; die Diskontinuität ist der
   Fold-Restart (leeres Buch, Zwangs-Kasse 9,4 %, abgeschnittene Trades, Peak-Reset). Besser: Korb-liegenlassen
   als Latte, exposure-normierter MaxDD oder Calmar, PSR gegen 0,75 × SPY, eine durchgehende Simulation für
   Festkandidaten, und das Eingeständnis, dass V1 T5 nicht bestätigen kann (Befund 2, 6).
3. **Ausschüttungen:** raw-Bars (`rest.ts` Z. 578). 6-Monats-Momentum bei HYG um 2,5–3,3 pp, LQD 1,3–2,3, TLT
   0,8–2,2, IEF 0,5–2 zu klein; Score um 0,1–0,35 zu klein (1–2 Rangplätze); `mom > 0` und `close > SMA` kippen
   für Anleihen systematisch ⇒ 4 der 11 Klassen strukturell benachteiligt. SPY-Latte ≈ 0,08 Sharpe zu niedrig,
   MaxDD ≈ 0,5 pp zu hoch (beides pro Basis) (Befund 7).
4. **Sizing/Halt in 2022:** Position = min(4 %/20 % = 20 %, 25 %) = 20 %; vier Plätze = 80 %. In 2022 hält der
   Drawdown-Halt die Basis **nicht** in Kasse — der Regimefilter tut es (alles außer XLE/GLD unter SMA); der
   20 %-Halt wird in der Kette voraussichtlich nie erreicht. Simulator ≠ live: Peak/Halt je Fold zurückgesetzt vs.
   intraday-Peak und manuelles `resume` je Nutzer (Befund 9). Die 3 %-Notbremse ist ein −3,75 %-Korbtag-Stop mit
   Monatssperre, treu simuliert, aber undeklariert (Befund 8). Und auf der Plattform gilt das Probe-Risiko für
   niemanden (Befund 4).
5. **Warmup/Embargo:** Warmup 152, Embargo 172 Bars; IS-Entscheidungsbereich ≈ 86–89 Bars (≈ 4 Monate, 3–4 Fenster)
   je Fold, Fold 1 = 0 Entscheidungen. Für den Festkandidaten ist der IS-Lauf nur Bericht; die
   Nachbarschaftsprüfung (7 einseitige Nachbarn, 153 Bars inkl. April 2025) ist informativ, nicht belastbar, und
   die gesuchte Vergleichsvariante ist per Rückfall die umschlagsstärkste (Befund 11, 12).
6. **Trades je Monat:** Erwartung 0,7–1,3 Round-Trips je Monat (2–4 je Fold), durch Fold-Abschneiden weiter
   untererfasst; §5a.15 maß 51–68 auf 30 Symbolen. B4s Obergrenze 8 ist unerreichbar, die Untergrenze 1 die
   einzige mit Biss — und die hat keine Konsequenz (Befund 2, 6, 16).
7. **Marktphasen:** Schmeichelnd: F1–F3 (Q2–Q4 2022, Filter schon aus), F11–F13 (Goldlauf 2024/25, ein
   Dauertrend), Kettenbeginn nach Q1 2022. Die Basis **muss** verlieren gegen SPY in F7 (Okt-2023-Dip, V-Rally
   Nov/Dez: Exit am 1.–3. Nov unter SMA, Wiedereinstieg 1.–4. Dez ≈ +9 % später), F13 (Zoll-Crash April 2025:
   Exit + Notbremse, Wiedereinstieg Juni), F4 (Jan-2023-Rally nach Dezember-Exit). Liegt sie dort **nicht** unter
   SPY, ist die Messung verdächtig. Zusätzlich: Stichtage 2025-03-07 / 2025-09-05 (Kette ohne 2025-V und ohne
   späten Goldlauf) und ein Placebo mit um 10 Handelstage verschobenem Fenster bzw. gewürfeltem Regime — bestehen
   B1/B3 auch dort, messen sie Exposure (Befund 2, 13).
8. **Nicht genannte Pfade:** Familienwahl auf derselben Kette (Befund 3), Fold-Restart-Artefakte (6),
   Kettenbeginn/Raster (13), Bar-Ausfall und `MIN_KORB` (14.1), IEX-Open (14.2), Rundung bei 25 000 $ (14.3),
   zwei Gebühren-Definitionen (14.4), Hypothesentext vs. Messfenster (14.6). Streuner-Bars: durch #467 abgefangen,
   im Bericht die Datenbereichs-Zeile prüfen. XLRE: Auflage 2015, Historie vollständig; kein Problem gefunden.
9. **§0.9:** Ja, so wie es steht, ist es die Hintertür (Befund 1, 15). Formulierung in Befund 15.

## C. Was in Ordnung ist (je ein Satz)

- Kein Lookahead in `regimeAllocation.ts`; Rang entsteht in `decide()` aus Bars desselben Zeitpunkts (§0.2).
- Sizing-Pfad: `byRisk` bindet bei 20 %, `byCap` 25 % nur Deckel, Bargeld am Fill nachgesizet — wie beschrieben.
- Neue `marktKette` verkettet MaxDD methodisch wie `aggregateOos` (Scale × Kurve, Peak über Fenster hinweg).
- OOS-Kette ist lückenlos und disjunkt; `foldMembership: fixed` wird im Bericht ehrlich als Rückwärts-Auswahl benannt.
- `probeConfigs.test.ts` erzwingt den `vorregistrierung:`-Verweis für abweichendes Risiko; das Dokument ist
  committet (ac461dd, heute) — der Textbeleg steht, der Auswertungsbeleg nicht (Befund 1, 14.5).
- Tages-Notbremse: Simulator und Engine prüfen beide nur bei neuer Tagesbar — Parität.

## D. Reihenfolge vor dem Lauf (Vorschlag)

1. Befund 1 + 15 entscheiden (Code-Pfad für B1–B4 oder V1 auf „nur Bericht" zurückstufen).
2. Befund 2 (Kriterien schärfen: Korb-Latte, PSR gegen 0,75 × SPY, Konsequenz bei jedem Fehlschlag), 14.4, 14.6, 16.
3. Befund 10 (V1a/V1b), 11 (Literaturwerte für Festkandidaten), 8/9 (Notbremse und Resume deklarieren).
4. Befund 6 (eine Simulation für Festkandidaten) — oder zumindest „offene Positionen je Fold-Ende" in den Bericht.
5. Befund 17 (Wächter), dann Lauf inklusive Befund 13 (drei Raster) und den Fenstern aus Frage 7.
