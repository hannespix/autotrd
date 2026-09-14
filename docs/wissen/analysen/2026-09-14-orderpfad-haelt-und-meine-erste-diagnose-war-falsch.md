# Der Orderpfad hält — und meine erste Diagnose war falsch

**Läufe:** #68, #69, #70 (Rauchtest, Paper, SPY × 1, 14.09.2026) ·
**Aufgabe #40**

## Das Ergebnis

**Bestanden, alle acht Schritte.** Die ersten Trades dieses Systems
überhaupt:

| Lauf | Einstand | Ausstieg | Netto | Gebühren |
|---|---:|---:|---:|---:|
| #68 | 758,82 | 758,75 | −0,09 | 0,021 |
| #69 | 758,20 | 758,19 | −0,03 | 0,021 |
| #70 | 758,54 | 758,49 | −0,07 | 0,021 |

Drei Round-Trips, zusammen −0,19 $. Das ist ein Mechanik-Beweis, kein
Handelsergebnis — die Trades tragen `rauchtestKind` und werden von
`readiness.ts` nie gezählt.

Was jeder Schritt belegt hat: Vorbedingungen (Paper, Markt offen, PDT frei),
Bracket-Einstieg mit GTC, Idempotenz auch nach simuliertem Neustart, Fill,
Stop und Ziel beim Broker mit der Rundung aus §4, Abgleich Buch ↔ Broker,
Storno vor eigenem Exit, Aufräumen mit Nachsehen.

**Der vorhergesagte Überraschungsfall trat NICHT ein.** Alpaca hat die
Bracket-Order mit GTC auf einer Marktorder anstandslos angenommen; kein 422,
an keiner Stelle.

## Die Rundung, gemessen statt behauptet

| | roh | beim Broker | Richtung |
|---|---:|---:|---|
| Stop (long) | 720,6035 | **720,60** | vom Kurs WEG, also abwärts ✔ |
| Ziel (long) | 796,4565 | **796,45** | zum Kurs HIN, also abwärts ✔ |

Beide wie in §4 vorgeschrieben.

## Meine erste Diagnose war falsch

Läufe #68 und #69 meldeten `stopBeinId: null, zielBeinId: null` — eine
Position scheinbar ohne Stop beim Broker, also die Fehlerklasse, gegen die
§0.4 steht.

**Erste Diagnose (falsch):** ein Rennen. Schritt 5 war der einzige der Kette
ohne Warten und fragte 211 ms nach dem Fill; Alpaca legt die Beine
asynchron an. Ich gab dem Schritt Geduld.

**Lauf #69 hat das widerlegt:** Er wartete volle 40 Runden — 60 Sekunden —
und fand trotzdem nichts (`beineRunden: 40`).

**Die wirkliche Ursache:** `eigeneOffene()` fragt
`listOrders({ status: 'open', nested: true })`. Alpaca filtert dabei die
OBERSTE Ebene. Nach dem Fill ist die Eltern-Order `filled`, nicht `open` —
sie fällt aus der Antwort und nimmt die unter ihr verschachtelten Beine mit.
Die Abfrage konnte die Beine nach dem Fill **strukturell nicht sehen**.

Behoben: Der Schritt fragt die Eltern-Order direkt (`getOrder`, ihre ID steht
seit dem Einstieg fest) und behält die offene Liste als zweite Quelle.

## Der Beleg, dass die Engine nie im Unrecht war

Im bestandenen Lauf:

```
stopBeinId:        "d2ec70cf-292d-405b-b097-afa2795393e9"
schutzStopImBuch:  "d2ec70cf-292d-405b-b097-afa2795393e9"
```

**Dieselbe ID.** Der Stop, den das Buch führt, IST das Stop-Bein beim
Broker. Das stand auch in den beiden gescheiterten Läufen schon so da
(`schutzStopImBuch` trug jedes Mal eine ID, und beim Ausstieg ließ sich
jedes Mal genau eine Schutzorder stornieren) — ich habe die Zeile gelesen und
ihre Bedeutung erst im dritten Anlauf verstanden.

**Es gab zu keinem Zeitpunkt eine Position ohne Stop.** Blind war die
Prüfung, nicht die Maschinerie.

## Was `beineRunden: 1` nachträglich sagt

Im bestandenen Lauf waren die Beine sofort da — über die Eltern-Order, in
der ersten Runde. Die Geduld aus dem ersten Fix wurde also in keinem der
drei Läufe gebraucht. Sie bleibt trotzdem drin: Dass Kinder-Beine erst nach
dem Fill entstehen, ist bei Alpaca dokumentiert, und ein Wächter deckt den
Fall ab. Aber sie ist Vorsorge, kein gemessener Bedarf — das gehört
dazugesagt.

## Die Lehre, und sie ist dieselbe wie gestern Nacht

`FakeAlpaca` war an **beiden** Stellen großzügiger als Alpaca: Es liefert
die Beine sofort, UND es gibt einen gefüllten Elternteil zurück, sobald
irgendein Kind offen ist. Deshalb konnte der bestehende Wächter keinen der
beiden Fehler sehen.

Das ist dieselbe Wurzel wie beim Bars-Cache gestern: **Die Attrappe war
entgegenkommender als die Wirklichkeit.** Beide neuen Fälle zwingen ihr das
echte Verhalten auf, und beide gehen rot, wenn man den jeweiligen Fix
zurücknimmt — wörtlich mit der Meldung des echten Laufs.

Ein Nachtrag zur Ehrlichkeit: Mein erster Versuch, den Geduld-Fix zu
brechen, lief grün. Nicht weil der Wächter nachsichtig war, sondern weil
mein Suchmuster nicht mehr passte und die Änderung wirkungslos blieb. Ein
grüner Bruchversuch ist kein Beleg — er ist eine Frage.
