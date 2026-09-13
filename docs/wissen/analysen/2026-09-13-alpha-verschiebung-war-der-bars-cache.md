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
> Cache-Schlüssel. Jede Config bekam damit ihren eigenen Bars-Cache. Der
> Backfill ist inkrementell, der IEX-Feed franst am Anfang aus — also füllten
> sich die Eimer verschieden.

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

Und genau dort fängt der Unterschied an. Die gewählten Parameter je Fold von
`momentum_pullback`:

| Fold | IS-Fenster | #56 | #59 |
|---|---|---|---|
| 1 | 2021-04-05 … 2022-04-05 | `rsiEntry 30, exitOnRsi 1, rrMult 0, trailMult 4` | `rsiEntry 40, exitOnRsi 0, rrMult 3.5, trailMult 2` |
| 2–9 | — | gleich | gleich |
| 10 | 2023-06-24 … 2024-06-23 | `fast 20, rsiLen 2, atrMult 1.5, trailMult 1` | `fast 25, rsiLen 6, atrMult 3, trailMult 5` |
| 11–16 | — | gleich | gleich |

Fold 1 ist der, dem zwei Warmup-Bars fehlen. Fold 10 liegt zweieinhalb Jahre
später — dorthin wandert es über die **Hysterese des Punkt-in-Zeit-Korbs**
(`optimize/korbJeFold.ts` wählt Stand für Stand, jeder Stand aus dem
vorigen). Eine Kette, die am Datenbeginn anfängt, trägt einen Unterschied am
Datenbeginn bis ans Ende.

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
