# Red-Team „Symbolprofile je Nacht" — Befund und Behebung (10.09.2026)

Prüfer: ein Agent, der nicht gebaut hat, mit dem Auftrag zu widerlegen
(CLAUDE.md §6). Geprüft wurde der uncommittete Stand des Bauagenten; der
Bericht darunter ist sein Original. Behoben wurde im selben PR, VOR dem Commit.

## Was aus den Befunden wurde

| Befund | Behebung |
|---|---|
| M1 Rang = Plattform-Korb, nicht der Korb der Nutzer-Engine bei Teilauswahl | `rang.symbole` nennt die Korbmitglieder nach Rang (`korbSchluessel`, derselbe wie in `korbRaenge`); Frontend beschriftet den Alpha-Rang bei Teilauswahl als „(Plattform-Korb)", Tooltip listet den Korb; Modulkopf und Infotip sagen, dass das Profil nie die Sicht eines Nutzers ist. Wächter: `symbolprofile.test.ts` (Nutzer mit einem Symbol rangiert 1/1, Profil sagt 2/2), `frontend/test/symbolProfil.test.ts`. |
| M2 Veraltetes Profil neben neuem Champion unsichtbar; „Lauf #n" verschoben; Datum ohne Jahr; Profil-Schritt hängt an der Config | Frontend liest `championUpdatedAt`, vergleicht mit `champion.updatedAt` und zeigt „Profil veraltet: gehört zum Champion vom … — aktueller Champion vom …" (rerendert bei jedem neuen Champion); der Lauf steht nur noch einmal im Kopf, `bewertung` je Symbol trägt keinen Lauf mehr; Datum mit Jahr (`wannTag`); Workflow-Schritt `always() && steps.champion.outcome == 'success'` mit `::warning::`-Annotation bei Fehler. Wächter: `symbolProfile.test.ts` (Workflow), `frontend/test/symbolProfil.test.ts` (`profilVeraltet`). |
| M3 `optimize --as-of` schreibt das Profil mit Wanduhr-Schnitt | `cmdOptimize` reicht `app.asOf ?? Date.now()`; die Datei trägt `asOf`; CLI-Kopf und Frontend zeigen den Stichtag. Wächter: Verhaltenstest `cli.test.ts` (echter `optimize --as-of`-Lauf: Profil = Champion dieses Laufs, `now` = Stichtag, keine Bar danach). |
| M4 Intraday: ATR-Stop aus Tagesbars mit falscher Beschriftung | Indikatoren der Wahl nur auf Tagesbars; `stopDistanz(…, tagesbars)` liefert bei Intraday null mit Grund, `stopPct` (Parameter) bleibt. Wächter: `symbolprofile.test.ts` (Intraday-Config mit `trend_donchian`). |
| M5 Basis ausgegraut, Nutzer-Deckel fehlen im Hinweis | `profilAnzeige` (rein, in data.ts): ausgegraut werden nur Alpha-Zeilen außerhalb der Auswahl, Basis-Zeilen tragen das Tag „Basis-Block"; Hinweis und Infotip nennen Positionsdeckel, Sperren, Not-Aus. Wächter: `frontend/test/symbolProfil.test.ts`. |
| M6 Kausalitätsschnitt am Bucket-Beginn | `geschlossenBis` schneidet am Sitzungsschluss (`sessionBounds`, ohne Kalendereintrag Beginn + 1 Tag), rückwärts gesucht; Liquidität aus rohen Cache-Bars mit demselben Schnitt (`geschlosseneBars`). Wächter: `symbolprofile.test.ts` (Bar offen bei `now` ⇒ nicht gesehen; offene letzte Bar fließt in nichts ein). |
| M7 Wächterlücken | Regex-Test auf den Quelltext von `cmdOptimize` ersetzt durch den Verhaltenstest (M3); Frontend-Test für `leseSymbolProfil`/`profilAnzeige`/`profilVeraltet`; Negativbeispiel für den Rang-Wächter (andere Bars ⇒ anderer Rang). |
| G1 „0.0M" ohne Daten | `liquiditaet.tage` wird gelesen, `umsatz` null ⇒ „--". |
| G2 Fremde Version ⇒ „noch kein Profil" | `versionUnbekannt` mit eigenem Text und Versionsnummer. |
| G3 „Stand" = Wanduhr; „Handelstage" statt Bars | Kopf zeigt „Datenschnitt" (bei Messung dazu „Stichtag"); Trend „seit n Tagesbars". |
| G4 Doku | `docs/PLATTFORM.md` (Tabelle, Allowlist), `docs/wissen/symbolprofile.md` (Haltedauer ohne Journal-Versprechen, Abschnitt „Was das Profil nicht ist"), CLAUDE.md §3. |
| G5 Haltedauer kann nie etwas zeigen | Offen — Owner-Entscheidung (additives Feld `basis.kennzahlen` im Optimierer). Bleibt ehrlich „unbekannt". |
| G6 Klassentabellen ohne Drift-Wächter | `test/profile/klassen.test.ts`: jeder Kandidat aus `config/platform.yaml` hat eine Klasse, kein Tabelleneintrag außerhalb des Pools, keine Doppelung. |
| G7 `imEngineUniversum` aus dem lokalen Buch | `profilFuerApp` baut das Engine-Universum ohne `heldSymbols` — das Profil gilt für alle. |
| G8 Leiser Publish-Fehler | `::warning::`-Annotation (siehe M2). |
| G9 Test-Hygiene | Datei `x` und Shell-`mkdir` entfernt, stdout der CLI-Tests abgefangen. |
| G10 Deutsche Bezeichner; USAGE nennt `fetch` nicht | Bezeichner bleiben (Bestandspraxis `korbRaenge`, `waehleUniverse`); USAGE-Zeile zu `--as-of` ergänzt. |

---

# Red-Team-Befund: „Symbolprofile je Nacht" (uncommitteter Arbeitsbaum, 10.09.2026)

**Auftrag:** widerlegen, nicht loben. Geprüft wurde der uncommittete Stand auf
`claude/auto-trader-alpaca-rebuild-lghm4u` (HEAD `0084d0d`), Diff-Sicherung
`scratchpad/vorher.diff` (sha256 `a1482048…32e85`), neue Dateien nach
`scratchpad/sicherung/`. Nichts wurde committet oder gepusht; der Baum ist am
Ende exakt wiederhergestellt (Beweis unten).

**Ergebnis in einem Satz:** Das Profil bewegt kein Geld, liest keine Keys, wird
von der Engine nicht importiert, und seine Wächter laufen gegen die echten
Funktionen (`decide()`, `strategyChoice`, `buildStrategyFor`, `bewerte`,
`precompute`) und werden rot, wenn man sie bricht (5/5). **Aber:** drei Zahlen
können vom Engine-Stand abweichen, ohne dass Datei oder Frontend es verraten
(Korb je Nutzer, Stichtag bei `optimize --as-of`, Intraday-Stop aus Tagesbars),
ein veraltetes Profil neben einem neuen Champion ist im Frontend nicht
erkennbar, und die Anzeige graut Basis-Symbole als „nicht in deiner Auswahl"
aus, obwohl die Basis sie für den Nutzer als Block handelt.

| Grad | Anzahl | Kurz |
|---|---|---|
| K | 0 | Kein Geld, keine Keys, keine Rules-Lücke, kein Import in die Engine. |
| M | 7 | M1 Korb je Nutzer · M2 veraltetes Profil unsichtbar / „Lauf #" verschoben · M3 `--as-of` vermischt · M4 Intraday-Stop aus Tagesbars · M5 Ausgrauen der Basis / Nutzer-Deckel · M6 Kausalitätsschnitt am Bucket-BEGINN · M7 Wächterlücken (Text-Tests, kein Frontend-Test, gleiche Daten auf beiden Seiten) |
| G | 10 | Anzeige-/Doku-/Hygiene-Punkte |

Lauf-Belege: `npx vitest run test/profile test/scripts/symbolProfile.test.ts functions/test/symbolProfil.test.ts` → 4 Dateien, 37/37 grün (1,9 s). `npm run typecheck` 0, `npm run lint` 0, `npm run typecheck --workspace functions` 0, `npm run build --workspace frontend` 0. Beweis-Skripte: `scratchpad/{asof,intraday,korb}.redteam.ts` (mit `node <pfad>` reproduzierbar, kein Netz).

---

## M — mittel (irreführend, Lücke im Wächter, latent falsche Zahl)

### M1 · Der Rang im Profil ist der Rang des PLATTFORM-Korbs, nicht der Korb der Engine des Nutzers — bei Teilauswahl kippt die Zahl (latent K)

- **Wo:** `src/profile/symbolprofile.ts:365` (`engineUniverse` nur als Flag), `:383–397` (Rang über `profilUniversum`, d. h. `config.universe.symbols ∪ basis.symbols`); Plattform: `functions/src/engine/config.ts:157` (`universe.symbols = subset` je Nutzer), `functions/src/engine/tick.ts:500–504`, `src/engine/engine.ts:609` (`inputs` aus `this.cfg.universe.symbols`) → `decide()` → `korbRaenge(inputs)` (`src/core/logic.ts:351`). Frontend: `frontend/src/dashboard.ts:1282` zeigt „Rang r/n" ohne Korb-Angabe; Infotip (`infotips.ts`, `symbolProfil`): „dieselbe Rangbildung, die auch die Engine benutzt".
- **Beweis** (`scratchpad/korb.redteam.ts`, gepoolter `cross_sectional_momentum`-Korb AAA/BBB/CCC/DDD, Nutzer wählt CCC+DDD):
  ```
  profil_CCC:          { rank: 3, of: 4, pct: 0.667 }   → pct > topPct 0.2 ⇒ kein Einstieg
  engineDesNutzers_CCC:{ rank: 1, of: 2, pct: 0 }       → Einstieg
  ```
  Dieselbe Funktion (`korbRaenge`), andere Korbmenge, entgegengesetztes Urteil. Die Basis ist NICHT betroffen (Korb kommt als Block, `universeWithBasis`); betroffen ist jeder gepoolte Querschnitts-Alpha-Champion — heute gibt es keinen (`config/platform.yaml` ohne `fixedCandidates`; je Symbol gesuchte Querschnitts-Kandidaten haben `of 1` und bestehen nie, `logic.ts:240`). Sobald einer besteht, zeigt das Frontend einem Nutzer mit Teilauswahl einen Rang, den seine Engine nie sieht — dann K.
- **Vorschlag:** `rang.korb` um die Korbmenge erweitern (`symbole: string[]`) und im Frontend anzeigen „Rang 3/4 im Plattform-Korb (AAA, BBB, CCC, DDD)"; für Nutzer mit `autoSymbols` die Alpha-Ränge ausblenden oder mit dem Hinweis „deine Engine rangiert über deine Auswahl" versehen. Wächter: Test, der ein Profil gegen `buildStrategyFor` mit `buildUserConfig(…, {auto:{symbols:[…]}})` stellt und die Abweichung erwartet — damit die Lücke benannt bleibt statt vergessen.

### M2 · Ein veraltetes Profil neben einem neuen Champion ist im Frontend nicht erkennbar; „Lauf #n" hängt am Profil-Lauf, nicht an der Bewertung

- **Wo:** `frontend/src/data.ts:854–866` (`leseSymbolProfil` liest `championUpdatedAt` NICHT, `publishedAt`/`generatedAt` werden nicht angezeigt), `frontend/src/dashboard.ts:1290–1292` (`bewertung` = `measuredAt` des Champions + `lauf` des PROFILS), `src/profile/symbolprofile.ts:421` (`lauf: a.lauf.nummer` für jedes Symbol), `frontend/src/dashboard.ts:114–121` (`wann` ohne Jahr), `.github/workflows/optimize.yml:152–157` (`continue-on-error: true`, keine `::warning::`-Annotation), `:140–144` (scheitert der Config-Sync, ist der Champion schon veröffentlicht und der Profil-Schritt wird übersprungen — kein `always()`).
- **Beweis:** Die Datei trägt `championUpdatedAt` (Modul `:466`), das Frontend verwirft es. `ChampionEntry` (`src/optimize/promote.ts:20–31`) hat keine Lauf-Nummer; `bewertung.lauf` ist per Konstruktion der Lauf, der das Profil schrieb. Anzeige: „Letzte Bewertung: 14.11. 12:00 · Lauf #41" — Datum ohne Jahr (kann 2025 sein) neben der heutigen Lauf-Nummer.
- **Vorschlag:** `championUpdatedAt` im Frontend lesen und gegen `champion.updatedAt` prüfen → Warnbanner „Profil gehört zum Champion vom …"; `bewertung.lauf` in `profilLauf` umbenennen oder nur im Kopf zeigen; `wann` mit Jahr, wenn älter als 6 Monate; im Workflow bei Fehler `echo "::warning::Symbolprofil nicht veröffentlicht"`; Profil-Schritt zusätzlich `if: always() && …` NUR wenn der Champion-Schritt erfolgreich war (`steps.<id>.outcome == 'success'`).

### M3 · `optimize --as-of <Stichtag>` schreibt das Profil mit WANDUHR-Datenschnitt neben den Stichtags-Champion; das Profil trägt den Stichtag nicht

- **Wo:** `src/cli.ts:612` (`schreibeProfil({ ...app, champion: res.champion }, Date.now())`), `:832–834` (`tagesSerie` → `seriesForTimeframe(a, symbol, now)`), `src/app.ts:170` (`const grenze = closedBefore ?? app.asOf` — das ausdrückliche `now` VERDRÄNGT den Stichtag), `SymbolProfileFile` ohne `asOf`.
- **Beweis** (`scratchpad/asof.redteam.ts`, Cache bis 2024-12-16, `asOf: '2024-06-03'`):
  ```
  optimizerLetzteBar: 2024-06-03 (106 Bars)   profilLetzteBar: 2024-12-16 (242 Bars)
  profilNow: 2026-09-10                        profilTraegtStichtag: false
  ```
  Genau das, was `nurMessen` sonst verhindert („stillschweigend zu ignorieren wäre schlimmer", `src/cli.ts:191–201`): Trend/Rang/Vol von heute, `bewertung.measuredAt` vom Stichtag, und `var/profile.json` des letzten echten Laufs ist überschrieben.
- **Vorschlag:** In `cmdOptimize` `now = app.asOf ?? Date.now()` und `profilFuerApp` ohne explizites `closedBefore`, wenn `app.asOf` gesetzt ist; `asOf` als Feld in `SymbolProfileFile` (+ Anzeige) oder bei Stichtag gar kein Profil schreiben (Messung ≠ Betrieb).

### M4 · Unter einer Intraday-Config rechnet das Profil die ATR-Stop-Distanz eines Alpha-Champions aus TAGESBARS und nennt sie „ATR der …-Indikatoren am Stand" (latent falsche Zahl)

- **Wo:** `src/profile/symbolprofile.ts:374` (`precompute(bars /*Tagesbars*/, choice.params)` unabhängig von `tf`), `:435` (`stop: stopDistanz(choice, s.ind, close, i)`); nur der RANG wird bei `tf !== 1440` genullt (`:383`). Test `symbolprofile.test.ts:422–427` prüft bei Intraday nur `rang`.
- **Beweis** (`scratchpad/intraday.redteam.ts`, `timeframe: 5`, `trend_donchian` atrLen 14 / atrMult 2, Tagesbars):
  ```
  stopPct: 13.95   stopQuelle: "atrMult 2 × ATR der trend_donchian-Indikatoren am Stand …"   rang: null
  nachrechnung 2×ATR14 auf TAGESbars: 13.95
  ```
  Die Engine läge auf 5-Minuten-Bars bei einem Bruchteil davon. Plattform steht auf 1440 (`config/platform.yaml:121`) — heute nicht sichtbar; jeder Einzelbetreiber mit 5/15-Minuten-Config sieht die falsche Zahl.
- **Vorschlag:** Bei `tf !== 1440` Stop (und `taktik.params`-abgeleitete Kennzahlen) auf null mit Grund „Intraday-Zeitrahmen — Profil rechnet auf Tagesbars", wie beim Rang; Test ergänzen.

### M5 · Frontend graut Basis-Korb-Symbole als „Nicht in deiner Symbolauswahl" aus, obwohl die Basis sie für diesen Nutzer als Block handelt; Nutzer-Deckel/Sperren fehlen im Hinweis

- **Wo:** `frontend/src/dashboard.ts:1270` (`inaktiv = gewaehlt !== null && !gewaehlt.has(e.symbol)` — für ALLE Zeilen, auch `quelle === 'basis'`), `:1293` (`title="Nicht in deiner Symbolauswahl"`, `class ch-aus`), `i18n.ts` `pr.hint` („ausgegraut: nicht in deiner Auswahl"). Gegenstück im Kern: `src/core/basisTier.ts:40–43` („Auf der Plattform wählt der Nutzer Alpha-Symbole aus, die Basis kommt als Block dazu"), `functions/src/engine/tick.ts:500` (`universeWithBasis` fügt den Korb nach der Teilauswahl hinzu). `renderChampionBasis` (`dashboard.ts:1240–1256`) graut bewusst nicht.
- **Beweis:** `st.autoSymbols` = `settings.auto.symbols` (Teilmenge des Alpha-Universums, `shared/src/autoSettings.ts:157`); GLD/TLT/IEF… stehen dort nie → jede Basis-Zeile ist für Nutzer mit Auswahl ausgegraut und trägt den Tooltip „nicht gehandelt". Dazu: `basisStatus` mit `maxPositionPct` des NUTZERS (`basisTier.ts:123–124`, `functions/src/engine/strategyFor.ts:92`) deckelt die Allokation je Nutzer — das Profil zeigt `grund`/`sizing` aus `platform.yaml` (20 %). `auswahlVeraltet`-Sperre, Kill-Switch, Halt: nicht im Profil (korrekt, aber der Hinweis nennt nur „Symbolauswahl und Basis-Schalter").
- **Vorschlag:** Ausgrauen nur für `quelle === 'champion'`/`'config'`; Basis-Zeilen mit eigenem Tag „Basis-Block (dein Schalter: an/aus)"; `pr.hint` um „Positionsdeckel, Sperren und Not-Aus deines Kontos gelten zusätzlich" erweitern.

### M6 · Der Kausalitätsschnitt des Moduls schneidet am Bucket-BEGINN — die Bar, die bei `now` gerade ÖFFNET, gilt als gesehen; der Präfix-Test schreibt das fest

- **Wo:** `src/profile/symbolprofile.ts:244–248` (`geschlossenBis`: `bars.t[n] <= now`; `Bar.t` ist der Bucket-BEGINN, CLAUDE.md §4), Modulkopf Regel 3 („Nur Bars mit Bucket-Beginn ≤ now; der Aufrufer reicht ohnehin nur geschlossene Bars"). Test `test/profile/symbolprofile.test.ts:180–188` (`now = TAGE[i]` = 09:30 ET, erwartet `stand.bars === i+1`), `:206–211` (`geschlossenBis(s, TAGE[10]).length === 11`). Fixtures in `test/scripts/symbolProfile.test.ts:55` und `functions/test/symbolProfil.test.ts:64` reichen `now = t[letzte]` mit der offenen Bar.
- **Beweis:** Produktion ist nur deshalb sauber, weil `seriesForTimeframe` (`src/app.ts:170–176`) am SITZUNGSSCHLUSS schneidet (`bounds.close > grenze`) — der Modulwächter selbst ließe eine offene/partielle Tagesbar durch (Roh-Cache-Bars aus `store.load` tragen `t` = Tagesbeginn). Zweite Sicht im selben Profil: `tagesbarsFor` (`src/cli.ts:847`, Roh-Cache) für die Liquidität wird nur mit `t <= jetzt` geschnitten (`bewerte`) — nach einem `fetch` während der Sitzung zählt die partielle Tagesbar in Median/`letzterKurs`, während `stand`/Indikatoren sie ausschließen.
- **Vorschlag:** `geschlossenBis` über `sessionBounds(...).close <= now` (Kalender liegt als `a.calendar` vor) oder umbenennen in `bisBucketBeginn` und im JSDoc der Datei (`now`) festhalten, dass der Aufrufer die Schließung garantiert; Test mit `now = t[i] + 1 h` (Bar offen ⇒ i Bars) ergänzen; Liquidität aus derselben geschlossenen Serie speisen, wenn kein `vw` gebraucht wird.

### M7 · Wächterlücken: Text-Tests statt Verhalten, kein Frontend-Wächter, beide Seiten des Rang-Wächters sehen dieselben Daten

- **Wo:** `test/profile/cli.test.ts:147–166` (Regex auf dem Quelltext von `cmdOptimize` — bricht bei jeder Umformulierung, prüft kein Verhalten); `frontend/test/` enthält keinen Test für `leseSymbolProfil`/`profilZeile` (grep leer) — genau der Pfad, der Falsches ANZEIGEN kann (G1, G2, M5); `test/profile/symbolprofile.test.ts:214–296` (WÄCHTER 2) reicht `decide()` und Profil dieselben `SERIEN` — eine Abweichung im Datenpfad (Cache-Serie vs. REST-Fenster des Takts, `functions/src/engine/tick.ts:520`) kann er prinzipiell nicht sehen.
- **Beweis:** Mutation 5 (`schreibeProfil(app, …)` statt `{...app, champion: res.champion}`) wird zwar rot — aber nur, weil das Literal fehlt; eine Variante `const a2 = app; schreibeProfil({...a2, champion: res.champion}…)` mit altem Champion in `a2` bliebe grün. Ein Verhaltenstest (Champion vorher/nachher, Profil-`bewertung.measuredAt` prüfen) existiert nicht.
- **Vorschlag:** `cmdOptimize`-Test über `main(['optimize', …])` mit gesätem Cache (wie `cli.test.ts` es für `profile` schon tut) und Prüfung `profile.json.championUpdatedAt === champion.json.updatedAt`; Frontend-Test für `leseSymbolProfil` (Null-Dokument, fremde Version, `dollarVolumenTag 0`, Basis-Ausgrauen); WÄCHTER 2 zusätzlich mit ungleichen Serien je Seite (dann MUSS es abweichen — als negatives Beispiel dokumentiert).

---

## G — gering

- **G1 · „Umsatz/Tag 0.0M (nicht handelbar)" statt „--"** — `frontend/src/dashboard.ts:1286` prüft `=== null`, der Kern schreibt bei fehlenden Daten `dollarVolumenTag: 0`, `tage: 0` (`symbolprofile.ts:437–444`; Beweis: `scratchpad/clihome/profile.json` bei leerem Cache). CLI-Tabelle nutzt `tage === 0` korrekt (`:503`). Vorschlag: `tage` mitlesen.
- **G2 · Fremde Profil-Version zeigt „Noch kein Symbolprofil veröffentlicht"** — `frontend/src/data.ts:855` liefert bei `version !== 1` null, Anzeige `pr.keins`. Vorschlag: eigener Text „Profilformat unbekannt (Version n)".
- **G3 · „Stand" ist die Wanduhr des Laufs, nicht das Datum der letzten Bar** — `dashboard.ts:1312` zeigt `p.now`; `stand.t` je Symbol wird gelesen (`data.ts`) und nie gezeigt; `trend.seitBars` heißt im Frontend „seit n Handelstagen", zählt aber Bars der Cache-Serie (Lücken ⇒ weniger). Vorschlag: `stand.t` je Zeile, `seitBars` als „Bars".
- **G4 · Doku-Lücke Plattform** — `docs/PLATTFORM.md:34–39` (Tabelle der `meta/*`-Dokumente, Liste „Öffentlich lesbar") kennt `meta/symbolProfile` nicht; `docs/wissen/symbolprofile.md:28–29` beschreibt im Design-Teil eine Haltedauer „live ersetzt durch das Journal", die es nicht gibt (im Abschnitt „Umgesetzt" korrekt als „unbekannt"). §4a: Code gilt, Bibliothek korrigieren.
- **G5 · Haltedauer kann nie etwas zeigen** — `gemesseneHaltedauer` (`symbolprofile.ts:478–488`) hat keinen Pfad, der einen gemessenen Wert liest, selbst wenn der Champion ihn einmal trägt; CLI-Spalte und Frontend-Feld sind heute konstant „unbekannt (nicht gemessen)". Ehrlich (keine Schätzung — §4a eingehalten), aber eine leere Spalte. Vorschlag: Feld erst mit `basis.kennzahlen` (Owner-Entscheidung, laut Doku offen) einführen.
- **G6 · Statische Klassentabellen ohne Drift-Wächter** — `BASIS_KLASSEN`/`ETF_KLASSEN`/`SEKTOREN` decken heute den Pool zu 100 % (geprüft: 139/139 Kandidaten, 0 Tabelleneinträge außerhalb). Kein Test vergleicht sie mit `config/platform.yaml`; ein neuer ETF im Pool erschiene als „Aktie". Vorschlag: Test „jeder Kandidat hat eine Klasse; kein ETF ohne ETF-Klasse".
- **G7 · Profil hängt am lokalen Buch** — `src/cli.ts:848` (`engineConfig(app, heldSymbols(app))` aus `state.json`) → `imEngineUniversum` variiert mit den offenen Positionen des Rechners, der das Profil schreibt. Im Workflow gibt es kein `state.json` (Cache nur `var/bars`, `var/universe.json`), lokal aber schon; das Skript erklärt das Profil als „plattformweit … ohne Konto- oder Nutzerdaten" (`scripts/publish-profile.mjs:13–14`). Vorschlag: `held` im Profil-Pfad leer lassen oder im Feld benennen.
- **G8 · Publish-Fehler ist leise** — `scripts/publish-profile.mjs` beendet mit Code 1 (Format/Größe/Datei) bzw. unbehandelter Rejection (Firestore), der Schritt ist `continue-on-error` — kein `::warning::`, kein Health-Flag. Sonst gleichwertig mit `publish-champion.mjs`: Trockenlauf, feste Zielpfad-Konstante (`meta/symbolProfile`, gerade Segmentzahl geprüft), Größe 900 kB (lehnt ab statt zu kürzen — strenger als der Bericht), `set` ersetzt das Dokument (keine Altfelder), keine Secrets im Log (Zusammenfassung: Zähler, Sperrliste, Ziel, `GITHUB_SHA`).
- **G9 · Test-Hygiene** — `test/scripts/symbolProfile.test.ts:134` schreibt eine sinnlose Datei `x`; `:135` `execFileSync('mkdir', ['-p', …])` statt `mkdirSync` (nicht portabel); `test/profile/cli.test.ts` lässt `cmdProfile` die Tabelle auf stdout schreiben (im vitest-Lauf sichtbar: „autotrd profile · 5 Symbole …"), nur der `--json`-Fall fängt stdout ab. Alles unter `os.tmpdir()`, kein Netz — Konvention §4 eingehalten.
- **G10 · Bezeichner** — §4 verlangt englische Bezeichner: `geschlossenBis`, `profilUniversum`, `taktikGrund`, `bewerte`, `pruefeProfil`, `veroeffentlicheProfil` … sind deutsch (konsistent mit bestehendem Stil `korbRaenge`, `waehleUniverse`, also Bestandspraxis, formal Verstoß). USAGE (`src/cli.ts:65`) nennt für `--as-of` „universe, backtest und optimize", die Menge enthält auch `fetch` (Altbestand, nicht dieser Diff).

---

## Antworten auf die neun Prüfpunkte

1. **Ein Entscheidungspfad / Rangliste.** Rang: dieselbe Funktion `korbRaenge` (`logic.ts:252`), dieselben `SymbolInput`-Felder (`snap`, `strategy`, `params`, `ind`, `sizing`); `crossScore` beider Familien hängt nur von `ind`/`bars` ab (`crossSectionalMomentum.ts:107`, `regimeAllocation.ts:157`), `position: null` ist also unschädlich; veraltete Bars fallen wie in `decide()` heraus (Test `:289`). Abweichungen: Korbmenge je Nutzer (M1); Basis-Symbole ohne Einstiegsrecht und ohne Bestand bekommen im Profil einen Rang, den keine Engine rechnet (`universeWithBasis` lässt den Korb dann weg) — Frontend markiert „nicht im Universum der Engine". Lookahead: kein Feld sieht Bars nach `now`; Präfix-Test deckt ALLE Felder (`toEqual` auf der ganzen Datei, plus angehängte Zukunft ×10/×0,1), aber am Bucket-Beginn statt am Schluss (M6). Datenpfad: Profil = `var/bars` (IEX 1Day, `broker.adjustment` aus `platform.yaml`), Takt = REST-Fenster derselben Quelle (`tick.ts:433–447`); gleiche Normierung auf `bounds.open` (`app.ts:174`, `engine.ts:1203–1205`).
2. **Taktik = Engine-Wahl.** Ja: `choiceFor = strategyForFn(app)` (`cli.ts:845`), wörtlich die Funktion, die `run` bekommt; Plattform-Äquivalenz mit `buildStrategyFor` nur im Test (`functions/test/symbolProfil.test.ts`), das produktive Profil entsteht aus `platform.yaml` + `universe.json`, nicht je Nutzer: Nutzer-Schalter `basis`, `maxPositionPct`-Deckel, `auswahlVeraltet`, Kill-Switch, Halt weichen ab (M5). `einstiege: gesperrt` ist die Sperre der WAHL (`entriesAllowed`), nicht die des Kontos — Hinweis nennt nur Auswahl und Schalter.
3. **Haltedauer.** Nirgends geschätzt (`gemesseneHaltedauer` liefert immer null; Frontend „unbekannt (nicht gemessen)"). Kein Wert im Frontend sieht wie eine Messung aus. Dafür ein Feld, das nie etwas zeigen kann (G5) und ein Doku-Satz, der mehr verspricht (G4).
4. **Geld/Sicherheit.** Importrichtung: `src/profile/` wird nur von `src/cli.ts:40` importiert; Engine, Kern, Functions importieren es nicht. Das Modul importiert nur Reines (`basisTier`, `logic.korbRaenge`, `session`, `time`, `indicators`, `params`, `regimeAllocation`, `universe/select.bewerte`). `firestore.rules:20–23`: `symbolProfile` in der Lese-Allowlist (ohne Auth, wie `champion`/`health`), `allow write: if false`. Inhalt: Universum, Champion-Parameter (schon via `meta/champion` öffentlich), Kennzahlen, Gründe, `GITHUB_SHA`; keine Konto-/Nutzerdaten — Ausnahme das lokale Buch via `imEngineUniversum` (G7). Keine Secrets im Log (G8); `logger.error` im `cmdOptimize`-Catch geht durch den redigierenden Logger. `publish-profile.mjs` ≙ `publish-champion.mjs`, teils strenger (G8).
5. **Workflow.** Reihenfolge Champion → Config → Profil ✓, `continue-on-error` ✓, keine Input-Interpolation (feste Argumente; der `samples`-Override bleibt der einzige Input und ist gehärtet, G5 alt) ✓, `var/profile.json` im Artefakt ✓. Ein Profil-Fehler hält Champion/Config nicht auf ✓. Umgekehrt: Profil-Fehler ODER Config-Sync-Fehler ⇒ neuer Champion, altes Profil — im Frontend nicht erkennbar (M2). Exit 3 (nichts gemessen) ⇒ nichts veröffentlicht, Profil nur als Artefakt — konsistent.
6. **CLI.** `node src/cli.ts profile --config config/config.example.yaml --env <fehlt> --home <leer>`: Exit 0, kein Netz (ohne Keys kein Client; `profilFuerApp` fasst `app.client` nie an), 10 Symbole mit „—"/null, `liquiditaet.grund` „keine Tagesbars geliefert — Datenausfall" (Beleg `scratchpad/clihome/profile.json`). `--as-of` ⇒ `nurMessen` wirft „gilt nur für universe, fetch, backtest, optimize, nicht für `profile`", Exit 1 — richtig (Profil ist Betriebs-, keine Mess-Sicht); dokumentiert nur implizit (USAGE-Zeile 65, `BETRIEB.md` schweigt). Aber: `optimize --as-of` nimmt das Profil mit und ignoriert dort den Stichtag (M3).
7. **Frontend.** XSS: alle Textfelder über `escText` = `esc` (`html.ts:10`, escaped `& < > "`), Attribute in doppelten Anführungszeichen, Zahlen nur über `zahlOderNull` (finite), Enumerationen vorher auf feste Codes gemappt (`data.ts:830–846`) — keine Einfügung roher Profilwerte gefunden. i18n: 26 `pr.*`-Schlüssel in DE und EN identisch, Infotip DE+EN. Ohne Dokument: „Noch kein Symbolprofil veröffentlicht …", kein Fehler; fremde Version: gleicher Text (G2). Ausgrauen der Basis (M5), „0.0M" (G1).
8. **Tests.** Gegen echte Funktionen, nicht gegen Attrappen: WÄCHTER 2 zeichnet `snap.rank` in einer Hülle um die ECHTE Strategie auf und ruft `decide()`; WÄCHTER 3 vergleicht mit `strategyChoice`/`strategyForFn`; Functions-Test mit `buildStrategyFor` + Firestore-Fake. Gebrochen: 5 Wächter, alle rot (unten). Lücken: M6, M7. Ein Test, der „Geld verliert", passt hier nicht (kein Geldpfad); der Fall „Profil zeigt Falsches" ist für Rang/Taktik/Kausalität abgedeckt, für Frontend-Lesen und Anzeige nicht.
9. **Konventionen.** `.ts`-Endungen ✓ (alle 11 Importe), keine neue Abhängigkeit (`package.json` unverändert; `yaml`/`zod` Bestand) ✓, `exactOptionalPropertyTypes` ✓ (tsc grün, `?: … | undefined` durchgängig), Kommentare Deutsch ✓, Bezeichner teils Deutsch (G10), Tests unter `os.tmpdir()` ✓, kein Netz ✓, Lint ✓.

---

## Gebrochene Wächter (jede Mutation: anwenden → Test → exakt wiederherstellen → `diff` gegen Sicherung)

| # | Mutation | Erwartung | Ergebnis |
|---|---|---|---|
| 1 | `symbolprofile.ts:434` Rang gespiegelt (`rank: rang.of - rang.rank + 1`) | WÄCHTER 2 rot | rot: „GLD: expected { rank: 9, of: 9 } to deeply equal { rank: 1, of: 9 }" — 1 failed / 18 passed |
| 2 | `symbolprofile.ts:373` kausaler Schnitt entfernt (`a.barsFor(sym)` statt `geschlossenBis(…)`) | WÄCHTER 1 rot | rot: Präfix-Vergleich UND „angehängte Zukunft" — 2 failed |
| 3 | `symbolprofile.ts:449` `einstiege` immer `'erlaubt'` | WÄCHTER 3 + Functions rot | rot: „EEM: expected 'erlaubt' to be 'gesperrt'", „SPY: …", Schalter-aus-Fall — 3 failed / 19 passed |
| 4 | `scripts/module/symbolProfile.mjs:66` Größenbremse ×100 | Übergröße-Test rot | rot: „expected [Function] to throw an error" — 1 failed / 7 passed |
| 5 | `src/cli.ts:612` Profil mit ALTEM Champion (`schreibeProfil(app, …)`) | cli-Text-Test rot | rot: „expected -1 to be greater than 949" — 1 failed / 6 passed (Text-Wächter, siehe M7) |

Nach jeder Mutation: `cp` aus `scratchpad/sicherung/…` und `diff` → „IDENTISCH".

## Wiederherstellung — Beweis

```
git diff > scratchpad/nachher.diff; diff vorher.diff nachher.diff   → leer (TRACKED-DIFF IDENTISCH)
sha256 vorher.diff = nachher.diff = a14820486fa9014fbd62a276b623edd13ec30091bd07ced5c180003f6be32e85
diff -r sicherung/src_profile src/profile · sicherung/test_profile test/profile · publish-profile.mjs ·
  module/symbolProfile.mjs · test/scripts/symbolProfile.test.ts · functions/test/symbolProfil.test.ts → leer (NEUE DATEIEN IDENTISCH)
git status --short → dieselben 12 M + 6 ?? wie zu Beginn
```

Kein Commit, kein Push, keine dauerhafte Änderung. Einzige Nebenwirkung: `frontend/dist/` (gitignored) wurde durch die Build-Prüfung neu geschrieben; Beweis-Skripte und Temp-Homes liegen im Scratchpad bzw. unter `os.tmpdir()`.
