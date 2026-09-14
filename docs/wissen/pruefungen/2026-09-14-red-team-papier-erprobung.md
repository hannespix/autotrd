# Red-Team über die Papier-Erprobung — zwei Wege zu Echtgeld, die ich übersehen hatte

**Prüfer:** eigener Agent, hat nicht gebaut, Auftrag zu WIDERLEGEN (§6) ·
**Gegenstand:** Commit `a4dd7f5` · **Leitfrage:** „Finde einen Weg, auf dem
ein Trade der Papier-Erprobung am Ende echtes Geld bewegt."

Er hat zwei gefunden. Beide sind behoben.

## K1 — Geteilte Plätze und geteilte Notbremse (BESTÄTIGT, behoben)

Meine Behauptung im ersten Commit: „Die Erprobung übersteuert nie etwas",
und „ihre Trades zählen nicht für die Live-Reife". Das erste war falsch, und
dadurch wurde das zweite hohl.

Nachgeprüft und bestätigt:

- `openCount` und `risk.maxPositions` (Vorgabe 4) sind **stufenblind**
  (`core/logic.ts:741, 951`). Vier Erprobungs-Positionen sperren jeden
  Champion-Einstieg.
- Die Rangordnung ist es auch, und zwar gegen den Champion:
  `korbRaenge` (`core/logic.ts:389-414`) vergibt Ränge **nur** an Symbole mit
  `crossScore`; ranglose sortieren mit `POSITIVE_INFINITY` ans Ende
  (`:758-765`). Ein durchgefallener `cross_sectional_momentum`-Kandidat wird
  damit **vor** einem Alpha-Champion bedient.
- `stufeOf('erprobung') === 'other'` ⇒ Erprobungs-Verluste laufen in die
  **Konto**-Notbremse. Löst sie aus, werden ALLE Positionen glattgestellt,
  auch die des Champions — und diese Zwangs-Exits tragen `stufe: 'champion'`
  und zählen voll in `readiness` und `stats/main`.

Der Weg lautet also: Erprobung verliert ⇒ Tagesbremse ⇒ Champion-Positionen
werden zwangsweise mit Verlust geschlossen ⇒ diese Verluste stehen in
`stats/main` ⇒ `reifeFuerKonto` ⇒ Echtgeld-Freigabe.

**Behoben durch Ausschließlichkeit:** Führt irgendein Symbol ein
Alpha-Champion oder hat die Basis Einstiegsrecht, bleibt die Erprobung GANZ
aus. Das schneidet Plätze, Rangordnung, Equity, Brutto-Budget, PDT und die
Notbremse in einem Schnitt ab — und kostet nichts, weil die Stufe genau für
den Zustand existiert, in dem nichts besteht.

## K2 — Adoption löscht die Herkunft (BESTÄTIGT, behoben)

`engine/reconcile.ts:167-169` legt Fremdbestand als `strategy: 'adopted'`
**ohne** `stufe` an. `istErprobung` ist dann falsch, der Trade zählt. Auf der
Plattform greift auch der Rückfall `stufeFor` nicht, weil die Strategie
`'adopted'` heißt und nie zu einer Wahl passt.

Vorbedingung ist `engine.onOrphan: 'adopt'` — Vorgabe und alle Configs stehen
auf `halt`. Trotzdem ein unterstützter Schalter.

**Behoben:** Bei `onOrphan: 'adopt'` bleibt die Erprobung aus. Die Stufe hängt
an der Herkunft; wer die Herkunft löscht, bekommt die Stufe nicht.

## M3 — Mein Kommentar war falsch, und die „Korrektur" wäre die Lockerung (BESTÄTIGT, behoben)

Ich hatte geschrieben, `zugang.verbindung.mode` sei `resolveBrokerMode`. Es
stammt aus `users/{uid}/private/broker.mode`, das `connectBroker` aus dem
**Schlüssel-Präfix** ableitet. Sachlich ist das strenger — aber wer dem
Kommentar folgt und tatsächlich auf `resolveBrokerMode` umstellt, bekommt für
ein Live-Konto **ohne Reife** ausdrücklich `'paper'` (`liveGate.ts:69`) und
hätte die Erprobung auf einem Konto mit Echtgeld-Schlüssel freigeschaltet.

Ein falscher Kommentar an einer Sicherung ist gefährlicher als gar keiner.
Korrigiert an allen vier Stellen, mit der Warnung „nicht umstellen".

## M4 — Die Plattform-Hälfte war tot (BESTÄTIGT, behoben)

`scripts/module/engineConfig.mjs` trug nur `strategy.basis`; `erprobung`
wäre im Takt still auf den zod-Default `false` gefallen, und ein von Hand
gesetzter Wert verschwände beim nächsten `set()` ohne merge. Der Schalter
geht jetzt mit, und der Wächter in `test/scripts/umstieg.test.ts` pinnt das.

## M5 — Teilweise WIDERLEGT

Der Prüfer schreibt, eine offene Position bleibe ohne Exit stehen, wenn die
Wahl wegfällt (`engine.ts:686 if (!choice) continue;`) — §0.4 verletzt.

Der Mechanismus stimmt, der Schluss nicht: Achtzig Zeilen weiter sammelt
`ohneFuehrung` (`engine.ts:771-782`) genau die Positionen ohne Führung ein
und stellt sie als `unmanaged` glatt. Die Position hängt also nicht, sie wird
geräumt. **§0.4 ist nicht verletzt.**

Was bleibt: Das ist gröber als bei der Basis-Stufe, die ihren Bestand mit
`entriesAllowed: false` zu Ende führt. Für eine Papier-Stufe vertretbar —
jetzt ausdrücklich im Modulkopf genannt statt stillschweigend in Kauf
genommen.

## G6, G7 — beide berechtigt, beide behoben

- **G6:** toter Code in `erprobungSperre` (beide Zweige `return null`) —
  entfernt.
- **G7:** Die ersten Plattform-Wächter waren **Textsuchen** in Quelldateien.
  Sie hätten K1 und K2 nie gesehen. Jetzt läuft `buildStrategyFor` in
  `functions/test/engine/strategyFor.test.ts` wirklich — mit Erprobungs-Block,
  Live-Modus, Schalter aus, K1 und K2.

  Das ist zum dritten Mal in drei Tagen dieselbe Lehre: **Ein Wächter, der
  nur Text liest oder eine gefällige Fälschung befragt, ist grün, während der
  Fehler lebt.**

## Offen, mit Absicht

- **G8/G9:** `stats/main.reibung` und das 500-Doc-Fenster von
  `snapshotEquity` sehen Erprobungs-Docs noch. `reibung` liest kein Gate; die
  Fensterverdrängung ist real, aber richtungslos und betrifft nur die
  Stichprobengröße. Mit der Ausschließlichkeit aus K1 kann ohnehin nie beides
  gleichzeitig laufen — notiert, nicht behoben.
- **G10:** Ein unbekannter Strategie-Name im Block wirft im eigenen Prozess
  und wird auf der Plattform gefangen — zwei Verhalten für denselben
  Datenfehler (§0.1). Notiert.

## Was ich daraus mitnehme

Ich hatte (c) — „kein Weg in die Live-Reife" — als die Sperre bezeichnet, die
man übersieht, und war stolz darauf, sie gefunden zu haben. Der Prüfer hat
gezeigt, dass ich sie nur zur Hälfte gefunden hatte: Die eigenen Trades
auszuschließen genügt nicht, wenn die Stufe die Trades der ANDEREN Stufe
verändern kann. Ein Ausschluss je Trade ist kein Ausschluss je Wirkung.
