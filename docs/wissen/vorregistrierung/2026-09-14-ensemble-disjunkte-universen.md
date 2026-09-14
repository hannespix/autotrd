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

---

## Nachtrag 14.09.2026, 16:50 — Stichtag statt Wanduhr (vor der Auswertung)

Der erste Lauf auf dem Branch (Probe #68) hat **beide Abbruchkriterien 1
und 2 ausgelöst**, und zwar aus demselben Grund: Es ist Montag, die Börse
ist offen, das Datenende wanderte von 2026-09-11 (E1, Probe #67) auf
2026-09-14. Die Fold-Kette hängt am Datenende, also verschob sich mit ihr
alles — auch der Alpha-Teil. Der Lauf ist **nach meinen eigenen Kriterien
nicht auswertbar**. Ich habe seine Gate-Zahlen nicht angesehen.

Das ist derselbe Mechanismus wie heute früh beim Bars-Cache
(`analysen/2026-09-13-alpha-verschiebung-war-der-bars-cache.md`): Zwei
Läufe, die „eine Änderung" messen sollen, sahen verschiedene Daten.

**Konsequenz — und sie ist strenger als der erste Plan.** Statt den
Referenzlauf einfach heute nachzufahren, wird der Stichtag gepinnt.
Beide Läufe bekommen `asOf = 2026-09-11`, das Datenende von E1:

| Lauf | Ref | asOf | Rolle |
|---|---|---|---|
| A | `main` (alter Code, kein `ensembleMembership`) | 2026-09-11 | **Kontrolle** |
| B | Branch (disjunkte Universen) | 2026-09-11 | Messung |

`main` trägt die Bars-Cache-Bereinigung bereits (`scripts/bars-cache-key.mjs`),
der einzige Unterschied zwischen A und B ist die Änderung selbst
(`git diff main..HEAD` = `run.ts`, Test, diese Datei).

**Neues Abbruchkriterium 4, vor dem Lauf:** Lauf A muss E1 (Probe #67)
reproduzieren — gleicher Datenbereich, gleiche Ensemble-Zahlen, gleiche
`entzogen`-Liste (EFA, GLD, LQD, QQQ, SPY, TLT). Tut er das nicht, bewegt
sich noch etwas anderes im Apparat, und **keine** der Erwartungen 1–5 wird
ausgewertet, bevor das geklärt ist. Der Kontrolllauf ist der eigentliche
Zweck dieses Nachtrags: Er prüft nicht die Änderung, er prüft die Messung.

Abbruchkriterium 2 („Datenbereich weicht ab") bleibt in Kraft und wird
jetzt am Stichtag durchgesetzt statt an der Hoffnung, dass niemand über
Mitternacht misst.

**Versuchszählung unverändert:** Probe #68 zählt nicht — sie hat nichts
gemessen. Es bleibt bei Versuch 2 von 6.

---

## Ergebnis (14.09.2026) — Proben #69 (Kontrolle) und #70 (Messung)

Auswertung: `analysen/2026-09-14-ensemble-e2-symbolentzug-war-nicht-die-ursache.md`

Alle vier Abbruchkriterien klar; der Kontrolllauf reproduziert E1 Zeile für
Zeile (eine Abweichung, und das ist die Stichtags-Zeile selbst).

| # | Erwartung | Ergebnis |
|---|---|---|
| 1 | `entzogen` leer, Korb wieder voll | **bestätigt** (leer, 30/30, aus 131 Kandidaten) |
| 2 | Aktien-Sleeve deutlich über 71 Trades | **widerlegt** — 77 |
| 3 | Gebührenanteil unter 100 % | **nicht auswertbar** — Gate vakant (kein Bruttogewinn) |
| 4 | Alpha ziffernidentisch | **bestätigt** — 575/575 Zeilen |
| 5 | Mehr Gates als E1 | **formal 4 statt 3, sachlich nein** (der Zugewinn ist das vakante Gate) |

**Der Symbolentzug war nicht der Engpass.** Die Folge tritt ein, die hier
vorher festgeschrieben wurde: kein zweiter Anlauf an derselben Stelle, kein
Nachbessern. E3–E6 bleiben ungefahren; 2 von 6 Versuchen verbraucht.

Die Code-Änderung bleibt — aus Korrektheit der gemessenen Einheit
(`maxSymbols: 30` soll 30 heißen), nicht wegen des Ergebnisses. Dieselbe
Begründung stünde hier bei umgekehrtem Vorzeichen.
