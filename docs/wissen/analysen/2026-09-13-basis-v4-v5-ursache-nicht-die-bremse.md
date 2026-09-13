# Basis-Stufe: die Tagesbremse war nicht die Ursache — und der Positionsdeckel auch nicht

**Läufe:** #54 (`basis-1440-v4`, Notbremsen je Stufe 5 %/30 %) und #55
(`basis-1440-v5`, zusätzlich Positionsdeckel 25 statt 20) gegen **#40** (V3)
und **#37** (V2) · **Vorregistrierung:**
`vorregistrierung/2026-09-09-basis-allokation-v4.md` samt Nachtrag

## Kurz

Die Entscheidung, die seit dem 10.09.2026 beim Owner liegt — „Regelwerk
behalten oder Bremsen je Stufe?" — **stand auf einer falschen Prämisse.**
Keiner der beiden Wege hätte die Basis über ihre Latte gebracht.

Zwei Ursachen sind jetzt ausgeschlossen, zwei stehen noch offen. Bis die
echte Ursache feststeht, ist die Frage nach den Bremsen nicht zu
beantworten — und es gibt nichts zu entscheiden.

## Was gemessen wurde

| Gate | V2 (#37) | V3 (#40) | V4 (#54) | V5 (#55) | Latte V4/V5 |
|---|---|---|---:|---:|---|
| `basis_net_profit` | +5 953 $ | +3 123 $ | **+3 298 $** | **+3 298 $** | > 0 ✔ |
| `basis_drawdown` | 12,06 % | 15,95 % | **15,99 %** | **15,99 %** | 14,29 % ✘ |
| `basis_sharpe` | 0,79 | 0,48 | **0,51** | **0,51** | 0,65 ✘ |
| `basis_costs` | 3,3 % | 7,2 % | **6,9 %** | **6,9 %** | ≤ 10 % ✔ |

Die zwei Scheiben, die die V3-Auswertung als Beweis der Tagesbremse führte:

| Scheibe | V2 | V3 | V4 | V5 |
|---|---|---|---|---|
| 10 (Juni–Sept. 2024) | +1 044 $ | +203 $ | **+251,96 $** | **+251,96 $** |
| 13 (März–Juni 2025, Zollcrash) | +712 $ | −750 $ | **−807,63 $** | **−807,63 $** |

**V5 ist im ganzen Basis-Block zeichengleich mit V4.** Der Positionsdeckel
hat buchstäblich nichts verändert — er war nie der bindende Faktor.

## Der Fehler in der V3-Auswertung

V3 schloss aus „die Scheiben 1–9 sind auf den Cent identisch mit V2, danach
laufen sie auseinander" auf die Tagesbremse von 2 %.

Der Schluss ist ungültig. Er zeigt nur, dass **irgendein** Unterschied
erstmals im August 2024 biss — und V2 und V3 unterscheiden sich in weit mehr
als in den Bremsen:

| | V2 | V3 / V4 / V5 |
|---|---|---|
| `riskPerTradePct` | 4 | 0,5 |
| `maxPositionPct` | 25 | 20 (V5: 25) |
| Sizing-Semantik der Basis | **Risiko-Budget** (4 % / 20 % Stop) | **Allokation** (`optimizer.basis.positionPct: 20`) |
| `maxDailyLossPct` / `maxDrawdownPct` | 5 / 30 | 2 / 10 (V4/V5: Stufe 5 / 30) |
| `universe.symbols` / `maxSymbols` | die 9 Basis-ETFs / 9 | die 30 Aktien / 30 |
| `optimizer.basisUniverse` | fehlt (das Universum IST der Basis-Korb) | die 9 Basis-ETFs |
| `foldMembership` | `fixed` | `point_in_time` |
| `optimizer.strategies` | nur `regime_allocation` | alle fünf |

Das ist die Lehre, und sie ist allgemeiner als dieser Fall: **Ein
Divergenzpunkt in der Zeit identifiziert keine Ursache.** Er grenzt nur den
Zeitpunkt ein, an dem die erste von mehreren Abweichungen zu wirken begann.
Wer daraus eine Ursache liest, hat geraten und es Analyse genannt.

## Was jetzt noch offen ist

Ausgeschlossen: **Notbremsen** (V4) und **Positionsdeckel** (V5).

Offen, in der Reihenfolge ihrer Plausibilität:

1. **Die Sizing-Semantik selbst.** V2 rechnete Risiko-Budget (4 % Risiko bei
   20 % Stop-Distanz = 20 % der Equity), V3+ rechnen Allokation (20 % der
   Equity). Beide zielen auf dieselben 20 % — aber V2 machte 37 Trades, V3+
   machen 43. Sechs Trades Unterschied bei gleicher Zielgröße heißt, dass die
   Wege sich nicht nur im Namen unterscheiden.
2. **`foldMembership: fixed` gegen `point_in_time`.** Der Basis-Korb sind in
   beiden Fällen dieselben neun ETFs — aber im Punkt-in-Zeit-Modus läuft er
   durch `waehleUniverse` mit deren Liquiditätsfiltern
   (`minDollarVolumen: 2 Mio. $/Tag`). Ein dünnes Mitglied wie XLRE oder EEM
   kann in einzelnen Ständen herausfallen. Dann handelt die Basis in manchen
   Folds acht statt neun Symbole — und das steht in keinem Bericht.

Punkt 2 wäre der unangenehmere Fund: eine stille Korbschrumpfung, die
niemand sieht. Er ist mit einem Lauf prüfbar (`foldMembership: fixed` bei
sonst gleicher V5-Config) und sollte vor Punkt 1 geprüft werden, weil er
eine Fehlfunktion wäre und nicht nur ein Designunterschied.

## Was daraus folgt

- **Task „Basis-Stufe aktivieren" bleibt blockiert**, aber aus einem anderen
  Grund als bisher: nicht wegen einer offenen Owner-Entscheidung, sondern
  weil die Ursache des V3-Einbruchs unbekannt ist.
- **Die Owner-Frage vom 10.09. ist gegenstandslos**, solange die Ursache
  nicht feststeht. Sie neu zu stellen, bevor sie beantwortbar ist, wäre
  dasselbe Raten in einer anderen Runde.
- `config/platform.yaml` bleibt unberührt. Es wurde nichts aktiviert und
  nichts befördert.

## Versuchszählung (§4a)

Das sind **vier gemessene Regelsätze für dieselbe Basis** — V2, V3, V4, V5 —
auf demselben Datenzeitraum. Wer ein Ergebnis dieser Reihe liest, liest es
mit vier Freiheitsgraden im Rücken. Ein künftiger Lauf, der die Latte nimmt,
ist deshalb ausdrücklich **kein** Aktivierungsgrund, sondern eine
Ursachenklärung; jede Aktivierung braucht danach Falsifikationen mit
`--as-of`, wie V2 sie bestanden hat.
