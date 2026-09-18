# Vorregistrierung: Die Papier-Erprobung wählt nach Handelsaktivität

**Datum:** 18.09.2026 · **These:** T22 (neu) · **Status vor dem Lauf:** offen
**Owner-Entscheidung** vom 18.09.2026 auf die Frage, was mit der Auswahlregel
der Papier-Erprobung geschehen soll: „Nach Handelsaktivität wählen" — nicht
einfrieren, nicht beides.

## Der Befund, der das auslöst

Seit dem 17.09.2026 steht im Journal je Handelstag eine Bewertungszeile
(PR #511). Sie sagt, was die Engine angesehen hat:

```
decision/bewertung: 30 im Korb · 30 mit neuer Bar · 30 bewertet · 0 Einstiegswunsch · 0 gesperrt
```

Die Engine sieht also alles an, kein Tor blockiert, und die Taktik will
nichts. Der Kandidat der Erprobung ist seit Lauf #17 `regime_allocation`:
**76 Trades über 18 Folds** (1 620 OOS-Kalendertage), also rund
**1,4 Trades je Monat über den ganzen 30er-Korb** — im Erwartungswert ein
Einstieg alle drei Wochen. Gestern war es `mean_reversion` mit 353 Trades
(≈ 6,6 je Monat), vorgestern `momentum_pullback` mit 544.

Die Erprobung existiert laut CLAUDE.md §0.9 aus genau einem Grund: „damit
überhaupt ein Journal entsteht, solange nichts besteht". Gewählt wird sie
aber nach dem Score (OOS-Median des Objectives) — und der Score ist blind
dafür, ob ein Kandidat je handelt. Ein Kandidat mit 1,4 Trades je Monat
kann den Zweck der Erprobung nicht erfüllen, gleich wie hoch sein Score ist.

## Die Änderung

`optimizer.erprobungMinTradesPerMonth` (Vorgabe **0** = heutiges Verhalten;
Plattform **4**). Unter den durchgefallenen Kandidaten wird der Score-beste
gewählt, **der die Untergrenze erreicht**. Erreicht sie keiner, gilt der
Score-beste — und der Erprobungs-Block sagt das ausdrücklich (`auswahl`).

`tradesPerMonth` ist die Zahl der Maßstab-Zeile: geschlossene OOS-Trades je
30,44 Kalendertage der tatsächlichen OOS-Kette (`massstabFuer`, run.ts).

**Warum 4.** `docs/wissen/aktivitaet.md` nennt 2–10 Trades je Monat und
Konto als Zielband und „unter etwa einem Trade je Monat entsteht kein
Journal". Mit 4 je Monat über den Korb (≈ 0,19 je Handelstag) ist die
Wahrscheinlichkeit, in zehn Handelstagen KEINEN Einstieg zu sehen, rund
15 %; mit 1,4 je Monat sind es rund 50 %. Die Untergrenze liegt bewusst
über dem Existenzminimum der Bibliothek, weil der Owner Trades SEHEN will,
nicht nur statistisch erwarten. Sie liegt bewusst unter dem Band-Mittel,
damit sie nicht selbst zur Auswahl nach Aktivität statt nach Güte wird:
Von fünf Familien scheidet heute genau eine aus.

## Was das NICHT ist

- **Kein Gate, keine Schwelle, keine Beförderung.** Die zehn Alpha-Gates,
  die Basis-Latte, `promote`/`keep`/`demote`/`stay_notrade`, `symbols` und
  `noTrade` sind von der Regel unberührt — sie entscheidet ausschließlich,
  welcher DURCHGEFALLENE Kandidat auf einem Papier-Konto läuft.
- **Keine dritte Latte.** Die fünf Sperren der Erprobung (§0.9 a–e) gelten
  unverändert; ihre Trades zählen weiter nicht für die Live-Reife.
- **Kein Einfrieren.** Der Kandidat darf weiter jede Nacht wechseln; das
  Führungsproblem (Position von gestern ohne Signal-Exit) bleibt bestehen
  und ist als offene Frage dokumentiert, nicht gelöst.
- **Keine Wirkung auf Proben.** Vorgabe 0 heißt: Jede Config, die den
  Schlüssel nicht setzt, verhält sich wie bisher. Nur `platform.yaml` setzt 4.

## Was ich VOR dem Lauf erwarte

| # | Erwartung | widerlegt, wenn |
|---|---|---|
| 1 | Der nächste nächtliche Lauf (#18) wählt für die Erprobung `mean_reversion` (Score-bester unter ≥ 4 Trades je Monat), nicht `regime_allocation` | ein anderer Kandidat steht im Block, oder `regime_allocation` bleibt |
| 2 | Der Alpha-Teil des Berichts (Gates, Scores, Entscheidung `stay_notrade`, `symbols` leer, `noTrade` 30) ist gegenüber #17 unverändert bis auf die Datenkante des neuen Tages | eine Gate-Zeile oder die Entscheidung ändert sich durch diese Änderung |
| 3 | Innerhalb von **10 Handelstagen** nach dem Lauf steht mindestens ein `Einstiegswunsch` in einer Bewertungszeile eines Papier-Kontos | keiner — dann ist die Untergrenze nicht der Hebel, sondern die Signaldichte des Kandidaten im HEUTIGEN Regime gegenüber dem historischen Mittel |
| 4 | Der Erprobungs-Block trägt `tradesPerMonth` und `auswahl`, und `auswahl` nennt die übersprungenen Kandidaten mit ihrer Aktivität | ein Leser des Blocks kann nicht sehen, warum dieser Kandidat gewählt wurde |

**Erwartung 3 ist der eingebaute Selbstzweifel.** Bleibt der Einstieg trotz
eines Kandidaten mit ≈ 6,6 Trades je Monat aus, ist die Regel nicht falsch,
aber nutzlos — und dann ist die Frage nicht mehr die Auswahl, sondern der
Kandidat selbst. Die Untergrenze wird in dem Fall NICHT angehoben.

## Abbruchkriterium

Ändert sich durch die Änderung irgendeine Zahl im Alpha-Teil des Berichts
außer dem Erprobungs-Block (Erwartung 2), ist die Verdrahtung falsch, und
die Änderung wird zurückgenommen, bevor sie einen Tag handelt.

## Bezug

- Owner-Entscheidung 18.09.2026 (Frage 1 von 2; Frage 2 — neue Familie —
  bekommt ihre eigene Vorregistrierung).
- `docs/wissen/analysen/2026-09-15-die-erprobung-handelt-selten-und-verliert-beim-handeln.md`
- `docs/wissen/aktivitaet.md` (Zielband, Existenzminimum)
- CLAUDE.md §0.9 (Papier-Erprobung, fünf Sperren), §4a (Vorregistrierung)
- Lauf #17 (35169670191): die fünf Kandidaten mit Trades und Scores
- Aufgaben #48, #42
