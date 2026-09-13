# Die Stufenbremse erreichte den Optimierer nie — und meine eigene Widerlegung war falsch

**Läufe:** #56 (V3 mit Notbremsen-Bilanz), #57 (V4 ebenso), #58 (V4 nach dem
Basis-Fix), #59 (V4 nach Basis- UND Alpha-Fix) · **Vorregistrierung:**
`vorregistrierung/2026-09-09-basis-allokation-v4.md`

## Kurz

Ich muss eine eigene Aussage von heute Nachmittag zurücknehmen. Ich hatte aus
„V4 reproduziert V3" geschlossen, die Tagesbremse von 2 % sei nicht die
Ursache des Basis-Einbruchs. **Der Schluss war falsch.** V4s Lockerung ist nie
in der Simulation angekommen.

Mit einer Bremse, die tatsächlich greift, **besteht die Basis-Stufe alle vier
Gates ihrer Latte.** Die ursprüngliche V3-Ursachenanalyse war also richtig.

## Wie es sichtbar wurde

Der Bericht wies bis heute nirgends aus, ob eine Notbremse je ausgelöst hat.
Nachdem er es tut, stand der Fehler in einem einzigen Wort:

| Lauf | Config | Notbremsen der Basis |
|---|---|---|
| #56 | V3 (keine `tiers`) | `konto:daily_loss 3×`, erste 2024-08-05 |
| #57 | V4 (`tiers.basis` 5 %/30 %) | **`other`**`:daily_loss 3×`, erste 2024-08-05 |

Dieselben drei Tage, dieselbe Schwelle. Die Stufe heißt `other`, nicht
`basis` — und `grenzenFuer(risk, 'other')` gibt stillschweigend die GLOBALEN
Werte zurück. `risk.tiers.basis` hat die Messung nie erreicht.

## Die Ursache im Code

`WindowSimArgs` kannte kein `stufe`, und `simulateWindow` reichte keines
durch. Der Simulator kann es seit dem 12.09. (`SimInput.strategyFor.stufe`);
der Optimierer hat es nie benutzt. **Die Engine wendete Stufen-Bremsen an, der
Optimierer nicht** — zwei Entscheidungspfade für dieselbe Frage, also genau
das, was §0.1 verbietet.

Behoben in zwei Schritten:

1. Die Basis-Simulation setzt `BASIS_STUFE`.
2. Ohne Angabe gilt `ALPHA_STUFE`. `other` wäre nicht bloß unbestimmt,
   sondern falsch: Sobald irgendeine Stufe eine eigene Bremse trägt, rechnet
   die Konto-Bremse mit der lockersten (`kontoGrenzen`) — eine Position in
   `other` hätte dann gar keinen eigenen Schutz mehr.

Ohne gesetzte `risk.tiers` ändert sich nichts: `grenzenFuer` liefert dann für
jede Stufe die globalen Werte.

## Das Ergebnis der Basis-Stufe (#59)

| Gate | Latte | Wert | |
|---|---|---:|---|
| `basis_net_profit` | > 0 | +6 137,45 (Stress +6 028,55) | ✔ |
| `basis_drawdown` | ≤ 14,29 % | **11,24 %** | ✔ |
| `basis_sharpe` | ≥ 0,65 | **0,81** | ✔ |
| `basis_costs` | ≤ 10 % | 3,3 % | ✔ |

**Basis-Latte: bestanden.** Keine einzige Bremsen-Auslösung mehr. Die zwei
Scheiben, an denen die V3-Auswertung die Ursache festmachte, kehren zurück:

| Scheibe | V2 | V3 | V4 (wirksam) |
|---|---|---|---|
| 10 (Juni–Sept. 2024) | +1 044 $ | +203 $ | **+1 096 $** |
| 13 (Zollcrash 2025) | +712 $ | −750 $ | **+646 $** |

## Erwartung 4 ist widerlegt — der schärfste Wächter des Laufs

Vorregistriert war: „Das ALPHA ändert sich um exakt null — es trägt
unveränderte Bremsen." Es tut es nicht:

| Kandidat | #56 (V3) | #59 (V4) |
|---|---|---|
| `trend_donchian` | +2 542,34 · 9/16 · **5/10** | +2 957,54 · 10/16 · **6/10** |
| `momentum_pullback` | 496 Trades · +2 240,51 | 457 Trades · +1 191,74 |
| `cross_sectional_momentum`, `mean_reversion`, `regime_allocation` | — | zeichengleich |

Die Ursache ist **die Config, nicht der Fix**: `momentum_pullback` ist in #58
(nur Basis-Fix) und #59 (auch Alpha-Fix) identisch und weicht in beiden von
#56 ab. Sobald `risk.tiers` überhaupt gesetzt ist, rechnet die Konto-Bremse
mit der lockersten aller Stufen — der Drawdown-Halt des Kontos steht damit
bei 30 % statt 10 %, auch für das Alpha.

Das ist so gebaut und so dokumentiert (`kontoGrenzen`: „erst wenn selbst die
duldsamste Stufe aufgegeben hätte, steht das ganze Konto still"). Es heißt
aber:

> **Eine Bremse für die Basis ist für das Alpha nicht nebenwirkungsfrei.**

Bei `trend_donchian` verschiebt sie ein Gate (`fold_positive_share`) von rot
auf grün. Kein Kandidat besteht dadurch alle zehn, und `beats_market` fällt
weiter bei allen fünf — aber ein Regelwerk, das die Latte eines Kandidaten
bewegt, ohne dass jemand seine Latte angefasst hat, ist eine
Owner-Entscheidung und keine Messfrage.

## Was daraus folgt — und was ausdrücklich nicht

**Die Basis-Stufe wird NICHT aktiviert.** Die Vorregistrierung sagt es selbst:

> Es ist derselbe Datenzeitraum wie V2 und V3. Ein bestandener V4-Lauf
> bestätigt die Ursachenanalyse, er ist kein neuer Beleg für die Basis. Die
> Falsifikationen mit `--as-of`, die V2 bestanden hat, müssten für V4
> wiederholt werden, bevor irgendjemand aktiviert.

Dazu kommt jetzt die Nebenwirkung auf das Alpha, die vorher niemand kannte.
Vor einer Aktivierung steht damit:

1. Zwei Falsifikationen mit `--as-of` (−15 und −30 Tage), wie V2 sie bestand.
2. Eine Entscheidung des Owners zur Nebenwirkung: Soll eine Basis-Bremse die
   Konto-Bremse des Alpha lockern dürfen? Wenn nein, braucht `tiers.alpha`
   eine ausdrückliche eigene Latte (2 %/10 %), damit sich für das Alpha
   nachweisbar nichts ändert.
3. Eine Prüfer-Runde über beide Fixes.

**Versuchszählung (§4a):** V2, V3, V4 — drei Regelsätze, und V4 in drei
technischen Fassungen (#54/#57 ohne Wirkung, #58 halb, #59 ganz). Die drei
Fassungen zählen als EIN Versuch: Sie unterscheiden sich nicht in einer
gesuchten Größe, sondern darin, ob der Code tat, was die Config sagte.

## Die Lehre

Zwei Fehler, beide aus derselben Wurzel:

1. **Ein Divergenzpunkt in der Zeit identifiziert keine Ursache.** Die
   V3-Auswertung hatte recht — aber nicht, weil ihr Beweis trug, sondern
   zufällig. Derselbe Beweis hätte jede der sieben Abweichungen zwischen V2
   und V3 stützen können.
2. **Meine Widerlegung war schlechter als die These, die sie widerlegte.** Ich
   habe aus „die Zahlen ändern sich nicht" geschlossen, die Ursache sei eine
   andere — ohne zu prüfen, ob die Änderung überhaupt angekommen ist. Ein
   Lauf, der nichts ändert, widerlegt nichts; er sagt zuerst etwas über sich
   selbst.

Beide Male fehlte dieselbe Zahl. Sie steht jetzt im Bericht.
