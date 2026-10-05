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
  it('Aktien-Einstieg → abgerundet, wenn mindestens 90 % der Menge bleiben', () => {
    expect(ganzeStueckeWoMoeglich(1433.113536, 'stocks_us', true)).toBe(1433);
    expect(ganzeStueckeWoMoeglich(10.5, 'stocks_us', true)).toBe(10);
    expect(ganzeStueckeWoMoeglich(2.05, 'stocks_us', true)).toBe(2);
  });
  it('würde Abrunden viel Größe kosten, bleibt die Menge (1,9 wird NICHT 1)', () => {
    expect(ganzeStueckeWoMoeglich(1.9, 'stocks_us', true)).toBe(1.9);
    expect(ganzeStueckeWoMoeglich(3.5, 'stocks_us', true)).toBe(3.5); // 3/3,5 = 86 % < 90 %
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

describe('doppelkaufGesperrt (Prüfbefund 05.10.: Sockel und Scan kaufen gleichzeitig)', () => {
  it('Engine-Kauf in eine bestehende Position ohne Aufstockung → gesperrt', async () => {
    const { doppelkaufGesperrt } = await import('../src/core/broker.js');
    expect(doppelkaufGesperrt({ source: 'engine', side: 'buy' }, { core: false }, false)).toBe(true);
    expect(doppelkaufGesperrt({ source: 'engine', side: 'buy', core: true }, { core: false }, false)).toBe(true);
  });
  it('Aufstockung beim selben Besitzer → erlaubt; beim fremden Besitzer → gesperrt', async () => {
    const { doppelkaufGesperrt } = await import('../src/core/broker.js');
    expect(doppelkaufGesperrt({ source: 'engine', side: 'buy', aufstockung: true, core: true }, { core: true }, false)).toBe(false);
    expect(doppelkaufGesperrt({ source: 'engine', side: 'buy', aufstockung: true, core: true }, { core: false }, false)).toBe(true);
  });
  it('ohne Position, Handeingabe, Verkauf oder Eindecken → nie gesperrt', async () => {
    const { doppelkaufGesperrt } = await import('../src/core/broker.js');
    expect(doppelkaufGesperrt({ source: 'engine', side: 'buy' }, null, false)).toBe(false);
    expect(doppelkaufGesperrt({ source: 'manual', side: 'buy' }, { core: false }, false)).toBe(false);
    expect(doppelkaufGesperrt({ source: 'engine', side: 'sell' }, { core: false }, true)).toBe(false);
    expect(doppelkaufGesperrt({ source: 'engine', side: 'buy' }, { core: false }, true)).toBe(false);
  });
  it('Quelltext-Wächter: die Sperre sitzt im Broker-Pfad VOR dem Routing', () => {
    const broker = readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'broker.ts'), 'utf8');
    const sperre = broker.indexOf('if (doppelkaufGesperrt(req, position, schliesst)) {');
    expect(sperre).toBeGreaterThan(-1);
    expect(sperre).toBeLessThan(broker.indexOf('const routing = await routeOrder(verbindung, {'));
  });
});
