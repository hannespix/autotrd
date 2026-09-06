# VALIDIERUNG.md — Das Protokoll, bevor eine Strategie handeln darf

Zweck: festlegen, wann eine Parameterwahl als „hat eine Kante nach Kosten"
gilt — und wann nicht. Das Protokoll ist bewusst streng, weil der Vorgänger
brutto positiv und netto negativ war und weil ein Suchraum ohne Bremse
zuverlässig Unsinn findet, der im Rückblick großartig aussieht.

Alle Zahlen unten sind die Defaults aus `src/core/config.ts` (Abschnitt
`optimizer`, `costs`) und `src/optimize/robustness.ts`; die Beispiel-Config
setzt dieselben Werte.

## 1. Datenbasis

- **Nur Alpaca-Bars**, derselbe Feed wie live (`broker.feed`, Default `iex`).
  Ein Backtest auf `sip` für eine Engine, die `iex` sieht, misst etwas
  anderes, als gehandelt wird.
- **1-Minuten-Bars als einzige Quelle**; der Strategie-Zeitrahmen entsteht
  über `core/bars.ts` `aggregate()` — dieselbe Funktion, die live die Buckets
  schließt. Bucket-Grenzen sind an der Sitzungseröffnung ausgerichtet;
  Pre-/After-Market fließt nicht ein.
- **Lücken bleiben Lücken.** IEX deckt nur einen Teil des Volumens; Minuten
  ohne Trade erzeugen keine Bar. Der Simulator erfindet keine Bars.
- **Historie** `optimizer.lookbackDays` = 400 Kalendertage; davon sind die
  letzten `holdoutDays` = 60 Tage nur Bericht (siehe §3).

## 2. Kostenmodell

Jede Simulation rechnet Kosten je Seite, Backtest und Live-Buchung
identisch (`costs`):

| Posten | Default | Bemerkung |
|---|---|---|
| Slippage | 3 bps je Seite | Marktorder gegen den Spread |
| Halber Spread | 2 bps je Seite | |
| SEC-Gebühr | 0,00278 % auf Verkaufserlöse | Satz wird jährlich angepasst |
| FINRA TAF | 0,000166 $ je verkaufter Aktie, max. 8,30 $ | |
| Krypto-Taker | 0,25 % | nur `assetClass: crypto` |
| Short-Leihe | 1 % p. a. | nur `allowShort: true` |

**Stress:** Jeder Kandidat wird zusätzlich mit Kosten × `stressCostMultiplier`
(1,5) simuliert und muss auch dann netto positiv bleiben. Wer bei 50 % mehr
Kosten kippt, lebt von der Kostenannahme, nicht von der Kante.

## 3. Walk-Forward

```
◄──────────────── lookbackDays (400) ────────────────►
[  IS 120  ][ OOS 30 ]                                 Fold 1
     step 30 ──► [  IS 120  ][ OOS 30 ]                Fold 2
                        ...                            Fold k
                                            [ Holdout 60 ] nur Bericht
```

- **In-Sample (IS)** `isDays` = 120 Kalendertage: Hier wird gesucht.
- **Out-of-Sample (OOS)** `oosDays` = 30: Hier wird nur gemessen — mit den
  Parametern, die die IS-Suche des **selben** Folds gewählt hat.
- **Schritt** `stepDays` = 30 = `oosDays` ⇒ die OOS-Fenster bilden eine
  lückenlose Kette; `stepDays > oosDays` wird von `parseConfig` abgelehnt.
- **Embargo** `embargoBars`: Sperrzone zwischen IS und OOS, damit weder
  Indikator-Warmup noch eine am IS-Ende offene Position ins OOS leckt.
  0 = automatisch (Warmup der Strategie + Reserve für die maximale
  Haltedauer).
- **Holdout** `holdoutDays` = 60: Die jüngsten Tage werden **nie** zur
  Auswahl benutzt. Sie erscheinen im Bericht, unübersehbar als „nur
  Bericht, nicht Auswahl" markiert — ein zweiter, unabhängiger Blick, der
  aber ebenfalls nicht mehr sagt als: die letzten zwei Monate hätten so
  ausgesehen.
- **Suche** je Fold: `samples` = 150 Zufallsstichproben aus dem
  Parameterraum der Strategie (`paramSpace`, Gitter mit `step`), mit
  `seed` = 42 reproduzierbar. Keine Gradienten, kein Nachziehen auf dem
  OOS — das OOS sieht die Suche nicht.
- **Finale Parameter** entstehen aus einer Suche auf dem letzten Fenster;
  ihr OOS-Beleg ist die Fold-Kette davor, nicht ihr eigenes Fenster.

## 4. Zielfunktion

`optimizer.objective` (Default `sortino`; alternativ `sharpe`,
`return_over_dd`) wird **je Fold** auf dem OOS berechnet; der Wert eines
Kandidaten ist der **Median über die Folds**, nicht die Summe. Ein einzelnes
Glücks-Fenster kann den Median nicht tragen; eine leere Liste ist −∞.

## 5. Gates — alle müssen bestehen

| Gate | Schwelle | Warum |
|---|---|---|
| OOS-Trades | ≥ `minOosTrades` (60) über alle Folds | Darunter ist jede Kennzahl Rauschen |
| Fold-Anteil | ≥ `minFoldPositiveShare` (60 %) der Folds netto positiv | Kante muss über Regime tragen, nicht über ein Fenster |
| OOS netto | > 0 bei normalen Kosten **und** bei Kosten × 1,5 | Kostenannahme darf nicht die Kante sein |
| Nachbarschafts-Plateau | ±1 Gitterschritt in jeder Parameterachse: Median der Nachbarn ≥ 50 % des Bestwerts **und** ≥ 60 % der Nachbarn netto positiv | Ein Optimum, das beim kleinsten Schritt einbricht, ist eine Spitze im Rauschen |
| Probabilistic Sharpe Ratio (OOS) | ≥ `minPsrOos` (0,90) | Wahrscheinlichkeit, dass der Sharpe der verketteten OOS-Tagesrenditen echt > 0 ist (Bailey / López de Prado 2012, mit Schiefe/Kurtosis und n = OOS-Tage). Die OOS-Kette ist selektionsfrei — das ist die ehrliche Zahl der Prozedur |
| Deflated Sharpe Ratio (IS) | informativ; als Gate ≥ 0,95 nur mit `dsrIsGate: true` | Deflation des In-Sample-Sharpe der finalen Parameter gegen die Zahl der Versuche (`trials`) und die Streuung der Trial-Sharpes. Steht immer im Bericht. Als hartes Gate bestraft es breite Gitter mit toten Regionen doppelt (die OOS-Kette hat die Auswahl schon bezahlt) — im Smoke fiel eine Strategie mit PSR-OOS 1,00 und 10/10 positiven Folds allein daran durch |
| Gebührenanteil | Σ Kosten / Σ Brutto-Gewinne ≤ 0,5 | Der Vorgänger lag bei 0,57 — brutto positiv, netto negativ |

Ein Kandidat, der ein Gate reißt, wird im Bericht mit dem gerissenen Gate
gelistet und **nicht** befördert — egal wie gut die anderen Zahlen sind.

## 6. Champion und Challenger

- `champion.json` (im State-Verzeichnis) hält Strategie, Parameter, den
  OOS-Objective-Median zum Zeitpunkt der Beförderung und den Zeitstempel.
- Ein Kandidat ersetzt den Champion nur, wenn er alle Gates besteht **und**
  sein Objective-Median den des Champions um `promotionMargin` (10 %)
  übertrifft. Ohne Marge tauscht man Rauschen gegen Rauschen und handelt
  jede Nacht etwas anderes.
- Der amtierende Champion wird bei jedem Lauf **neu bewertet** (gleiche
  Daten, gleiche Gates). Reißt er ein Gate, verliert er den Status — dann
  gibt es keinen Champion.
- **Kein Champion ⇒ kein Handel.** `strategy.allowWithoutChampion` ist
  `false`; die Engine startet, hält Positionen und Stops, nimmt aber keine
  Einstiege. Das ist ein reguläres, erwartetes Ergebnis — nicht ein Fehler,
  den man mit `true` „behebt". `true` ist ausschließlich für die
  Paper-Erkundung gedacht.

## 7. Lookahead-Wächter

Der Vorgänger hatte ein Lookahead-Leck in der Prognose-Bewertung; deshalb
gibt es hier mehrere unabhängige Sperren:

1. **Nur geschlossene Bars.** Eine Bar gilt als geschlossen, wenn
   `t + timeframe` erreicht ist (+ `engine.barGraceSec` live). Strategien
   sehen nie die laufende Bar.
2. **Präfix-Snapshot im Simulator.** Der Snapshot an Index `i` trägt
   `bars.prefix(i + 1)` — die Serie **endet** an der Entscheidungs-Bar; es
   gibt für die Strategie physisch keinen Index `i + 1`.
3. **Präfix-Konsistenz-Tests für Indikatoren.** `precompute(bars.prefix(n))`
   muss für alle Indizes `< n` dieselben Werte liefern wie
   `precompute(bars)`. Ein Indikator, der die Zukunft anfasst (zentrierte
   Glättung, Normierung über die ganze Serie), fällt hier durch.
4. **Sitzungs-Sicht am Bucket-Ende.** `minutesToClose`, `isLastBarOfDay`
   werden vom Ende der geschlossenen Bar aus gerechnet, nicht vom Beginn.
5. **Embargo und Holdout** (§3).
6. **Fills nur an sichtbaren Kursen.** Marktorders füllen am Open der
   Folgebar plus Kosten; Stop und Ziel füllen innerhalb der Bar, die sie
   berührt — bei Gap zum Open, nie zum Stop-Kurs.
7. **Live-Reife ohne Zukunft.** `assessReadiness` ignoriert Trades, deren
   Exit nach `now` liegt.

Jede Änderung an Zeitlogik, Aggregation oder Simulator ist hochriskant und
wird mit echten Datumsgrenzen (DST-Wechsel, Frühschluss, Feiertage) getestet.

## 8. Live-Reife — vor dem Schalter auf Echtgeld

Owner-Regel: „bis man sicher nur noch Gewinn schreibt, dann erst den
Schalter umlegen." `autotrd readiness` prüft das Paper-Journal
(`src/readiness.ts`):

| Kriterium | Schwelle |
|---|---|
| Abgeschlossene Trades | ≥ 200 |
| Kalendertage erster Einstieg → letzter Ausstieg | ≥ 30 |
| Profit-Faktor (Σ Netto-Gewinne / Σ Netto-Verluste) | ≥ 1,2 |
| Gebührenanteil (Σ Kosten / Σ Brutto-Gewinne) | ≤ 0,5 (ohne Brutto-Gewinne: nicht berechenbar ⇒ fällt durch) |
| Netto-Ergebnis | > 0 |

Zusätzlich informativ: der größte Rückgang der kumulierten Netto-PnL. Erst
wenn alle fünf bestehen, ist `broker.mode: live` überhaupt ein Thema — und
auch dann bleiben `ALPACA_ALLOW_LIVE=1` und ein Live-Key als zwei weitere,
bewusste Handgriffe (ARCHITEKTUR.md §5).

Diese Schwellen sind Mindestwerte: 200 Trades trennen bei realistischen
Kanten Glück noch nicht zuverlässig von Können. Sie verhindern nur, dass
man nach zwanzig guten Trades den Schalter umlegt.

## 9. Was das Protokoll nicht leistet

Kein Verfahren garantiert Gewinn. Walk-Forward begrenzt die Selbsttäuschung
durch In-Sample-Auswahl, die PSR auf der OOS-Kette die durch zu kurze
Stichproben, der (informative) Deflated Sharpe zeigt die durch viele
Versuche, der Stresstest begrenzt die durch geschönte Kosten, das Plateau die
durch Zufallsspitzen.
Nichts davon schützt vor einem Markt, der sich ändert, vor einem
Datenfeed, der anders lückt als in der Historie, oder vor einem Fehler in
der Ausführung. Ein Champion ist eine Parameterwahl, die die bekannten
Fallen überlebt hat — mehr nicht. Das Journal entscheidet, ob er es auch
live tut; die Live-Reife-Schwellen sind der Punkt, an dem man das erstmals
ernsthaft prüfen kann, nicht der Beweis.
