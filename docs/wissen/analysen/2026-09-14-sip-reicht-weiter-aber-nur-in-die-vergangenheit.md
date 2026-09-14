# Der Datenfeed ist die Grenze — und SIP löst sie nur halb

**Läufe:** `diagnose.yml` 34874735546 (Historie) und 34875294857 (Historie +
Gegenwart), beide read-only gegen `config/config.example.yaml`

## Die Frage

Jede Messung dieses Projekts beginnt bei **2020-07-27**. Alle 23 Configs
stehen auf `feed: iex`; `sip` kennt das Schema, benutzt hat es nie jemand.

Das ist kein Randdetail. Die Fold-Kette hängt am Datenende und wächst
rückwärts — der **Datenanfang** bestimmt also, wie viele Folds es geben
kann. Und der beste je gemessene Kandidat (`mean_reversion`, 7/10, Lauf #52
mit Gegenprobe #53) scheitert an genau den drei Gates, die Stichprobengrösse
und Verteilung prüfen:

| Gate | Wert | Schwelle |
|---|---:|---:|
| `fold_concentration` | 0,745 | 0,500 |
| `probabilistic_sharpe_oos` | 0,696 (Kurtosis 50,07) | 0,900 |
| `beats_market` | 0,255 | 0,438 |

Dieselbe Abo-Stufe deckelt über `IEX_STREAM_SYMBOL_MAX` auch den Korb auf 30.

## Der Befund

```
Feed         erreichbar  SPY ab (sondiert)  Proben (Jahr:Bars)                       letzte 10 Tage
iex (aktiv)  ja          ≤ 2021             2016:0 2018:0 2020:0 2021:23 2022:24     5 Bars
sip          ja          ≤ 2016             2016:23 2018:23 2020:23 2021:23 2022:24  NEIN — HTTP 403:
                                                                                     „subscription does not
                                                                                      permit querying recent
                                                                                      SIP data"
```

**Der vorhandene Key erreicht SIP — aber nur rückwärts.** Historie ab
mindestens 2016, aktuelle Bars: 403.

## Warum das die Umstellung NICHT erlaubt

Nach dem ersten Lauf stand nur die linke Hälfte da, und „dann stellen wir
auf `sip` um" lag nahe. Es wäre falsch gewesen.

`broker.feed` gilt laut Schema für **Backtest UND Live** — „immer derselbe,
sonst misst man etwas anderes als man handelt". Mit SIP-Historie und
IEX-Betrieb hätte der Optimierer auf konsolidierten Kursen gesucht, während
die Engine auf einem Feed mit rund zwei Prozent des Umsatzes handelt.
Hochs und Tiefs unterscheiden sich dort systematisch — und genau an Hoch und
Tief hängen ATR-Stops und Donchian-Kanäle.

Das ist wörtlich die Fehlerklasse, an der das Vorgängersystem gestorben ist
(§2: „Backtest maß Tagesbars/Long-Flat, live lief Intraday/Short").

**Die Sondierung der Gegenwart gab es beim ersten Lauf nicht.** Sie wurde
hinzugefügt, WEIL der erste Befund verführerisch war — nicht, nachdem der
Fehler passiert ist.

## Was daraus folgt

Die Historie ist mit dem heutigen Abo **nicht** erweiterbar, ohne §0.1 zu
brechen. Damit bleibt es bei rund sechs Jahren Daten, einer OOS-Kette von
rund vier Jahren, 16 Folds und einem Korb von 30 Symbolen.

Ob das gelockert wird, ist eine **Owner-Entscheidung mit Kosten** (Alpacas
bezahlte Stufe hebt die Gegenwartssperre auf und liefert den SIP-Strom).
Sie wird hier nicht getroffen und nicht vorweggenommen.

## Was ausdrücklich offen bleibt

- Die Sondierung prüft Jahre, nicht Tage. `≤ 2016` ist eine **Untergrenze**
  der Reichweite, keine Feststellung des Datenbeginns. SIP kann weiter
  zurückreichen.
- Ob mehr Historie die drei roten Gates wirklich grün macht, ist **nicht
  gezeigt**. Mehr Folds helfen `probabilistic_sharpe_oos` und
  `fold_concentration` rechnerisch; `beats_market` ist davon unberührt — wer
  gegen kaufen-und-liegenlassen verliert, verliert auch über zehn Jahre,
  wenn keine Kante da ist. Eine längere Reihe kann eine Kante belegen; sie
  erzeugt keine.
