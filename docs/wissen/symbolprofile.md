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
| Erwartete Haltedauer | Median der Haltedauer dieser Taktik in der OOS-Kette — heute trägt der Champion sie nicht, das Feld heißt „unbekannt" (siehe „Umgesetzt") | Erwartung für Nutzer; Abgleich mit dem Aktivitätsbudget. |
| Letzte Bewertung | Lauf-Nummer, Datum, Gates | Rückverfolgbarkeit (Regel 1 der Bibliothek). |

## Wie Taktik und Haltedauer daraus folgen

1. Cluster bestimmt die Kandidatenfamilien: Anlageklassen-ETFs → Allokation
   (Basis); Einzelaktien → Signalfamilien unter zehn Gates.
2. Champion hat Vorrang vor Basis, Basis vor „keine". Beides steht im
   Profil mit Lauf-Nummer.
3. Die Haltedauer ist keine Einstellung, sondern eine gemessene Größe der
   Taktik: Median aus der OOS-Kette. Solange der Champion sie nicht trägt,
   steht „unbekannt" — nichts wird geschätzt, auch nicht aus dem Journal
   (das wäre je Nutzer, nicht plattformweit).
4. Die Stückzahl folgt aus Risiko-Budget und Stop-Distanz — eine Position in
   einem volatilen Symbol ist kleiner, nicht kürzer.

## Speicherort und Anzeige

Eigener Prozess: `var/profile.json`. Plattform: `meta/symbolProfile`
(vom nächtlichen Workflow geschrieben), Anzeige auf der Champion-Seite je
Symbol. Das Profil ist Anzeige und Erklärung; handeln tut weiterhin nur
`decide()` mit Champion oder Basis.

## Umgesetzt (10.09.2026)

**Code:** `src/profile/symbolprofile.ts` (`buildSymbolProfiles`), CLI
`autotrd profile` und der Haken am Ende von `autotrd optimize` (`src/cli.ts`,
nach `saveChampion`, mit dem Champion des Laufs), Veröffentlichung
`scripts/publish-profile.mjs` → `meta/symbolProfile` (ein Dokument;
`scripts/module/symbolProfile.mjs` prüft Format und Größe, Rules-Allowlist wie
`meta/champion`), Anzeige unter der Champion-Karte (`frontend/src/dashboard.ts`,
Infotip `symbolProfil`). Wächter: `test/profile/`, `test/scripts/symbolProfile.test.ts`,
`functions/test/symbolProfil.test.ts`.

**Was das Profil je Feld tatsächlich ist (Quelle im JSDoc des Typs `SymbolProfil`):**

| Feld | Umgesetzt als |
|---|---|
| Anlageklasse / Cluster | Feste Tabellen im Modul: die neun Basis-ETFs nach GTAA-Klasse (`BASIS_KLASSEN`), Pool-ETFs (`ETF_KLASSEN`), Einzelaktien mit Sektor aus den Blöcken des Kandidatenpools (`SEKTOREN`); Benchmark markiert. Korrelations-Cluster: nicht umgesetzt. |
| Volatilität 63 Tage | `regime_allocation.precompute().rvol` — dieselbe Funktion wie die Strategie, nicht kopiert. |
| Trendzustand | `precompute().sma` über `regimeLen` des Basis-Blocks (sonst 150, Vorregistrierung V3); „auf/ab seit n Bars" als Länge der Serie gleichen Vorzeichens. |
| Momentum, Rang | `precompute().mom` (126/21 bzw. Block); Rang aus `korbRaenge()` in `core/logic.ts` — importiert, mit denselben `SymbolInput`s wie `decide()`. Nur für Symbole mit Querschnitts-Taktik; ohne Taktik kein Rang. |
| Stop-Distanz | `stopPct` der Wahl (Basis) bzw. `atrMult` × ATR aus den Indikatoren der Strategie (Alpha); ohne Taktik null. |
| Liquidität | `bewerte()` aus `universe/select.ts` (exportiert, nicht kopiert) — Median-Dollarumsatz über 60 Bars, dieselben Filter wie die nächtliche Wahl, mit Ablehnungsgrund. |
| Zugewiesene Taktik | Wörtlich die Wahl der Engine: `strategyForFn(app)` (eigener Prozess) bzw. `buildStrategyFor(...).fn` (Plattform-Test), beide über `core/basisTier.ts`. Das Profil leitet nichts selbst ab; ein Symbol ohne Wahl trägt keine Taktik, keinen Rang, keinen Stop. Zusätzlich `imEngineUniversum`. |
| Erwartete Haltedauer | **„unbekannt"** — weder `ChampionEntry.oos` noch `ChampionBasis` tragen eine gemessene Haltedauer (`BasisKennzahlen.avgHoldingDays` steht nur im Lauf und im Bericht). Nichts wird geschätzt. Offen: additives Feld `basis.kennzahlen` (Median aus den Trades der durchgehenden Simulation) im Optimierer — Owner-Entscheidung. |
| Letzte Bewertung | `lauf` aus `GITHUB_RUN_NUMBER`/`GITHUB_RUN_ID`/`GITHUB_SHA` (lokal null); Messzeitpunkt aus `decidedAt` (Alpha), `measuredAt` + `configCommit` (Basis) bzw. `noTrade.decidedAt`. |

**Kausalität:** nur Bars, deren Sitzung bei `now` geschlossen ist — Schnitt am
Sitzungsschluss, nicht am Bucket-Beginn (`geschlossenBis`; der Aufrufer
`seriesForTimeframe(app, sym, now)` schneidet ohnehin so, die Liquidität aus
den rohen Cache-Bars wird gleich geschnitten). `optimize --as-of` schreibt das
Profil mit dem Stichtag als Datenschnitt (`asOf` in der Datei). Präfix-Konsistenz-Test
an drei Ständen plus angehängte Zukunft plus offene letzte Bar
(`test/profile/symbolprofile.test.ts`).

**Was das Profil nicht ist (Red-Team 10.09.2026):** die Sicht eines einzelnen
Nutzers. Der Rang gilt für den Korb der PLATTFORM und nennt seine Mitglieder
(`rang.symbole`); ein Nutzer mit Teilauswahl rangiert in seiner Engine anders,
das Frontend beschriftet den Rang dann als Plattform-Korb. Die Basis kommt für
jeden Nutzer als Block und wird nie ausgegraut. Positionsdeckel, Sperren und
Not-Aus je Konto stehen nicht im Profil. Auf einem Intraday-Zeitrahmen bleiben
Rang und ATR-Stop leer (die Engine rechnet sie auf anderen Bars). Gehört das
Profil zu einem älteren Champion als dem aktuellen (`championUpdatedAt`),
sagt der Kopf der Karte das.

**Nicht umgesetzt (bewusst):** Korrelations-Cluster, Haltedauer aus dem
Journal (auf der Plattform je Nutzer, nicht global), Profil auf
Intraday-Zeitrahmen (Rang dann null — die Engine hätte andere Indikatoren).

