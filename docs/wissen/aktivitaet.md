# Aktivitätsbudget — „aktiv, nicht hyperaktiv" in Zahlen

Aktivität ist eine Kostenposition (A1, C8). Das Budget legt fest, wie viel
davon eine Taktik ausgeben darf, und wo das erzwungen und gemessen wird.

## Kennzahlen

| Kennzahl | Definition | Ziel je Konto |
|---|---|---|
| Trades je Monat | abgeschlossene Round-Trips je 30,44 Tage über alle Symbole | 2 bis 10 |
| Umschlag je Quartal | gehandeltes Volumen / mittlere Equity | ≤ 150 % |
| Median-Haltedauer | Median der Haltedauer abgeschlossener Trades | ≥ 10 Handelstage |
| Gebührenanteil | Gebühren / Bruttogewinn (Gate `fee_share`) | ≤ 50 % (Gate), ≤ 25 % (Basis) |
| Positionen | gleichzeitig offene Positionen | ≤ `risk.maxPositions` (4) |

Zum Maßstab: Das Vorgängersystem machte 525 Trades in zwei Tagen — über
5 000 je Monat — und zahlte 3 049 $ Gebühren auf 1 456 $ Bruttogewinn.
Die zweite Messreihe lag bei 51–528 OOS-Trades über 12–16 Folds, also
etwa 1–10 je Monat, je nach Familie.

## Wo das Budget wirkt

- **Config:** `risk.maxPositions`, Rebalance-Fenster (`REBAL_TAGE`) und
  Haltedauer-Parameter der Familien begrenzen die Aktivität nach oben.
- **Gates:** `fee_share` und `stress_costs` lehnen Kandidaten ab, deren
  Umschlag die Kante frisst.
- **Bericht:** Trades je Monat stehen je Kandidat in der Maßstab-Zeile
  (Festkandidaten-Änderung, 09.09.).
- **Betrieb:** Das Journal liefert dieselben Kennzahlen live; `readiness`
  verlangt Gebührenanteil ≤ 50 %.

## Was zu wenig ist

Unter etwa einem Trade je Monat je Konto entsteht kein Journal, aus dem
`readiness` je etwas lernen könnte (T9, T13). Eine Taktik, die im Mittel
seltener handelt, ist als Standard ungeeignet — sie kann als Kandidat
weiterlaufen.
