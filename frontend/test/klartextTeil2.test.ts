/**
 * Task 20 Teil 2: Klartext der übrigen Karten. Die Faktenprüfung (09.10.)
 * fand Texte, die etwas anderes behaupteten als der Code — diese Pins halten
 * die Korrektur fest, gegen die Konstanten, auf die sie sich beziehen.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KI_GEWICHT_MAX, KI_MIN_FAELLE, KI_WIRKUNG_TAGE } from '@autotrd/shared';
import { DE, EN } from '../src/i18n.js';
import { INFO_DE, INFO_EN } from '../src/infotips.js';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

describe('Klartext Teil 2 — Texte sagen, was der Code tut', () => {
  it('KI-Gewicht: Mindestfälle und Obergrenze aus den Konstanten', () => {
    expect(KI_MIN_FAELLE).toBe(40);
    expect(KI_GEWICHT_MAX).toBe(1);
    expect(DE['ew.kiGewichtTitel']).toContain(`weniger als ${KI_MIN_FAELLE} Fällen`);
    expect(EN['ew.kiGewichtTitel']).toContain(`Below ${KI_MIN_FAELLE} cases`);
    for (const s of [DE['ew.kiGewichtTitel'], EN['ew.kiGewichtTitel']]) expect(s).not.toContain('×2');
  });

  it('KI-Wirkung: Zahl der Handelstage wie im Code', () => {
    expect(KI_WIRKUNG_TAGE).toBe(3);
    expect(DE['ew.kiWirkungTitel']).toMatch(/^Drei Handelstage/);
    expect(EN['ew.kiWirkungTitel']).toMatch(/^For three trading days/);
  });

  it('Momentum handelt als Sockel echtes Kapital — kein „Probedepot ohne echtes Geld"', () => {
    expect(INFO_DE['momentum']?.d).toContain('handelt dieselbe Regel aber mit echtem Kapital');
    expect(INFO_EN['momentum']?.d).toContain('does trade real capital');
  });

  it('Stress sperrt Einstiege, nicht Trades (Ausstiege laufen weiter)', () => {
    expect(DE['reg.stress']).toBe('Stress — keine neuen Einstiege');
    expect(EN['reg.stress']).toBe('Stress — no new entries');
  });

  it('Uhrzeiten mit Zeitzone', () => {
    expect(DE['kv.snapshotZeit']).toContain('deutscher Zeit');
    expect(EN['kv.snapshotZeit']).toContain('New York time');
    expect(dashboard).not.toContain('${teil.uhrzeit}');
  });

  it('Fachbegriffe aus dem Markup laufen über i18n', () => {
    for (const alt of ['Spitze des Universums', 'Amtierender Baum', 'Schatten-Depot', '<span>Lookback</span>', '<span>MAE</span>', ' · DSR ${']) {
      expect(dashboard, alt).not.toContain(alt);
    }
  });
});
