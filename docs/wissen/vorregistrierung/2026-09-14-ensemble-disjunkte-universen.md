# Vorregistrierung: disjunkte Universen im Ensemble

**Datum:** 14.09.2026 · **Vor dem Lauf UND vor dem Bau geschrieben.**
**Owner-Entscheidung:** Weg 2 von dreien, nach dem Befund zu E1
(`analysen/2026-09-14-ensemble-e1-hungert-beide-sleeves-aus.md`)

## Der Befund, der das auslöst

E1 ist nicht an seiner These gescheitert — die Korrelation der beiden
Sleeves lag bei 0,39, wie vorhergesagt. Gescheitert ist die Umsetzung, an
drei Engpässen aus „ein Konto, ein Positionslimit":

1. **Symbolentzug** (dieser Lauf behebt ihn),
2. Kapitalhalbierung,
3. Platzteilung.

Der Aktien-Sleeve kam auf 71 statt 496 Trades und +160,66 statt +2 240,51 $.

## Was genau geändert wird — eine Änderung

Heute nimmt `korbZuordnung` (`optimize/ensemble.ts`) den Punkt-in-Zeit-Korb
und **streicht** daraus jedes Symbol, das ein fester Sleeve schon belegt:

```
for (const [sym, b] of korbZum(a.alle, a.membership, a.at)) {
  if (belegt.has(sym)) { entzogen.push(sym); continue; }   // ← Symbol fällt WEG
```

Der Korb-Sleeve verliert dadurch Plätze. Bei E1 waren es sechs von dreißig
(EFA, GLD, LQD, QQQ, SPY, TLT).

**Neu:** Die Symbole fester Sleeves werden aus dem KANDIDATENPOOL genommen,
BEVOR die Liquiditätsauswahl läuft. Das Ensemble bekommt dafür eine eigene
`membership` — dieselbe Auswahlregel, derselbe Hysterese-Mechanismus, nur
auf einem um die belegten Symbole verkleinerten Pool.

Folge: Der Korb-Sleeve füllt wieder alle `maxSymbols` Plätze. Er verliert
keine Breite, er wählt **andere** Symbole. `entzogen` muss leer sein.

**Was ausdrücklich NICHT geändert wird:** die Auswahl der Einzelkandidaten.
Sie behalten ihre bisherige `membership` über den vollen Pool. Sonst
verschöbe dieser Lauf zwei Dinge auf einmal — der Fehler, der gestern
dreimal Zeit gekostet hat.

## Abbruchkriterien — vor dem Lauf festgelegt

1. **Der Alpha-Teil verschiebt sich.** Die fünf Einzelkandidaten müssen
   ziffernidentisch bleiben. Tun sie es nicht, hat die Änderung mehr
   angefasst als das Ensemble, und der Lauf ist nicht auswertbar.
2. **Der Datenbereich weicht vom Referenzlauf ab.** Dann wieder kein
   Vergleich mit einer Änderung.
3. **`entzogen` ist nicht leer.** Dann hat der Fix nicht gewirkt, und das
   Ergebnis sagt nichts über disjunkte Universen.

## Erwartungen

| # | Erwartung | widerlegt, wenn |
|---|---|---|
| 1 | `entzogen` ist leer, der Korb-Sleeve führt wieder `maxSymbols` Symbole | eines von beidem nicht |
| 2 | Die Trades des Aktien-Sleeves steigen deutlich über die 71 aus E1 | sie bleiben unter 150 |
| 3 | Der Gebührenanteil fällt deutlich unter die 188 % aus E1 | er bleibt über 100 % |
| 4 | Die fünf Einzelkandidaten sind ziffernidentisch | jede Abweichung ⇒ Abbruch (Kriterium 1) |
| 5 | Das Ensemble besteht MEHR Gates als E1 (3 von 10) | es besteht gleich viele oder weniger |

**Erwartung 5 ist bewusst schwach formuliert.** Zwei der drei Engpässe
(Kapitalhalbierung, Platzteilung) bleiben bestehen — dieser Lauf behebt
einen von dreien. Wer hier ein Bestehen aller zehn Gates erwartet, hat den
Befund nicht gelesen. Gemessen wird, ob der Engpass, den wir benannt haben,
wirklich der war, für den wir ihn halten.

## Die Folge, beide Richtungen

**Trifft Erwartung 2 und 3 zu:** Der Symbolentzug war ein echter Engpass,
und die beiden anderen sind es wert, einzeln gemessen zu werden — jeder
wieder als eigener Versuch, jeder wieder vorregistriert.

**Trifft sie nicht zu:** Dann war der Symbolentzug nicht die Ursache, meine
Diagnose war falsch, und das gehört genauso aufgeschrieben. Kein zweiter
Anlauf an derselben Stelle, kein Nachbessern an den Zahlen.

**Versuchszählung (§4a):** EIN Versuch, gezählt — und zwar als
Ensemble-Versuch. E1 gleichgewichtet war Versuch 1 von 6; dies ist Versuch 2.
Die Vorregistrierung vom 12.09. bleibt in Kraft: höchstens sechs.
