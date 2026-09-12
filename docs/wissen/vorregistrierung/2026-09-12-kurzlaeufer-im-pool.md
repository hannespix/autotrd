# Vorregistrierung: Kurzlaufende Staatsanleihen in den Kandidatenpool

**Datum:** 12.09.2026 · **These:** T13 (neu) · **Config:** `config/diagnose-kurzlaeufer.yaml`
**Status vor dem Lauf:** offen. Geschrieben VOR der Messung; das Commit-Datum ist der Beweis.

## Der Befund, der das auslöst

Lauf #42 (18 Folds, 2020-07-27 … 2026-09-11, Bärenmarkt 2022 enthalten):
`momentum_pullback` besteht acht von zehn Gates und fällt an
`fold_positive_share` (9 von 18 Quartalen positiv, verlangt 60 %) und
`fold_concentration`. Die Folds 1 bis 5 — Oktober 2021 bis Dezember 2022 —
sind ausnahmslos negativ oder leer.

Prüfung des Kandidatenpools von `config/platform.yaml` (139 Symbole):

| Papier | im Pool | 2022 |
|---|---|---|
| IEF, TLT (Staatsanleihen lang) | ja | stark gefallen |
| LQD, HYG (Unternehmens-, Hochzinsanleihen) | ja | gefallen |
| GLD, SLV (Edelmetalle) | ja | etwa flach |
| BIL, SHV, SHY (Kurzläufer, Geldmarkt) | **nein** | **positiv** |
| AGG, BND, TIP | nein | gefallen |

**Im gesamten Pool gibt es kein Papier, das 2022 verdient hat.** Damit kann
keine long-only-Strategie in einem fallenden Markt ein positives Quartal
haben — nicht wegen ihrer Signale, sondern weil es keinen Ort gibt, an dem
man steht. `fold_positive_share ≥ 0,6` ist über ein Fenster mit Bärenmarkt
strukturell unerreichbar, solange das so bleibt.

Feinheit, die das verschärft: Ein Fold ohne Trades hat Netto 0 und zählt
NICHT als positiv. Ein Quartal bloß auszusitzen hilft dem Gate also nicht.
Im Geldmarkt zu liegen und den Zins zu verdienen, hilft.

## Die Änderung

`universe.candidates` bekommt **BIL** (1–3 Monate T-Bills) und **SHY**
(1–3 Jahre Treasuries). Zwei Symbole, sonst nichts.

Begründung der Auswahl, vor dem Lauf festgehalten:
- Es sind die Standard-Geldmarkt-Surrogate der Literatur; Keller & Keuning
  benutzen in DAA/VAA genau kurzlaufende Staatsanleihen als defensiven Pol.
- Beide sind unter den liquidesten ETFs überhaupt; die nächtliche Auswahl
  wählt nach Handelbarkeit, und daran ändert sich nichts.
- BIL ist der reine Geldmarkt (Duration unter 3 Monaten, praktisch kein
  Zinsrisiko), SHY trägt etwas Duration. Zwei Punkte auf derselben Achse,
  damit der Unterschied messbar wird und nicht geraten werden muss.
- **Keine** breiten Anleihe-ETFs (AGG, BND) und **kein** TIP: Die sind 2022
  gefallen und würden den Befund nicht adressieren.

## Was ich VOR dem Lauf erwarte (das ist die Falsifikationsvorlage)

1. Die nächtliche Auswahl nimmt BIL und SHY in den 30er-Korb auf (beide sind
   sehr liquide). Zwei Aktien fallen dafür heraus.
2. `cross_sectional_momentum` rangiert BIL in den Folds des Bärenmarkts 2022
   vorn und hält es statt Aktien. Dadurch werden **mindestens zwei** der
   Folds 1 bis 5 positiv statt negativ.
3. `fold_positive_share` von `cross_sectional_momentum` steigt um mindestens
   0,08 (also mindestens 1,5 Folds von 18).
4. Der OOS-Sharpe von `cross_sectional_momentum` steigt, nicht fällt.
5. `momentum_pullback` und `mean_reversion` ändern sich kaum — sie handeln
   Rückschläge und Umkehr, und ein Geldmarktpapier schwankt dafür zu wenig.

**Widerlegt ist die These, wenn** Punkt 2 oder 3 ausbleibt, oder wenn der
Sharpe eines Kandidaten durch die Aufnahme fällt. Dann ist der Pool nicht die
Ursache, und die Änderung wird zurückgenommen.

## Was die Änderung ausdrücklich NICHT ist

- Keine Lockerung. Alle zehn Gates, alle Schwellen, Kosten und Risiko bleiben
  Zeichen für Zeichen gleich.
- Keine Auswahl nach Ergebnis. BIL und SHY kommen in den Pool, weil sie
  handelbar sind und die defensive Seite des Universums fehlt — nicht, weil
  eine Messung sie vorn gesehen hätte. Die Messung kommt danach.
- Keine Aussage darüber, ob 2022 sich wiederholt. Sie sagt nur: Wenn Aktien
  fallen, soll es einen Ort geben, an dem das System stehen kann.

## Bekannte Schwächen dieser Vorregistrierung

- Dass Kurzläufer 2022 verdient haben, ist im Nachhinein bekannt. Die
  Aufnahme ist damit nicht frei von Rückschau — ich weiß, welches Jahr sie
  rettet. Gegengewicht: Der Mechanismus ist nicht an 2022 gebunden (ein
  Geldmarktpapier trägt in jedem Zinsumfeld den kurzen Zins), und die
  Erwartungen oben sind so formuliert, dass sie auch scheitern können.
- In einem Nullzinsumfeld (2020–2021) trägt BIL praktisch nichts. Der
  Effekt ist zinsabhängig; das gehört zum Befund und nicht in die Fußnote.
