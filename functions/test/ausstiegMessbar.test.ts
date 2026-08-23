/**
 * Zwei Mess-Reparaturen am Ausstieg — beide am 23.08. an einer gescheiterten
 * Auswertung entstanden, keine ändert Handelsverhalten.
 *
 * Der Anlass: Der Eimer `trailing_stop` stand mit −2.253 $ auf neun Trades da,
 * und ich wollte daraus schließen, dass der nachziehende Stop Geld kostet. Ein
 * Widerlegungs-Durchgang hat das zerlegt — unter anderem mit zwei Befunden,
 * die nicht die Auswertung betrafen, sondern die MESSUNG selbst.
 *
 * ── Befund 1: die Eimer trennen die Mechanismen nicht ─────────────────────
 *
 * `pflegeSchutz` buchte JEDEN Fill des Broker-Netzes hart als `stop_loss`,
 * obwohl das Netz die ENGERE der beiden Marken wählt. Löste dort die
 * Trailing-Marke aus, landete der Trade im Eimer des Einstands-Stops.
 *
 * ── Und der Fehler im ersten Anlauf, den ein zweiter Durchgang fand ───────
 *
 * Der erste Versuch RIET die Marke beim Lesen: Er verglich das gespeicherte
 * Order-Niveau mit einem frisch gerechneten Einstands-Stop. Das lag in drei
 * realen Zuständen falsch — verbreiterter Stop-Loss (die alte Order wird nie
 * ersetzt), `adoptBroker` (fremdes Niveau, neuer Einstand), `byClass`-Override
 * `stopLossPct: 0`. Deshalb steht die Marke jetzt dort, wo sie bekannt ist:
 * im `Math.max`/`Math.min` selbst, festgehalten beim ANLEGEN der Order.
 *
 * ── Befund 2: der Extremkurs fehlte am Trade ──────────────────────────────
 *
 * Ohne ihn ist nicht feststellbar, ob ein Trailing-Exit einen Gewinn
 * GESICHERT oder einen Aufschwung ABGESCHNITTEN hat — beide Fälle sehen im
 * Trade-Log gleich aus.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planeSchutzStop, schutzStopMarke, schutzStopPreis } from '../src/core/schutzStop.js';
import type { RiskConfig } from '@autotrd/shared';

const RISK: RiskConfig = { stopLossPct: 2, takeProfitPct: 4, trailingStopPct: 3 };

describe('schutzStopMarke — die Marke wird beim Rechnen festgehalten', () => {
  describe('Long', () => {
    it('nie im Plus ⇒ der Einstands-Stop führt', () => {
      // highWater == avgEntry heißt: kein Anstieg beobachtet, das Trailing
      // ist gar nicht scharf (`peak > avgEntry`).
      const m = schutzStopMarke({ qty: 10, avgEntry: 100, highWater: 100, side: 'long' }, RISK);
      expect(m).toEqual({ preis: 98, marke: 'einstand' });
    });

    it('im Plus, aber das Trailing liegt weiter ⇒ weiterhin der Einstand', () => {
      // Trailing 101 × 0,97 = 97,97 < 98,00 ⇒ Math.max nimmt den Einstand.
      const m = schutzStopMarke({ qty: 10, avgEntry: 100, highWater: 101, side: 'long' }, RISK);
      expect(m?.marke).toBe('einstand');
      expect(m?.preis).toBe(98);
    });

    it('im Plus und das Trailing liegt enger ⇒ Trailing', () => {
      // 110 × 0,97 = 106,70 > 98,00.
      const m = schutzStopMarke({ qty: 10, avgEntry: 100, highWater: 110, side: 'long' }, RISK);
      expect(m).toEqual({ preis: 106.7, marke: 'trailing' });
    });

    it('ohne Einstands-Stop trägt allein das Trailing', () => {
      const nurTrail: RiskConfig = { stopLossPct: 0, takeProfitPct: 4, trailingStopPct: 3 };
      const m = schutzStopMarke({ qty: 10, avgEntry: 100, highWater: 110, side: 'long' }, nurTrail);
      expect(m).toEqual({ preis: 106.7, marke: 'trailing' });
    });

    it('ohne Einstands-Stop und nie im Plus gibt es kein Niveau', () => {
      const nurTrail: RiskConfig = { stopLossPct: 0, takeProfitPct: 4, trailingStopPct: 3 };
      expect(schutzStopMarke({ qty: 10, avgEntry: 100, highWater: 100, side: 'long' }, nurTrail)).toBeNull();
    });
  });

  describe('Short — gespiegelt', () => {
    it('nie im Plus ⇒ Einstands-Stop ÜBER dem Einstand', () => {
      const m = schutzStopMarke({ qty: 10, avgEntry: 100, lowWater: 100, side: 'short' }, RISK);
      expect(m).toEqual({ preis: 102, marke: 'einstand' });
    });

    it('im Plus und das Trailing liegt tiefer ⇒ Trailing', () => {
      // 90 × 1,03 = 92,70 < 102,00 ⇒ Math.min nimmt das Trailing.
      const m = schutzStopMarke({ qty: 10, avgEntry: 100, lowWater: 90, side: 'short' }, RISK);
      expect(m?.marke).toBe('trailing');
      expect(m?.preis).toBeCloseTo(92.7, 6);
    });
  });

  it('schutzStopPreis liefert unverändert nur das Niveau', () => {
    // Alle Bestandsaufrufer benutzen weiterhin diese Fassung — die Marke ist
    // additiv, kein Umbau.
    const lage = { qty: 10, avgEntry: 100, highWater: 110, side: 'long' as const };
    expect(schutzStopPreis(lage, RISK)).toBe(schutzStopMarke(lage, RISK)?.preis);
  });

  it('der Plan trägt die Marke bis zur Order', () => {
    const plan = planeSchutzStop(
      { qty: 10, avgEntry: 100, highWater: 110, side: 'long' },
      RISK,
      'stocks_us',
      null,
    );
    expect(plan.anlegen).toBe(true);
    expect(plan.marke).toBe('trailing');
  });
});

/* ── Quelltext-Wächter ─────────────────────────────────────────────────────
 *
 * Beide Reparaturen sind einzelne Zeilen an Stellen, die beim Lesen harmlos
 * wirken. Genau so ist der Fehler entstanden, den sie beheben.
 */
describe('Wächter: das Etikett folgt der gespeicherten Marke', () => {
  const scan = readFileSync(join(__dirname, '../src/scheduled/scanMarket.ts'), 'utf8');
  const stop = readFileSync(join(__dirname, '../src/core/schutzStop.ts'), 'utf8');
  const broker = readFileSync(join(__dirname, '../src/core/broker.ts'), 'utf8');

  it('die Marke wird beim ANLEGEN geschrieben, nicht später geraten', () => {
    expect((stop.match(/\.\.\.\(plan\.marke \? \{ quelle: plan\.marke \} : \{\}\),/g) ?? []).length).toBe(2);
    // Die alte Rate-Funktion darf nicht zurückkommen.
    expect(stop).not.toContain('export function schutzQuelle');
  });

  it('gelesen wird die gespeicherte Marke — fehlt sie, bleibt das alte Etikett', () => {
    /* BEIDE Lesestellen prüfen, nicht nur eine.
     *
     * Eine Sabotage-Probe hat genau hier zugeschlagen: Ein `toContain` blieb
     * grün, während `pflegeSchutz` wieder riet — die zweite Fundstelle in
     * `schutzAufheben` deckte den Ausdruck zu. Ein Wächter, der die gemeldete
     * Sache nicht messen kann, bescheinigt Fehlerfreiheit (CLAUDE.md §6). */
    const treffer = stop.match(/quelle: schutz\.quelle \?\? 'einstand',/g) ?? [];
    expect(treffer.length).toBe(2); // pflegeSchutz UND schutzAufheben
    // Und keine der beiden darf einen festen Wert einsetzen.
    expect(stop).not.toMatch(/quelle: 'trailing',/);
  });

  it('BEIDE Fill-Pfade stempeln gleich — sonst bleibt die Mischung', () => {
    // scanMarket über pflegeSchutz …
    expect(scan).toContain(
      "riskExit: befund.quelle === 'trailing' ? 'trailing_stop_broker' : 'stop_loss',",
    );
    // … und broker.ts über schutzAufheben.
    expect(broker).toContain(
      "req.riskExit ?? (aufhebung.quelle === 'trailing' ? 'trailing_stop_broker' : 'stop_loss'),",
    );
    // Kein Pfad bucht mehr blind.
    expect(scan).not.toMatch(/^\s*riskExit: 'stop_loss',$/m);
    expect(broker).not.toMatch(/riskExit: req\.riskExit \?\? 'stop_loss',/);
  });

  it('der Broker-Fill bekommt einen EIGENEN Eimer', () => {
    // Zumischen zu `trailing_stop` verschöbe still Masse zwischen
    // bestehenden Eimern und mischte zwei verschiedene Mechanismen.
    expect(scan).not.toContain("? 'trailing_stop' :");
    expect(broker).not.toContain("? 'trailing_stop' :");
  });
});

describe('Wächter: der Extremkurs steht am schließenden Trade', () => {
  const broker = readFileSync(join(__dirname, '../src/core/broker.ts'), 'utf8');

  it('Long aus highWater, Short aus lowWater', () => {
    expect(broker).toContain("const roh = pos.side === 'short' ? pos.lowWater : pos.highWater;");
  });

  it('nur bei beobachtetem Anstieg — ein Peak am Einstand wäre keine Messung', () => {
    // Sonst entstünden Trades der Form „40 Tage gehalten, nie im Plus" aus
    // Positionen, deren Wasserstandsmarke adoptBroker zurückgesetzt hat.
    expect(broker).toContain(
      "(pos.side === 'short' ? roh < pos.avgEntry : roh > pos.avgEntry)",
    );
    expect(broker).toContain("...(peak !== null ? { peakPrice: peak } : {}),");
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
