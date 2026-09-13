# Vorregistrierung: Basis-Allokation V4 — Notbremsen je Stufe

**Datum:** 13.09.2026 · **These:** T5 (Fortsetzung) · **Status vor dem Lauf:** offen
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
