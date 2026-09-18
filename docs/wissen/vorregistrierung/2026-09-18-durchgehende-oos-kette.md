# Vorregistrierung: Die OOS-Kette als EINE durchgehende Simulation (Prüfbefund K4)

**Datum:** 18.09.2026 · **Auslöser:** Prüfbericht
`pruefungen/2026-09-18-red-team-erster-champion.md` (K4) und Lauf #21
(`befunde.md`, Nebenbefund B) · **Art:** Messung, keine Strategie, keine
Schwelle · **Status vor dem Lauf:** offen
**Geschrieben, BEVOR ein Wert mit der neuen Rechnung nachgemessen wurde.**

Diese Vorregistrierung ändert, WAS die OOS-Kette misst. Sie ist nach §4a
genauso pflichtig wie eine neue Familie. Sie ändert **keine Schwelle**.

---

## 1. Der Messfehler

Jeder Fold der OOS-Kette ist heute eine eigene Simulation: leeres Buch am
OOS-Beginn, Startkapital E₀, und am OOS-Ende werden offene Positionen zum
letzten Schluss bewertet — ohne Exit-Kosten, ohne dass sie je ein Trade
werden. Der nächste Fold beginnt wieder leer. Für eine Trailing-Strategie
mit 98 % Zeit im Markt heißt das: 18 Fold-Enden, an denen Buchgewinne in die
Kette gehen, die der Trailing-Exit im Median zu 55 % wieder hergegeben hätte
(Anatomie #18).

| Lauf | csm-Kette roh | Überschuss über BIL | geschlossene Trades |
|---|---:|---:|---:|
| #18 (Champion) | +7 476 $ | +3 388 $ | +1 471 $ |
| #21 (Raster −0) | +5 568 $ | +1 505 $ | **−178 $** |

Die Basis-Stufe hat denselben Fehler am 09.09.2026 (Prüfbefund M6)
bekommen und läuft seitdem durchgehend (`basisSimulation`). Die Alpha-Kette
hat ihn noch — und auf ihr steht jede Beförderung.

## 2. Das Prinzip

> **Die OOS-Kette ist EINE Simulation:** ein Buch, ein Peak, ein Konto von
> `oosStart` des ersten bis `oosEnd` des letzten Folds. Positionen laufen
> über Fold-Grenzen weiter. An der OOS-Grenze eines Folds wechseln die
> Parameter auf den Fold-Besten seiner IS-Suche und der Korb auf den Stand
> zu diesem Zeitpunkt (Korb je Fold) — genau das, was die Plattform nachts
> tut: neue Parameter, offene Positionen bleiben, ein Symbol ohne führende
> Strategie wird geschlossen (`unmanaged`).

Die Suche je Fold ist davon unberührt: IS-Fenster, Embargo, Kandidaten,
Fold-Beste bleiben, wie sie sind. Nur die BEWERTUNG der Kette ändert sich.

## 3. Was sich ändert — und was ausdrücklich nicht

### Simulator (`src/backtest/simulator.ts`)

`strategyFor(symbol)` darf einen Fahrplan `wechsel: { ab, params }[]`
mitgeben: Ab `ab` gelten die Parameter des Eintrags; Indikatoren werden je
Parametersatz vorberechnet (kausal — dieselbe Präfix-Regel wie bisher).
`params: null` heißt: Das Symbol hat ab hier keine führende Strategie — kein
neuer Einstieg, eine offene Position wird am nächsten Open als `unmanaged`
geschlossen. Ohne Fahrplan verhält sich der Simulator bitgleich wie heute.

### Kette (`src/optimize/walkForward.ts`)

`durchgehendeKette`: ein Lauf über die OOS-Kette mit Fahrplan (Fold-Beste)
und Korbständen (Korb je Fold). Das Ergebnis wird an den Fold-Grenzen in
Scheiben geschnitten und **je Scheibe auf E₀ normiert** (Equity × E₀/E_Start,
Trades nach Ausstiegszeit, Tagesrenditen der Scheibe). Damit gelten
unverändert: `aggregateOos` (Produkt der Scheibenfaktoren = Gesamtfaktor),
die Invariante von `ueberschussKette` (aufgezinst = Netto je Fold), PSR und
`beats_market` auf der Kette, `fold_positive_share`, `fold_concentration`.
`stress_costs` ist ein zweiter durchgehender Lauf bei Kosten ×1,5, ebenso
geschnitten. Die Nachbarschaft bleibt auf dem finalen Fenster, der DSR auf
der IS-Zahl — beide messen die Suche, nicht die Kette.

Gilt für gesuchte Kandidaten, Festkandidaten, die nächtliche Prüfung des
Amtsinhabers (Regel 2, R3) und alle drei Raster.

### Schalter

`optimizer.oosChain`: `continuous` (**Vorgabe, Plattform**) · `per_fold`
(die Rechnung bis heute — nur für Vergleichsläufe und Rauchtests; die
Plattform setzt sie nie).

### Unverändert, mit Begründung

- **Zehn Gates, Schwellen, Überschuss-Maßstab, Latte, Regel 2.**
- **Suche je Fold, Embargo, Korb je Fold, Generator je Fenster.**
- **Basis-Latte** (läuft schon durchgehend), **Ensembles** (eigene Messung).
- **Erprobung** (§0.9): wählt weiter den Score-besten Durchgefallenen — der
  Score ist der OOS-Median der Scheiben, jetzt der durchgehenden.

## 4. Erwartungen — vor dem Lauf, falsifizierbar

Erster Lauf: `optimize.yml` von Hand am 18.09.2026 (Anker 2026-09-18 —
dieselben Daten und dieselben Lose wie #21, also der direkte A/B-Vergleich
je-Fold gegen durchgehend).

1. **Die K4-Zeile jedes Kandidaten zeigt offene Positionen nur im LETZTEN
   Fold** (Σ unrealisiert = Stand am Kettenende); in #21 waren es bis zu 18
   Fenster.
2. **csm (Familie, Raster −0):** Überschuss fällt unter +1 505 $ und PSR
   unter 0,742; geschlossene Trades und Kettenergebnis rücken zusammen (die
   Differenz ist nur noch das Kettenende).
3. **Keine Familie besteht 3/3.** Die Zahl bestandener Gates je Familie sinkt
   oder bleibt; steigt sie bei einer Familie um zwei oder mehr, ist das ein
   Befund über die Rechnung, nicht über die Familie — dann Prüfer.
4. **Laufzeit:** höchstens +15 % gegenüber #21 (18,6 min) — ein durchgehender
   Lauf je Kandidat und Raster ersetzt 18 Fold-Läufe, dazu ein Stress-Lauf.
5. **`per_fold` reproduziert #21 bitgleich** (Score, Trades, Netto je Familie
   auf Raster −0 — Wächter im Code, Rauchtest mit dem Schalter).

## 5. Was das NICHT ist

- Keine Schwelle, keine dritte Latte, kein Owner-Pfad.
- Kein Urteil über csms festen Parametersatz (Nebenbefund A, #21): Er wird
  erst gemessen, wenn er als Festkandidat vorregistriert ist — NACH diesem
  Lauf, mit dieser Rechnung, Owner-Entscheidung.
- Keine Änderung an Engine, Sizing, Erprobung.

## 6. Wächter (jeder einmal absichtlich gebrochen)

- Simulator: Ohne Fahrplan bitgleich; mit Fahrplan gelten ab `ab` die neuen
  Parameter (Indikatoren des neuen Satzes); `params: null` schließt
  `unmanaged` am nächsten Open und lässt keinen Einstieg zu.
- Kette: Bei einer Strategie, die an jedem Fold-Ende flat ist, sind die
  Scheiben der durchgehenden Kette bitgleich zu den Fold-Läufen; Produkt der
  Scheibenfaktoren = Faktor der ganzen Kette; Trades der Scheiben = Trades
  der Kette.
- Gates: `ueberschussKette` nimmt die normierten Scheiben ohne Fehler.
- Schalter: `per_fold` = alte Zahlen (Snapshot-Test auf dem Fake).
- Plattform-Config: `oosChain: continuous`.

## 7. Abbruch und Umkehr

Reißt Erwartung 4 (Laufzeit), wird die Laufzeit behoben, nie die Rechnung.
Reißt Erwartung 5, ist der Umbau fehlerhaft und wird nicht veröffentlicht.
Eine Familie, die durchgehend BESSER aussieht als je Fold, ist zuerst ein
Verdacht auf die Rechnung (Erwartung 3).
