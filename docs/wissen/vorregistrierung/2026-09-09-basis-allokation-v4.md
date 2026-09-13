# Vorregistrierung: Basis-Allokation V4 — Notbremsen je Stufe

**Datum:** 13.09.2026 · **These:** T5 (Fortsetzung) · **Status vor dem Lauf:** offen
**Status nach dem Stufen-Fix (Lauf #59):** **BESTANDEN** — alle vier Gates
(Netto +6 137,45 · Drawdown je Exposure 11,24 % gegen 14,29 % · Sharpe 0,81
gegen 0,65 · Kosten 3,3 %). Erwartung 4 ist widerlegt: Eine Basis-Bremse
lockert über `kontoGrenzen` die Konto-Bremse des Alpha. **Trotzdem keine
Aktivierung** — siehe `analysen/2026-09-13-basis-stufenbremse-erreichte-den-optimierer-nie.md`.

**Status nach den Läufen #54 und #55 (überholt, siehe oben):** nicht bestanden. Erwartungen 2 und 3
widerlegt. Weder Notbremsen je Stufe noch der Positionsdeckel erklären den
Einbruch gegenüber V2 — V5 ist im Basis-Block zeichengleich mit V4. Die
V3-Ursachenanalyse ist damit widerlegt und die Owner-Frage vom 10.09.
gegenstandslos, solange die Ursache offen ist. Auswertung:
`analysen/2026-09-13-basis-v4-v5-ursache-nicht-die-bremse.md`.
**Folgt auf:** `2026-09-09-basis-allokation-v3.md` (nicht bestanden, #40/#41)

## Was V3 ergeben hat und warum das hier steht

V3 hat die Basis unter dem Regelwerk der Plattform gemessen (Notbremsen 2 %
Tagesverlust / 10 % Drawdown) und zwei Gates verfehlt:

| Gate | V2 (#37, Bremsen 5 %/30 %) | V3 (#40, Bremsen 2 %/10 %) | Latte | Urteil V3 |
|---|---|---|---|---|
| `basis_net_profit` | +5 953 $ | +3 123 $ | > 0 | ✔ |
| `basis_drawdown` | 12,06 % | **15,95 %** | 15,48 % | ✘ knapp |
| `basis_sharpe` | 0,79 | **0,48** | 0,61 | ✘ |
| `basis_costs` | 3,3 % | 7,2 % | ≤ 10 % | ✔ |

Die Ursache ist belegt und nicht vermutet: Die 90-Tage-Scheiben sind bis Juni
2024 **auf den Cent identisch** mit V2; erst danach laufen sie auseinander
(Scheibe 10: +203 $ statt +1 044 $; Scheibe 13, Zollcrash: **−750 $ statt
+712 $**). Das ist die Signatur der Tagesbremse: Ein Buchtag unter −2 %
stellt alles glatt, der Wiedereinstieg kommt erst im nächsten
Monatsfenster, die Erholung wird verpasst.

Die Bremse **verschlechtert** dabei genau die Größe, die sie schützen soll:
Drawdown je Einheit Exposure 15,95 % statt 12,06 %. Sie schreibt Verluste
fest und lässt Erholungen aus.

## Was hier gemessen wird — und was ausdrücklich NICHT

Das V3-Dokument nennt zwei Wege und sagt, die Wahl sei eine
**Owner-Entscheidung, keine Messfrage**:

> (a) Regelwerk behalten ⇒ die Basis ist auf dieser Plattform nicht
> einsetzbar; (b) Bremsen je Stufe (für die Basis: Tagesverlust sperrt nur
> Einstiege, oder Schwelle 5 %; Drawdown-Halt mit `resume` zum nächsten
> Fenster).

Dieser Lauf **misst (b)**, Variante „Schwelle 5 %". Er

- aktiviert nichts,
- ändert `config/platform.yaml` nicht,
- befördert nichts,
- fasst keine Gate-Schwelle der Gruppe `basis` an.

Sein einziger Zweck ist, dass die Entscheidung des Owners Zahlen hat statt
Vermutungen. **Die Entscheidung selbst bleibt seine.** Nimmt die Basis ihre
Latte auch mit eigenen Bremsen nicht, wird sie nicht aktiviert — das
Argument „eine Monatsallokation braucht eine andere Bremse als ein
Intraday-Signal" ist ein Argument, kein Freibrief.

## Die Änderung

`risk.tiers.basis: {maxDailyLossPct: 5, maxDrawdownPct: 30}`. Der Code-Pfad
je Stufe existiert bereits (`src/risk/limits.ts`, `grenzenFuer`,
`EngineState.stufenHalt`) und steht per Vorgabe auf `null` — also auf „der
globale Wert gilt".

`risk.tiers.alpha` bleibt auf `null`: Das Alpha trägt weiter die 2 %/10 % der
Plattform. Zwei Änderungen zugleich zu messen war der Fehler in Lauf #46.

Die globalen Werte `maxDailyLossPct: 2` / `maxDrawdownPct: 10` bleiben
stehen. Sie gelten für alles ohne Stufe; ein Stufenwert übersteuert nur seine
eigene Stufe.

**Woher 5 und 30 kommen:** Es sind die Werte aus V2 (#37), unter denen die
Basis ihre Latte genommen hat. Sie sind nicht gesucht und werden in diesem
Lauf nicht variiert. Wer sie variiert, zählt die Versuche.

## Messlauf

Config: `config/basis-1440-v4.yaml` — Zeichen für Zeichen
`config/basis-1440-v3.yaml` mit genau zwei Unterschieden: dem Block
`risk.tiers` oben und `paths.home`. Derselbe Fold-Plan, dieselben Kosten,
dieselbe Latte (der liegengelassene Korb), derselbe Basis-Korb, dieselben
Parameter des Festkandidaten, dieselben Bremsen für das Alpha.

## Was ich VOR dem Lauf erwarte

| # | Erwartung | widerlegt, wenn |
|---|---|---|
| 1 | Die Scheiben 1–9 (bis Juni 2024) sind auf den Cent identisch mit V3 **und** V2 — dort hat keine Bremse ausgelöst | sie unterscheiden sich; dann wirkt die Änderung irgendwo, wo sie nichts zu suchen hat |
| 2 | Die Scheiben 10 und 13 kehren auf die V2-Werte zurück (+1 044 $ und +712 $) | sie tun es nicht; dann war die Tagesbremse nicht die alleinige Ursache |
| 3 | `basis_drawdown` und `basis_sharpe` erreichen wieder die V2-Werte (12,06 % und 0,79) und bestehen | sie bleiben unter der Latte |
| 4 | Das ALPHA ändert sich um exakt null — es trägt unveränderte Bremsen | es ändert sich; dann übersteuert ein Stufenwert mehr als seine Stufe |
| 5 | **Die Basis besteht nicht plötzlich Gates, die sie in V2 verfehlt hat** | sie besteht mehr als in V2 — dann ist zu prüfen, ob die Stufen-Bremse mehr tut als die globale zurückzunehmen |

**Erwartung 4 ist der schärfste Wächter dieses Laufs**: Er prüft, ob
`grenzenFuer` wirklich nur die eigene Stufe betrifft. Ein Stufenwert, der
auch auf das Alpha durchschlägt, wäre ein Fehler im Risikopfad — und der
wäre schwerer als jedes Ergebnis dieses Laufs.

**Erwartung 5 ist der Selbstzweifel.** V4 soll V2 reproduzieren, nicht
übertreffen. Die Stufen-Bremse nimmt eine Verschärfung zurück; mehr als V2
darf dabei nicht herauskommen.

## Bekannte Schwächen

- **Es ist derselbe Datenzeitraum wie V2 und V3.** Ein bestandener V4-Lauf
  bestätigt die Ursachenanalyse, er ist kein neuer Beleg für die Basis. Die
  Falsifikationen mit `--as-of`, die V2 bestanden hat, müssten für V4
  wiederholt werden, bevor irgendjemand aktiviert.
- **Eine weitere Bremse bleibt scharf, die V2 nie hatte:** der Kill-Switch
  und die Nutzer-Kommandos. Das ist kein Nachteil, aber es heißt, dass das
  Konto nicht ungeschützt ist, wenn die Stufenbremse weiter steht.
- **5 % Tagesverlust auf eine Stufe mit 20 % Allokation** heißt, dass ein
  Tag mit −25 % im gehaltenen Papier die Stufe glattstellt. Das ist eine
  bewusste Wahl und keine Abschaffung der Bremse.
- Die Wahl zwischen „Schwelle 5 %" und „Tagesverlust sperrt nur Einstiege"
  (die zweite Variante aus V3) ist **nicht** gemessen. Wer sie messen will,
  registriert sie vorher und zählt sie als zweiten Versuch.


---

## Ergebnis V4 (Lauf #54) — und der Nachtrag zu V5, VOR seinem Lauf

**V4 hat die Latte nicht genommen, und wichtiger: die Ursachenanalyse aus V3
ist widerlegt.**

| Gate | V2 (#37) | V3 (#40) | **V4 (#54)** | Latte V4 |
|---|---|---|---:|---|
| `basis_net_profit` | +5 953 $ | +3 123 $ | **+3 298 $** | > 0 ✔ |
| `basis_drawdown` | 12,06 % | 15,95 % | **15,99 %** | 14,29 % ✘ |
| `basis_sharpe` | 0,79 | 0,48 | **0,51** | 0,65 ✘ |
| `basis_costs` | 3,3 % | 7,2 % | **6,9 %** | ≤ 10 % ✔ |

Die beiden Scheiben, die die V3-Auswertung namentlich als Beweis der
Tagesbremse führte:

| Scheibe | V2 | V3 | **V4 (Bremsen wie V2)** |
|---|---|---|---|
| 10 (Juni–Sept. 2024) | +1 044 $ | +203 $ | **+251,96 $** |
| 13 (März–Juni 2025, Zollcrash) | +712 $ | −750 $ | **−807,63 $** |

**V4 reproduziert V3, nicht V2** — obwohl die Bremsen der Basis auf den
V2-Werten stehen (5 % / 30 %). Erwartungen 2 und 3 sind widerlegt.

### Warum die V3-Zuordnung falsch war

V3 schloss aus „die Scheiben 1–9 sind auf den Cent identisch mit V2, danach
laufen sie auseinander" auf die Tagesbremse. Der Schluss ist ungültig: Er
zeigt nur, dass *irgendein* Unterschied erstmals im August 2024 biss. Ein
Blick in die Configs zeigt, dass V2 und V3 sich in weit mehr unterscheiden
als in den Bremsen:

| | V2 | V3 / V4 |
|---|---|---|
| `riskPerTradePct` | 4 | 0,5 |
| `maxPositionPct` | **25** | **20** |
| Sizing-Semantik der Basis | Risiko-Budget (4 % / 20 % Stop = 20 %) | Allokation (`optimizer.basis.positionPct: 20`) |
| `maxDailyLossPct` / `maxDrawdownPct` | 5 / 30 | 2 / 10 |
| `universe.symbols` / `maxSymbols` | die 9 Basis-ETFs / 9 | die 30 Aktien / 30 |
| `foldMembership` | fixed | point_in_time |
| `optimizer.strategies` | nur `regime_allocation` | alle fünf |

Das ist der eigentliche Befund dieses Laufs, und er ist unangenehm: **Die
Entscheidung, die seit dem 10.09. beim Owner liegt („Bremsen je Stufe, ja
oder nein?"), stand auf einer falschen Prämisse.** Weder (a) noch (b) hätte
die Basis über ihre Latte gebracht.

### V5: die nächste Isolierung

Der einzige verbliebene Unterschied, der die Basis **mechanisch** treffen
kann, ist der Positionsdeckel. Die Basis zielt auf 20 % je Position; steht
`maxPositionPct` exakt auf 20, bindet der Deckel die Zielallokation
permanent, steht er auf 25 (wie in V2), hat sie Luft. Universum,
`foldMembership` und `optimizer.strategies` betreffen das Alpha, nicht die
Basis (sie handelt `optimizer.basisUniverse` in einer eigenen durchgehenden
Simulation). `riskPerTradePct` ist bei Allokations-Sizing ohne Wirkung.

Config: `config/basis-1440-v5.yaml` — **genau eine** Änderung gegenüber V4:
`maxPositionPct` von 20 auf 25.

| Ausgang | Lesart |
|---|---|
| V5 kehrt auf die V2-Zahlen zurück (Scheibe 10 ≈ +1 044, Scheibe 13 ≈ +712, `basis_drawdown` ≈ 12 %) | Der Positionsdeckel war die Ursache. Dann ist die offene Owner-Frage nicht „Bremsen je Stufe", sondern „darf die Basis-Stufe einen Positionsdeckel über ihrer Zielallokation haben?" — eine andere Frage mit anderer Risikowirkung. |
| V5 bleibt bei den V4-Zahlen | Auch der Deckel ist es nicht. Dann liegt der Unterschied in der Sizing-SEMANTIK selbst (Risiko-Budget gegen Allokation), und die beiden sind trotz gleicher Zielgröße nicht dasselbe — das wäre ein Befund über `decide()`, kein Regelwerksthema. |

**Versuchszählung (§4a): Das ist der vierte gemessene Regelsatz für dieselbe
Basis** — V2, V3, V4, V5. Wer ein Ergebnis dieser Reihe liest, liest es mit
vier Freiheitsgraden im Rücken. Ein bestandener V5-Lauf ist deshalb
ausdrücklich **kein** Aktivierungsgrund, sondern eine Ursachenklärung; jede
Aktivierung braucht danach Falsifikationen mit `--as-of` und die
Entscheidung des Owners zur dann richtigen Frage.
