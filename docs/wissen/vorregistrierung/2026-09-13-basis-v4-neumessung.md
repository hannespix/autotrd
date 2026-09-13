# Vorregistrierung: V3 und V4 neu messen — diesmal auf denselben Daten

**Datum:** 13.09.2026, nachts · **Vor dem Lauf geschrieben.**
**Anlass:** `analysen/2026-09-13-alpha-verschiebung-war-der-bars-cache.md`

## Warum überhaupt noch einmal

Der Vergleich V3 gegen V4 sollte EINE Änderung messen (`risk.tiers.basis`).
Er hat zwei gemessen: Die Workflows hashten die ganze Config-Datei als
Cache-Schlüssel, also bekam jede Config ihren eigenen Bars-Cache, und die
beiden Eimer füllten sich verschieden — #56 sah Daten ab 2021-03-22, #59 ab
2021-03-24.

Ein Vergleich mit zwei Änderungen trägt kein Urteil. Weder das über das Alpha
(„Erwartung 4 widerlegt" — zurückgenommen) noch, in seiner Höhe, das über die
Basis („4/4 bestanden").

Behoben ist der Messstand (PR #487): `basis-1440-v3.yaml` und
`basis-1440-v4.yaml` tragen jetzt denselben Cache-Schlüssel
(`us_equity-iex-all`).

## Der Lauf

Zwei Probe-Läufe NACHEINANDER, nicht parallel (`concurrency: probe` erzwingt
das ohnehin):

1. `config/basis-1440-v3.yaml` — füllt den gemeinsamen Cache.
2. `config/basis-1440-v4.yaml` — stellt ihn wieder her.

Ohne `--as-of`, ohne `samples`-Übersteuerung, ohne `allowShort`. Der erste
Lauf lädt neu (die alten Eimer liegen unter alten Schlüsseln); der zweite
erbt seinen Cache.

## Abbruchkriterium — vor dem Lauf festgelegt

**Nennen die beiden Berichte in Zeile 4 nicht denselben `Datenbereich`, ist
der Vergleich wieder keiner, und aus ihm wird NICHTS geschlossen** — weder
für das Alpha noch für die Basis. Dann ist der Fix unvollständig, und das ist
der Befund.

Das ist derselbe Fehler, der diese Neumessung nötig macht. Er wird hier nicht
noch einmal übersehen, weil das Kriterium vor dem Lauf steht.

## Erwartungen

| # | Erwartung | Woran sie scheitert |
|---|---|---|
| 1 | Beide Berichte nennen denselben Datenbereich. | Verschiedene Bereiche ⇒ Abbruch (siehe oben). |
| 2 | Das ALPHA ist zwischen V3 und V4 **ziffernidentisch** — alle fünf Kandidaten, gleiche Trades, gleiches Netto, gleiche Gate-Urteile. | Jede Abweichung. Das ist Erwartung 4 der V4-Vorregistrierung, zum ersten Mal wirklich prüfbar. |
| 3 | Die Basis löst in V3 `konto:daily_loss` aus (3× erwartet, erste 2024-08-05), in V4 keinmal. | Keine Auslösung in V3, oder eine in V4. |
| 4 | Die Basis besteht in V4 ihre vier Gates und scheitert in V3. | Ein anderes Urteil als bisher — dann trug die alte Zahl die Datenlücke, nicht die Bremse. |

Erwartung 2 ist die eigentliche Messung. Trifft sie zu, hat `risk.tiers.basis`
keine Nebenwirkung auf das Alpha, und die Owner-Frage von damals bleibt
gegenstandslos. Trifft sie NICHT zu, gibt es doch eine Wirkung im Kern, und
die 120 synthetischen Szenarien haben ihren Fall nicht getroffen — dann ist
der Unterschied zu suchen, nicht zu deuten.

## Was auch bei vollem Erfolg NICHT folgt

**Keine Aktivierung der Basis-Stufe.** Es ist derselbe Datenzeitraum wie V2
und V3; ein bestandener Lauf bestätigt die Ursachenanalyse und ist kein neuer
Beleg für die Basis. Es bleiben offen:

- `risk.tiers.basis` gehört in `config/platform.yaml`, sonst gilt die
  bestandene Latte für ein Regelwerk, das niemand handelt (Prüferbefund M2).
- Wirklich unabhängige Falsifikationen. `--as-of −15/−30 Tage` sind es nicht:
  Die Fold-Kette ist am Datenende verankert, die Überlappung liegt über 90 %
  (Prüferbefund M4).

**Versuchszählung (§4a):** Diese Neumessung ist KEIN neuer Versuch. Sie
variiert keine gesuchte Größe, sondern stellt her, dass der bereits gezählte
Versuch V3→V4 die Bedingung erfüllt, unter der er gezählt wurde.
