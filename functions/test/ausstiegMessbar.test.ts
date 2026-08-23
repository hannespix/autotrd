/**
 * Zwei Mess-Reparaturen am Ausstieg — beide am 23.08. an einer gescheiterten
 * Auswertung entstanden, keine ändert Verhalten.
 *
 * Der Anlass: Der Eimer `trailing_stop` stand mit −2.253 $ auf neun Trades da,
 * und ich wollte daraus schließen, dass der nachziehende Stop Geld kostet. Ein
 * Widerlegungs-Durchgang hat das zerlegt — unter anderem mit zwei Befunden,
 * die nicht die Auswertung betrafen, sondern die MESSUNG selbst:
 *
 *   1. Die Eimer trennen die Mechanismen nicht. `pflegeSchutz` buchte JEDEN
 *      Fill des Broker-Netzes hart als `stop_loss`, obwohl das Netz die
 *      ENGERE der beiden Marken wählt. Löste dort die Trailing-Marke aus,
 *      landete der Trade im Eimer des Einstands-Stops. `stop_loss` war damit
 *      eine Mischung, `trailing_stop` nur der Engine-Zweig — der Vergleich maß
 *      das Trailing zu einem unbekannten Teil gegen sich selbst.
 *
 *   2. Der Extremkurs fehlte am Trade. Damit ist grundsätzlich nicht
 *      feststellbar, ob ein Trailing-Exit einen Gewinn GESICHERT oder einen
 *      Aufschwung ABGESCHNITTEN hat — beide Fälle sehen im Trade-Log gleich
 *      aus. Ohne diese Zahl bleibt jede Trailing-Bewertung Meinung, egal wie
 *      lange man sammelt.
 *
 * Beides ist additiv und rein beschreibend. Kein Buchungspfad, keine
 * Handelsentscheidung und kein Sicherheitsnetz hängt daran.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schutzQuelle } from '../src/core/schutzStop.js';
import type { RiskConfig } from '@autotrd/shared';

const RISK: RiskConfig = { stopLossPct: 2, takeProfitPct: 4, trailingStopPct: 3 };

describe('schutzQuelle — an welcher Marke stand die Order', () => {
  describe('Long', () => {
    const lage = { avgEntry: 100, side: 'long' as const };
    // Einstands-Stop = 100 × (1 − 2 %) = 98,00

    it('eine Order AM Einstands-Stop stammt vom Einstands-Stop', () => {
      expect(schutzQuelle(98, lage, RISK)).toBe('einstand');
    });

    it('eine ENGERE Order kann nur vom Trailing stammen', () => {
      // Es gibt nur zwei Kandidaten; wer 98,00 schlägt, ist der andere.
      expect(schutzQuelle(99, lage, RISK)).toBe('trailing');
      expect(schutzQuelle(104.6, lage, RISK)).toBe('trailing');
    });

    it('eine WEITERE Order ist keine Trailing-Marke', () => {
      // Kann bei Altbestand oder geänderter Konfiguration vorkommen. Im
      // Zweifel das bisherige Etikett — nie raten.
      expect(schutzQuelle(95, lage, RISK)).toBe('einstand');
    });

    it('Rundung im Cent-Raster ist dieselbe Marke', () => {
      expect(schutzQuelle(98.00001, lage, RISK)).toBe('einstand');
      expect(schutzQuelle(97.99999, lage, RISK)).toBe('einstand');
    });
  });

  describe('Short — gespiegelt', () => {
    const lage = { avgEntry: 100, side: 'short' as const };
    // Einstands-Stop liegt ÜBER dem Einstand: 100 × (1 + 2 %) = 102,00

    it('eine Order AM Einstands-Stop stammt vom Einstands-Stop', () => {
      expect(schutzQuelle(102, lage, RISK)).toBe('einstand');
    });

    it('enger heißt beim Short TIEFER', () => {
      expect(schutzQuelle(101, lage, RISK)).toBe('trailing');
    });

    it('höher ist keine Trailing-Marke', () => {
      expect(schutzQuelle(105, lage, RISK)).toBe('einstand');
    });
  });

  describe('Randfälle', () => {
    it('ohne Einstands-Stop gab es nur einen Kandidaten', () => {
      const ohne: RiskConfig = { stopLossPct: 0, takeProfitPct: 4, trailingStopPct: 3 };
      expect(schutzQuelle(99, { avgEntry: 100, side: 'long' }, ohne)).toBe('trailing');
    });

    it('unbrauchbare Zahlen behalten das bisherige Etikett', () => {
      // Ein NaN darf keinen Trade zum Trailing-Exit umdeklarieren.
      expect(schutzQuelle(Number.NaN, { avgEntry: 100, side: 'long' }, RISK)).toBe('einstand');
      expect(schutzQuelle(99, { avgEntry: Number.NaN, side: 'long' }, RISK)).toBe('einstand');
      expect(schutzQuelle(99, { avgEntry: 0, side: 'long' }, RISK)).toBe('einstand');
    });

    it('fehlende Seite gilt als Long', () => {
      expect(schutzQuelle(99, { avgEntry: 100 }, RISK)).toBe('trailing');
      expect(schutzQuelle(98, { avgEntry: 100 }, RISK)).toBe('einstand');
    });
  });
});

/* ── Quelltext-Wächter ─────────────────────────────────────────────────────
 *
 * Beide Reparaturen sind einzelne Zeilen an Stellen, die beim Lesen harmlos
 * wirken. Genau so ist der Fehler entstanden, den sie beheben.
 */
describe('Wächter: das Etikett folgt der Marke', () => {
  const scan = readFileSync(join(__dirname, '../src/scheduled/scanMarket.ts'), 'utf8');
  const stop = readFileSync(join(__dirname, '../src/core/schutzStop.ts'), 'utf8');

  it('der Broker-Netz-Fill wird nicht mehr hart als stop_loss gebucht', () => {
    expect(scan).toContain(
      "riskExit: befund.quelle === 'trailing' ? 'trailing_stop' : 'stop_loss',",
    );
    expect(scan).not.toMatch(/^\s*riskExit: 'stop_loss',$/m);
  });

  it('die Quelle wird am gespeicherten Order-Niveau abgelesen, nicht neu gerechnet', () => {
    // Die Order wurde mit einem DAMALIGEN highWater gesetzt; der Peak wandert
    // weiter. Nachrechnen aus dem heutigen Stand ergäbe eine andere Marke.
    expect(stop).toContain('quelle: schutzQuelle(schutz.stopPreis, pos, risk),');
  });
});

describe('Wächter: der Extremkurs steht am schließenden Trade', () => {
  const broker = readFileSync(join(__dirname, '../src/core/broker.ts'), 'utf8');

  it('anschaffung schreibt peakPrice — Long aus highWater, Short aus lowWater', () => {
    expect(broker).toContain("const peak = pos.side === 'short' ? pos.lowWater : pos.highWater;");
    expect(broker).toContain(
      "...(typeof peak === 'number' && Number.isFinite(peak) && peak > 0 ? { peakPrice: peak } : {}),",
    );
  });

  it('und zwar in derselben Funktion wie Einstand und Eröffnungszeit', () => {
    // Weil das Positions-Doc in derselben Transaktion gelöscht wird: Was hier
    // nicht mitgeschrieben wird, ist danach aus nichts rekonstruierbar.
    const i = broker.indexOf('function anschaffung(');
    const block = broker.slice(i, broker.indexOf('\n}', i));
    expect(block).toContain('entryPrice: pos.avgEntry');
    expect(block).toContain('peakPrice: peak');
  });
});
