/**
 * Task 19: Kennzahlen im Steckbrief-Kärtchen und im Detail-Sheet.
 *
 * Pins: das Kärtchen lädt NICHTS beim Hover (nur Cache), die Zeile ist
 * optional (kein „--"), das Sheet zeigt acht Werte mit `fmtNum` (Punkt, wie
 * der große Kurs darüber — ein Format je Fläche), Wörterbuch DE/EN, kein
 * fest verdrahtetes Deutsch mehr in openDetail.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DE, EN } from '../src/i18n.js';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');
const data = readFileSync(join(import.meta.dirname, '..', 'src', 'data.ts'), 'utf8');
const css = readFileSync(join(import.meta.dirname, '..', 'src', 'theme.css'), 'utf8');
const fn = (name: string, len = 2500): string => {
  const i = dashboard.indexOf(`function ${name}(`);
  expect(i, `${name} fehlt`).toBeGreaterThan(0);
  return dashboard.slice(i, i + len);
};

describe('Kennzahlen — Cache ohne Lesevorgänge', () => {
  it('data.ts füllt den Cache aus Listener und Übersicht; kein eigener getDoc', () => {
    expect(data).toContain('const kennzahlenCache = new Map<string, Partial<import(\'@autotrd/shared\').Kennzahlen>>();');
    expect(data).toContain('export function kennzahlenAusCache(symbol: string)');
    const w = data.slice(data.indexOf('export function watchMarketDoc('), data.indexOf('export function watchBars('));
    expect(w).toContain('merkeKennzahlen(symbol, p as MarketDocData | null);');
    const l = data.slice(data.indexOf('export async function loadMarketQuotes('), data.indexOf('export async function loadDailyChunk('));
    expect(l).toContain('merkeKennzahlen(d.id, data);');
    expect(data.slice(data.indexOf('const kennzahlenCache'), data.indexOf('export function watchMarketDoc('))).not.toContain('getDoc');
  });
});

describe('Kennzahlen — Steckbrief-Kärtchen', () => {
  it('eine optionale Mono-Zeile, höchstens 52W und Volumen, nur aus dem Cache — kein await, kein Abruf', () => {
    const k = fn('symTipKennzahlen', 900);
    expect(k).toContain('const k = kennzahlenAusCache(sym);');
    expect(k).toContain("if (!k) return '';");
    expect(k).toContain('<div class="sym-tip-kz mono">');
    expect(k).not.toContain('await');
    expect(k).not.toContain('getDoc');
    expect(k).not.toContain("'--'");
    const z = fn('zeigeSymbolTip', 2200);
    expect(z).toContain('+ chips + symTipKennzahlen(sym) + koerper;');
    expect(z).not.toContain('await');
    // Symbole außerhalb des Katalogs bekommen Yahoos Klarnamen
    expect(z).toContain("const kopfName = herkunft?.ausserhalbKatalog === true && typeof kz?.name === 'string' && kz.name ? kz.name : (herkunft?.name ?? sym);");
    expect(css).toContain('.sym-tip-kz { margin-top: 7px; font-size: 10.5px;');
  });
});

describe('Kennzahlen — Detail-Sheet', () => {
  it('acht Werte in einem 2-Spalten-Raster, alle Kurse mit fmtNum (Punkt wie .vbig), Volumen kompakt, nichts fest auf Deutsch', () => {
    const r = fn('kennzahlenRaster', 1600);
    for (const k of ['dt.vortag', 'dt.oeffnen', 'dt.tagesspanne', 'dt.spanne52w', 'dt.volumen', 'dt.volDurchschnitt', 'dt.boerse', 'dt.waehrung']) {
      expect(r).toContain(`t('${k}')`);
    }
    expect(r).toContain('<dl class="dkz mono">');
    expect(r).toContain("const wert = (v: number | null | undefined): string => (typeof v === 'number' ? fmtNum(v) : '—');");
    expect(r).toContain('${fmtNum(a)} – ${fmtNum(b)}');
    expect(r).toContain('volKompakt(kz.volumen)');
    // Ø-Volumen nur, solange es frisch ist — sonst stünde eine eingefrorene Zahl neben einem frischen Tagesvolumen (Red-Team M1)
    expect(r).toContain("volDurchschnittFrisch(kz.volDurchschnittAt) ? volKompakt(kz.volDurchschnitt3M) : '—'");
    const o = fn('openDetail', 5200);
    for (const k of ['dt.schlagzeilen', 'dt.vorMin', 'dt.vorStd']) expect(o).toContain(`t('${k}')`);
    expect(o).toContain('${kennzahlenRaster(data?.kennzahlen)}');
    expect(o).not.toContain('>Schlagzeilen<');
    expect(o).not.toContain('`vor ${min} min`');
    expect(o).not.toContain('toLocaleString(\'de-DE\')');
    expect(css).toContain('.dsheet .dkz { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(css).toContain('.dsheet .dkz dd { color: var(--t1); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin: 0; }');
  });

  it('volKompakt: Punkt-Format wie fmtNum, 0/unbekannt → —', () => {
    const v = fn('volKompakt', 600);
    expect(v).toContain("if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) return '—';");
    expect(v).toContain('toFixed(1)}M');
    expect(v).not.toContain('de-DE');
  });

  it('Wörterbuch DE und EN vollständig', () => {
    for (const k of ['dt.schlagzeilen', 'dt.vorMin', 'dt.vorStd', 'dt.vortag', 'dt.oeffnen', 'dt.tagesspanne', 'dt.spanne52w', 'dt.volumen', 'dt.volDurchschnitt', 'dt.boerse', 'dt.waehrung', 'steck.kz52w', 'steck.kzVol'] as const) {
      expect(DE[k], `${k} ohne DE`).toBeTruthy();
      expect(EN[k], `${k} ohne EN`).toBeTruthy();
    }
    expect(DE['dt.vorMin']).toContain('{0}');
    expect(EN['dt.vorMin']).toContain('{0}');
  });
});
