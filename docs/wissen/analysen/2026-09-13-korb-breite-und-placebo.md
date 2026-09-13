# Reservierte Plätze im Korb: die Gegenprobe hält — und reicht trotzdem nicht

**Läufe:** #52 (`korb-breite-1440`, Gruppe TLT/IEF/GLD/SLV) und #53
(`korb-breite-placebo-1440`, Gruppe DELL/V/NOW/CSCO) gegen **#49** (ohne
reservierte Plätze) · **Vorregistrierung:**
`vorregistrierung/2026-09-13-korb-breite.md` samt Nachtrag, VOR Lauf #53
geschrieben

## Kurz

Zwei der 30 Korbplätze für Diversifizierer heben `mean_reversion` von 4 auf
**7 von 10 Gates** — das beste Ergebnis dieses Projekts. Die Gegenprobe mit
Aktien statt Diversifizierern reproduziert das **nicht**: dort fällt derselbe
Kandidat auf 3 von 10.

Damit ist die naheliegende Alternativerklärung ausgeschlossen: Es wirkt nicht
„zwei frische Zeitreihen", sondern die Assetklasse.

**Befördert wird trotzdem nichts**, und zwar nicht aus Vorsicht, sondern
wegen der drei roten Gates, die bleiben.

## Der Aufbau, der die Aussage trägt

Beide Läufe sind Zeichen für Zeichen `config/parken-1440.yaml` (#49) mit
genau einer Änderung — zwei reservierte Plätze — und unterscheiden sich
untereinander **nur in der Assetklasse der Einsteiger**:

| | Gruppe | Plätze bekamen | Ränge | Verdrängt |
|---|---|---|---|---|
| #52 | TLT, IEF, GLD, SLV | **TLT, GLD** | 32, 56 | **LLY, XLV** |
| #53 | DELL, V, NOW, CSCO | **DELL, V** | 31, 34 | **LLY, XLV** |

Dieselbe Zahl Plätze, dieselben zwei verdrängten Papiere, vergleichbare
Ränge, 28 von 30 Korbmitgliedern identisch. Was sich unterscheidet, ist
allein, WAS hereinkommt.

## Das Ergebnis

| Kandidat | #49 ohne | #52 Diversifizierer | #53 Placebo (Aktien) |
|---|---:|---:|---:|
| `mean_reversion` | 4/10 | **7/10** | **3/10** |
| `regime_allocation` | 6/10 | 5/10 | 6/10 |
| `cross_sectional_momentum` | 6/10 | 6/10 | 6/10 |
| `momentum_pullback` | 5/10 | 5/10 | 5/10 |
| `trend_donchian` | 5/10 | 5/10 | 5/10 |

**In #53 sind vier der fünf Kandidaten gate-identisch mit #49** — bis auf die
Namen der durchgefallenen Gates dieselbe Liste. Nur `mean_reversion` bewegt
sich, und zwar nach unten. Eine sauberere Kontrollgruppe hätte man nicht
bestellen können: Zwei Aktien gegen zwei Aktien zu tauschen tut in einem
Korb aus 28 Aktien praktisch nichts.

Die vorregistrierte Falsifikationsschwelle lautete: legt `mean_reversion` im
Placebo um ≥ 2 Gates zu oder erreicht `fold_positive_share ≥ 0,6`, ist T21
widerlegt. Es verlor ein Gate und kam auf `fold_positive_share` 0,438.
**T21 übersteht die Prüfung.**

## Was damit NICHT gezeigt ist

Die Gegenprobe schließt eine Alternativerklärung aus. Sie macht aus dem
Befund keine Kante. Drei Gates bleiben rot, und jedes einzelne ist ein
K.-o.-Kriterium:

| Gate | Wert | Schwelle | Was es heißt |
|---|---:|---:|---|
| `beats_market` | 0,255 | 0,438 | OOS-Sharpe 0,26 gegen 0,44 aus SPY kaufen-und-liegenlassen. **Der Kandidat verliert gegen Nichtstun.** |
| `fold_concentration` | 0,745 | 0,500 | Ein Fold trägt 74 % des OOS-Überschusses (252,58 von 339,08). Ohne ihn bleiben **86,50 $ über fünfeinhalb Jahre**. |
| `probabilistic_sharpe_oos` | 0,696 | 0,900 | Bei Schiefe 2,21 und Kurtosis 50,07 ist der Sharpe nicht verlässlich von null zu trennen. |

Die Kurtosis von 50 ist dabei die deutlichste Warnung: Eine Verteilung mit
so schweren Rändern wird von wenigen Tagen bestimmt. Zusammen mit
`fold_concentration` 0,745 ergibt das dasselbe Bild aus zwei Richtungen —
**das Geld kommt aus einem Quartal, nicht aus einer Methode.**

Dazu die Grenzen des Aufbaus, die kein Lauf wegnimmt:

1. **Hindsight bleibt.** Dass „Anleihen und Gold streuen" meine Erwartung
   war, stammt aus der Vergangenheit dieser Papiere. Die Gegenprobe zeigt,
   dass der Effekt an der Assetklasse hängt — sie zeigt nicht, dass ich die
   Assetklasse ohne Kenntnis ihrer Vergangenheit gewählt hätte.
2. **n = 1 Fenster, n = 2 Symbole.** Ein Messfenster, zwei Papiere. Dass 2022
   Aktien und lange Treasuries gemeinsam verloren, liegt IM Fenster und hat
   den Effekt nicht verhindert — aber ein zweites Fenster hat niemand gesehen.
3. **Die Wirkung läuft über einen anderen Weg als gedacht.** Vorhergesagt war,
   dass die KORB-Kandidaten im Bärenmarkt ausweichen. Sie tun es nicht:
   `cross_sectional_momentum` steht unverändert, `regime_allocation` wird in
   #52 sogar schlechter (6/10 auf 5/10). Gewirkt hat es auf eine SYMBOLWEISE
   Familie, die schlicht zwei neue Zeitreihen zum Handeln bekam.

Punkt 3 ist der ehrlichste Teil: Die Erwartung war richtig im Ergebnis und
falsch in der Begründung. Wer daraus „Streuung hilft der Rangliste" liest,
liest etwas, das hier gerade widerlegt wurde.

## Was daraus folgt

- `universe.reserve` bleibt im Code, bleibt per Vorgabe **aus**, und
  `config/platform.yaml` bleibt unberührt. Es ist ein gemessenes Werkzeug
  ohne belegten Nutzen für den Betrieb.
- Nichts wird befördert. Ein Kandidat, der gegen kaufen-und-liegenlassen
  verliert, ist kein Champion — unabhängig davon, wie viele der übrigen
  Gates er besteht.
- Die nächste Frage ist nicht „mehr Plätze" (das wäre das Variieren einer
  vorregistrierten Zahl, und dann zählt man Versuche), sondern ob der Effekt
  ein zweites Messfenster überlebt. Eine Falsifikation mit `--as-of` ist der
  nächste Schritt und kostet einen Lauf.
