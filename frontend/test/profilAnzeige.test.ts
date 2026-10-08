/**
 * Task 19, Teil 2: Firmenprofil und Fundamentaldaten im Detail-Sheet.
 *
 * Pins: der Block fehlt ohne Profil (Krypto, FX, Indizes, ohne Schlüssel)
 * statt „—"-Reihen zu zeigen; sechs Werte im selben Raster und Format wie
 * die Kennzahlen darüber; Website nur mit http(s) und als sicherer Link;
 * Wörterbuch DE/EN; Typ am Markt-Dokument.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DE, EN } from '../src/i18n.js';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');
const data = readFileSync(join(import.meta.dirname, '..', 'src', 'data.ts'), 'utf8');
const css = readFileSync(join(import.meta.dirname, '..', 'src', 'theme.css'), 'utf8');
const fn = (name: string, len: number): string => {
  const i = dashboard.indexOf(`function ${name}(`);
  expect(i, `${name} fehlt`).toBeGreaterThan(0);
  return dashboard.slice(i, i + len);
};

describe('Profil im Detail-Sheet', () => {
  it('ohne Profil kein Block; mit Profil Übersichtszeile und sechs Werte im dkz-Raster', () => {
    const r = fn('profilRaster', 2600);
    expect(r).toContain("if (!pr) return '';");
    expect(r).toContain('<div class="hint dprofil">');
    expect(r).toContain('<dl class="dkz mono">');
    for (const k of ['dt.marktkap', 'dt.beta', 'dt.kgv', 'dt.eps', 'dt.dividende', 'dt.gewinntermin', 'dt.ipo']) expect(r).toContain(`t('${k}')`);
    // Marktkap. in Millionen → kompakt mit Dollar (nur US-Aktien haben ein Profil)
    expect(r).toContain('`$${volKompakt(pr.marktkapMio * 1e6)}`');
    // Website nur http(s), escaped, als sicherer Link
    expect(r).toContain("typeof pr.website === 'string' && /^https?:\\/\\//.test(pr.website)");
    expect(r).toContain('target="_blank" rel="noopener noreferrer"');
    expect(r).toContain('escText(pr.website)');
    const o = fn('openDetail', 5200);
    expect(o).toContain('${profilRaster(data?.profil)}');
    expect(css).toContain('.dsheet .dprofil { margin-top: 10px; font-size: 11px; line-height: 1.5; }');
  });

  it('Typ am Markt-Dokument und Wörterbuch DE/EN', () => {
    expect(data).toContain("profil?: Partial<import('@autotrd/shared').Profil> | null;");
    for (const k of ['dt.ipo', 'dt.marktkap', 'dt.beta', 'dt.kgv', 'dt.eps', 'dt.dividende', 'dt.gewinntermin'] as const) {
      expect(DE[k], `${k} ohne DE`).toBeTruthy();
      expect(EN[k], `${k} ohne EN`).toBeTruthy();
    }
  });
});
