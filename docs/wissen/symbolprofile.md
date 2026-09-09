# Symbolprofile — Taktik und Haltedauer je Symbol (Entwurf, Phase 2)

Owner-Anweisung: Taktiken, Käufe, Verkäufe und Haltedauern **individuell je
Symbol** ableiten und bewerten. Die Antwort dieses Repos darauf ist nicht
eine Parametersuche je Symbol (T10: Lotterie), sondern ein **Profil aus
Daten**, aus dem die Taktik je Symbol regelbasiert folgt.

## Was das Profil enthält (nächtlich, aus Tagesbars, kausal)

| Feld | Quelle | Wozu |
|---|---|---|
| Anlageklasse / Cluster | Pool-Zuordnung (`config`), später Korrelations-Cluster | Welche Taktik-Familie überhaupt in Frage kommt (T10). |
| Volatilität 63 Tage (annualisiert) | `rvol` aus `regime_allocation` | Stückzahl über das Risiko-Budget; Vergleichbarkeit der Ränge. |
| Trendzustand | Kurs über/unter gleitendem Mittel (`regimeLen`) | Regimefilter; Anzeige „aufwärts / abwärts seit n Tagen". |
| Momentum 126 Tage, Rang im Korb | `mom / rvol`, Rang aus `decide()`-Logik | Relative Stärke; Eintritt/Austritt der Allokation. |
| Stop-Distanz | `stopPct` bzw. ATR-Vielfaches der Familie | Katastrophen-Stop beim Broker; Größe der Position. |
| Liquidität | Median-Dollarumsatz 60 Tage (`universe/select.ts`) | Handelbarkeit; Slippage-Annahme. |
| Zugewiesene Taktik | Champion → Basis → keine | Was die Engine für dieses Symbol tut, und warum. |
| Erwartete Haltedauer | Median der Haltedauer dieser Taktik in der OOS-Kette bzw. im Journal | Erwartung für Nutzer; Abgleich mit dem Aktivitätsbudget. |
| Letzte Bewertung | Lauf-Nummer, Datum, Gates | Rückverfolgbarkeit (Regel 1 der Bibliothek). |

## Wie Taktik und Haltedauer daraus folgen

1. Cluster bestimmt die Kandidatenfamilien: Anlageklassen-ETFs → Allokation
   (Basis); Einzelaktien → Signalfamilien unter zehn Gates.
2. Champion hat Vorrang vor Basis, Basis vor „keine". Beides steht im
   Profil mit Lauf-Nummer.
3. Die Haltedauer ist keine Einstellung, sondern eine gemessene Größe der
   Taktik: Median aus der OOS-Kette, live ersetzt durch das Journal.
4. Die Stückzahl folgt aus Risiko-Budget und Stop-Distanz — eine Position in
   einem volatilen Symbol ist kleiner, nicht kürzer.

## Speicherort und Anzeige

Eigener Prozess: `var/profile.json`. Plattform: `meta/symbolProfile`
(vom nächtlichen Workflow geschrieben), Anzeige auf der Champion-Seite je
Symbol. Das Profil ist Anzeige und Erklärung; handeln tut weiterhin nur
`decide()` mit Champion oder Basis.
