/**
 * Quellen-Anzeige (Task 18b) — die private Messung aus #546/#547 wird im
 * eigenen Konto sichtbar.
 *
 * Das öffentliche Aggregat zeigt Kante und Gebühr je Einstiegsweg erst ab
 * der Konten-Schwelle; ohne diese Karte sähe der Owner seine eigene
 * Quellen-Tabelle nie, und die Frage „welcher Pfad verbrennt Krypto?"
 * bliebe wieder eine Bauchfrage. Pins: Verdrahtung (Daten → Render, VOR
 * renderKapital wegen des Textdiät-Wächters), Reihung (schlechteste Kante
 * zuerst, ungemessene ans Ende), Wörterbuch DE/EN, Infotip DE/EN.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DE, EN } from '../src/i18n.js';
import { INFO_DE, INFO_EN } from '../src/infotips.js';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');
const data = readFileSync(join(import.meta.dirname, '..', 'src', 'data.ts'), 'utf8');

describe('Quellen-Anzeige — Verdrahtung', () => {
  it('renderQuellen liest stats.byClassQuelle und läuft zwischen Reibung und Kapital', () => {
    const fn = dashboard.indexOf('function renderQuellen');
    expect(fn, 'renderQuellen fehlt').toBeGreaterThan(0);
    expect(dashboard.slice(fn, fn + 400)).toContain('s.byClassQuelle');
    const reibung = dashboard.indexOf('renderReibung(s);');
    const quellen = dashboard.indexOf('renderQuellen(s);');
    const kapital = dashboard.indexOf('renderKapital(s);');
    expect(reibung).toBeGreaterThan(0);
    expect(quellen).toBeGreaterThan(reibung);
    expect(kapital).toBeGreaterThan(quellen);
  });

  it('Markup, Sektionsliste und Infotip-Knopf hängen zusammen', () => {
    expect(dashboard).toContain('<div id="pfSekQuellen" hidden>');
    expect(dashboard).toContain("${t('pf.quellen')} ${iBtn('quellen')}");
    expect(dashboard).toContain('<div id="pfQuellen" class="fl-tbl"></div>');
    expect(dashboard).toContain("const PF_SEKTIONEN = ['pfSekExits', 'pfSekKosten', 'pfSekReibung', 'pfSekQuellen', 'pfSekKapital'] as const;");
  });

  it('PortfolioStatsDoc kennt byClassQuelle (und das 7-Tage-Fenster), wie snapshotEquity es schreibt', () => {
    expect(data).toContain('byClassQuelle?: Record<string, Record<string, { pnl: number; n: number; fees?: number; notional?: number; kantePct?: number | null }>>;');
    expect(data).toContain('byClassQuelle7t?: Record<string, Record<string, { pnl: number; n: number; fees?: number; notional?: number; kantePct?: number | null }>>;');
  });

  it('Reihung: schlechteste Kante zuerst, ungemessene (null) ans Ende — nicht in die Mitte (Red-Team #546 M6)', () => {
    const fn = dashboard.slice(dashboard.indexOf('function renderQuellen'));
    const kopf = fn.slice(0, 1800);
    expect(kopf).toContain('const ka = a.kantePct ?? Number.POSITIVE_INFINITY;');
    expect(kopf).toContain('const kb = b.kantePct ?? Number.POSITIVE_INFINITY;');
    expect(kopf).toContain('return ka - kb || b.n - a.n;');
    // Schlüssel aus der Datenbank werden entschärft
    expect(kopf).toContain("z.klasse.replace(/[^\\w-]/g, '')");
    // eigenes Raster: die Zahlen bekommen volle Breite, der Name die Ellipse (Bildbefund 08.10.)
    expect(kopf).toContain('<div class="fl-row q-row" title="${klasse} · ${weg}">');
    const css = readFileSync(join(import.meta.dirname, '..', 'src', 'theme.css'), 'utf8');
    expect(css).toContain('.q-row { grid-template-columns: minmax(0, 1fr) max-content max-content; }');
    expect(css).toContain('.q-row span:first-child { overflow: hidden; text-overflow: ellipsis; }');
  });

  it('alle Anzeige-Zeilen stehen DE und EN im Wörterbuch, alle acht Wege haben einen Klarnamen', () => {
    for (const k of [
      'pf.quellen',
      'pf.quelleKante',
      'pf.quelleKonfluenz',
      'pf.quelleRegelbaum',
      'pf.quelleMomentum',
      'pf.quelleSockel',
      'pf.quelleKiProbe',
      'pf.quelleHand',
      'pf.quelleSync',
      'pf.quelleUnbekannt',
    ] as const) {
      expect(DE[k], `${k} ohne DE`).toBeTruthy();
      expect(EN[k], `${k} ohne EN`).toBeTruthy();
    }
    for (const q of ['konfluenz', 'regelbaum', 'momentum', 'sockel', 'ki_probe', 'hand', 'sync', 'unbekannt']) {
      expect(dashboard).toContain(`  ${q}: t('pf.quelle`);
    }
  });

  it('der Infotip erklärt Kante, Lücken (Nachgebucht/Unbekannt) und die Konten-Schwelle — DE und EN', () => {
    expect(INFO_DE['quellen']?.t).toBe('Ergebnis je Einstiegsweg');
    // kurz genug, dass Beschriftung und ⓘ in der 280-px-Seitenspalte auf EINER Zeile bleiben (Bildbefund 08.10.)
    expect(DE['pf.quellen']).toBe('Je Einstiegsweg: n · Kante · P&L');
    expect((DE['pf.quellen'] ?? '').length).toBeLessThanOrEqual(34);
    expect((EN['pf.quellen'] ?? '').length).toBeLessThanOrEqual(34);
    expect(INFO_DE['quellen']?.d).toContain('„Nachgebucht" und „Unbekannt" sind keine Wege, sondern Lücken der Messung');
    expect(INFO_DE['quellen']?.d).toContain('nur dein eigenes Konto');
    expect(INFO_EN['quellen']?.t).toBe('Result by entry path');
    expect(INFO_EN['quellen']?.d).toContain('“Synced” and “Unknown” are not paths but gaps in the measurement');
    expect(INFO_EN['quellen']?.d).toContain('only your own account');
  });
});
