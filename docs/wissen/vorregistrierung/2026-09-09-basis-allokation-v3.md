# Vorregistrierung V3 — Basis-Allokation unter dem Regelwerk der Plattform

Geschrieben am 09.09.2026 nachts, **vor** dem Lauf, nach V2 (dreimal
bestanden) und dem Prüfer-Befund zur Basis-Stufe
(`../pruefungen/2026-09-09-redteam-basis-stufe.md`). Kern des Befunds 2:
V2 bestand mit **drei Regelwerken** — gemessen mit Notbremsen 5 %/30 % und
2000 Tagen, nachts würde die Plattform mit 2 %/10 % und 1400 Tagen neu
messen, gehandelt würde je Nutzer mit dessen Bremsen. Was scharf schaltet,
muss gemessen sein. V3 misst deshalb die Basis mit **genau der Config, mit
der sie aktiviert würde.**

## Was gleich bleibt

Hypothese T5, Strategie und Parameter (`regime_allocation` 126/21/150/
0,4/0,6/20), die neun ETFs nach GTAA-Regel, die vier Gates der Gruppe
`basis` mit unveränderten Schwellen (im Code: `optimizer.basis`), die
durchgehende Simulation, der liegengelassene Korb als Maßstab, Position =
`positionPct 20` der Equity (Sizing `allocation`, seit der Basis-Stufe im
Code — im Simulator und im Takt derselbe Pfad), ausschüttungsbereinigte
Tagesbars, zwei Falsifikationsläufe mit Stichtag −15 und −30 Tage.

## Was V3 ändert — je mit Befund

| Befund | V3 |
|---|---|
| Stufe-Befund 2: drei Regelwerke | Config `config/basis-1440-v3.yaml` = `config/platform.yaml` plus die Aktivierungseinträge (Bereinigung, 2000 Tage, Festkandidat, Basis-Latte, Basis-Korb). Risiko-Block der Plattform: Risiko je Trade 0,5 % (für die Basis ohne Wirkung — Allokation 20 %), Positionsdeckel 20 %, vier Plätze, Brutto 100 %, **Tagesverlust 2 %, Drawdown-Halt 10 %**. Der Lauf misst zugleich das Alpha wie die Plattform (Korb je Fold, fünf Familien) — dessen Ergebnis ist hier nur Bericht. |
| Stufe-Befund 1: Tagesbremse im Takt tot | Der Takt misst den Tagesverlust künftig wie der Simulator vom Vortagesschluss (`last_equity`); beide prüfen einmal je Tag am Schluss. Ohne diesen Fix in `main` findet der Lauf nicht statt. |
| Stufe-Befund 6/8: pass-Flip und Schalter liquidieren | Ein gefallenes `pass`, ein fehlender Block und ein Schalter „aus" sperren nur Einstiege; offene Basis-Positionen führt die Basis-Strategie zu Ende (eigene Exits, Broker-Stop). Kein Zwangs-Exit über alle Konten. Ebenfalls Voraussetzung in `main`. |
| Stufe-Befund 3: Bracket ohne Ziel | Einstiege ohne Ziel gehen als `oto` mit Stop-Bein. Ohne Fix handelt die Basis still nie — deshalb Voraussetzung. |
| 1400 statt 2000 Tage | `lookbackDays 2000` auch für die Plattform; der Bärenmarkt 2022 bleibt in der Kette. Das verlängert die Alpha-Messung ebenfalls (16 statt 12 Folds) — gewollt, gleiche Fenster wie alle Proben seit dem 09.09. |

## Kriterien und Entscheidungsregeln

Die vier Gates der Gruppe `basis`, unverändert, im Hauptlauf und in beiden
Falsifikationsläufen dasselbe Urteil.

- Bestanden ×3 ⇒ **gestaffelte Aktivierung**, in dieser Reihenfolge, jede
  Stufe erst nach der vorigen:
  1. Aktivierungs-PR mit exakt dieser Config in `config/platform.yaml`, aber
     `strategy.basis: false` (globaler Schalter aus): Die erste Nacht misst
     nur und schreibt den Block; die Gate-Zahlen müssen den Probe-Zahlen
     gleichen (gleiche Config, gleiche Daten). Handel: keiner.
  2. Ein Pilotkonto (Paper, das des Owners) mit Schalter an über das erste
     Rebalance-Fenster (1., 2., 5. Oktober 2026): erwartet 1–4 Einstiege zu
     je 20 % der Equity, `oto`-Stops beim Broker, Journal mit Stufe „basis".
  3. Alle Paper-Konten erst nach einem Pilot-Fenster ohne Fehler im Journal.
  Echtgeld: unverändert Doppel-Guard und `readiness`.
- Ein Gate verfehlt oder die drei Läufe widersprechen sich ⇒ keine
  Aktivierung; Bericht an den Owner; V4 nur nach neuer Prüfer-Runde.
- Löst in der Simulation der Drawdown-Halt (10 %) oder die Tagesbremse
  (2 %) aus und die Basis bleibt danach in Kasse, ist das ein regulärer
  Fehlschlag — kein Messfehler, sondern das Regelwerk, das die Nutzer
  tragen.

## Bekannte Verzerrungen

Alle aus V2 (Periode, Familienwahl K3, Rasterschwankung T4, kurze
Horizonte, Latte ohne Kosten, Bereinigung auf heute), dazu:

7. Der Drawdown-Halt der Plattform (10 %) misst gegen den Intraday-Peak
   des Kontos, der Simulator gegen den Peak der Schlusskurse; live ist der
   Halt damit etwas leichter zu erreichen als gemessen, und er endet nur
   über `resume` durch den Nutzer (Stufe-Befund 7). Nicht behoben; als
   Owner-Entscheidung offen (Vorschlag: `resume` zum nächsten
   Rebalance-Fenster für die Basis).
8. Die Tagesbremse 2 % bei 55 % mittlerer Exposure entspricht einem
   Korbtag von etwa −3,6 %; im Bärenmarkt 2022 kann sie auslösen und
   glattstellen. V3 misst genau das.
9. Basis und Alpha teilen die vier Plätze des Nutzers; heute handelt kein
   Alpha-Champion, die Basis hat alle vier. Ändert sich das, ist die
   Messung nicht mehr die Realität (Stufe-Befund 5) — dann V4.

## Ergebnis (eingetragen nach dem Hauptlauf, 10.09.2026 kurz nach Mitternacht)

Hauptlauf #40 (Lauf 34418975177) auf `main` 5acd696 mit
`config/basis-1440-v3.yaml`: Datenbereich 2021-03-22 … 2026-09-09, Kette
2022-04-03 … 2026-03-13 — dieselbe Kette wie V2-Hauptlauf #37, dieselben
Bars, dieselbe Strategie, dasselbe Sizing (20 % je Position). Einziger
wirksamer Unterschied: die Notbremsen der Plattform, **Tagesverlust 2 %
statt 5 %** (der Drawdown-Halt 10 % wurde nie erreicht, MaxDD 8,3 %).

| Gate | V2 (#37, Bremsen 5 %/30 %) | V3 (#40, Bremsen 2 %/10 %) | Latte | Urteil V3 |
|---|---|---|---|---|
| basis_net_profit | +5 953 $ (Stress +5 848) | +3 123 $ (Stress +2 956) | > 0 | ✔ |
| basis_drawdown | 6,71 % / 55,6 % = 12,06 % | 8,27 % / 51,9 % = **15,95 %** | 15,48 % | ✘ knapp |
| basis_sharpe | 0,79 | **0,48** | 0,61 | ✘ |
| basis_costs | 3,3 % | 7,2 % | ≤ 10 % | ✔ |

Netto +12,5 % statt +23,8 %, 43 statt 37 Trades, Haltedauer 59 statt 68
Tage. Die 90-Tage-Scheiben sind bis Scheibe 9 (Juni 2024) auf den Cent
identisch mit V2; danach: Scheibe 10 (Juni–Sept. 2024, Volatilitätsspitze
Anfang August) +203 $ statt +1 044 $, Scheibe 13 (März–Juni 2025,
Zollcrash) **−750 $ statt +712 $**, Scheibe 14 +1 167 $ statt +1 401 $. Das
ist die Signatur der Tagesbremse: Ein Buchtag unter −2 % stellt alles
glatt (`risk/limits.ts`: „alles glatt, Halt bis nächster Tag"), der
Wiedereinstieg kommt erst im nächsten Monatsfenster, die Erholung wird
verpasst. Die Bremse **verschlechtert** den Drawdown je Einheit Exposure
(15,95 % gegen 12,06 %), weil sie Verluste festschreibt und Erholungen
auslässt.

**Urteil nach den Entscheidungsregeln: nicht bestanden ⇒ keine
Aktivierung.** Der Falsifikationslauf −15 Tage (#41) lief mit, der Lauf
−30 Tage wurde nicht mehr gestartet — das Urteil steht mit dem Hauptlauf.

**Was das heißt.** Die Basis hat sich nicht geändert; das Regelwerk, das
die Nutzer tragen, passt nicht zu ihr. Eine Tagesbremse, die bei −2 % das
ganze Buch glattstellt, ist für Intraday-Signale auf 5-Minuten-Bars
gedacht (CLAUDE.md §2), nicht für eine Monatsallokation mit 55 % Exposure.
Das ist eine Owner-Entscheidung, keine Messfrage: (a) Regelwerk behalten
⇒ die Basis ist auf dieser Plattform nicht einsetzbar; (b) Bremsen je
Stufe (für die Basis: Tagesverlust sperrt nur Einstiege, oder Schwelle
5 %; Drawdown-Halt mit `resume` zum nächsten Fenster) ⇒ Code-Pfad je Stufe
plus V4-Vorregistrierung plus neue Prüfer-Runde. Nichts davon wird ohne
Entscheidung gebaut.
