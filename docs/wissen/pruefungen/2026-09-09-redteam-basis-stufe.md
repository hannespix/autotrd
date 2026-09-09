# Red-Team-Befund — Basis-Stufe (Commit aade8106, 09.09.2026)

Prüfer-Auftrag: widerlegen. Gegenstand: der letzte Commit auf dem Branch („basis-stufe: alpha-champion vor basis vor
noTrade, allokations-sizing, nutzer-schalter, eigene mess-einheit") und die für morgen vorgeschlagene Aktivierung in
`config/platform.yaml` (broker.adjustment all; fixedCandidates tier basis; optimizer.basis positionPct 20;
basisUniverse [SPY, IWM, EFA, EEM, IEF, TLT, LQD, GLD, XLRE]; evtl. lookbackDays 2000).

Methode: Code gelesen (alle im Auftrag genannten Dateien plus `src/engine/orders.ts`, `reconcile.ts`, `ids.ts`,
`src/risk/limits.ts`, `src/data/backfill.ts`, `store.ts`, `src/alpaca/stream.ts`, `scripts/module/wachhund.mjs`,
`functions/src/scheduled/snapshotEquity.ts`, `shared/src/liveReadiness.ts`, Workflows). Zwei Prüfskripte gegen die
Repo-Funktionen (`check1.test.ts`, `check2.test.ts` im Scratchpad, ausgeführt mit vitest und eigener Config
`vitest.redteam.mjs`; keine Repo-Datei geändert, `git status` leer). **Kein Bars-Cache auf der Platte** (`var/`,
`var-probe/` fehlen) ⇒ kein Datenlauf; Marktzahlen sind die aus der V2-Vorregistrierung bzw. Größenordnungen aus dem
Gedächtnis und als solche markiert.

Schwere: **K** = die Stufe handelt live etwas anderes als gemessen, oder ein Konto verliert ohne gemessenen Grund Geld
oder Schutz · **M** = verzerrt Messung/Handel messbar oder verletzt eine §0-Regel · **G** = Unschärfe, vor der
Aktivierung zu klären.

---

## A. Befunde

### 1 (K) — Die Tages-Notbremse ist auf der Plattform bei Tagesbars tot; die Messung wendet sie an

**Beleg (gerechnet, `check2.test.ts`).** Plattform-Takt auf Tagesbars, Nutzer mit Voreinstellung (2 % Tagesverlust):
Tag 1 Einstieg und Fill; über Nacht Equity 100 000 → 95 000 (−5 %); Tag 2, erster Takt 09:40 ET:

```
Tag 2 (2026-09-02 09:40): ok=1 failed=[]
  Broker-Equity 95 000 (Vortagesschluss 100 000 = −5 %); State: day=2026-09-02 dayStartEquity=95000 halt={"halted":false,...}
  Journal halt-Ereignisse: 0; Rollover-Notizen: 2026-09-02:95000
  ⇒ Tages-Notbremse (2 %) auf der Plattform bei Tagesbars ausgelöst? NEIN
Tag 2, 10:40 (Equity 90 000 = −5,3 % seit 09:40): halt=null — decide() läuft ohne neue Tagesbar nicht
```

Mechanik: Der Takt läuft für normale Nutzer nur bei offenem Markt (`tick.ts:458–466`, `market_closed`); der erste
Takt des Tages ist ~09:30. Dort setzt `rollover` `dayStartEquity = this.account.equity` (`engine.ts:911`, Equity
NACH dem Gap), und im selben Takt läuft `decide()` (einzige neue Tagesbar des Tages) mit derselben Equity ⇒
`dailyLossPct` = 0. Danach läuft `decide()` (und damit `checkHalt`) bis zum nächsten Morgen nicht mehr
(`engine.ts:615` `if (inputs.length > 0)`; kein neuer Bucket). Der Simulator setzt `dayStartEquity` am Tageswechsel
auf die Schluss-Equity des Vortags und prüft am Schluss (`simulator.ts:446/457`, `:560`) ⇒ close-to-close
(`check1` E: −5 % ⇒ `halt: daily_loss`, Exit `kill_switch`). Der Prüfbefund V1/M8 hatte „Parität" behauptet — das
galt für den Dauerprozess (Rollover um Mitternacht, Tick jede Sekunde), nicht für die Plattform.

Zwei Sonderfälle machen es schlimmer, nicht besser: Nutzer mit zurückgestelltem Intent oder Kommando werden auch nach
Schluss getaktet (`needsWorkWhileClosed`) und entscheiden dann um 16:00:20 — für sie greift die Bremse intraday
(ohne Gap); zwei Regeln je nach Tageszustand. Und `st.peakEquity` wird JEDEN Takt mit Intraday-Equity fortgeschrieben
(`engine.ts:548`) — der Drawdown-Halt sieht Intraday-Peaks, der Simulator nur Schlusskurse (M9, bekannt).

**Wirkung.** Die nächtliche Messung (2 %/10 %, Befund 2) liquidiert bei −2 %-Tagen und bleibt bis zum nächsten
Monatsfenster in Kasse; live passiert das nie. Richtung: live mehr Exposure/Risiko als gemessen; und die Zahl
`maxDailyLossPct`, die der Nutzer einstellt, ist bei Tagesbars ein Placebo. Das betrifft nicht nur die Basis — sie ist
nur das Erste, das auf der Plattform mit Tagesbars tatsächlich handelt (es gibt keinen Alpha-Champion).

**Vorschlag.** Vor Aktivierung: (a) `rollover` setzt `dayStartEquity` auf `acc.lastEquity` (Alpaca `last_equity`,
Schluss-Equity des Vortags; `AlpacaAccount.lastEquity` existiert, `types.ts:21`) — genau die Konvention, die
`simulator.ts:445` als Kommentar nennt; (b) `checkHalt` in jedem Takt rechnen, nicht nur bei neuer Bar (Notbremsen
sind Kontosperren, keine Bar-Entscheidungen); (c) Wächter-Test im Functions-Takt: „Gap −5 % über Nacht bei Tagesbars
⇒ Halt daily_loss im ersten Takt". Alternativ ehrlich messen: `maxDailyLossPct: 0` für die Basis-Messung UND das Feld
aus der Nutzer-Karte für Tagesbars entfernen — dann ist es wenigstens dieselbe Regel.

### 2 (K) — Drei Regelwerke: Vorregistrierung V2 ≠ nächtliche Messung ≠ Handel je Nutzer

**Beleg.** V2 hat mit `maxDailyLossPct 5`, `maxDrawdownPct 30`, `lookbackDays 2000` bestanden
(`config/basis-1440-v2.yaml`, Vorregistrierung §M8/M9). Der Nachtlauf misst die Basis mit `simConfig.risk = cfg.risk`
(`run.ts:749–755`), also mit dem `risk`-Block von `platform.yaml`: 0,5/20/4/100/**2/10**, und mit `lookbackDays 1400`
(sofern nicht geändert). `riskDefaults` im Doc `meta/engineConfig` liest niemand (grep über functions/frontend/shared:
kein Treffer); der Nutzer-Default kommt aus dem zod-Schema/`AUTO_DEFAULTS` (2/10). Gehandelt wird je Nutzer mit dessen
Bremsen (`config.ts` Functions Z. 92–111), mit toter Tagesbremse (Befund 1), Intraday-Peak und Resume-Pflicht
(Befund 7), und im selben Buch wie der Alpha-Champion (Befund 5).

**Was das mit dem Urteil macht.** (a) 1400 Tage: Kette beginnt ≈ 2023-11 (1400 Kalendertage ab 2026-09-10 =
2022-11-10, plus 365 Tage IS) — der Bärenmarkt 2022, in dem die Basis laut V2 ihren Drawdown-Vorteil „verdient",
liegt außerhalb. Ob `basis_drawdown` (Latte 0,75 × Korb-MaxDD) auf 2023-11 … 2026-03 hält, ist nicht bekannt; die
Vorregistrierung hat 2000 festgeschrieben, 1400 wäre ein anderer, nie registrierter Test. (b) 2 %-Tagesbremse in der
Simulation: bei 4 Positionen × 20 % reicht ein −2,5 %-Tag des Korbs; 2024-08-05 (SPY ≈ −3 %, IWM/EEM ≈ −3…−4 %,
Gedächtniswert) und 2025-04-04 (SPY ≈ −6 %, EFA/EEM ≈ −5…−6 %) sind Kandidaten ⇒ Liquidation am Folge-Open (das ist
am 07.04.2025 der Gap-Tag) und Kasse bis zum Fenster 1.–5. Mai — die V2-Scheibe „April 2025 +712 $" entsteht so nicht.
(c) Das Ergebnis dieser anderen Messung schaltet die Stufe scharf (`pass` ⇒ Handel, Default an).

**Vorschlag.** `lookbackDays 2000` ist Pflicht, nicht „evtl.". Für die Bremsen eine von zwei Entscheidungen, vor der
Aktivierung: entweder V3 vorregistrieren („Basis mit Plattform-Bremsen 2/10, drei Läufe") und erst danach schalten,
oder die Basis-Einheit mit dem registrierten Risiko messen (eigener `risk`-Block für `tier: basis`, z. B.
`optimizer.basis.risk`) UND Befund 1 fixen, damit live dieselben Bremsen wirken wie gemessen. In jedem Fall: der
Nachtbericht muss den Risiko-Block der Basis-Messung nennen (heute steht dort nur die Plattform-Zeile, `report.ts:181`).

### 3 (K, sofern Alpaca den Stop-only-Bracket ablehnt) — Basis-Einstiege sind Bracket-Orders ohne Take-Profit-Bein; nie gegen Alpaca geprüft

**Beleg.** `regime_allocation` liefert kein Ziel (`regimeAllocation.ts:192–193`, `target` fehlt). `buildEntryOrder`
setzt IMMER `orderClass: 'bracket'` und hängt `takeProfit` nur an, wenn ein Ziel da ist (`orders.ts:322–340`);
`rest.ts:167–181` sendet das so. Alpacas Order-API verlangt für `bracket` beide Beine, für Stop-only gibt es `oto`
(der Typ `OrderClass` kennt `'oto'`, `types.ts:104`, benutzt es aber nirgends). Alle bisherigen Aktien-Strategien
setzen Ziele (`atrBracket`); der Test `orders.test.ts:106` schickt `target: null` nur gegen den Fake, der Beine nicht
prüft. Ob der echte Endpunkt den Stop-only-Bracket annimmt, ist im Repo nirgends belegt — und ich kann es ohne Netz
nicht prüfen.

**Wirkung, falls abgelehnt.** 422 ⇒ `execute` bucht `error execute:enter` (`orders.ts:220–231`), der Tick wirft
„Order-Ausführung fehlgeschlagen" ⇒ `onError`, `consecutiveErrors` steigt an Fenstertagen und fällt am nächsten
sauberen Takt zurück ⇒ kein Halt, keine Position, kein Fehler im Spiegel (`runUser` meldet `ok`), nur Journal-Zeilen.
Die Basis wäre „aktiv" und handelte nie — still.

**Vorschlag.** Vor Aktivierung EINE Paper-Order dieses Typs von Hand (oder per `doctor`-Erweiterung) gegen
`paper-api` senden. Wenn abgelehnt: bei `target === null` `orderClass: 'oto'` mit `stopLoss` senden; Test, der den
Order-Body für zielose Einstiege festnagelt.

### 4 (M) — Eine Basis-Position wird von der Strategie geführt, die das Symbol HEUTE führt — beim Alpha-Wechsel mit fremden Regeln

**Beleg (gerechnet, `check1` B).** Position `strategy: regime_allocation`, Stop 80 (20 % unter 100), Symbol wechselt
über Nacht zum Alpha-Champion (trendartig, Trailing): `decide()` ruft `strategy.decide(snap)` der NEUEN Strategie mit
der alten Position (`logic.ts:368–398`) ⇒ `move_stop 101,85` — der Katastrophen-Stop wird zum ATR-Trailing.
`engine.ts:605–612` prüft nur, OB eine Strategie das Symbol führt, nicht WELCHE; die Position gilt als geführt.
Gepoolte Alpha-Beförderungen schreiben denselben Eintrag für alle 30 Symbole (`run.ts:1120–1123`) — mit SPY, IWM
und jedem Korb-ETF, das gerade im Top-30-Universum steht, wechselt das Regime für mehrere Basis-Positionen in einer
Nacht, und beim `demote` zurück. Das ist die „Trailing-Stop"-Fehlerklasse aus CLAUDE.md §2, per Bauart.

**Vorschlag.** In `engine.ts` (oder `decide()`): `pos.strategy !== strategy.id` ⇒ Position „ohne Führung" wie beim
Universumsabgang (Exit `unmanaged`) — oder, wenn der Owner Basis-Positionen auslaufen lassen will, ein
`hold`-Modus ohne `move_stop`/Signal-Exit fremder Strategien. Test: Basis-Position + Alpha-Strategie ⇒ kein
`move_stop`.

### 5 (M) — „Alpha vor Basis" gilt je Symbol, nicht je Platz: die Basis nimmt dem Alpha-Champion die Plätze

**Beleg (gerechnet, `check1` C).** `maxPositions 4`, neun Basis-Symbole mit Rang und ein Alpha-Symbol ohne Rang,
alle mit Einstiegssignal: Einstiege IEF, GLD, TLT, EFA; blockiert u. a. `ALPHA: Positionslimit 4 erreicht`. Ursache:
Wer einen Korb-Rang hat, konkurriert VOR den Ranglosen (`logic.ts:349–355`). Die Basis wurde ALLEIN mit 4 Plätzen und
80 % Exposure gemessen (`optimizer.basisUniverse`, eigene Einheit); live teilt sie `maxPositions`, Exposure-Budget und
Bargeld mit dem Alpha-Champion — dessen Messung (allein, gepoolt) ist damit ebenso keine Messung des gehandelten
Buchs. Heute latent (kein Alpha-Champion), aber die Bauart schaltet es beim ersten `promote` ein.

**Vorschlag.** Getrennte Budgets: Basis-Plätze und -Exposure aus dem Block (`topPct × n` = 4, `positionPct × 4` =
80 %), Alpha-Plätze aus `maxPositions`; Summe gedeckelt durch `maxGrossExposurePct`. Oder vorregistrieren, dass die
Basis nur ohne Alpha-Champion läuft — dann muss das auch im Code stehen.

### 6 (M) — `pass` kippt oder der Block wird geräumt ⇒ Zwangsliquidation aller Basis-Positionen auf allen Konten am nächsten Open

**Beleg.** `pass !== true` ⇒ nicht handelbar (`basisTier.ts:57`) ⇒ Korb verlässt das Universum (`:94–100`) bzw.
Symbol ist `noTrade` ⇒ `strategyFor` null ⇒ Exit `unmanaged` (`engine.ts:605–612`), Marktorder am nächsten Open
(zurückgestellt, `:671–678`). Dasselbe, wenn der Festkandidat aus der Config verschwindet (`run.ts:1172–1178`, Block
geräumt) oder `meta/champion` von Hand angefasst wird. Wiedereinstieg erst bei `pass: true` UND im nächsten
Drei-Tage-Fenster (`regimeAllocation.ts:170`). Die Gate-Margen in V2: Sharpe 0,79 gegen 0,61, MaxDD/Exposure 12,06
gegen 15,48 — 20–30 % Luft, bei einem Netto, das je Rasterlage um sieben Punkte schwankt (T4). Ein Quartal wie
Jan. 2023 (−733 $) kann `basis_sharpe` unter die Latte drücken, ein Rally-Halbjahr des Korbs die Drawdown-Latte
(0,75 × kleiner Korb-MaxDD). Die durchgehende Simulation kennt diesen Aus-/Wiederein-Zyklus nicht; sie läuft durch.
Sechs Konten × 4 Positionen als Marktorder am Open, weil ein Gate um 1 % verfehlt wurde, ist ein nie gemessener
Handelsweg.

**Vorschlag.** Hysterese wie beim Universum: `pass` fällt erst nach n Nächten hintereinander unter der Latte (oder
mit Marge), und ein gefallenes `pass` sperrt nur EINSTIEGE — offene Positionen laufen nach ihrer eigenen Regel aus
(Regime/Momentum/Rang im Fenster, Stop beim Broker); `unmanaged` bleibt für Symbole ohne jede Strategie. Räumen des
Blocks nur mit ausdrücklicher Owner-Freigabe (Journal-Notiz reicht nicht).

### 7 (M) — Drawdown-Halt 10 % je Nutzer, Peak intraday und über Wochen, Resume nur von Hand — der Einmal-Halt (M9 offen)

**Beleg.** `logic.ts:27–37` benennt es; `limits.ts:55–66` (Halt bis `resume`); `engine.ts:548` (Peak je Takt,
Intraday); `commands.ts` (Resume nur mit `ackDrawdown`, je Nutzer). Messung V2: MaxDD 6,71 % close-to-close, Basis
allein, ein Peak über vier Jahre. Live: Peak intraday (+ ≈ 1 %), plus Alpha-P&L im selben Konto, plus Konto-Historie
seit `emptyState`. 10 % in einem 2022-artigen Jahr ist erreichbar; danach handelt die Basis für dieses Konto NIE
wieder, bis der Nutzer klickt. Für „Standard statt nichts" auf passiven Paper-Konten ist das die schädlichste Form
(Stop + unbegrenzte Sperre).

**Vorschlag (Owner-Entscheidung, §0.5).** Als Regel vorregistrieren: Resume für `tier: basis` zum nächsten
Monatsfenster mit Peak-Reset (journalisiert) — oder eine Basis-eigene Drawdown-Schwelle aus dem Block (30 % wie V2).
Mindestens: der Nachtbericht zählt Halt-Auslösungen der Basis-Simulation (`haltNotes` existieren, der Bericht zeigt sie
nicht — schon V1/M8).

### 8 (M) — Es gibt keinen plattformweiten Basis-Schalter; „aus" heißt immer liquidieren

**Beleg.** `strategy.basis` aus `platform.yaml`/`meta/engineConfig` wird durch den Nutzerteil ÜBERSCHRIEBEN
(`functions/src/engine/config.ts:151`: `{ ...global.strategy, basis: part.basis }`) — ein `strategy.basis: false` in
der Plattform-Config bewirkt nichts. Der Kill-Switch sperrt nur Live-Schlüssel (`brokerZugang.ts:174–177`, Paper ⇒
`null`). Bleiben: `settings.auto.basis=false` je Nutzer (Callable, je Nutzer), `engineCommand halt` je Nutzer, oder
`meta/champion` von Hand — und jeder dieser Wege schließt Basis-Positionen (Befund 6) statt nur Einstiege zu stoppen.
Für eine gestaffelte Aktivierung (Frage 9) fehlt genau der Hebel.

**Vorschlag.** `basis = global.strategy.basis !== false && part.basis` (UND-Verknüpfung, Test), plus ein globaler
Modus „keine neuen Basis-Einstiege, Bestand wird geführt" (entspricht `halt manual` nur für die Basis).

### 9 (M) — Ein Basis-Block mit fremder oder fehlender `version` nimmt den GANZEN Champion mit

**Beleg (gerechnet, `check1` D).** `championFromDoc` wirft bei `basis.version !== 1` — auch bei fehlendem Feld
(`strategyFor.ts:33–36`); im Takt bleibt `champion = null` für ALLE Nutzer (`tick.ts:416–422`): keine Alpha-Einstiege
mehr, nur eine Notiz. Im Dauerprozess wirft `loadChampion` (`promote.ts:116–119`) im `bootstrap` ⇒ JEDES
CLI-Kommando stirbt. Ein additiver Block darf nicht mehr Schaden anrichten können als sein Fehlen.

**Vorschlag.** Unlesbarer Block ⇒ `basis` weglassen + Journal-Notiz „Basis-Block unlesbar — nicht gehandelt";
`symbols`/`noTrade` bleiben gültig. Gleiches für `basis.params` ≠ Objekt (`mergeParams(defaults, null)` wirft
`TypeError` in `Object.entries`; in `buildStrategyFor` gefangen, in `app.ts:strategyChoice` nicht).

### 10 (M) — Eigener Prozess (`run`): 30 + 8 Symbole reißen das IEX-WebSocket-Limit ⇒ stiller Einstiegs-Stopp für alles

**Beleg.** `cmdRun` nimmt `engineConfig(app)` (Universum ∪ Korb, `cli.ts` Diff), die Engine abonniert
`subscribeBars(this.allSymbols())` (`engine.ts:353`); IEX-Basic erlaubt 30 (`stream.ts:459`, `platform.yaml`
Kommentar „405 symbol limit exceeded"). Folge: `DataStream: Verbindung fehlgeschlagen` ⇒ `dataFresh` false ⇒ keine
Einstiege, weder Alpha noch Basis, während Exits laufen — der Prozess meldet sich nicht als kaputt. Die Plattform ist
nicht betroffen (REST-Backfill in Blöcken zu 50, `backfill.ts:32`; die nächtliche Wahl lädt 139 Kandidaten per REST).

**Vorschlag.** `run` verweigert den Start, wenn `allSymbols().length > 30` bei `feed: iex` (oder abonniert in
Prioritätsfolge und sagt es laut); `docs/BETRIEB.md` ergänzen.

### 11 (M) — Der Korb der Basis umgeht den Pool-Wächter; der Wächter ist blind für Basis-Symbole

**Beleg.** `universeWithBasis` hängt `champion.basis.symbols` ungeprüft ans Engine-Universum (`basisTier.ts:97`);
`parseConfig` normalisiert `basisUniverse`, prüft aber nicht `⊆ universe.candidates` (`config.ts:489–497`). Der
Wächter beurteilt nur `meta/engineConfig.universe.symbols` gegen den Pool und die Champion-Deckung
(`wachhund.mjs:59–86`) — Basis-Symbole stehen weder dort noch in `champion.symbols/noTrade`. „Den Pool ändert nur ein
Commit" (PLATTFORM §5a) gilt für den Korb der Basis nicht: Wer `meta/champion.basis.symbols` schreibt, schreibt das
gehandelte Universum, und niemand sieht es. (Heute sind alle neun im Pool — das ist Zufall, kein Wächter.)

**Vorschlag.** `parseConfig`: `basisUniverse ⊆ candidates`; Takt: Korb-Symbole außerhalb des Pools verwerfen mit
Notiz (Pool muss dafür ins Doc oder als Hash mit); Wächter: `champion.basis.symbols` gegen Pool und Blockgröße (≥ 8)
prüfen.

### 12 (M) — Korb schrumpft um Alpha-geführte und bar-lose Symbole: andere Schwellen, dann Stillstand — im Simulator nie

**Beleg (gerechnet, `check1` A).** `pct = (rank−1)/(of−1)`, `topPct 0,4`, `exitPct 0,6`: `of=9` ⇒ 4 Berechtigte,
Austritt ab Rang 6; `of=8` ⇒ **3** Berechtigte, Austritt ab 6; `of=7` ⇒ unter `MIN_KORB 8` (`regimeAllocation.ts:182/188`)
⇒ keine Einstiege UND kein relativer Exit (nur Regime/Momentum). Ursachen live: Alpha-Champion führt SPY/IWM/… (Befund
4/5; `basisTier.ts:26–29` benennt es), Symbol ohne Bar im Takt (`korbRaenge` Regel 2, `logic.ts:251`: nur die jüngste
Bar rangiert — fehlt die Tagesbar eines ETFs im 09:30-Takt, rangieren 8, im nächsten Takt rangiert das Nachzügler-Symbol
allein mit `of 1`). Die Messung hat immer 9.

**Vorschlag.** Vorregistrieren, dass die Basis nur mit vollem Korb gilt: unter 9 keine neuen Einstiege (statt
verschobener Schwellen), und im Spiegel/Bericht die effektive Korbgröße je Takt. Alternativ Schwellen absolut
(`top 4`, `exit ab 6`) statt prozentual — dann ist wenigstens die Rangregel korbgrößenunabhängig.

### 13 (G) — Aktivierungsnacht: Block, Config-Sync und Default-an in EINEM Schritt; alte Clients schalten wieder ein

Der Nachtlauf schreibt den Block und synchronisiert `adjustment: all` in derselben Nacht (`optimize.yml`); am Morgen
ist die Basis für alle sechs Konten scharf (Default an: `autoSettings.ts:228`, `config.ts:101/108/110`), ohne
Probe-Schritt. `saveStrategy` von einem Client ohne das Feld speichert `basis: true` (`autoSettings.ts:192–194, 228`)
— ein ausdrückliches `false` wird durch einen gecachten alten Frontend-Bundle still zurückgesetzt. Erste Einstiege
frühestens im Fenster 1./2./5. Oktober (`rebalanceFenster`, `REBAL_TAGE 3`) — das ist die natürliche Beobachtungszeit,
wenn man sie nutzt (Abschnitt C).

### 14 (G) — `stufe` fehlt genau bei der Zwangsliquidation

`stufeFor` liefert die Stufe nur, wenn die HEUTIGE Wahl dieselbe Strategie ist wie die der Position
(`tick.ts:643–646`, `journal.ts:255`, `mirror.ts:27–33`). Beim `unmanaged`-Schluss (Schalter aus, `pass` gekippt,
Block geräumt) gibt es keine Wahl mehr ⇒ Trade-Doc und Positions-Doc ohne `stufe: basis` — der Nutzer sieht in der
Historie nicht, dass die Basis liquidiert wurde. Vorschlag: `stufe` beim Einstieg in `PositionState` persistieren
(additiv) und von dort stempeln.

### 15 (G) — `positionPct` gegen `maxPositionPct`: stiller Deckel in Messung und Handel

`byCap = maxPositionPct` deckelt die Allokation (`sizing.ts:68–72`). Plattform-Messung: 20 = 20, in Ordnung — aber
`optimizer.basis.positionPct: 25` würde nachts still auf 20 gekappt, der Block trüge trotzdem 25. Nutzer aus dem
Alt-Schema mit `maxPositionPct 10` (`autoSettings.ts:261–262`) handeln 10 %, die Notiz sagt 20 %
(`basisTier.ts:71`). Vorschlag: `parseConfig`-Wächter `optimizer.basis.positionPct ≤ risk.maxPositionPct`; Notiz je
Nutzer mit effektivem Deckel.

### 16 (G) — Live-Reife der Plattform ist nicht die aus CLAUDE.md, und die Basis hat keine

Plattform-Reife = `liveReife` (40 Trades, 14 Tage, PF ≥ 1,2, feeShare ≤ 0,5, netto > 0; `liveReadiness.ts:102–108`)
aus `stats/main`, das ALLE Trade-Docs zählt, nicht nur `source: 'engine'` (`snapshotEquity.ts:346–425`) — nicht die
200/30 aus `readiness.ts`/CLAUDE.md §3. Die Basis allein (0,7–0,8 Trades je Monat, V2) erreicht 40 Trades in ≈ 4–5
Jahren — sie kann Echtgeld nicht freischalten (gut); ein Konto mit manuellen Paper-Trades plus Basis kann es. Eine
Basis-eigene Reife-Regel ist laut §5a.16 „offen beim Owner". Kein neuer Live-Pfad (Frage 1), aber die Regel, hinter
der „Echtgeld bleibt", ist eine andere als dokumentiert.

### 17 (G) — Kosten der Bereinigung: vollständiger Neu-Abruf je TAKT, nicht je Tag

`backfillAdjustedDaily` lädt bei `adjustment ≠ raw` den ganzen Bestand neu (`backfill.ts:190–227`), aufgerufen aus
`tick.ts:544` jede Minute: ≈ 38 Symbole × ≈ 245 Tagesbars (Cache auf `windowMs + 30 d` ≈ 352 Tage gekürzt,
`tick.ts:548–555`) ⇒ 1 Anfrage (≤ 50 Symbole, 10 000 Bars je Seite) je Takt — tragbar. Nachtlauf: 139 Kandidaten + 9
× ≈ 1 400 Bars (2000 Tage) ≈ 21 Seiten, kalter Actions-Cache (Schlüssel hasht `platform.yaml`). Kein Befund, nur die
Antwort auf Frage 7.

### Was in Ordnung ist (je ein Satz)

- **Echtgeld (Frage 1):** `liveGate.ts`, `brokerZugang.ts`, `setLiveMode.ts` ohne Diff; der Takt sperrt Einstiege
  über `entryLock` für Basis und Alpha gleich (`tick.ts:490, 675`, `logic.ts:414–417`, Test `basisStufe.test.ts`
  „verriegelt"); der Modus kommt aus dem Schlüssel-Präfix, nie aus der Stufe. Kein neuer Pfad.
- **Idempotenz (Frage 4):** Einstieg (mode, symbol, Bucket-Beginn des Takttags), Exit (mode, symbol, entryTime)
  (`ids.ts:44–57, 108–119`); Wiederholung im selben Bucket findet die Order (`orders.ts:283–297`). Der
  `unmanaged`-Exit läuft am Halt und am `entryLock` vorbei und wird nach Schluss zurückgestellt — nie gesperrt.
- **Sizing-Identität (Frage 2):** 4 %/20 %-Stop ⇔ Allokation 20 % byte-gleich im Simulator (`allokation.test.ts`),
  gleicher Pfad in der Engine (`engine.ts:580`, `simulator.ts:541`).
- **Fill und Fenster (Frage 2):** Simulator füllt am nächsten Open; Plattform entscheidet die Tagesbar im ersten Takt
  des Folgetags (`closedSeries`, `engine.ts:1113`) und schickt die Marktorder ≈ 09:30:20–09:31 — dieselbe Bar,
  derselbe Handelstag; Fensterlogik (`rebalanceFenster`) sieht nur `t[i−1]`, gleich in beiden Welten.
- **Stop (Frage 2):** GTC-Bracket-Bein (`orders.ts:334–337`), nie nachgezogen (kein `move_stop` der Familie), Storno
  vor eigenem Exit mit 422-Nachsehen (`orders.ts:605–632`) — vorbehaltlich Befund 3.
- **Bars (Frage 2):** eigene Wurzel `iex-adj-all`, Store und Backfill verweigern Mischung (`store.ts:55–57,
  141–150`, `backfill.ts:154–163`, Test `bereinigung.test.ts`); ein Doc ohne Feld bleibt roh.
- **Halb geschriebener Block (Frage 5):** ohne `pass: true`, `positionPct`, `symbols`, passenden `timeframe` wird
  nicht gehandelt (`basisTier.ts:53–73`) — außer Befund 9.
- **Frontend (Frage 8):** Positions- und Trade-Zeilen tragen „Basis", der Champion-Block zeigt Urteil, Korb, Position
  und den Satz „Kein Alpha" (`i18n.ts:591`, `infotips.ts:75–77`) — außer Befund 14.

---

## B. Antworten auf die neun Fragen (kurz)

1. **Echtgeld:** kein neuer Pfad (oben). Offen: die Plattform-Reife zählt alle Trade-Docs (Befund 16).
2. **Ein Entscheidungspfad:** Sizing, Fill, Fenster, Stop und Bars sind ein Pfad; die **Bremsen** sind es nicht
   (Befund 1, 2, 7), das **Buch** nicht (Befund 5), der **Korb** nicht (Befund 12), die Führung beim
   Champion-Wechsel nicht (Befund 4). Umschalten auf `all`: eigene Wurzel, kein Mischen; Kosten Befund 17.
3. **Universum:** REST kennt die 30er-Grenze nicht (Plattform ok); der Dauerprozess reißt sie (Befund 10). SPY beim
   Alpha ⇒ Korb 8 ⇒ 3 statt 4 Berechtigte; zwei Alpha-Symbole ⇒ Stillstand (Befund 12); gepoolte Beförderung nimmt
   alle Korb-ETFs im Top-30 auf einmal (Befund 4).
4. **Schalter:** Default an wirkt sofort für alle (auto ohne Feld, Alt-Schema, ohne Settings); „aus" = Liquidation als
   nie gesperrter Exit, zurückgestellt bis zur Eröffnung; Kennungen idempotent. Kein globaler Schalter (Befund 8).
5. **Champion-Datei:** halbe Blöcke handeln nicht; fremde/fehlende `version` reißt den Champion für alle (Befund 9);
   Räumen = Liquidation (Befund 6).
6. **Neumessung 2/10:** anderes Regelwerk als V2, nicht vorregistriert; Tagesbremse in der Messung aktiv, live tot
   (Befund 1, 2); `pass` true → false ⇒ Zwangsliquidation am nächsten Open, Wiedereinstieg erst im übernächsten
   Fenster (Befund 6).
7. **Kosten:** je Takt ein Voll-Abruf (≈ 1 Anfrage), nachts ≈ 21 Seiten — tragbar (Befund 17).
8. **Frontend:** ja, sichtbar; Ausnahme Befund 14.
9. **§0:** verletzt §0.1 (Befund 1, 2, 4, 5, 12), §0.5 im Geist (Befund 6: Sperre durch Messrauschen, Lösung nur über
   Neu-Messung), §0.9 gedehnt (Basis handelt `noTrade`-Symbole — im Text seit dem Commit benannt, in Ordnung);
   Staffelung unten.

---

## C. Staffelung der Aktivierung (Vorschlag)

0. **Vor der Config-Änderung, Code:** Befund 1 (Bremse), 3 (Stop-only-Order von Hand prüfen), 8 (globaler Schalter),
   9 (Block-Parser). Ohne 1 und 3 misst man weiter etwas, das nicht gehandelt wird, bzw. handelt vielleicht gar nichts.
1. **Nacht 1 — messen, nicht handeln:** Config mit `basisUniverse`, Festkandidat, `adjustment: all`,
   `lookbackDays 2000` (Pflicht), globaler Basis-Schalter **aus** (oder, ohne Befund 8: `settings.auto.basis=false`
   für alle Konten außer dem Pilotkonto per Admin-SDK-Skript, wie `umstieg.mjs --only`). Morgen prüfen:
   `meta/champion.basis` (pass, 9 Symbole, positionPct 20, `configCommit`, Gate-Zahlen gegen V2 — Abweichung heißt:
   Befund 2 ist real), `meta/engineConfig.broker.adjustment = all`, Health `symbolsOk = 30 + 8`, keine Orders.
2. **`pass=false`-Probe:** nicht per Hand in `meta/champion` (das ist die Hintertür); stattdessen der Wächter-Test im
   Repo plus die Beobachtung in Nacht 1, dass ein Block mit `pass` ohne Schalter nichts auslöst.
3. **Ein Konto, ein Fenster:** Pilotkonto an; erstes Fenster 1./2./5. Oktober; Journal, Order-Body (Bracket/OTO),
   Fill-Kurs gegen die IEX-Open-Bar, Positions-Doc mit `stufe`, Stop beim Broker prüfen.
4. **Alle Konten** nach dem ersten vollständigen Fenster mit sauberem Journal — und erst, wenn Befund 6 (Hysterese)
   steht, sonst kann die zweite Nacht sechs Konten liquidieren.

---

## D. Zusammenfassung

| Nr. | Schwere | Befund | Beleg | Vorschlag |
|---|---|---|---|---|
| 1 | K | Tages-Notbremse auf der Plattform bei Tagesbars wirkungslos (dayStartEquity = Equity des 09:30-Takts, decide nur bei neuer Bar); Simulator prüft close-to-close | `check2.test.ts`; `engine.ts:911, 548, 615`; `tick.ts:458–466`; `simulator.ts:446/457/560` | Rollover mit `acc.lastEquity`, `checkHalt` je Takt, Wächter-Test „Gap −5 % ⇒ Halt" |
| 2 | K | V2 (5/30, 2000 d) ≠ Nachtmessung (2/10, 1400 d) ≠ Handel je Nutzer; das ungemessene Regelwerk schaltet scharf | `run.ts:749–755`; `platform.yaml` risk/lookbackDays; `riskDefaults` ungenutzt (grep) | `lookbackDays 2000` Pflicht; V3 vorregistrieren ODER Basis mit registriertem Risiko messen + Befund 1 fixen; Bericht nennt den Risiko-Block |
| 3 | K (bedingt) | Zielose Bracket-Order (nur `stop_loss`) nie gegen Alpaca geprüft; Ablehnung ⇒ Basis handelt still nie | `orders.ts:322–340`; `rest.ts:167–181`; `types.ts:104` (`oto` ungenutzt) | Eine Paper-Order von Hand; bei 422 `orderClass: 'oto'` für `target === null`, Test auf den Order-Body |
| 4 | M | Alpha-Wechsel führt Basis-Positionen mit fremden Regeln (Trailing statt Katastrophen-Stop) | `check1` B; `logic.ts:368–398`; `engine.ts:605–612`; `run.ts:1120–1123` | `pos.strategy ≠ strategy.id` ⇒ ohne Führung / Hold ohne fremde Exits; Test |
| 5 | M | Basis (Rang) nimmt die Plätze vor dem Alpha; Messung allein ≠ Buch gemeinsam | `check1` C; `logic.ts:349–355` | Getrennte Platz-/Exposure-Budgets aus dem Block; oder Regel „Basis nur ohne Alpha" im Code |
| 6 | M | `pass`-Flip/Block-Räumung ⇒ Marktliquidation aller Basis-Positionen, Wiedereinstieg erst im übernächsten Fenster; nie gemessen | `basisTier.ts:57`; `engine.ts:605–612`; `run.ts:1172–1178`; V2 Gate-Margen, T4 | Hysterese für `pass`; gefallenes `pass` sperrt nur Einstiege; Räumen nur mit Freigabe |
| 7 | M | Drawdown-Halt 10 % je Nutzer, Peak intraday/persistent, Resume von Hand ⇒ Einmal-Halt für passive Konten | `logic.ts:27–37`; `limits.ts:55–66`; `engine.ts:548`; V2 MaxDD 6,7 % | Registrierte Resume-Regel zum Monatsfenster oder Basis-eigene DD-Schwelle; Halt-Zählung im Bericht |
| 8 | M | Kein plattformweiter Basis-Schalter (global wird vom Nutzerteil überschrieben), Kill-Switch nur live; „aus" = liquidieren | `config.ts (functions):151`; `brokerZugang.ts:174–177` | UND-Verknüpfung global ∧ Nutzer; Modus „keine neuen Basis-Einstiege" |
| 9 | M | Block mit fremder/fehlender `version` ⇒ Champion für alle weg; im Dauerprozess stirbt jedes CLI-Kommando | `check1` D; `strategyFor.ts:33–36`; `tick.ts:416–422`; `promote.ts:116–119` | Unlesbarer Block ⇒ nur Basis aus + Notiz; `params` ≠ Objekt abfangen |
| 10 | M | `run`: 38 Symbole > IEX-WebSocket-Limit 30 ⇒ Datenstrom tot ⇒ keine Einstiege für Alpha und Basis, still | `engine.ts:353`; `stream.ts:459`; `cli.ts` Diff | Start verweigern bei > 30 mit IEX; BETRIEB.md |
| 11 | M | Korb der Basis umgeht Pool-Prüfung; Wächter sieht Basis-Symbole nicht | `basisTier.ts:97`; `config.ts:489–497`; `wachhund.mjs:59–86` | `basisUniverse ⊆ candidates`; Takt verwirft Fremdsymbole; Wächter prüft `champion.basis.symbols` |
| 12 | M | Korb 8 ⇒ 3 statt 4 Berechtigte, Korb 7 ⇒ Stillstand ohne relativen Exit; Nachzügler-Bar rangiert allein | `check1` A; `regimeAllocation.ts:182/188`; `logic.ts:251`; `crossSectionalMomentum.ts:73` | Nur mit vollem Korb einsteigen; effektive Korbgröße im Spiegel/Bericht; absolute Schwellen |
| 13 | G | Aktivierung in einer Nacht ohne Probe; alter Client schaltet `basis:false` zurück | `optimize.yml`; `autoSettings.ts:192–194, 228` | Staffelung (Abschnitt C); fehlendes Feld beim Speichern = bisheriger Wert |
| 14 | G | `stufe` fehlt bei Zwangsliquidation | `tick.ts:643–646`; `journal.ts:255` | `stufe` in `PositionState` persistieren |
| 15 | G | `positionPct` still durch `maxPositionPct` gedeckelt (Messung und Alt-Nutzer), Notiz sagt 20 % | `sizing.ts:68–72`; `autoSettings.ts:261–262`; `basisTier.ts:71` | Config-Wächter; Notiz mit effektivem Deckel |
| 16 | G | Plattform-Reife (40/14, alle Trade-Docs) ≠ CLAUDE.md-Reife (200/30, Journal); Basis ohne eigene Regel | `liveReadiness.ts:102–108`; `snapshotEquity.ts:346–425` | Owner-Entscheidung vor dem ersten Live-Schlüssel; nur `source: engine` zählen |
| 17 | G | Bereinigte Bars: Voll-Abruf je Takt (≈ 1 Anfrage), nachts ≈ 21 Seiten — tragbar | `backfill.ts:190–227`; `tick.ts:544–555` | keiner |

Kern in einem Satz: Die Stufe handelt die Basis nicht so, wie sie gemessen wurde — nicht wegen des Sizings (das
stimmt), sondern wegen der Bremsen (1, 2, 7), des gemeinsamen Buchs (4, 5), des Korbs (12) und eines
Aus-/Ein-Zyklus, den keine Simulation kennt (6); und ob die Einstiegs-Order beim Broker überhaupt angenommen wird, ist
ungeprüft (3). Nichts davon öffnet Echtgeld; alles davon gehört vor die Aktivierung auf sechs Konten.
