# Die Basis besteht auf einem zweiten Korb nicht — das Urteil hing an den Fonds

**Läufe:** #65 (Korb 2) und #66 (Korb 1, nachgefahren) ·
**Vorregistrierung:** `vorregistrierung/2026-09-14-basis-zweiter-korb.md`

## Erst das Abbruchkriterium — es hat gegriffen, und zwar gegen mich

Der erste Anlauf war nicht auswertbar: Korb 2 lief mit Datenbeginn
2021-03-22, der Referenzlauf #63 mit 2021-03-24. Ursache war **mein eigener
Fix von gestern**: `datenAnker` hängt das Fenster seit PR #488 am letzten
Handelstag auf statt an der Wanduhr. Der Lauf fiel auf einen Sonntag, die
letzte Bar war Freitag — also holte er korrekt drei Tage mehr als #63, der
noch unter dem alten Anker lief.

Richtiger als vorher, aber anders als die Referenz. Also: Korb 1 unter dem
neuen Anker nachgefahren, **ohne vorher eine Zahl von Korb 2 anzusehen**.
Danach nennen beide Berichte `Datenbereich: 2021-03-22 … 2026-09-11`, und der
Vergleich zählt.

## Das Ergebnis

| Gate | Korb 1 (SPY IWM EFA EEM IEF TLT LQD GLD XLRE) | Korb 2 (VTI IJR VEA VWO GOVT VGLT VCIT IAU VNQ) |
|---|---|---|
| `basis_net_profit` | 6 137,45 ✔ | 4 555,28 ✔ |
| `basis_drawdown` | 11,24 % gegen 14,29 % ✔ | **14,35 % gegen 13,47 % ✘** |
| `basis_sharpe` | 0,81 gegen 0,65 ✔ | 0,70 gegen 0,68 ✔ (knapp) |
| `basis_costs` | 3,3 % ✔ | 4,7 % ✔ |
| Notbremsen | keine | keine |
| **Urteil** | **bestanden** | **nicht bestanden** |

**Erwartung 2 der Vorregistrierung ist widerlegt.**

Beide Seiten bewegen sich gegen die Basis, und das ist der Punkt:

* Die Strategie wird schlechter: Drawdown je Exposure 14,35 % statt 11,24 %.
* Die Latte wird strenger, weil der zweite Korb **liegengelassen besser
  ist**: MaxDD je Exposure 17,96 % statt 19,05 %, Sharpe 0,75 statt 0,72.
  Der Maßstab wandert mit dem Korb, wie er soll — und er wandert nach oben.

Es ist knapp (14,35 gegen 13,47, also 0,88 Punkte). Knapp ist kein Bestehen.
Die Vorregistrierung sagt: ein einziges rotes Gate genügt, und §0.9 sagt,
dass niemand nachhilft.

## Was das bedeutet

Das Urteil aus #63 — „Basis-Latte bestanden, 4/4" — **hängt an den neun
konkreten Fonds.** Neun gleichwertige Alternativen derselben neun Klassen,
nach einer vor der Auswahl festgelegten Regel gewählt, reißen die Latte.

Das ist ein stärkeres Argument gegen die Aktivierung als die fehlende
zeitliche Unabhängigkeit. Dort konnten wir nicht prüfen; hier haben wir
geprüft, und es hat nicht gehalten.

Zur Einordnung, ohne es kleinzureden: Die Basis verliert auch auf Korb 2 kein
Geld (+4 555 $ netto, auch unter Stresskosten), und ihr Sharpe hält die Latte
knapp. Was sie NICHT tut, ist das, wofür sie da wäre — den Drawdown je
Einheit Exposure um ein Viertel gegenüber dem liegengelassenen Korb senken.
Auf Korb 2 senkt sie ihn um 20 %, nicht um 25 %.

## Die Folge — vor dem Lauf festgeschrieben

> **Besteht sie nicht:** Die Basis-Stufe wird nicht aktiviert, und das Urteil
> aus #63 ist als das zu lesen, was es dann ist — ein Ergebnis von neun
> bestimmten Fonds in einem bestimmten Fenster. Kein dritter Korb, keine
> Nachbesserung, keine Suche nach der Besetzung, in der es doch klappt.

Daran ändert sich nichts. **Die Basis-Stufe bleibt aus.** Sie war die
Antwort auf „was handeln wir, solange kein Alpha-Champion besteht"; diese
Antwort trägt nicht.

Damit ist auch die Owner-Frage zu M2 (`tiers` in `platform.yaml`)
gegenstandslos: Es gibt nichts zu aktivieren, wofür man das Regelwerk ändern
müsste.

## Was nicht zitiert wird

Der Alpha-Teil beider Läufe. Wie vorregistriert: Die neun neuen ETFs mussten
in den Kandidatenpool (der Wächter in `core/config.ts` verlangt zu Recht,
dass der Basis-Korb aus dem committeten Pool stammt), VTI/VEA/VWO liegen weit
über der Kappungsgrenze des 30er-Korbs, also hat sich der Alpha-Korb
verschoben. Zwei Änderungen, kein Vergleich.

**Versuchszählung (§4a):** Ein Versuch, gezählt. Die Basis-Familie steht
damit bei V1, V2, V3, V4 und Korb 2 — fünf Regelsätze, einer davon
bestanden, und dieser eine hat die Gegenprobe nicht überlebt.
