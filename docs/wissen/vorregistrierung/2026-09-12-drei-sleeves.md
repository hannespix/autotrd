# Vorregistrierung: Drei Sleeves mit anderem Mechanismus

**Datum:** 12.09.2026 · **Thesen:** T16, T17, T18 (neu) ·
**Configs:** `config/vigilant-1440.yaml`, `config/sleeves-1440.yaml`
**Status vor dem Lauf:** offen. Geschrieben und committet **vor** jeder
Messung dieser drei Familien; das Commit-Datum ist der Beleg. Keine Zahl
unten stammt aus einem Lauf mit diesen Strategien — es gibt noch keinen.

## Der Befund, der das auslöst

Owner am 12.09.2026: „seit dem Umbau wurde überhaupt nichts gehandelt … es
muss aktiv handeln … gute Möglichkeit in Profit zu kommen … wie man am
wenigsten Verlust fährt."

Die Ursache ist nicht die Latte, sondern der **Kandidatenkreis**. Alle fünf
gemessenen Familien (`trend_donchian`, `momentum_pullback`,
`mean_reversion`, `cross_sectional_momentum`, `regime_allocation`) fragen im
Kern dasselbe — „steigt das hier?" —, sind long-only auf US-Aktien, laufen
auf Tagesbars und sind direktional. Sie sind fünf Varianten desselben
Marktes mit Zusatzkosten; keine kann dessen Sharpe schlagen, weil sie der
Markt IST.

Zwei Läufe haben das inzwischen als Architekturbefund festgeschrieben:

- **Lauf #42** (18 Folds, 2020-07-27 … 2026-09-11, Marktdrawdown 25,68 %):
  `momentum_pullback` besteht acht von zehn Gates (Sharpe 0,64 gegen SPY
  0,61 bei 6,67 % eigenem Drawdown) und fällt an `fold_positive_share`
  (9 von 18 Quartalen positiv) und `fold_concentration` (ein Quartal trägt
  65 %). Die Folds 1–5 — Oktober 2021 bis Dezember 2022 — sind ausnahmslos
  negativ oder leer.
- **Lauf #43** (`vorregistrierung/2026-09-12-kurzlaeufer-im-pool.md`): Der
  nach Median-Dollarumsatz gewählte 30er-Korb kann bauartbedingt kein
  defensives Papier enthalten — BIL landete auf Rang 138 von 141 und wurde
  nie gewählt. Ein Fold ohne Trades hat Netto 0 und zählt NICHT als positiv:
  Ein schlechtes Quartal auszusitzen hilft dem Gate nicht, im Geldmarkt zu
  liegen und den Zins zu verdienen hilft.

Daraus folgt die Aufgabe dieser Vorregistrierung: **Renditequellen mit
anderem MECHANISMUS und eigenem, festem Universum** — nicht ein sechster
Aufguss derselben Frage, und nicht eine weichere Latte.

## Was für alle drei gilt

Tagesbars, `us_equity`, long-only (`risk.allowShort: false`), kausal,
Katastrophen-Stop beim Broker, kein Kursziel, kein Trailing.
**Parameter fest aus der Literatur — keine Suche, kein Gitter.** Beide
Configs führen in `optimizer.strategies` nur den Platzhalter `orb_breakout`,
den `run.ts` bei timeframe 1440 überspringt; gemessen werden ausschließlich
die Festkandidaten (`trials` = 1 je Sleeve, Deflated Sharpe „nicht
anwendbar", alle anderen neun Gates in voller Schärfe). Regelwerk beider
Configs ist Zeichen für Zeichen das der Plattform (Risiko 0,5 %, Deckel
20 %, vier Plätze, Brutto 100 %, Tagesbremse 2 %, Drawdown-Halt 10 %) — die
Lehre aus Basis V3, wo dasselbe Sleeve unter zwei Regelwerken zwei
Ergebnisse hatte. Ausschüttungsbereinigte Tagesbars (`adjustment: all`).

**Latte:** die zehn Alpha-Gates, unverändert. Keine dritte Latte (§0.9).
„Nicht handeln" bleibt ein zulässiges Ergebnis.

---

## Sleeve 1 — `vigilant_allocation`

**Mechanismus.** Momentum über vier Horizonte auf einem GEMISCHTEN Korb aus
Risiko- und defensiven Papieren, Entscheidung nur im Rebalance-Fenster von
drei Handelstagen je Monat. Kennzahl ist 13612W:

    score = 12·r(21) + 4·r(63) + 2·r(126) + 1·r(252)

Gekauft wird, was (a) unter den `topN` stärksten des Korbs liegt UND (b)
selbst ein positives 13612W hat. Verkauft wird im Fenster, sobald das eigene
13612W negativ ist oder der Rang schlechter als `exitRank`. Fällt der
Aktienteil, stehen die defensiven Papiere oben und sind zugleich die
einzigen mit positivem Momentum — die **Rotation in Anleihen bzw. den
Geldmarkt fällt aus der Rangliste heraus** und braucht keine Sonderregel.

**Quelle.** Keller & Keuning, „Breadth Momentum and Vigilant Asset
Allocation" (2017) und „Breadth Momentum and the Canary Universe" (DAA,
2018) — Literatur D8. Gewichte und Horizonte sind aus der Quelle
übernommen, nicht aus unseren Daten gefittet.

**Exakte Parameter** (`config/vigilant-1440.yaml`):
`topN: 2`, `exitRank: 4`, `stopPct: 20`.
Fest im Code, keine Suchachse: Horizonte 21/63/126/252 Bars, Gewichte
12/4/2/1, Rebalance-Fenster `REBAL_TAGE` = 3 (dieselbe Funktion wie
`regime_allocation`), `MIN_KORB_VIGILANT` = 5.
Korb (9, nach Rolle besetzt): SPY, QQQ, EFA, EEM · IEF, TLT, LQD, GLD · BIL.

**Was ihn von `regime_allocation` unterscheidet — nachrechenbar, nicht
behauptet.** `regime_allocation` rangiert nach `mom / rvol` (D5). Ein
Geldmarkt-Papier hat eine realisierte Volatilität nahe null: BIL kommt auf
etwa 0,3 % p. a.; für 1,5 % Jahresertrag ergibt das `0,015/0,003 ≈ 5`,
während SPY in einem guten Jahr bei `0,20/0,32 ≈ 0,6` liegt. **Mit einem
Geldmarkt-Surrogat im Korb stünde bei `regime_allocation` also immer
Bargeld auf Rang 1 — auch im Bullenmarkt.** Der Wächter dazu steht in
`test/strategy/vigilantAllocation.test.ts` („warum nicht regime_allocation
auf demselben Korb") und rechnet beide Kennzahlen auf denselben Serien
gegeneinander. Ohne Normierung ist die Familie nicht denkbar (sonst gewinnt
das volatilste Papier); mit ihr ist der Geldmarkt nicht denkbar. Das ist der
Grund für eine eigene Familie, und es ist der einzige, den ich brauche.

Weitere Unterschiede: vier Horizonte statt einem Fenster mit `skip`; der
jüngste Monat wiegt am SCHWERSTEN (Faktor 12) statt ausgelassen zu werden
(D7) — diese Familie sucht keine Momentum-Prämie, sie sucht den Ausstieg;
kein SMA-Regimefilter (das Vorzeichen des 13612W ist der Regimetest);
absoluter Rang (`topN`) statt Ranganteil.

**Was FEHLT, und das ist keine Kleinigkeit.** Der **Kanarienvogel**. Kellers
definierender Mechanismus („ist das 13612W von EEM oder LQD negativ, dann
defensiv") verlangt, dass eine Strategie FREMDE Zeitreihen liest. Der
Vertrag in `src/core/types.ts` gibt das nicht her, und das mit Absicht
(§0.2: Querschnitt entsteht ausschließlich in `decide()`). Was gebaut ist,
ist die im Vertrag mögliche Hälfte; der Unterschied ist die
Frühzeitigkeit — der Kanarienvogel dreht, BEVOR das eigene Momentum der
Risikopapiere kippt. Der Name ist damit heute eine Absichtserklärung. Die
minimale Vertragserweiterung steht unten.

**Erwartete Trades je Monat:** 0,7–1,5 (bei vier Plätzen und 9 Papieren;
die Top-2 nach 13612W wechseln erfahrungsgemäß alle zwei bis drei Monate).
**Erwartete Haltedauer:** 40–90 Handelstage (Median ~60).
**Erwartete Korrelation** zu den bestehenden Familien: **hoch im Mittel,
negativ dort, wo es zählt.** Wenn der Sleeve in SPY/QQQ steht, korreliert
er mit jeder Aktien-Long-Familie nahe 0,8; in Bärenphasen steht er in
BIL/GLD und korreliert negativ. Über die ganze Kette schätze ich 0,5–0,75
zu `momentum_pullback`. **Damit könnte gerade dieser Sleeve die Erwartung 2
der Ensemble-Vorregistrierung (Durchschnittskorrelation < 0,5) verfehlen,
obwohl er seine Aufgabe erfüllt.** Das ist vor dem Lauf notiert, damit es
hinterher nicht umgedeutet wird: Sein Beitrag ist nicht niedrige
Durchschnittskorrelation, sondern Ertrag in den Quartalen, in denen die
anderen verlieren.

---

## Sleeve 2 — `index_reversal`

**Mechanismus.** Kurzfristige Umkehr auf BREITEN Index-ETFs, gefiltert durch
den langfristigen Trend. Einstieg long, wenn `Close > SMA(200)` UND
`RSI(2) < 10`. Ausstieg, was zuerst kommt: `RSI(2) > 70`, erster Schluss über
dem Vortageshoch, oder Zeitstopp nach 5 Bars. Weiter Katastrophen-Stop
(4 × ATR(14)), nie nachgezogen.

**Quelle.** Der Effekt: Jegadeesh (1990), Lehmann (1990), Lo & MacKinlay
(1990) — Literatur E1, Vertrauen hoch für den Effekt. Die konkrete
RSI(2)-Ausprägung: Connors & Alvarez, „Short Term Trading Strategies That
Work" (2008) — Literatur E2, **Vertrauen niedrig**: Praktikerbuch, stark
datengetrieben, keine Mehrfachtest-Korrektur. Bekannte Schwächen, hier
vorab benannt: Der Effekt hat nach 2010 nachgelassen, und in starken
Trends (2017, 2021) versagt er, weil es keine Rücksetzer gibt.

**Exakte Parameter** (`config/sleeves-1440.yaml`):
`trendLen: 200`, `rsiLen: 2`, `rsiEntry: 10`, `rsiExit: 70`,
`exitOnPrevHigh: 1`, `maxHoldBars: 5`, `atrMult: 4`.
Universum (4, nach Rolle): SPY, QQQ, IWM, DIA.

**Warum Indizes und nicht Einzelaktien.** Ein Index hat keine eigenen
Nachrichten. Ein Rücksetzer ist dort Liquiditätsnachfrage; bei einer
Einzelaktie ist er oft eine Gewinnwarnung, in die eine Umkehr-Regel
hineinkauft. `mean_reversion` wurde auf 30 Einzelwerten gemessen (ein
Treffer, der einer Rasterverschiebung um sechs Tage nicht standhielt, T4) —
das ist ein anderer Gegenstand, nicht bloß ein anderes Universum.

**Was ihn von `mean_reversion` unterscheidet.** Drei Dinge, alle im Code:
(1) der Ausstieg ist die ERSTE Stärke (Schluss über dem Vortageshoch) statt
der Rückkehr zum 20-Tage-Mittel — das verkürzt die Haltedauer und nimmt den
Teil der Bewegung, der belegt ist; (2) der Zeitstopp ist Pflicht und nicht
abschaltbar; (3) `crossScore` = −RSI: Bei knappen Plätzen bekommt der
TIEFSTE Rücksetzer den Platz, nicht der, den die Rotation zuerst aufruft —
die Rangliste baut ausschließlich `decide()` (§0.2), die Strategie liest sie
nicht einmal. **Nebenwirkung, benannt:** Sobald eine Strategie im Zyklus
`crossScore` hat, sortiert `core/logic.ts` rangierte Symbole vor unrangierte.
In einem gemischten Zyklus bekämen die Symbole dieses Sleeves die knappen
Plätze zuerst. Gemessen wird er allein auf seinem Korb.

**Erwartete Trades je Monat:** 2–5 (RSI(2) < 10 trifft etwa 6 % der Tage,
der Trendfilter lässt ~70 % zu, vier korrelierte Indizes tauchen gemeinsam
ab; offene Positionen blockieren neue Signale im selben Symbol).
**Erwartete Haltedauer:** Median 3 Handelstage, Spanne 1–5.
**Erwartete Korrelation:** zu `trend_donchian`/`momentum_pullback` auf
Monatsnetto 0,2–0,4 — beide sind long Aktien, aber an verschiedenen TAGEN
investiert (Ausbruch kaufen gegen Rücksetzer kaufen). Auf Tagesrenditen, in
den Phasen, in denen beide investiert sind, deutlich höher (Marktbeta).

**Das bindende Gate ist `fee_share`, nicht die Trefferquote.** Ein
Round-Trip kostet 3 bp Slippage + 2 bp halber Spread je Seite, also rund
10 bp, im Stresslauf 15 bp. Bei einem erwarteten Bruttogewinn im Bereich von
0,3–0,5 % je Trade liegt der Gebührenanteil bei grob 20–40 %, im Stress
höher. Die Schwelle ist 50 %. Das ist die engste Stelle dieses Sleeves, und
sie wird nicht verschoben.

---

## Sleeve 3 — `turn_of_month`

**Mechanismus.** Der Einstieg fragt KEINEN Kurs, sondern den Kalender:
Entscheidung am Schluss des Handelstags, auf den noch genau `entryOffset`
Handelstage des Monats folgen; Ausstieg am Schluss des `exitTradingDay`-ten
Handelstags des neuen Monats. Weil Fills immer am OPEN der Folgebar liegen,
hält die Position tatsächlich `open(letzter Handelstag)` bis
`open(vierter Handelstag)`. Kein Trendfilter (die Quellen finden den Effekt
ohne einen); Schutz ist allein der weite Katastrophen-Stop.

**Quelle.** Ariel (1987), Lakonishok & Smidt (1988), McConnell & Xu (2008) —
Literatur H1–H3. Plausibler Mechanismus: Lohn-, Sparplan- und
Pensionsflüsse zum Monatsende, die mechanisch investiert werden.
**Gegenliteratur, ausdrücklich mitgeführt:** Sullivan, Timmermann & White
(2001) zeigen, dass Kalendereffekte eine Korrektur für Mehrfachtesten
schlecht überleben (H4, Vertrauen hoch). Publizierte Kalendereffekte
verschwinden manchmal nach ihrer Veröffentlichung (C7). Vertrauensgrad
gesamt: mittel.

**Exakte Parameter** (`config/sleeves-1440.yaml`):
`entryOffset: 1`, `exitTradingDay: 3`, `atrMult: 4`, `maxHoldBars: 8`.
Universum: SPY, QQQ, IWM, DIA (dieselbe Config wie Sleeve 2).

**Die Stelle, an der dieser Sleeve falsch werden kann,** ist der Kalender.
„Handelstage bis Monatsende" ist nicht „Kalendertage": Karfreitag ist
geschlossen, der 4. Juli wird vorgezogen, Monatsenden fallen auf
Wochenenden. Und Bars zu zählen wäre **Lookahead** — ob nach der aktuellen
Bar noch eine im Monat kommt, steht erst in der Zukunft. Die Zahl kommt
deshalb aus dem NYSE-Kalender (`core/time.ts`), einer Funktion von Datum
und Feiertagsregel. Geprüft mit handverifizierten Daten 2026 (Neujahr,
Karfreitag 3. April, vorgezogener 4. Juli, Monatsende am Wochenende
29. Mai, Thanksgiving) und über die Zeitumstellung am 1. November
(`test/strategy/turnOfMonth.test.ts`).

**Bekannte Ausführungslücke, nicht schöngerechnet:** Das klassische Fenster
wird von Schluss zu Schluss gemessen; wir besitzen open-zu-open. Der
Übernacht-Gap in den letzten Handelstag hinein fehlt uns, der Gap in den
vierten Tag kommt dazu. Ein großer Teil der Aktienrendite fällt über Nacht
an (B3) — dieser Sleeve gibt also einen Teil des Effekts an die Mechanik ab.
Wie groß der Teil ist, sagt der Lauf.

**Erwartete Trades je Monat:** 4 (genau ein Round-Trip je Symbol und Monat;
ein blockierter Einstiegstag lässt den Monat ausfallen, es gibt keinen
Nachkauf).
**Erwartete Haltedauer:** 4 Handelstage, praktisch ohne Streuung.
**Erwartete Korrelation:** die niedrigste der drei. Der Sleeve ist an rund
4 von 21 Handelstagen investiert und weiß nicht, ob ein Trend besteht;
Monatsnetto-Korrelation zu allen bestehenden Familien 0,1–0,3.

**Erwarteter Beitrag, ehrlich klein.** Der Stop bemisst die Stückzahl: bei
4 × ATR(14) ≈ 4,4 % Stop-Distanz und 0,5 % Risiko je Trade sind das ~11 %
der Equity je Position. Vier Positionen ≈ 45 % Exposure an vier Tagen im
Monat. Ein Fenster-Effekt von 0,5–0,8 % brutto, nach T11 halbiert auf
0,25–0,4 %, ergibt 0,11–0,18 % je Monat auf die Equity, also grob
1,4–2,2 % im Jahr vor Kosten und 0,9–1,7 % danach. Wer mehr will, braucht
Allokations-Sizing, nicht einen engeren Stop (siehe „Erweiterungen").

---

## Was ich VOR dem Lauf erwarte (die Falsifikationsvorlage)

### Erwartungen je Sleeve

| # | Erwartung | widerlegt, wenn |
|---|---|---|
| 1 | `vigilant_allocation` erreicht ≥ 60 OOS-Trades über die Kette | es sind unter 50 — dann ist die Familie zu langsam für dieses Gate, und das ist Bauart, kein Zufall |
| 2 | `vigilant_allocation` hält in den Folds Okt. 2021 – Dez. 2022 überwiegend BIL oder GLD | es hält dort überwiegend Aktien-ETFs |
| 3 | `index_reversal` erreicht 2–5 Trades je Monat und einen Median der Haltedauer von 2–4 Tagen | unter 1 oder über 8 Trades je Monat |
| 4 | `index_reversal` hält `fee_share` unter 0,5 (Normalkosten) | darüber — dann frisst der Umschlag die Kante, wie bei `mean_reversion` |
| 5 | `turn_of_month` erreicht 3,5–4 Trades je Monat, Haltedauer 4 Bars | weniger als 3 je Monat (dann blockiert etwas systematisch den Einstiegstag) |
| 6 | `turn_of_month` liegt im OOS-Netto über null | es liegt darunter — dann ist der Effekt in diesem Fenster tot oder von der Ausführungslücke gefressen |

### Erwartung für die Folds des Bärenmarkts 2022 (Owner-Auflage)

Das ist die Vorhersage, an der die drei später falsifiziert werden. Bezug
sind die fünf Folds Oktober 2021 bis Dezember 2022 aus Lauf #42, in denen
alle fünf bestehenden Familien negativ oder leer waren.

| Sleeve | Erwartung 2022 | widerlegt, wenn |
|---|---|---|
| `vigilant_allocation` | **positiv, aber klein**: mindestens 3 der 5 Folds mit Netto > 0, kein Fold schlechter als −2 % der Equity. Der Ertrag kommt aus BIL (Zins 2022 steigend) und GLD, nicht aus Aktien. | 3 oder mehr der 5 Folds negativ, oder ein Fold schlechter als −4 % |
| `index_reversal` | **flach bis leicht negativ**: Der SMA(200)-Filter hält ihn 2022 die meiste Zeit aus dem Markt; ich erwarte 1–2 positive, 1–2 leere (Netto 0) und 1–2 leicht negative Folds. **Dieser Sleeve repariert `fold_positive_share` NICHT** — er liefert Aktivität und verteilt das Netto. | er verliert in mehr als 2 der 5 Folds mehr als 2 % |
| `turn_of_month` | **etwa flach**: Ohne Trendfilter kauft er 2022 zwölfmal in einen fallenden Markt. Ich erwarte 2–3 positive Folds, Drawdown klein wegen kurzer Haltedauer. | mehr als 3 der 5 Folds negativ, oder MaxDD über 8 % |

Wenn alle drei 2022 negativ sind, ist die Diagnose („es fehlt eine
Renditequelle mit anderem Mechanismus") in dieser Umsetzung widerlegt — und
zwar unabhängig davon, wie gut die Gesamtzahlen aussehen.

### Warum das nach meiner Überzeugung KEIN Überfitting ist

1. **Kein Freiheitsgrad im Lauf.** Alle Parameter stehen oben, sie stammen
   aus benannten Quellen, und die Configs suchen nichts (`trials` = 1 je
   Sleeve). Es gibt kein Gitter, an dessen Ausrichtung das Ergebnis hängen
   könnte — genau der Befund T4, an dem der `mean_reversion`-Treffer starb.
2. **Die Versuche werden gezählt.** Drei Sleeves = **drei Versuche** auf
   denselben Daten. Zusammen mit den sechs Einheiten der
   Ensemble-Vorregistrierung sind es **neun**. Das steht hier, damit später
   niemand „ein Sleeve hat bestanden" ohne den Nenner liest (C5, C6).
3. **Jeder Mechanismus hat einen wirtschaftlichen Grund**, nicht nur eine
   Statistik: Absicherungs- und Umschichtungsflüsse (Sleeve 1),
   Liquiditätsnachfrage im Rücksetzer (Sleeve 2), Lohn- und Pensionsflüsse
   (Sleeve 3). Ein Effekt ohne Mechanismus wäre hier nicht eingetragen.
4. **Die Effektgrößen sind vorab halbiert** (T11/C7), und was dann die
   Kosten nicht deckt, ist oben als solches benannt (Sleeve 3).
5. **Die Universen sind nach ROLLE besetzt, nicht nach Ergebnis.** Kein
   Papier ist drin, weil eine Messung es vorn gesehen hätte.

### Bekannte Verzerrungen

1. **Rückschau in der Korbwahl.** Dass Kurzläufer 2022 verdient haben, weiß
   ich, während ich BIL in den Korb schreibe. Gegengewicht: Der Mechanismus
   ist nicht an 2022 gebunden — im Nullzinsumfeld 2020/21 trägt BIL nichts,
   und das ist Teil des Befunds, nicht seine Fußnote.
2. **Survivorship.** Alle 9 bzw. 4 ETFs existierten über den ganzen
   Messzeitraum, und ich wähle sie in Kenntnis dessen. Die Verzerrung ist
   klein (es gibt keine ausgefallenen Kandidaten dieser Rollen), aber nicht
   null.
3. **Periode.** 2018–2026 enthält zwei Abstürze (2020, 2022) und einen
   langen Bullenmarkt. Ein Zinsumfeld mit Nullzins über die ganze Kette
   würde Sleeve 1 anders aussehen lassen.
4. **Die Ausführungslücke von Sleeve 3** (open-zu-open statt
   Schluss-zu-Schluss) wirkt in Richtung pessimistisch — anders als die
   meisten unserer Verzerrungen.
5. **Kleine Positionen verdecken die Notbremsen.** Im Alpha-Pfad bemisst die
   Stop-Distanz die Stückzahl. Sleeve 1 steht damit bei ~2,5 % der Equity je
   Position, also ~10 % investiert; eine Tagesbremse von 2 % kann dort
   praktisch nicht auslösen. Gemessen wird deshalb die REGEL (Sharpe,
   Fold-Anteil, Kosten sind skalenfrei), nicht die Allokation. Eine echte
   Allokation (20 % je Position) würde die Bremse treffen — genau daran
   scheiterte Basis V3. Wer Sleeve 1 als Allokation will, misst ihn neu.
6. **`adjustment: all` weicht vom heutigen Produktions-Default (`raw`) ab.**
   Für BIL ist es zwingend (monatliche Ausschüttung, roh ein Sägezahn), für
   Index-ETFs richtig. Eine Aktivierung müsste diesen Schalter mitnehmen,
   sonst ist das Gemessene nicht das Gehandelte.
7. **`foldMembership: fixed`.** Der Korb wechselt nicht je Fold, weil er die
   Vorregistrierung IST. Damit gibt es hier keinen Korb-Survivorship über
   die Folds (T3), aber auch keine Punkt-in-Zeit-Wahl — die Korbwahl ist
   einmalig und steht in diesem Dokument.

### Plausibilitätslauf auf SYNTHETISCHEN Bars (kein Messergebnis)

Vor dem Commit lief jede Config einmal durch `fixedCandidateWfa` — mit
erfundenen Kursreihen (Zickzack-Aufwärtstrend mit einem Einbruch in der
Mitte, dazu eine flach steigende Reihe als BIL-Stellvertreter). Geprüft
wurde ausschließlich die **Arithmetik**: Warmup, Embargo, Fold-Plan,
Größenordnung der Aktivität. Über Kante, Sharpe oder Netto sagt das nichts,
und keine Zahl daraus steht in einer Erwartung oben.

Was dabei herauskam und hier festgehalten wird, damit es später nicht wie
eine Überraschung aussieht:

- `config/vigilant-1440.yaml` mit `isDays: 365` **wirft** —
  „Embargo (275 Bars) verschluckt das gesamte Fenster". Deshalb 550. Genau
  daran scheiterte die erste `regime_allocation`-Fassung.
- Aktivität auf den synthetischen Reihen: `turn_of_month` 3,6 Trades je
  Monat (erwartet 4 minus Aufwärmphase — passt), `index_reversal` 5,9
  (am oberen Rand meiner Erwartung von 2–5; die synthetische Reihe hat
  mehr Rücksetzer als ein echter Index), `vigilant_allocation` **0,5 und
  damit nur 35 OOS-Trades über 24 Folds**. Auf erfundenen, glatt steigenden
  Reihen wechseln die Top-2 fast nie, und bei echten Kursen dürfte es mehr
  sein — aber es unterstreicht, dass Erwartung 1 (≥ 60 OOS-Trades) die
  wackeligste der sechs ist und dass diese Familie am Trade-Zahl-Gate
  scheitern kann, ohne dass ihre Regel falsch ist. Die Erwartung bleibt
  stehen, wie sie geschrieben ist.

### Entscheidungsregeln

- Ein Sleeve, der alle zehn Gates nimmt, ist **noch nicht** Champion: Er
  wird mit `--as-of` auf mindestens zwei früheren Stichtagen wiederholt
  (Vorschlag −90 und −180 Tage). Erst wenn dasselbe Urteil dreimal auf
  getrennten Fenstern steht, zählt es (dieselbe Regel wie im Ensemble).
- Ein Sleeve, der ein Gate verfehlt, bleibt Kandidat und wird nicht
  nachgebessert. Eine geänderte Schwelle wäre eine neue Vorregistrierung,
  keine Korrektur.
- Kein Sleeve geht ohne Paper-Betrieb und `readiness` an Echtgeld (§6).
- Jeder Lauf bekommt eine Zeile in `befunde.md`, auch der, der nichts
  befördert.

---

## Erweiterungen, die dafür in FREMDEN Dateien nötig wären

Beide sind nicht gebaut; an `core/logic.ts`, `risk/`, `optimize/` und
`engine/` arbeiten parallel andere. Sie stehen hier, damit die Entscheidung
darüber eine Entscheidung ist und kein Nebenprodukt.

**(1) Der Kanarienvogel — Breite im Korb-Rang.** Minimal und ohne neue
Datenquelle: `KorbRang` in `src/core/types.ts` bekommt ein zusätzliches,
optionales Feld, das `korbRaenge()` in `src/core/logic.ts` mitliefert —
etwa `negativ: number` (wie viele Korbmitglieder an DIESER Bar eine
negative Kennzahl haben). `korbRaenge` kennt die Liste der Kennzahlen des
Zyklus schon; das Zählen sind drei Zeilen, und es bleibt im Kern, wie §0.2
es verlangt (nie in der Strategie, nie im Aufrufer). Der Sleeve bekäme dann
einen Parameter `breadthMax` (eine ZAHL, passt in `Params`) und die Regel
„sind mehr als `breadthMax` Mitglieder negativ, kauf nur noch defensiv".
Simulator und Engine brauchen keine Zeile Änderung, weil beide den Rang
nicht selbst bauen. Wächter gehört nach `test/core/korb.test.ts`.
Das ist NICHT Kellers Kanarienvogel mit ausgewählten Wächterpapieren (dafür
bräuchte eine Strategie Symbolrollen, und `Params` kennt nur Zahlen) — es
ist seine ältere Fassung „breadth momentum", und sie ist im Vertrag
ausdrückbar.

**(2) Allokations-Sizing für Alpha-Kandidaten.** `SizingSpec`
(`mode: 'allocation'`) gibt es heute nur für die Basis-Stufe
(`core/basisTier.ts`, Prüfbefund K4). Solange das so ist, ist Sleeve 1 im
Alpha-Pfad mit ~10 % investiert, und Sleeve 3 trägt absolut wenig. Wer die
Sleeves als Allokation messen will, braucht entweder einen zweiten
Basis-Block (dann konkurriert er mit der bestehenden Basis — höchstens EIN
Basis-Kandidat je Config) oder `sizing` als Feld einer Champion-Wahl auch
für `tier: alpha`. Das ist eine Owner-Entscheidung: Sie verschiebt die
Größe jeder Position, also auch jede bestehende Messung.
