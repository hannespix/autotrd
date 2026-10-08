/**
 * Task 19: Die Kennzahlen sind ANGESCHLOSSEN — der Parser liest die Meta-
 * Felder, alle drei Schreibstellen des market-Docs reichen sie weiter, und
 * nur der 1y-Abruf des Scans darf das Ø-Volumen setzen.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const md = readFileSync(join(hier, '../src/core/marketData.ts'), 'utf8');
const scan = readFileSync(join(hier, '../src/scheduled/scanMarket.ts'), 'utf8');
const quoteNow = readFileSync(join(hier, '../src/callable/quoteNow.ts'), 'utf8');
const z = (text: string, nadel: string): number => text.split(nadel).length - 1;

describe('Kennzahlen — Anschluss-Wächter', () => {
  it('der Parser nimmt die Kennzahlen aus DEMSELBEN Abruf (kein zweiter Request, Host bleibt Yahoo)', () => {
    for (const f of ['regularMarketDayHigh', 'regularMarketDayLow', 'fiftyTwoWeekHigh', 'fiftyTwoWeekLow', 'regularMarketVolume', 'longName', 'fullExchangeName', 'currency']) {
      expect(md).toContain(`${f}?:`);
    }
    expect(z(md, 'kennzahlen: kennzahlenAus(result.meta, bars, new Date().toISOString()),')).toBe(1);
    expect(z(md, 'kennzahlen: snap.kennzahlen };')).toBe(1); // getQuickQuote
    // der Vortag bleibt bars[n-2] — chartPreviousClose ist kein Vortag
    expect(md).not.toMatch(/vortag:\s*result\.meta\.chartPreviousClose/);
  });

  it('Scan (1y, mit Ø-Volumen), Katalog-Rotation und quoteNow (5d, ohne) schreiben über kennzahlenFelder', () => {
    expect(z(scan, 'kennzahlen: kennzahlenFelder(snap.kennzahlen),')).toBe(1);
    expect(z(scan, '{ lastBarDate: qq.lastBar.date, kennzahlen: kennzahlenFelder(qq.kennzahlen) },')).toBe(1);
    expect(z(quoteNow, 'kennzahlen: kennzahlenFelder(q.kennzahlen),')).toBe(1);
    // nie das rohe Objekt mit null-Ø in ein merge — das löschte den Scan-Wert
    expect(scan).not.toMatch(/kennzahlen:\s*snap\.kennzahlen,/);
    expect(scan).not.toMatch(/kennzahlen:\s*qq\.kennzahlen,/);
    expect(quoteNow).not.toMatch(/kennzahlen:\s*q\.kennzahlen,/);
  });
});
