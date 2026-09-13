# Die Alpha-Verschiebung war der Bars-Cache — die Läufe sahen nie dieselben Daten

**Läufe:** #56 (V3), #58/#59 (V4) · **Frage:** Warum bewegte sich das Alpha
zwischen zwei Läufen, die sich laut Config nur in `risk.tiers` unterschieden?
· **Antwort:** Sie unterschieden sich nicht nur darin.

## Kurz

Der Prüfer hatte recht, dass meine Erklärung falsch war (Befund M1), und
seinen eigenen Verdacht — nicht die Latte, sondern der PFAD durch `decide()` —
habe ich gemessen und **widerlegt**. Die Ursache liegt nicht im Handelskern,
sondern im Messstand:

> `probe.yml` und `optimize.yml` hashten die GANZE Config-Datei als
> Cache-Schlüssel. Jede Config bekam damit ihren eigenen Bars-Cache — und
> weil ein frisch angelegter Eimer am ANFANG systematisch zu kurz ist
> (siehe „Der zweite Fehler" unten), sahen ein alter und ein neuer Eimer
> verschiedene Daten.

| Lauf | Config | Datenbereich |
|---|---|---|
| #56 | `basis-1440-v3.yaml` | **2021-03-22** … 2026-09-11 |
| #58/#59 | `basis-1440-v4.yaml` | **2021-03-24** … 2026-09-11 |

Zwei Tage am ANFANG. Die Zeile stand die ganze Zeit im Kopf beider Berichte;
ich habe sie nicht gelesen und stattdessen eine Ursache im Code gesucht.

## Warum zwei Tage ein Gate umlegen

Der Fold-Plan ist am Datenende verankert (`selectionEnd = dataEnd − holdout`,
Befund M4) — die Fold-Fenster sind in beiden Läufen ZEICHENGLEICH. Was sich
unterscheidet, ist das, was VOR dem frühesten Fold liegt: sein Warmup.

Und genau dort fängt der Unterschied an. Fold für Fold bei
`momentum_pullback` — und die Grenze sitzt auf der Bar genau dort, wo sie
sitzen muss:

| Fold | IS-Fenster | Warmup reicht zurück bis | Unterschied #56 gegen #59 |
|---|---|---|---|
| 1 | ab 2021-04-05 | ~2020-06-16 | **andere Parameter** (`rsiEntry 30/40`, `exitOnRsi 1/0`, `rrMult 0/3.5`, `trailMult 4/2`) |
| 2 | ab 2021-07-04 | ~2020-09-14 | gleiche Parameter, aber **IS-Objective 1,876 gegen 1,490** |
| 3 | ab 2021-10-02 | ~2020-12-13 | gleiche Parameter, **IS-Objective 3,018 gegen 2,951** |
| 4 | ab 2021-12-31 | ~2021-03-13 | gleiche Parameter, **IS-Objective 0,002 gegen 0,669** |
| 5–9 | ab 2022-03-31 | ~2021-06-11 und später | **zeichengleich** |
| 10 | ab 2023-06-24 | weit im Datenbereich | **andere Parameter** (`fast 20/25`, `rsiLen 2/6`, `atrMult 1,5/3`) |
| 11–16 | — | — | **zeichengleich** |

`warmupBars` ist für diese Parameter **202 Bars**. Die Folds 1 bis 4 sind
genau die, deren Warmup-Fenster VOR dem Datenbeginn endet — sie bekommen in
den beiden Läufen verschieden viele Bars und messen deshalb verschieden.
Ab Fold 5 liegt das ganze Warmup im Datenbereich, und ab dort ist der Bericht
zeichengleich. Die Grenze liegt nicht ungefähr richtig, sie liegt exakt
richtig.

Fold 10 fällt aus dieser Reihe: Sein Warmup liegt längst im Datenbereich.
Dorthin wandert der Unterschied über die **Hysterese des
Punkt-in-Zeit-Korbs** (`optimize/korbJeFold.ts` wählt Stand für Stand, jeder
Stand aus dem vorigen). Eine Kette, die am Datenbeginn anfängt, trägt einen
Unterschied am Datenbeginn bis ans Ende.

Bemerkenswert an den Folds 2 bis 4: Dort gewinnt **derselbe** Parametersatz,
nur mit einer anderen IS-Kennzahl. Ein Unterschied in den Daten muss also
nicht sofort das Urteil kippen — er wartet, bis zwei Kandidaten nah genug
beieinanderliegen. Das macht ihn schwerer zu bemerken, nicht harmloser.

Ergebnis: 496 statt 457 OOS-Trades, `beats_market` 0,46 statt 0,25 — und bei
`trend_donchian` `fold_positive_share` von rot auf grün.

## Was die Bremse ausschließt

Drei Gegenproben, jede für sich ausreichend:

1. **`momentum_pullback` hat in KEINEM der beiden Läufe je eine Bremse
   ausgelöst** (Bericht: „keine einzige Auslösung über die ganze OOS-Kette") —
   und ist trotzdem der Kandidat, der sich am stärksten bewegt. Eine Bremse,
   die nie auslöst, erklärt nichts.
2. **#58 gegen #59** ist der Kontrollversuch, den ich schon hatte: dieselbe
   Config-DATEI, also derselbe Cache-Eimer, aber unterschiedlicher Code (der
   `ALPHA_STUFE`-Fix). Der Bericht ist ziffernidentisch — der einzige
   Unterschied im ganzen Dokument ist das Etikett `other` ⇒ `alpha` in zwei
   Zeilen.
3. **120 synthetische Szenarien** (3 Strategien × 40 Szenarien, variierter
   Crash-Zeitpunkt, Crash-Tiefe, Tages- und Drawdown-Latte) durch `simulate()`,
   je einmal ohne `tiers` und einmal mit `tiers.basis 5/30`: **kein einziges
   Gegenbeispiel.** Trades, Netto und Endkapital stimmen überall auf die
   Nachkommastelle; nur die Etiketten der Bilanz unterscheiden sich
   (`konto:…` gegen `alpha:…`).

Punkt 3 widerlegt ausdrücklich den Verdacht des Prüfers. Er ist gut begründet
— die Konto-Bremse kehrt früh aus `decide()` zurück, die Stufen-Bremse
durchläuft die Symbolschleife mit `schonExit` — aber in einem Buch, das nur
EINE Stufe hält, stellen beide Wege dieselben Positionen glatt und sperren
dieselben Einstiege. Der Unterschied ist sichtbar nur bei gemischten Stufen,
und im Optimierer wird jede Stufe für sich simuliert.

## Der zweite Fehler — und er ist der eigentliche

Meine erste Fassung schrieb, „der IEX-Feed franst am Anfang aus". Das war
geraten. Nachgerechnet ist es exakt, und es liegt im Code:

**`fetch` und `optimize` ankern ihr Fenster verschieden.**

| | Anker | ab wann |
|---|---|---|
| `cmdFetch` (`cli.ts`) | `now`, die WANDUHR | `now − lookbackDays` |
| `runOptimization` (`run.ts` §762) | das DATENENDE | `letzteBar + 1 − lookbackDays` |

Am Sonntag, 13.09.2026, war die letzte Bar Freitag, der 11.09.:

```
fetch will ab    2021-03-23   (Anker Wanduhr)
optimize will ab 2021-03-21   (Anker Datenende)
Lücke            2 Tage       — genau die Marktlücke
```

Der Schnitt in `run.ts` ist richtig und sein Kommentar nennt den Grund
(„ohne diesen Schnitt hinge die Fold-Zahl davon ab, wer zuletzt wie tief
geladen hat"). Nur kann er keine Bars herbeizaubern, die `fetch` nie geholt
hat. **Ein Lauf mit frischem Cache ist am Anfang um genau die Marktlücke zu
kurz** — zwei Tage am Wochenende, bis zu vier nach einem Feiertagswochenende.

Ein ALTER Eimer verdeckt das: `backfillAdjustedDaily` fragt ab
`min(from, first)`, behält also den frühesten Beginn, den er je gesehen hat.
Deshalb war #56 (alter V3-Eimer) vollständig und #59 (frischer V4-Eimer)
zwei Tage kurz — und deshalb passt die Rechnung auf den Tag:

| Lauf | Eimer | erste Bar | erwartet |
|---|---|---|---|
| #56 | alt, aus einem früheren Lauf | 2021-03-22 | Fenster ab 2021-03-21 ⇒ Montag 2021-03-22 ✔ |
| #59 | frisch am 13.09. | 2021-03-24 | `fetch` ab 2021-03-23 ⇒ 2021-03-24 ✔ |

Die Kette ist damit vollständig: **(1)** `fetch` ankert falsch ⇒ frischer
Cache ist am Anfang zu kurz. **(2)** `min(from, first)` ⇒ ein alter Cache
verdeckt es. **(3)** Der Schlüssel je Config-Datei ⇒ V3 bekam einen alten,
V4 einen frischen Eimer.

Behoben ist hier (3). **(1) bleibt offen** und ist der schwerere Befund:
Dieselbe Config, zweimal gefahren, misst ein anderes Fenster — je nachdem,
ob der Cache warm war. Das trifft auch `optimize.yml`, also den nächtlichen
Champion.

## Der Fehler im Messstand

```yaml
key: probe-bars-${{ hashFiles(github.event.inputs.config) }}-${{ github.run_id }}
```

Der Hash war für die Trennung überflüssig: Auf der Platte liegen die Bars
längst getrennt unter `<home>/bars/<assetClass>/<feed>[-adj-<wert>]`
(`src/data/store.ts`, `barStoreRoot`) und je Symbol und Zeitrahmen in eigenen
Dateien. Krypto konnte Aktien nie überschreiben. Was der Hash ZUSÄTZLICH
trennte, war kein Datenunterschied — es war der Messfehler.

Behoben: `scripts/bars-cache-key.mjs` bildet den Schlüssel aus genau den drei
Größen, die die Wurzel bestimmt (Assetklasse, Feed, Bereinigung). Beide
Workflows benutzen ihn.

`optimize.yml` hatte denselben Fehler mit schärferer Folge: Dort liegt
`var/universe.json` im selben Cache — der Bestand für die Hysterese der
nächsten Universumswahl. Eine reine Risiko-Änderung an `platform.yaml` warf
also Bars UND Bestand weg, und der nächste nächtliche Champion hätte sich aus
einem Grund bewegen können, der mit der Änderung nichts zu tun hat.

Wächter: `test/scripts/barsCacheKey.test.ts`. Er prüft die Äquivalenzklasse
direkt (alles außer den drei Größen darf den Schlüssel NICHT bewegen, jede der
drei MUSS ihn bewegen) und dass beide Workflows ihn benutzen. Ein erster
Entwurf ließ genau den alten Fehler durch — `risk.maxDrawdownPct` mit in den
Schlüssel zu nehmen fiel nicht auf, weil V3/V4/V5 dort alle 10 stehen haben.
Vier absichtliche Brüche gehen jetzt rot, in beide Richtungen.

## Was das zurücknimmt

**Erwartung 4 der Vorregistrierung V4 ist weder bestätigt noch widerlegt.**
Sie lautete: „Das ALPHA ändert sich um exakt null — es trägt unveränderte
Bremsen." Ich hatte sie für widerlegt erklärt. Das war voreilig: Der Lauf, der
sie zu widerlegen schien, hat eine zweite Größe mitgeändert. Sie ist nicht
gemessen worden und muss neu gemessen werden.

**Auch die V3→V4-Aussage zur Basis ist ein Vergleich mit zwei Änderungen.**
Was davon trägt und was nicht:

- **Trägt:** Dass `risk.tiers.basis` die Bremsen abstellt, ist mechanisch
  belegt und datenunabhängig — V3 löste `konto:daily_loss` 3× aus, V4 keinmal,
  und zwar an denselben drei Tagen, die V3 noch meldete.
- **Trägt NICHT ohne Neumessung:** die HÖHE der Verbesserung und damit das
  Urteil „Basis-Latte bestanden, 4/4". Die Latte wird zwar im selben Lauf aus
  denselben Daten gebildet (Korb liegenlassen als Maßstab), das Urteil ist
  also in sich stimmig — aber es ist nicht mehr dasselbe Experiment wie V3.

Deshalb gilt weiter und jetzt erst recht: **Die Basis-Stufe wird nicht
aktiviert.** Vor der Aktivierung steht jetzt zusätzlich eine saubere
Neumessung von V3 und V4 auf demselben Cache.

## Die Lehre

Dreimal in zwei Tagen dieselbe Wurzel, jedes Mal eine Stufe tiefer:

1. V3-Auswertung: ein Divergenzpunkt in der Zeit als Ursache genommen.
2. V4-Widerlegung: aus „die Zahlen ändern sich nicht" geschlossen, die Ursache
   sei eine andere — ohne zu prüfen, ob die Änderung ankam.
3. Hier: aus „die Zahlen ändern sich" geschlossen, die eine Änderung in der
   Config sei die Ursache — ohne zu prüfen, ob es die einzige war.

Der gemeinsame Kern: **Ich habe die Läufe verglichen, statt zuerst zu prüfen,
ob sie vergleichbar sind.** Die Zahl, die es gesagt hätte, stand in beiden
Berichten in Zeile 4.
