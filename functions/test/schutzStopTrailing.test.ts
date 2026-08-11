/**
 * Audit-Befund 11.08.: Der Broker-Schutz-Stop kannte das „erst wenn im Plus"
 * des Trailings nicht — und verkaufte Positionen, die die Engine gehalten
 * hätte.
 *
 * ── Der Befund ────────────────────────────────────────────────────────────
 *
 * `riskExitReason` führt das Trailing mit einer zusätzlichen Bedingung:
 *
 *     if (peak > pos.avgEntry && atMost(price, peak * (1 - trailPct / 100)))
 *
 * `schutzStopPreis` spiegelt dieselbe Regel für die GTC-Order beim Broker —
 * ohne das `peak > avgEntry`. Beim Einstieg ist `highWater` gleich dem
 * Einstand, der Trailing-Kandidat wurde also vom EINSTAND aus gerechnet und
 * gewann das `Math.max`, sobald `trailingStopPct < stopLossPct`.
 *
 * Das ist keine Anzeige, sondern eine echte Order: Sie verkauft wirklich.
 *
 * ── Warum das teuer war ───────────────────────────────────────────────────
 *
 * Bei „fester Stop aus, nur Trailing" — `stopLossPct: 0` (⇒ clampStrategyRisk
 * setzt die 25-%-Notbremse), `trailingStopPct: 3` — und einem Einstieg über
 * 50 Stück AAPL zu 200,00:
 *
 *     Engine        Stop bei 150,00; Trailing inaktiv (peak = 200, nicht > 200)
 *     Schutz-Stop   max(150,00 ; 194,00) = 194,00
 *
 * Bei 193,80 löste die Order aus: 300 $ realisierter Verlust auf einer
 * Position, die nach den eigenen Regeln bis 150,00 laufen durfte — 22
 * Prozentpunkte zwischen beabsichtigtem und tatsächlichem Stop. Gebucht wurde
 * der Fill danach als regulärer `stop_loss`; die Statistik sah nichts.
 *
 * Mit den ausgelieferten Defaults (2 % Stop, 3 % Trailing) tritt es nicht auf,
 * weil dort der Einstands-Stop gewinnt.
 */
import { describe, expect, it } from 'vitest';
import { schutzStopPreis } from '../src/core/schutzStop.js';
import type { RiskConfig } from '../../shared/src/index.js';

/** Die Konstellation aus dem Befund: enges Trailing, weiter Einstands-Stop. */
const ENG: RiskConfig = { stopLossPct: 25, takeProfitPct: 0, trailingStopPct: 3 };
/** Die ausgelieferten Defaults — hier war nie etwas kaputt. */
const DEFAULT: RiskConfig = { stopLossPct: 2, takeProfitPct: 4, trailingStopPct: 3 };

describe('Long: das Trailing zählt erst, wenn die Position im Plus war', () => {
  it('frisch eröffnet gilt der EINSTANDS-Stop, nicht das Trailing', () => {
    // Der eigentliche Befund. Vorher: 194 (−3 % vom Einstand).
    expect(schutzStopPreis({ side: 'long', qty: 50, avgEntry: 200, highWater: 200 }, ENG)).toBe(150);
  });

  it('ohne highWater ebenso', () => {
    expect(schutzStopPreis({ side: 'long', qty: 50, avgEntry: 200 }, ENG)).toBe(150);
    expect(schutzStopPreis({ side: 'long', qty: 50, avgEntry: 200, highWater: null }, ENG)).toBe(
      150,
    );
  });

  it('ein Hoch UNTER dem Einstand aktiviert es auch nicht', () => {
    // Kann vorkommen, wenn highWater aus einer Teilausführung stammt.
    expect(schutzStopPreis({ side: 'long', qty: 50, avgEntry: 200, highWater: 190 }, ENG)).toBe(150);
  });

  it('sobald die Position im Plus WAR, zieht das Trailing nach', () => {
    // Kurs lief auf 240 ⇒ Trailing bei 232,80, das ist besser als 150.
    expect(schutzStopPreis({ side: 'long', qty: 50, avgEntry: 200, highWater: 240 }, ENG)).toBe(
      232.8,
    );
  });

  it('EIN CENT im Plus reicht — und dann springt der Stop', () => {
    /* Bei 200,01 ist `highWater > avgEntry` erfüllt, das Trailing greift und
     * hebt den Stop von 150,00 auf 194,00. Der Sprung ist beabsichtigt und
     * NICHT der Befund: `riskExitReason` schaltet an derselben Schwelle um
     * (`peak > pos.avgEntry`). Der Fehler war, dass er auch OHNE einen Cent
     * Gewinn passierte — dann ist er nicht die Absicherung eines Gewinns,
     * sondern ein Stop, den niemand eingestellt hat. */
    expect(schutzStopPreis({ side: 'long', qty: 50, avgEntry: 200, highWater: 200.01 }, ENG)).toBe(
      194,
    );
    // Der Gegenfall, ein Cent darunter: Einstands-Stop.
    expect(schutzStopPreis({ side: 'long', qty: 50, avgEntry: 200, highWater: 199.99 }, ENG)).toBe(
      150,
    );
  });

  it('bei den Defaults zieht das Trailing im Plus wie gewohnt nach', () => {
    expect(schutzStopPreis({ side: 'long', qty: 50, avgEntry: 200, highWater: 220 }, DEFAULT)).toBe(
      213.4,
    );
  });

  it('die ausgelieferten Defaults verhalten sich unverändert', () => {
    // Hier gewann schon vorher der Einstands-Stop (196 > 194).
    expect(schutzStopPreis({ side: 'long', qty: 50, avgEntry: 200, highWater: 200 }, DEFAULT)).toBe(
      196,
    );
  });
});

describe('Short: dieselbe Regel gespiegelt', () => {
  const ENG_S: RiskConfig = { stopLossPct: 25, takeProfitPct: 0, trailingStopPct: 3 };

  it('frisch eröffnet gilt der Einstands-Stop ÜBER dem Einstand', () => {
    // Vorher: 206 (+3 %) — der Broker hätte bei +3 % eingedeckt, während die
    // Engine bis +25 % hält.
    expect(schutzStopPreis({ side: 'short', qty: 50, avgEntry: 200, lowWater: 200 }, ENG_S)).toBe(
      250,
    );
  });

  it('ein Tief ÜBER dem Einstand aktiviert das Trailing nicht', () => {
    expect(schutzStopPreis({ side: 'short', qty: 50, avgEntry: 200, lowWater: 210 }, ENG_S)).toBe(
      250,
    );
  });

  it('sobald der Kurs UNTER dem Einstand war, zieht es nach', () => {
    // Tief bei 160 ⇒ Eindecken bei 164,80.
    expect(schutzStopPreis({ side: 'short', qty: 50, avgEntry: 200, lowWater: 160 }, ENG_S)).toBe(
      164.8,
    );
  });
});

describe('Nur Trailing konfiguriert, noch nie im Plus', () => {
  const NUR_TRAIL: RiskConfig = { stopLossPct: 0, takeProfitPct: 0, trailingStopPct: 3 };

  it('ergibt KEIN Stop-Niveau — die Engine führt gerade auch keins', () => {
    /* Vorher wäre hier eine Order vom Einstand aus entstanden: genau der
     * Befund, nur ohne konkurrierenden Einstands-Stop, der ihn abfängt.
     *
     * `null` heißt für `schutzPlan`: nicht anlegen (`kein_prozent_stop`), und
     * für die Pflege: bestehende Order unangetastet lassen. Über die Engine
     * ist die Lage ohnehin unerreichbar — `clampStrategyRisk` ersetzt einen
     * `stopLossPct` von 0 durch die 25-%-Notbremse. */
    expect(schutzStopPreis({ side: 'long', qty: 10, avgEntry: 100, highWater: 100 }, NUR_TRAIL)).toBe(
      null,
    );
    expect(
      schutzStopPreis({ side: 'short', qty: 10, avgEntry: 100, lowWater: 100 }, NUR_TRAIL),
    ).toBe(null);
  });

  it('sobald die Position im Plus war, entsteht es', () => {
    expect(schutzStopPreis({ side: 'long', qty: 10, avgEntry: 100, highWater: 120 }, NUR_TRAIL)).toBe(
      116.4,
    );
  });

  it('ganz ohne Prozent-Stop bleibt es wie bisher null', () => {
    const KEINS: RiskConfig = { stopLossPct: 0, takeProfitPct: 0, trailingStopPct: 0 };
    expect(schutzStopPreis({ side: 'long', qty: 10, avgEntry: 100, highWater: 120 }, KEINS)).toBe(
      null,
    );
  });
});
