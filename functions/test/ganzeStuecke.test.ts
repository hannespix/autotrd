/**
 * Ganze Stücke für eröffnende Aktien-Orders, wo möglich (05.10.): Alpaca
 * nimmt Stops nur für ganze Stücke — 0,11 von 1.433,11 CCG und 0,57 AAPL
 * blieben ohne Broker-Stop. Gepinnt wird, dass NUR abgerundet wird, wo
 * mindestens ein Stück bleibt: kleine Konten handeln weiter.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ganzeStueckeWoMoeglich } from '../src/core/broker.js';

describe('ganzeStueckeWoMoeglich', () => {
  it('Aktien-Einstieg ab einem Stück → abgerundet', () => {
    expect(ganzeStueckeWoMoeglich(1433.113536, 'stocks_us', true)).toBe(1433);
    expect(ganzeStueckeWoMoeglich(1.9, 'stocks_us', true)).toBe(1);
  });
  it('unter einem Stück bleibt die Bruchstück-Order — kein qty_unter_1 für kleine Konten', () => {
    expect(ganzeStueckeWoMoeglich(0.57, 'stocks_us', true)).toBe(0.57);
  });
  it('Krypto und schließende Orders bleiben unberührt', () => {
    expect(ganzeStueckeWoMoeglich(2.5, 'crypto', true)).toBe(2.5);
    expect(ganzeStueckeWoMoeglich(1433.11, 'stocks_us', false)).toBe(1433.11);
  });
  it('Quelltext-Wächter: der Buchungspfad rundet die geplante Menge über diese Regel', () => {
    const broker = readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'broker.ts'), 'utf8');
    expect(broker).toContain('const qty = ganzeStueckeWoMoeglich(planeMenge(req, strategy, {');
    expect(broker).toContain('}), klasse, eroeffnet);');
  });
});
