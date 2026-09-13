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
#56 ab.

> ### ⚠ Korrektur (Prüferbefund M1, 13.09.2026 abends)
>
> Die erste Fassung dieses Abschnitts erklärte die Verschiebung damit, dass
> `kontoGrenzen` den Drawdown-Halt auf 30 % stellt und `other` „keine eigene
> Stufenlatte" habe. **Das ist falsch.** `STUFEN` enthält `other`, `logic.ts`
> nimmt es in die Prüfung auf, und `grenzenFuer(risk, 'other')` liefert die
> globalen Werte — `other` ist geschützt, nur eben immer global. Ein
> bestehender Wächter sagt es seit Tagen:
> `test/core/stufenbremse.test.ts` — „eine Position OHNE Stufe hängt an der
> globalen Latte, nicht an der lockeren".
>
> Der Prüfer hat drei Welten (ohne `tiers` · mit Stufe `other` · mit Stufe
> `alpha`) **ziffernidentisch** gemessen — 1 Trade, −11 474,00, MaxDD
> 11,47 % — nur das Etikett der Bremse unterschied sich.
>
> **Damit ist die Alpha-Verschiebung ungeklärt**, und die Owner-Frage
> darunter stand auf einer falschen Diagnose. Verdacht des Prüfers: nicht die
> Latte, sondern der PFAD — die Konto-Bremse kehrt früh aus `decide()` zurück
> (`logic.ts`), die Stufen-Bremse durchläuft die Symbolschleife mit
> `schonExit`. Das ist zu messen, bevor jemand entscheidet.
>
> ### ⚠⚠ Nachtrag (13.09.2026 nachts): gemessen — die Ursache ist KEINE von beiden
>
> Der Pfad-Verdacht ist widerlegt (120 synthetische Szenarien, drei
> Strategien, variierte Crash-Zeitpunkte und Latten: kein einziges
> Gegenbeispiel — ohne `tiers` und mit `tiers.basis 5/30` messen
> ziffernidentisch). Die Ursache liegt nicht im Handelskern:
>
> **Die beiden Läufe haben nie dieselben Daten gesehen.** #56 lief ab
> 2021-03-22, #58/#59 ab 2021-03-24 — der Cache-Schlüssel der Workflows
> hashte die ganze Config-Datei, also bekam jede Config ihren eigenen
> Bars-Cache. Zwei Warmup-Bars weniger im frühesten Fold, andere gewählte
> Parameter dort, und über die Hysterese des Punkt-in-Zeit-Korbs bis in
> Fold 10. `momentum_pullback` — der Kandidat, der sich am stärksten bewegt
> — hat in KEINEM der beiden Läufe je eine Bremse ausgelöst.
>
> Vollständig: `2026-09-13-alpha-verschiebung-war-der-bars-cache.md`.
> Was das für die Aussagen dieses Dokuments bedeutet, steht dort unter
> „Was das zurücknimmt" — kurz: **Erwartung 4 ist weder bestätigt noch
> widerlegt**, und die Höhe der Basis-Verbesserung braucht eine Neumessung
> auf gemeinsamem Cache. Dass die Bremse abgestellt wurde, bleibt belegt.
>
> Es ist dieselbe Fehlerklasse, die weiter unten unter „Die Lehre" steht —
> diesmal von mir, im selben Text.

~~Was bleibt: `trend_donchian` verschiebt ein Gate (`fold_positive_share`) von
rot auf grün, wenn `risk.tiers` gesetzt ist.~~ **Falsch — `risk.tiers` hat
damit nichts zu tun** (siehe Nachtrag oben): Der Kandidat bewegt sich, weil
die beiden Läufe verschiedene Daten gesehen haben. Was unverändert gilt: Kein
Kandidat besteht alle zehn Gates, und `beats_market` fällt bei allen fünf.

## Was daraus folgt — und was ausdrücklich nicht

**Die Basis-Stufe wird NICHT aktiviert.** Die Vorregistrierung sagt es selbst:

> Es ist derselbe Datenzeitraum wie V2 und V3. Ein bestandener V4-Lauf
> bestätigt die Ursachenanalyse, er ist kein neuer Beleg für die Basis. Die
> Falsifikationen mit `--as-of`, die V2 bestanden hat, müssten für V4
> wiederholt werden, bevor irgendjemand aktiviert.

Dazu kommt jetzt die Nebenwirkung auf das Alpha, die vorher niemand kannte.
Vor einer Aktivierung steht damit:

1. ~~Zwei Falsifikationen mit `--as-of` (−15 und −30 Tage), wie V2 sie
   bestand.~~ **Erledigt am 13.09.2026 (#60, #61) — beide bestanden:**

   | Stichtag | Netto | Drawdown/Exposure | Latte | Sharpe | Latte | V2 |
   |---|---:|---:|---:|---:|---:|---|
   | 2026-08-25 | +7 705,84 | 12,24 % | 15,55 % | **1,01** | 0,75 | #38: 1,01 / 12,2 % |
   | 2026-08-10 | +7 186,30 | 12,44 % | 15,61 % | **0,96** | 0,71 | #39: 0,96 / 12,4 % |

   Zeichengenau dieselben Zahlen wie V2 unter dem alten Regelwerk, in keinem
   Lauf eine Bremsen-Auslösung.

   **Einschränkung (Prüferbefund M4):** Das sind KEINE unabhängigen Belege.
   Alle Folds sind an `selectionEnd = dataEnd − holdout` verankert und wachsen
   rückwärts (`walkForward.ts`, `buildFolds`); ein Stichtag 15 oder 30 Tage
   früher verschiebt die ganze Kette, die Überlappung mit #59 liegt deutlich
   über 90 %. „Zeichengenau dieselben Zahlen" ist bei praktisch denselben
   Daten das ERWARTETE Ergebnis und belegt Determinismus, nicht Robustheit.
   „Dreimal dasselbe Urteil" suggeriert drei Belege, wo einer steht.
2. ~~**Die Ursache der Alpha-Verschiebung finden.**~~ **Erledigt
   (13.09.2026 nachts): Es war der Bars-Cache, nicht die Bremse.** Die
   Owner-Frage („darf eine Basis-Bremse die Konto-Bremse des Alpha
   lockern?") ist damit endgültig gegenstandslos — es gibt keine gemessene
   Nebenwirkung auf das Alpha. An ihre Stelle tritt eine Pflicht, keine
   Frage: **V3 und V4 neu messen, jetzt auf gemeinsamem Cache**, damit das
   Urteil über die Basis auf einem Vergleich mit EINER Änderung steht.
3. **`risk.tiers.basis` gehört in `config/platform.yaml`** (Prüferbefund M2).
   Die bestandene Latte gilt für ein VORGESCHLAGENES Regelwerk; die Produktion
   setzt keine `tiers` und hat damit weiter 2 %/10 % — der einzige Lauf unter
   dem echten Regelwerk der Plattform war V3, und der ist gescheitert.
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
