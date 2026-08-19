/**
 * Einstiegs-Reibung messen statt modellieren (Task #144, 19.08.).
 *
 * Der Befund: Das Kostenmodell TIPPT die Ausführungs-Reibung — für
 * US-Aktien stehen 5 bp Slippage je Seite als Annahme vom Juli im Code,
 * während die echte Zahl längst an jedem gerouteten Trade steht
 * (`rawPrice` = Entscheidungskurs, `brokerFillPrice` = echter Fill). Am
 * Unterschied hängt der nächste Kostenhebel: Aktien-Einstiege als
 * Limit-Order lohnen nur, wenn die ECHTE Einstiegs-Reibung die Annahme
 * spürbar übersteigt. Hier stehen die pure Rechnung, das Aggregat und die
 * Verdrahtungs-Pins, ohne die beide tote Helfer wären.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  aggregateTradingHealth,
  reibungsProfil,
  type AccountContribution,
  type BrokerFill,
} from '../../shared/src/index.js';

const hier = dirname(fileURLToPath(import.meta.url));

describe('reibungsProfil — die pure Rechnung', () => {
  it('Vorzeichen: bezahlt ist positiv, auf BEIDEN Seiten', () => {
    /* Der Fehler, der hier lauert: (fill − raw) für beide Seiten. Dann
     * sähe ein teurer Verkauf (füllt UNTER dem Entscheidungskurs) wie ein
     * Gewinn aus, und Kauf- und Verkaufs-Reibung höben sich im Schnitt
     * gegenseitig auf — die Messung zeigte ~0 und wäre damit schlimmer
     * als keine, weil sie „alles günstig" bescheinigt. */
    const out = reibungsProfil([
      // Kauf füllt 10 bp ÜBER der Entscheidung: kostet.
      { side: 'buy', rawPrice: 100, fillPrice: 100.1, assetClass: 'stocks_us', eroeffnend: true },
      // Verkauf füllt 10 bp UNTER der Entscheidung: kostet ebenfalls.
      { side: 'sell', rawPrice: 100, fillPrice: 99.9, assetClass: 'stocks_us', eroeffnend: false },
    ]);
    const s = out['stocks_us']!;
    expect(s.n).toBe(2);
    expect(s.avgBp).toBe(10);
    expect(s.einstieg).toEqual({ n: 1, avgBp: 10 });
    expect(s.ausstieg).toEqual({ n: 1, avgBp: 10 });
  });

  it('ein Krypto-Limit-Fill AM Entscheidungskurs steht bei 0 — der Maker-Vorteil', () => {
    const out = reibungsProfil([
      { side: 'buy', rawPrice: 60_000, fillPrice: 60_000, assetClass: 'crypto', eroeffnend: true },
    ]);
    expect(out['crypto']!.einstieg.avgBp).toBe(0);
  });

  it('trennt Klassen und hält den teuersten Einzelfall fest', () => {
    const fills: BrokerFill[] = [
      { side: 'buy', rawPrice: 100, fillPrice: 100.05, assetClass: 'stocks_us', eroeffnend: true },
      { side: 'buy', rawPrice: 100, fillPrice: 100.45, assetClass: 'stocks_us', eroeffnend: true },
      { side: 'buy', rawPrice: 50, fillPrice: 50.01, assetClass: 'etf_sectors', eroeffnend: true },
    ];
    const out = reibungsProfil(fills);
    expect(out['stocks_us']!.n).toBe(2);
    expect(out['stocks_us']!.avgBp).toBe(25);
    // Der Schnitt (25) versteckt den 45-bp-Ausreißer — maxBp zeigt ihn.
    expect(out['stocks_us']!.maxBp).toBe(45);
    expect(out['etf_sectors']!.n).toBe(1);
    expect(out['stocks_us']!.ausstieg).toEqual({ n: 0, avgBp: 0 });
  });

  it('unbrauchbare Kurse fallen heraus statt zu verzerren', () => {
    const out = reibungsProfil([
      { side: 'buy', rawPrice: 0, fillPrice: 100, assetClass: 'stocks_us', eroeffnend: true },
      { side: 'buy', rawPrice: 100, fillPrice: 0, assetClass: 'stocks_us', eroeffnend: true },
    ]);
    expect(out['stocks_us']).toBeUndefined();
  });
});

describe('Aggregat über Konten (aggregateTradingHealth)', () => {
  const reibungA = {
    stocks_us: {
      n: 3,
      avgBp: 10,
      maxBp: 30,
      einstieg: { n: 2, avgBp: 12 },
      ausstieg: { n: 1, avgBp: 6 },
    },
  };
  const reibungB = {
    stocks_us: {
      n: 1,
      avgBp: 50,
      maxBp: 50,
      einstieg: { n: 1, avgBp: 50 },
      ausstieg: { n: 0, avgBp: 0 },
    },
  };

  it('gewichtet mit n je Konto — kein Mittel über Konto-Schnitte', () => {
    const beitraege: AccountContribution[] = [
      { stats: { n: 3, wins: 2 }, reibung: reibungA },
      { stats: { n: 1, wins: 0 }, reibung: reibungB },
    ];
    const h = aggregateTradingHealth(beitraege);
    const s = h.reibung['stocks_us']!;
    // (10×3 + 50×1) / 4 = 20 — NICHT (10+50)/2 = 30.
    expect(s.n).toBe(4);
    expect(s.avgBp).toBe(20);
    expect(s.maxBp).toBe(50);
    expect(s.einstieg).toEqual({ n: 3, avgBp: Math.round(((12 * 2 + 50) / 3) * 10) / 10 });
  });

  it('zählt auch Konten OHNE geschlossene Trades — Einstiegs-Reibung entsteht vor dem ersten Abschluss', () => {
    /* Das Aggregat filtert sonst auf stats.n > 0. Ein frisches Konto hat
     * Einstiege (und deren Reibung), aber noch keinen Abschluss — genau
     * seine Fills fehlten, wenn die Reibung denselben Filter durchliefe. */
    const beitraege: AccountContribution[] = [
      { stats: { n: 0, wins: 0 }, reibung: reibungB },
    ];
    const h = aggregateTradingHealth(beitraege);
    expect(h.accounts).toBe(0);
    expect(h.reibung['stocks_us']!.n).toBe(1);
    expect(h.reibung['stocks_us']!.avgBp).toBe(50);
  });
});

describe('Verdrahtung — ohne sie wären die Helfer tot', () => {
  const snapshot = readFileSync(join(hier, '../src/scheduled/snapshotEquity.ts'), 'utf8');
  const broker = readFileSync(join(hier, '../src/core/broker.ts'), 'utf8');

  it('snapshotEquity sammelt die Fills VOR dem pnl-Filter', () => {
    /* Die Falle dieser Verdrahtung: `pnl` tragen nur SCHLIESSENDE Trades.
     * Rutschte die Fill-Sammlung in den pnl-geführten Block, wären genau
     * die EINSTIEGE unsichtbar, um die es geht — die Messung liefe, zeigte
     * für den Einstieg dauerhaft n = 0 und niemandem fiele etwas auf. */
    const sammeln = snapshot.indexOf('fills.push(');
    const pnlFilter = snapshot.indexOf("typeof pnl === 'number' && Number.isFinite(pnl) && symbol");
    expect(sammeln, 'Fill-Sammlung fehlt in snapshotEquity').toBeGreaterThan(0);
    expect(pnlFilter, 'pnl-Filter nicht gefunden — Loop umgebaut?').toBeGreaterThan(0);
    expect(sammeln, 'Fill-Sammlung steht HINTER dem pnl-Filter').toBeLessThan(pnlFilter);
    expect(snapshot).toContain('reibungsProfil(fills)');
  });

  it('liest exakt die Felder, die broker.ts schreibt', () => {
    // Lese- und Schreibstelle gegeneinander gepinnt (Muster executedAt,
    // 14.08.): Ein umbenanntes Feld ließe die Messung leerlaufen statt
    // scheitern.
    for (const feld of ["t.get('rawPrice')", "t.get('brokerFillPrice')", "t.get('side')"]) {
      expect(snapshot, `${feld} fehlt`).toContain(feld);
    }
    expect(broker).toContain('rawPrice: req.price');
    expect(broker).toContain('brokerFillPrice: req.fillPreis');
  });
});
