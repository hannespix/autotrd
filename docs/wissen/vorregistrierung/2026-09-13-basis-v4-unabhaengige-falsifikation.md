# Vorregistrierung: die erste WIRKLICH unabhängige Falsifikation der Basis

**Datum:** 13.09.2026, nachts. **Vor dem Lauf geschrieben.**
**Anlass:** Prüferbefund M4 · **Config:** `config/basis-1440-v4.yaml`

## Warum die bisherigen Falsifikationen keine sind

V2 und V4 wurden mit `--as-of −15` und `−30 Tagen` „falsifiziert" (#38/#39,
#60/#61). Der Prüfer hat das zerlegt, und er hat recht: Die Fold-Kette ist an
`selectionEnd = dataEnd − holdout` verankert und wächst rückwärts
(`walkForward.ts`, `buildFolds`). Ein Stichtag 15 oder 30 Tage früher
verschiebt die ganze Kette um 15 bzw. 30 Tage — bei einer OOS-Kette von rund
1 440 Tagen sind das **über 95 % Überlappung**. „Zeichengenau dieselben
Zahlen" ist bei praktisch denselben Daten das ERWARTETE Ergebnis; es belegt
Determinismus, nicht Robustheit.

## Der Entwurf: null Überlappung, nicht wenig

Die OOS-Kette des sauberen Laufs (#63) läuft **2022-04-05 … 2026-03-15**.
Damit die neue Kette sie nicht berührt, muss sie davor enden:

```
selectionEnd = dataEnd − 180 Tage  ≤  2022-04-05
⇒ dataEnd ≤ 2022-10-02
```

**Stichtag: `--as-of 2022-10-01`.** Die neue OOS-Kette liegt dann bei rund
2018-04 … 2022-04 — ein anderes Jahrzehnt der Marktgeschichte, ohne einen
einzigen gemeinsamen OOS-Tag. Sie enthält den Einbruch Ende 2018, den
Corona-Crash 2020 und den Zinsschock 2022; der bisherige Lauf enthält keinen
davon vollständig.

Ein Lauf, nicht zwei: Gefragt ist, ob das Urteil der Basis unabhängige Daten
überlebt — nicht noch einmal, ob die Bremse die Ursache ist. Das steht seit
#62/#63.

## Abbruchkriterien — vor dem Lauf festgelegt

1. **Zu wenig Daten.** Der Lauf braucht `lookbackDays` (2 000) vor dem
   Stichtag, also Bars ab etwa 2017-04. Reicht der IEX-Feed nicht so weit,
   bricht der Lauf ab oder meldet zu wenige Folds — dann ist das Ergebnis
   „nicht messbar", und es wird NICHTS über die Basis geschlossen.
2. **Überlappung doch vorhanden.** Nennt der Bericht eine OOS-Kette, die
   über den 2022-04-05 hinausreicht, ist die Unabhängigkeit nicht
   hergestellt und der Lauf zählt nicht als Falsifikation.
3. **Weniger als 8 Folds.** Dann ist die Kette zu kurz für ein Urteil.

## Erwartungen

| # | Erwartung | Woran sie scheitert |
|---|---|---|
| 1 | Die OOS-Kette endet vor dem 2022-04-05 und umfasst ≥ 8 Folds | Abbruch (siehe oben) |
| 2 | Die Basis besteht ihre vier Gates auch hier | Ein einziges rotes Gate |
| 3 | Der Drawdown je Exposure bleibt unter der Latte `(1 − 0,25) × Korb` | — |

**Erwartung 2 ist die Messung.** Ich rechne NICHT damit, dass sie
zwangsläufig hält: Das Fenster enthält mit dem Corona-Crash einen Einbruch,
wie ihn der bisherige Zeitraum nicht kennt, und eine Monatsallokation mit
Trendfilter kann daran scheitern. Genau deshalb ist der Lauf etwas wert.

## Die Folge, beide Richtungen, vorher festgeschrieben

**Besteht die Basis:** Prüferbefund M4 ist erledigt. Dann bleibt vor einer
Aktivierung nur noch M2 — `risk.tiers.basis` gehört in
`config/platform.yaml`, und das ist eine Owner-Entscheidung, weil es ändert,
was Nutzer handeln.

**Besteht sie nicht:** Die Basis-Stufe wird **nicht aktiviert**, und das
Urteil aus #63 gilt als das, was es dann ist — ein Ergebnis auf einem
einzigen Zeitfenster. Kein Nachbessern an Parametern, kein zweiter Stichtag
„zum Vergleich", keine Suche nach dem Fenster, in dem es doch klappt. Ein
Kandidat, der auf der Hälfte der Geschichte scheitert, ist kein Kandidat
(§0.9: „wir sollten nicht handeln" ist ein zulässiges Ergebnis).

**Versuchszählung (§4a):** EIN Versuch. Er variiert eine gesuchte Größe —
das Zeitfenster — und wird als solcher gezählt, egal wie er ausgeht.
