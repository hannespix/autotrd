# Prüfbericht: die Stufen-Fixes (Red-Team, 13.09.2026)

**Geprüft:** `3107808` (Stufe der Basis durchreichen), `4e07b97` (Alpha-Stufe
als Vorgabe), `0bc1c6f` (Notbremsen im Bericht) · **Prüfer:** hat nicht
gebaut, Auftrag war WIDERLEGEN (§6) · **Ergebnis:** zwei kritische Befunde,
vier mittlere, sieben geringe. Zwei davon widerlegen Aussagen, die ich selbst
aufgeschrieben hatte.

## Was behoben ist

| | Befund | Behoben in |
|---|---|---|
| **K1** | `cli.ts backtest` reicht `source` statt `stufe` — jede Position des CLI-Backtests lief als `other`, während dieselbe Wahl in der Engine ihre Stufe trägt. Derselbe §0.1-Bruch, in dem Befehl, den CLAUDE.md §5 als Verifikation nennt. Der Prüfer hat **3 877 $ Unterschied** im selben Lauf gemessen. TypeScript meldet es nie: `stufe` ist optional. | `src/app.ts` — `EngineStrategyChoice` trägt `stufe`, `strategyForFn` setzt es. Wächter: `test/app/basisWahl.test.ts` |
| **K2** | Die Notbremsen-Bilanz verschweigt die Eskalation `daily_loss ⇒ drawdown`. Belegt: Ein Lauf endet tot in einem Drawdown-Halt, die Bilanz meldet `{"konto:daily_loss": 2}` und kein `konto:drawdown`. Der Drawdown ist gerade der, der ohne `resume` nie endet — dieselbe fehlende Zahl, gegen die die Bilanz gebaut wurde. | `src/backtest/simulator.ts` — Flanke auch bei Grundwechsel. Wächter: `test/backtest/bremsenZaehlen.test.ts` |
| **M3** | Der Ensemble-Pfad hatte dasselbe Loch, 55 Zeilen unter dem gefixten: `Wahl` kannte kein `stufe`, `simulateKorbWindow` reichte nichts durch. Derselbe Parametersatz mass über `simulateWindow` als `alpha`, über das Ensemble als `other`. | `src/optimize/walkForward.ts` — `Wahl.stufe`, Vorgabe `ALPHA_STUFE`. Wächter: `test/optimize/basisStufe.test.ts` |

Alle drei Fixes wurden absichtlich gebrochen; jeder wurde rot, K2 mit genau
der Ausgabe des Prüfers (`['konto:daily_loss']` ohne `konto:drawdown`).

## Was korrigiert ist, weil ICH falsch lag

**M1 — meine Begründung für `ALPHA_STUFE` war sachlich falsch.**

Ich hatte geschrieben, eine Position in `other` bekomme „keine eigene
Stufenlatte" und verliere ihren Schutz, sobald eine Basis-Bremse gesetzt ist.
Der Prüfer widerlegt das aus dem Code: `STUFEN` enthält `other`, `logic.ts`
nimmt es in die Prüfung auf, `grenzenFuer(risk, 'other')` liefert die
globalen Werte. **Ein Wächter sagte es seit Tagen** —
`test/core/stufenbremse.test.ts`: „eine Position OHNE Stufe hängt an der
globalen Latte, nicht an der lockeren".

Empirisch, drei Welten, dieselben Bars:

| Welt | Trades | Netto | MaxDD | Bilanz |
|---|---:|---:|---:|---|
| ohne `tiers` | 1 | −11 474,00 | 11,47 % | `konto:drawdown 1×` |
| `tiers` + Stufe `other` | 1 | −11 474,00 | 11,47 % | `other:drawdown 1×` |
| `tiers` + Stufe `alpha` | 1 | −11 474,00 | 11,47 % | `alpha:drawdown 1×` |

Ziffernidentisch. Nur das Etikett unterscheidet sich.

**Folgen:** Der Fix bleibt richtig (Namensgleichheit mit `stufeOf('champion')`;
eine künftige `tiers.alpha`-Latte wäre als `other` wirkungslos — ohne
Fehlermeldung). Aber die **Alpha-Verschiebung zwischen #56 und #58/#59 ist
ungeklärt**, und die Owner-Frage, die ich daraus abgeleitet hatte, stand auf
einer falschen Diagnose. Verdacht des Prüfers: nicht die Latte, sondern der
PFAD — die Konto-Bremse kehrt früh aus `decide()` zurück, die Stufen-Bremse
durchläuft die Symbolschleife mit `schonExit`.

**M2 — „dreimal unter dem Regelwerk der Plattform bestätigt" ist falsch.**
`config/platform.yaml` setzt keine `tiers`. Die bestandene Latte gilt für ein
VORGESCHLAGENES Regelwerk, das es in der Produktion nicht gibt; der einzige
Lauf unter dem echten war V3 — gescheitert. Vor einer Aktivierung muss
`risk.tiers.basis` in `platform.yaml` und `meta/engineConfig`.

**M4 — #60/#61 sind keine unabhängigen Falsifikationen.** Die Fold-Kette ist
an `dataEnd − holdout` verankert und wächst rückwärts; ein Stichtag 15 oder
30 Tage früher verschiebt sie, die Überlappung mit #59 liegt über 90 %.
„Zeichengenau dieselben Zahlen" ist bei praktisch denselben Daten das
ERWARTETE Ergebnis und belegt Determinismus, nicht Robustheit.

Alle drei sind in `analysen/2026-09-13-basis-stufenbremse-erreichte-den-optimierer-nie.md`
und `befunde.md` korrigiert, M1 zusätzlich im Kommentar von
`src/risk/limits.ts` und im Testkommentar.

## Was der Prüfer bestätigt hat

- **A** „ohne `risk.tiers` ändert der Fix nichts" — bestätigt für Kern und
  Optimierer (`stufenBremsenAktiv` falsch ⇒ Schritt 1b übersprungen).
- **B** „jeder gesuchte Kandidat ist ein Alpha-Kandidat" — bestätigt für
  `simulateWindow`; als allgemeine Regel widerlegt (M3, und `stufeOf('config')`
  ⇒ `other` für die Fallback-Strategie der Engine).
- **C** „reine Diagnose, kausal, beeinflusst nichts" — bestätigt (kein Gate
  liest sie, gezählt wird nach `decide()`).
- **E** `kontoGrenzen` und §0.4/§0.5 — bestätigt: Einstiege werden gesperrt,
  nie Exits; kein Pfad hebt einen stehenden Halt per Config auf.
- **F** die Wächter — acht absichtliche Brüche, acht rot.

## Offene Befunde (nicht behoben, festgehalten)

- **G1** `bremsenZeile` druckt den Vorbehalt „Untergrenze, jeder Fold beginnt
  neu" auch unter dem Basis-Block — dort ist es EINE durchgehende Simulation
  und die Zahl exakt. Zusätzlich ist „Untergrenze" nicht immer wahr: zwei
  benachbarte Folds können denselben durchgehenden Halt je einmal auslösen.
- **G2** Stress-Lauf (×1,5) und Holdout der Basis tragen keine Bilanz, obwohl
  `basis_net_profit` den Stress-Netto verlangt.
- **G3** Nur die OOS-Kette wird bilanziert; eine Bremse, die im IS die
  Parameterwahl geformt hat, erscheint nirgends.
- **G4** `erste`/`letzte` sind global über alle Schlüssel — bei mehreren
  Auslösern kann ein Leser die Zeitspanne dem falschen zuordnen. Genau die
  Zuordnung, an der die V3-Auswertung gescheitert ist.
- **G5** `tiers.*.maxDrawdownPct: 0` plus lockere Schwesterstufe nimmt den
  Schutz wirklich: belegt mit 15,35 % Drawdown und **keiner** Auslösung, und
  der Bericht druckt dann „keine einzige Auslösung" — formal wahr, als
  Auskunft irreführend. V4 benutzt `null`, nicht `0`.
- **G6** `stufeOf('config') = other`: Engine und Optimierer weichen für die
  Fallback-Strategie auseinander (latent, nur mit `allowWithoutChampion`).
- **G7** Der Basis-Korb ist fest und rückwärts angewandt — die ausdrückliche
  Ausnahme von §0.2. Vorregistriert und begründbar, gehört aber wie §5a.13 als
  „bekannt, in Richtung optimistisch" in jede Auswertung.

## Die Lehre, zum zweiten Mal an einem Tag

Drei meiner Wächter griffen zunächst nicht, weil sie eine Ebene zu hoch
ansetzten. Der Prüfer hat denselben Fehler in meiner Argumentation gefunden:
Ich habe aus „die Zahlen ändern sich" auf eine Ursache geschlossen, ohne die
Alternative zu messen — obwohl ein Wächter im selben Repo die Antwort schon
enthielt. Ein Divergenzpunkt identifiziert keine Ursache; eine plausible
Erklärung auch nicht.
