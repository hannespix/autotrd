# Die Plattform misst ihre Gates gegen null — die Erkundungsläufe gegen BIL

**Gefunden am 15.09.2026** beim Lesen des Plattform-Berichts aus Lauf
34889637521 (18 Folds, 2020-07-27 … 2026-09-14). Kein neuer Lauf nötig: Der
Bericht sagt es in jeder Gate-Notiz selbst.

## Der Befund

```
| oos_net_profit | ✔ | 421.831 | 0 | … Maßstab: ROHES Netto (keine Zinsreihe)
                                     — Zinsertrag auf brachliegender Kasse
                                     zählt als Gewinn |
| beats_market   | ✘ | 0.146 | 0.650 | … Zins: kein Geldmarkt-Symbol
                                       konfiguriert — gegen null gerechnet |
```

Nachgeprüft in den Configs:

| | `config/platform.yaml` | `config/parken-1440.yaml` (Lauf #49) |
|---|---|---|
| `optimizer.riskFreeSymbol` | **nicht gesetzt** | `BIL` |
| `risk.cashParking` | **nicht gesetzt** | an, BIL, Band 5 Pp |
| BIL im Kandidatenpool | nein | nein (Infrastruktur, eigens geladen) |

**Die Plattform entscheidet ihren Champion auf einem milderen Maßstab als
die Läufe, mit denen wir forschen.** Das ist keine gelockerte Schwelle —
kein Zahlenwert wurde angefasst — aber die Wirkung ist dieselbe Richtung:
Gegen null gemessen sieht jeder Kandidat besser aus als gegen den Zins.

## Warum das genau jetzt auffällt

`regime_allocation` ist der **einzige Kandidat dieses Projekts, der
`beats_market` je ehrlich bestanden hat**: In #49 stand er bei
Überschuss-Sharpe 0,51 gegen 0,44 (6/10 Gates). Auf der Plattform steht
derselbe Kandidat bei 0,146 gegen 0,650.

Der Unterschied ist nicht die Strategie. Es sind zwei Dinge, die in #49
zusammen gesetzt waren und auf der Plattform beide fehlen.

## Die beiden Dinge sind NICHT dasselbe

**(A) `optimizer.riskFreeSymbol: BIL` — reine Messung.**
Alle Geld-Gates rechnen dann auf dem Überschuss über den kurzen Zins statt
über null. Ändert keinen Handel, keine Order, keine Position. Macht die
Gates **strenger** — §0.9 erlaubt strenger ausdrücklich, lockerer nie. Eine
Kante kann so nicht erzeugt werden, nur eine scheinbare verschwinden.

**(B) `risk.cashParking` mit BIL — echter Handel.**
Brachliegende Kasse liegt dann in kurzen T-Bills statt auf 0 %. Das ist eine
ökonomische Änderung, kein Messtrick: Live entsteht eine echte BIL-Position
im Konto jedes Nutzers.

## Warum (A) allein die falsche Hälfte wäre

Der Simulator verzinst freie Kasse nicht (`equity = cash + mv`,
`backtest/simulator.ts`; festgehalten in
`vorregistrierung/2026-09-13-sharpe-gegen-zins.md`). Und die gemessenen
Kandidaten binden **7 bis 26 % ihrer Equity** (Lauf 34802913110, Spalte
„gebundenes Kapital"). Setzt man nur (A), misst man ein Konto, das auf
80–90 % seines Kapitals nichts verdient, gegen einen Maßstab, der den vollen
Zins abzieht — jeder Kandidat wird um rund den Zinssatz schlechter, ohne
dass sich an der Wirklichkeit etwas ändert.

Ökonomisch kohärent ist das Paar: Wer gegen den Zins gemessen wird, soll den
Zins auch verdienen können.

## Was (B) einmal kaputtgemacht hat — und warum das behoben ist

Lauf #48 (Parken AN, Gates noch auf ROHEM Netto) erzeugte ein **Artefakt**:
`mean_reversion` hatte 16 von 16 Folds positiv, darunter drei Quartale mit
NULL Trades (+95,93 / +134,31 / +227,50). Das Parken verdiente, nicht die
Strategie.

Genau dagegen wurden die Geld-Gates auf Überschuss umgestellt. Parken in BIL
liefert dann exakt den Zins, also **0 Überschuss** — ein Quartal ohne Trade
ist kein positiver Fold mehr. (A) ist damit die Bedingung, unter der (B)
überhaupt messbar ist. Einzeln ist jedes von beiden schief; zusammen
ergeben sie #49.

## Was ich ausdrücklich NICHT behaupte

- **Dass damit etwas besteht.** `regime_allocation` stand in #49 bei 6/10.
  `fold_positive_share`, `fold_concentration` und
  `probabilistic_sharpe_oos` fielen weiter durch — und auf der Plattform
  trägt sein bester Fold **295 % des OOS-Nettos** (1 246,02 von 421,83;
  ohne ihn bleiben −824,19). Das ist genau der Fall, für den
  `fold_concentration` gebaut wurde.
- **Dass ich das unvoreingenommen gefunden habe.** Ich habe danach gesucht,
  WEIL ich wusste, dass #49 den einzigen ehrlichen `beats_market`-Treffer
  trägt. Das gehört dazugesagt. Was den Befund trotzdem trägt: (A) macht die
  Gates strenger, und eine strengere Messung kann keinen Champion
  herbeiführen. Käme nach (A)+(B) etwas durch alle zehn, hätte es eine
  härtere Prüfung bestanden als heute.
- **Dass die Reihenfolge egal ist.** (B) ohne (A) ist das Artefakt aus #48.

## Offen — Owner-Entscheidung

(A) ist eine Korrektur der Messung und für sich genommen unstrittig, aber
allein pessimistisch verzerrt. (B) legt Geld der Nutzer in ein Papier, das
vorher nicht in ihrem Konto lag. Beides zusammen ist die Konfiguration, die
als einzige je einen ehrlichen `beats_market`-Treffer erzeugt hat — und
beides zusammen ist eine Änderung an `config/platform.yaml`, die Nutzer
sehen.
