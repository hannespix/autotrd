# Wo das Geld verloren geht — Strukturbefunde der Exit-Anatomie (12.09.2026)

Owner-Frage: „wie die Trades am besten verlaufen. bzw. wie man am wenigsten
Verlust fährt." Um sie überhaupt beantworten zu können, messen Simulator und
Bericht ab jetzt je Ausstiegsgrund, wer verdient und wer verliert, dazu MFE
und MAE je Trade (wie viel vom erreichten Buchgewinn mitgenommen wurde, wie
weit Verlierer liefen, bevor der Stop griff) und ein Aktivitätsprofil.

Diese Datei hält die Befunde fest, die **aus dem Code folgen und nicht aus
Kursen** — sie gelten unabhängig davon, mit welchen Daten man messe. Die
Zahlen aus dem Probelauf stehen absichtlich NICHT hier: Er lief auf
synthetischen Bars (kein Bars-Cache im Baum), also sind sie Mechanik-Nachweis
und keine Aussage über eine Kante.

## S1 — Sieben von neun Familien können gar keinen Ziel-Ausstieg erzeugen

CLAUDE.md §2 zieht aus dem Vorgängersystem die Lehre: „Signal-Exits schnitten
Gewinner ab; Take-Profit-Exits gewannen 26/26" ⇒ „**Bracket-Orders mit
Ziel**". Geprüft, welche Familie überhaupt eine `rrMult`-Achse hat (das Ziel
entsteht nur über `bracketFromStop`, und dort nur bei `rrMult > 0`):

| Familie | `rrMult`-Achse | Default | kann ein Ziel setzen |
|---|---|---|---|
| `momentum_pullback` | ja | 2 | **ja** |
| `trend_donchian` | ja | **0** | ja, aber **standardmäßig aus** |
| `orb_breakout` | ja | — | ja (nur Intraday) |
| `mean_reversion` | **nein** | — | nein |
| `cross_sectional_momentum` | **nein** | — | nein |
| `regime_allocation` | **nein** | — | nein |
| `vigilant_allocation` | **nein** | — | nein |
| `index_reversal` | **nein** | — | nein |
| `turn_of_month` | **nein** | — | nein |

Für sieben von neun Familien ist die teuerste Lehre des Vorgängersystems
**strukturell unerreichbar**. Ihre Ausstiege sind Signal, Stop oder Trailing —
also genau die Sorte, die damals die Gewinner abschnitt. Und die einzige
Trendfamilie mit Ziel-Achse hat es im Default auf 0.

Das ist kein Fehler im engeren Sinn: Eine Allokationsstrategie im
Monatsrhythmus hat kein sinnvolles Kursziel, und ein Kalendereffekt schon gar
nicht. Aber es heißt, dass der Satz „Bracket-Orders mit Ziel" in §2 für die
Mehrheit des heutigen Kandidatenkreises nicht gilt, und das sollte dort auch
so stehen, statt als allgemeine Regel gelesen zu werden.

**Offene Frage an die Messung (nicht an die Meinung):** Bei welchen der
signalgetriebenen Familien würde eine Ziel-Achse das Ergebnis verbessern? Das
ist ein vorregistrierungspflichtiges Experiment, kein Handgriff — eine neue
Achse vergrößert den Suchraum und muss sich den Deflated Sharpe gefallen
lassen.

## S2 — `ExitReason 'time'` hat keinen Produzenten

Der Typ `ExitReason` in `src/core/types.ts` kennt `'time'`. Im ganzen Repo
erzeugt es niemand: Die einzigen Treffer sind die Typdeklaration selbst und
die Auswertungstabelle, die die Kategorie auflistet. Ein Zeitausstieg findet
also nie statt.

Folge: Eine Position, deren Signal nie wieder auslöst und deren Stop nie
greift, wird unbegrenzt gehalten. Für die Monatsfamilien ist das unkritisch
(sie steigen am Datum aus, das läuft als Signal-Ausstieg), für die
signalgetriebenen Familien ist es eine offene Flanke. Im Vorgängersystem war
„offene Position ohne Ausstiegsgrund" eine Fehlerquelle.

Zwei mögliche Konsequenzen, beide messbar und keine davon hier entschieden:
entweder `'time'` aus dem Typ entfernen (dann steht nichts Totes im Vertrag),
oder einen Zeitausstieg als vorregistrierte Achse einführen. Die zweite
Variante ist die interessantere, weil ein harter Zeitausstieg das
Klumpenrisiko in den Folds senkt — und `fold_concentration` ist eines der
zwei Gates, an denen der beste Kandidat scheitert.

## S3 — `mean_reversion` und das Aktivitätsbudget widersprechen sich

`docs/wissen/aktivitaet.md` verlangt eine Haltedauer von mindestens zehn
Handelstagen. `mean_reversion` steigt im Probelauf nach median drei Bars aus,
und das ist keine Parameterfrage, sondern die Bauart der Familie: Eine
Rückkehr zum Mittel ist in wenigen Tagen vorbei oder war falsch.

Entweder gilt das Budget nicht für kurzfristige Umkehr — dann muss es das
sagen —, oder diese Familie hat im Kandidatenkreis nichts zu suchen. Derselbe
Widerspruch trifft den neuen Sleeve `index_reversal`, der bewusst kurz hält.
**Das ist eine Owner-Entscheidung**, weil das Aktivitätsbudget eine
Owner-Vorgabe umsetzt („aktiver, aber nicht hyperaktiv").

## S4 — Die Auswertung kostet einen zusätzlichen Lauf je Fold

Die neuen Kennzahlen brauchen die Equity-Kurve je Kandidat über die
OOS-Kette. Weil `WfaCandidate` seine OOS-Equity heute nicht behält, läuft je
Kandidat und Fold eine zweite, identische Simulation nur zum Mitschreiben —
bei gesuchten Kandidaten rund 1 % Mehraufwand, bei Festkandidaten drei statt
zwei Läufe je Fold. Die Trades selbst kommen weiter aus dem Walk-Forward; es
gibt keine zweite Zählung, und ein Wächter vergleicht Fold für Fold.

Sauber zu beheben, indem `walkForward.ts` die OOS-Equity behält. Vormerkung,
kein Notfall.

## Was die Messung selbst schützt

Die Auswertung darf das Ergebnis nicht verändern — sonst misst man das
Messgerät. Zwei Wächter sichern das:

1. Dieselbe Simulation liefert mit und ohne Mitschrift **identische Trades
   und identische Equity-Kurve**. Dieser Wächter wurde absichtlich gebrochen
   (die Exkursion zog den Stop vor der Stop/Ziel-Prüfung nach) und wurde rot.
2. Ein Strategie-Spion prüft, dass kein `SymbolSnapshot.position` je ein Feld
   `mae`, `mfe` oder `stopTrailed` trägt — `decide()` kann die
   Auswertungsgrößen physisch nicht sehen.

MFE und MAE werden auch am Ausstiegs-Fill nachgezogen: Ein Gap-Open ist oft
der schlechteste Kurs des Trades, und ohne ihn unterschätzt die Messung genau
die teuren Ausstiege.
