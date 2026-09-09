# Thesen — die eigene Theorie, mit Status

Status: `offen` (vorregistriert oder in Vorbereitung), `bestätigt`,
`widerlegt`, `verworfen` (nicht mehr verfolgt). Jede These nennt Beleg und
Konsequenz. Belege sind Läufe (Nummer = Probe-Lauf in `befunde.md`) oder
Abschnitte in `docs/ARCHITEKTUR.md`.

| # | These | Status | Beleg | Konsequenz |
|---|---|---|---|---|
| T1 | Auf Intraday-Bars (≤ 60 Minuten) frisst der Umschlag bei Retail-Kosten jede Kante, die es auf diesem Korb gibt. | bestätigt | §5a.10: Gebühren 271–2 438 % des Bruttogewinns auf 5-Minuten-Bars; Literatur B1–B5, C8 | Plattform auf Tagesbars; keine Intraday-Familie, solange die Kosten nicht unter 1 bp liegen. |
| T2 | Signal-Strategien je Aktie (Trend, Pullback, Umkehr) schlagen auf 30 liquiden US-Werten den Index nach Kosten nicht. | bestätigt (4 Fenster, 2020–2026) | §5a.12, §5a.15: alle unter der SPY-Latte außer ein Treffer (T4) | Diese Familien bleiben Kandidaten unter zehn Gates; sie sind nicht der Standard. |
| T3 | Der Korb entscheidet mehr als die Strategie: Ein Endkorb rückwärts schmeichelt jeder Momentum-Regel. | bestätigt | csm 0,71 ✔ → 0,58 ✘ mit Korb je Fold (§5a.13, §5a.15) | Korb je Fold ist Pflicht; der Pool-Survivorship bleibt als bekannte, optimistische Verzerrung. |
| T4 | Ein Walk-Forward mit jährlich neu gesuchten Parametern misst keine Strategie, sondern eine Folge von Strategien; sein Ergebnis hängt an der Ausrichtung des Rasters. | belegt an mr | §5a.15: dieselben 14 Quartale +2 086 $ und −200 $ bei 6 Tagen Rasterversatz | Falsifikationslauf (Raster + Seed) für jeden Treffer, bevor er zählt; Festkandidaten mit vorregistrierten Parametern als Gegenprobe. |
| T5 | Trend auf Anlageklassen-ETFs mit Regimefilter und Rang hält die Marktrendite bei kleinerem Drawdown — die Kante liegt in der Breite über unkorrelierte Märkte, nicht in der Titelwahl. | **bestätigt bis auf Weiteres** (V2, drei Läufe) | V1 (#36) verfehlte ihre Latte und konnte T5 nicht bestätigen (Prüfbefund). V2 (#37, #38, #39; Latte im Code, durchgehende Simulation, Korb liegenlassen als Maßstab): MaxDD je Einheit Exposure 12,1–12,4 % gegen Latte 15,5–15,6 %, Sharpe 0,79–1,01 gegen 0,61–0,75, Netto +23,8 bis +30,8 %, Kosten 2,4–3,3 % — dreimal dasselbe Urteil bei 0/−15/−30 Tagen Stichtag. Vorbehalte: trendfreundliche Periode, Familienwahl auf derselben Kette (K3), Netto schwankt mit dem Raster (T4). | Basis-Stufe bauen und auf Paper-Konten aktivieren (Position 20 % der Equity je Symbol, Nutzer-Schalter). Der Vorwärtstest auf Paper (T9) ist die nächste Messung; ein Halbjahr mit MaxDD über der Latte setzt T5 zurück auf `offen`. |
| T6 | Es gibt einen optimalen Aktivitätsbereich: wenige Trades je Monat, Haltedauern von Wochen bis Monaten. Darunter passiert nichts, darüber zahlt man. | Ableitung aus C8, A1 | Umsatz × Kosten gegen Effektgröße | Aktivitätsbudget (`aktivitaet.md`) als Design- und Messgröße; Trades/Monat im Bericht. |
| T7 | Ein Universum nach Dollarumsatz ist ein Momentum-Tilt, weil der Umsatz den Kurs enthält. | bestätigt | §5a.12 (2), Kopf von `universe/select.ts` | Auswahl nur punkt-in-zeit; nie nach Strategieergebnis; Umsatz als Kriterium bleibt, aber gewusst. |
| T8 | Weite Katastrophen-Stops bei Trendfamilien, keine engen Stops bei Umkehrfamilien. | Design-Regel | Literatur F1; Vorgänger verkaufte bei −3 % statt −25 % (CLAUDE.md §2) | `regime_allocation`: Stop 10–25 %, nie nachgezogen; `mean_reversion`: Zeit- und Signal-Exits statt enger Stops. |
| T9 | Der einzige Test ohne Raster ist der Vorwärtstest mit echten Fills: Paper-Betrieb mit Journal. | offen | `readiness.ts` misst ihn; noch kein Journal, weil nichts handelt | Basis-Allokation und Challenger auf Paper-Konten erzeugen das Journal. |
| T10 | Je Symbol optimieren ist eine Lotterie; die richtige Granularität ist der Korb oder die Anlageklasse. | teilweise belegt | TSLA-Beispiel im Kopf von `config/platform.yaml`; gepoolt seit 08.09. | Symbolprofile leiten Taktik je Symbol aus der Klasse ab, nicht aus einer Suche je Symbol (`symbolprofile.md`). |
| T11 | Jeder Literatur-Effekt wird mit etwa 50 % Abschlag geplant; was dann die Kosten nicht deckt, wird nicht gebaut. | Regel | C7 | Vorregistrierung nennt die erwartete Effektgröße nach Abschlag. |
| T12 | Auf Krypto zu 25 bp Taker überlebt keine Tagesbar-Taktik dieses Repos. | bestätigt | Krypto-Proben Stunden- und Tagesbars (BTC/ETH/SOL): alle stay_notrade; Vorgänger −1 133 $ mit, +40 $ ohne Krypto | Krypto nicht aktiv; einzige literaturnahe Idee wäre Wochen-Momentum (G1), unter Kostenvorbehalt. |
| T13 | Ein System, das nie handelt, kann nicht lernen: Ohne Journal keine Live-Reife, ohne Live-Reife kein Echtgeld. Der Standard muss handeln, mit einer Latte, die zur Aufgabe passt. | Ableitung | Owner-Anweisung 09.09.; A4 (Lernen findet im Messsystem statt) | Zwei Latten: Alpha-Kandidaten unter zehn Gates; Marktexposition unter B1–B4. Keine dritte. |

## Wie Thesen entstehen und sterben

Eine These entsteht aus einer Literatur-Karte oder einem Befund und wird
`offen`, sobald sie eine Vorregistrierung hat. Sie wird `bestätigt`, wenn
ein vorregistrierter Lauf ihre Kriterien erfüllt, und `widerlegt`, wenn er
sie verfehlt. Bestätigt heißt „bis auf Weiteres": Ein späterer Lauf, der
widerspricht, setzt sie zurück auf `offen` und erzwingt eine neue
Vorregistrierung. `verworfen` ist für Thesen, deren Test wir uns nicht mehr
leisten oder deren Kosten die beste denkbare Kante übersteigen.
