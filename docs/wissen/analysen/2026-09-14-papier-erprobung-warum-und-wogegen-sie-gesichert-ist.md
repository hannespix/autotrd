# Papier-Erprobung: warum es sie gibt und wogegen sie gesichert ist

**Owner-Entscheidung 14.09.2026** · Code: `src/core/erprobung.ts` ·
Regelwerk: CLAUDE.md §0.9 und §6

## Die Sackgasse, die das auslöst

Am 14.09.2026 lag sie offen zutage:

```
Gates  ⇒  Champion  ⇒  Paper-Trades  ⇒  readiness  ⇒  Echtgeld
```

Jeder Pfeil ist richtig. Zusammen ergeben sie: Besteht nie etwas, passiert
nie etwas — auf ewig, und ohne dass je eine Zeile Betriebserfahrung
entsteht. Der Stand an diesem Tag: `meta/champion` mit 0 Symbolen und 30 ×
`noTrade`, der beste je gemessene Kandidat bei 7 von 10 Gates, und der
Datenfeed als harte Grenze für die Stichprobe
(`2026-09-14-sip-reicht-weiter-aber-nur-in-die-vergangenheit.md`).

Dem Owner wurden drei Wege vorgelegt (Datenabo bezahlen · bei IEX bleiben ·
Papier vom Champion trennen). Gewählt wurde der dritte.

## Was die Stufe NICHT ist

**Keine dritte Latte.** Eine Latte entscheidet, ob etwas gut genug ist. Hier
wird nichts entschieden und nichts befördert:

- Kein Gate wird gelockert, umdefiniert oder umgangen.
- Der Kandidat bleibt durchgefallen und steht weiter in `noTrade`.
- `champion.symbols` bleibt unberührt — die Erprobung ist ein eigener Block.
- Echtgeld sieht die Stufe nie.

Sie ist eine **Erhebungsart**: Sie erzeugt Daten über einen Kandidaten, von
dem wir wissen, dass er nicht besteht.

## Die drei Sperren — und warum gerade diese

### (a) Nur Papier, entschieden am AUFGELÖSTEN Modus

Nicht an dem, was eine Config behauptet, sondern an `resolveMode`
(eigener Prozess) bzw. `resolveBrokerMode`/`verbindung.mode` (Plattform).
Ein Live-Konto erreicht die Stufe nie — auch nicht, wenn jeder Schalter an
ist, auch nicht bei `mode: undefined` (wer den Modus nicht kennt, darf einen
durchgefallenen Kandidaten erst recht nicht handeln lassen).

Die Prüfung steht **als erste** in `erprobungSperre`, damit die Sperre, an
der alles hängt, nie hinter einer anderen Bedingung verschwindet. Dafür gibt
es einen eigenen Wächter.

### (b) Schalter aus per Vorgabe

`strategy.erprobung`, Default `false`. Wer nichts tut, ändert nichts.

### (c) Kein Weg in die Live-Reife — die Sperre, die man übersieht

Das ist die eigentliche Gefahr der Entscheidung, und sie wurde beim Bauen
gesucht statt abgewartet. Die Kette lautet:

```
Erprobungs-Trades  ⇒  stats/main  ⇒  reifeFuerKonto  ⇒  Echtgeld-Freigabe
```

`functions/src/core/liveGate.ts` liest `users/{uid}/stats/main` (trades,
profitFactor, costs), und `functions/src/scheduled/snapshotEquity.ts` baut
dieses Dokument aus `users/{uid}/trades`. Ohne Filter hätte ein
durchgefallener Kandidat über Papier-Trades **genau den Weg zu Echtgeld,
den die Erprobung nicht haben darf**.

Geschlossen an zwei Stellen, in beiden Betriebsarten dieselbe Regel (§0.1):

| Stelle | Wirkung |
|---|---|
| `src/readiness.ts` | schliesst Erprobungs-Trades vor jeder Kennzahl aus, zählt sie getrennt (`erprobung`) und nennt sie in der Zusammenfassung |
| `functions/src/scheduled/snapshotEquity.ts` | überspringt sie beim Aufbau von `stats/main` |

**Weder dafür noch dagegen.** Sie gehören schlicht nicht in diese Rechnung —
sie dürfen die Reife weder aufblähen noch entwerten. Beides ist geprüft.

## Wie die Stufe gelesen wird

`Trade.stufe` trägt die Quelle der Wahl (`app.ts`: `stufe: choice.source`,
`book.ts` reicht sie durch). Es gibt **kein zweites Feld**: Zwei Felder für
dieselbe Frage sind genau die Bauart, die am 13.09. 3 877 $ Unterschied im
selben Lauf erzeugt hat.

Fehlt `stufe` (ältere Journale), lautet die Antwort NEIN — solche Trades
stammen aus dem Champion-Betrieb und zählen weiter. Die Richtung ist mit
Absicht so herum.

## Reihenfolge je Symbol

```
Alpha-Champion  →  Basis  →  Papier-Erprobung  →  noTrade
```

Die Erprobung ist die schwächste Behauptung im Haus und übersteuert nie
etwas. `stufeOf('erprobung')` ergibt `other` (`risk/limits.ts`), also gelten
die **globalen** Notbremsen — die konservative Wahl, ohne dass dafür eine
Zeile nötig war.

## Vier Wächter absichtlich gebrochen

| Bruch | Folge |
|---|---|
| Modus-Sperre entfernt | 2 rot — „Modus live darf die Erprobung nicht bekommen" |
| Modus hinter dem Schalter geprüft | 1 rot — „bei live muss der Modus der genannte Grund sein" |
| `readiness` zählt sie mit | 4 rot — „die Erprobung darf die Stichprobe nicht aufblähen: expected 700 to be 200" |
| Plattform-Filter entfernt | 1 rot — „ohne diesen Filter bahnt die Erprobung einen Weg zu Echtgeld" |

## Was offen bleibt

- **Der Schalter ist überall aus.** Diese Änderung ändert an keinem Konto
  etwas. Ihn zu setzen ist ein eigener, sichtbarer Schritt.
- **Ein Nutzer-Schalter auf der Plattform fehlt noch.** Heute gilt nur der
  globale (`meta/engineConfig`); die Basis-Stufe hat zusätzlich einen je
  Nutzer (`settings.auto.basis`). Wer die Erprobung plattformweit
  einschaltet, schaltet sie für alle Papier-Konten ein.
- **Die Erprobung macht keinen Kandidaten besser.** Sie erzeugt ein
  Journal, sonst nichts. Wer aus ihren Zahlen später eine Kante liest, hat
  dieselbe Stichprobe zweimal benutzt.
