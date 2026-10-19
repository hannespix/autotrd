/**
 * Loop #138, 19.10.: Tagesschwankung beim Einstieg stempeln und im
 * Abendlauf je Klasse × Einstiegsweg × Ausstiegsgrund zählen. Reine
 * Messung — ein vergessener Weg ließe die Frage „löst der Stop am Rauschen
 * aus?" für genau diese Einstiege unbeantwortbar.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { atrStempel } from '../src/core/broker.js';

const hier = dirname(fileURLToPath(import.meta.url));
const lies = (rel: string): string => readFileSync(join(hier, rel), 'utf8');
const broker = lies('../src/core/broker.ts');
const scan = lies('../src/scheduled/scanMarket.ts');
const snapshot = lies('../src/scheduled/snapshotEquity.ts');
const adopt = lies('../src/callable/adoptBroker.ts');

const zaehle = (text: string, nadel: string): number => text.split(nadel).length - 1;

describe('Einstiegs-ATR: Stempel und Messung', () => {
  it('jeder Engine-Einstieg mit Stop-Abstand reicht den ATR mit', () => {
    const abstand = zaehle(scan, 'stopDistancePct: stopAbstand(symbol, data.atrPct),');
    expect(abstand).toBeGreaterThan(0);
    expect(zaehle(scan, 'stopDistancePct: stopAbstand(symbol, data.atrPct),\n')).toBe(abstand);
    expect(zaehle(scan, 'einstiegAtrPct: data.atrPct,')).toBe(abstand);
  });

  it('Long- und Short-Eröffnung stempeln die Position, der Schluss-Trade erbt ihn', () => {
    expect(zaehle(broker, '...atrStempel(req.einstiegAtrPct),')).toBe(2);
    expect(broker).toContain('    acquiredAt: pos.openedAt,\n    ...atrStempel(pos.einstiegAtrPct),\n');
    expect(broker).toContain("return typeof v === 'number' && Number.isFinite(v) && v > 0");
  });

  it('Abendlauf liest den Stempel und schreibt das Profil per Feldpfad (keine Map-Leichen)', () => {
    expect(snapshot).toContain("const einstiegAtrPct = t.get('einstiegAtrPct') as number | undefined;");
    expect(snapshot).toContain("...(typeof einstiegAtrPct === 'number' ? { einstiegAtrPct } : {}),");
    expect(snapshot).toContain('exitAtrTeile.push(exitAtrProfil(closed, fensterSeit));');
    expect(snapshot).toContain(".update({ 'trading.exits7tAtr': exitAtrStand(exitAtrTeile, fensterSeit, now.toISOString()) })");
    expect(snapshot).not.toContain('exits7tAtr: exitAtr');
    expect(snapshot).toContain("...(typeof acquiredAt === 'string' ? { acquiredAt } : {}),");
  });
});

describe('atrStempel (Verhalten)', () => {
  it('nur echte positive Zahlen, auf 3 Stellen gerundet — sonst kein Feld (kein undefined an Firestore)', () => {
    expect(atrStempel(2.34567)).toEqual({ einstiegAtrPct: 2.346 });
    expect(atrStempel(undefined)).toEqual({});
    expect(atrStempel(null)).toEqual({});
    expect(atrStempel(0)).toEqual({});
    expect(atrStempel(-1)).toEqual({});
    expect(atrStempel(Number.NaN)).toEqual({});
    expect(Object.keys(atrStempel(undefined))).toHaveLength(0);
  });

  it('Übernahme (adoptBroker) behält den Stempel der Messreihe', () => {
    expect(adopt).toContain('? { einstiegAtrPct: alt.einstiegAtrPct }');
  });
});
