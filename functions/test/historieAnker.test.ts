/**
 * Order-Historie ohne 30-Tage-Deckel (Owner-Wunsch 13.08.).
 *
 * Der Befund: Die Depot-Übernahme ankerte die Order-Historie auf „vor 30
 * Tagen" — Steuer-FIFO und Handelsanalyse sahen nur den letzten Monat,
 * obwohl das Alpaca-Konto älter ist. Der ehrliche Anker ist die
 * KONTO-ERÖFFNUNG (`created_at` aus /v2/account): Vor ihr kann es keine
 * Orders geben, jeder spätere Anker verliert Historie.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { historieAnker } from '../src/callable/adoptBroker.js';

const hier = dirname(fileURLToPath(import.meta.url));
const adopt = readFileSync(join(hier, '../src/callable/adoptBroker.ts'), 'utf8');
const broker = readFileSync(join(hier, '../src/core/alpacaBroker.ts'), 'utf8');

const JETZT = Date.parse('2026-08-13T18:00:00.000Z');

describe('historieAnker — die pure Anker-Entscheidung', () => {
  it('gültige Konto-Eröffnung ⇒ exakt dieser Zeitpunkt', () => {
    expect(historieAnker('2024-03-05T09:30:00Z', JETZT)).toBe('2024-03-05T09:30:00.000Z');
  });

  it('fehlender oder unlesbarer Stempel ⇒ 30-Tage-Rückfall', () => {
    const rueckfall = new Date(JETZT - 30 * 86_400_000).toISOString();
    expect(historieAnker('', JETZT)).toBe(rueckfall);
    expect(historieAnker('kein-datum', JETZT)).toBe(rueckfall);
  });

  it('Zukunfts-Stempel ⇒ Rückfall (sonst käme gar nichts zurück)', () => {
    const rueckfall = new Date(JETZT - 30 * 86_400_000).toISOString();
    expect(historieAnker('2027-01-01T00:00:00Z', JETZT)).toBe(rueckfall);
  });
});

describe('Verdrahtung (Quelltext-Wächter)', () => {
  it('die Übernahme ankert auf der Konto-Eröffnung', () => {
    expect(adopt).toContain('historieAnker(konto.createdAt, Date.now())');
  });

  it('alpacaKonto liefert created_at durch', () => {
    expect(broker).toContain("typeof d['created_at'] === 'string'");
  });

  it('der Seitendeckel trägt die volle Historie und schneidet nie still ab', () => {
    // 40 × 500 = 20.000 Orders — und wenn selbst das nicht reicht, steht es
    // ausdrücklich im Log statt als unsichtbare FIFO-Lücke im Steuerbericht.
    expect(broker).toContain('const SEITEN_MAX = 40;');
    expect(broker).toContain('Historie vor ${after} unvollständig');
  });
});
