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
    expect(dashboard).toContain('<div id="pfQuellen" class="fl-tbl q-tbl"></div>');
    expect(dashboard).toContain("const PF_SEKTIONEN = ['pfSekExits', 'pfSekKosten', 'pfSekReibung', 'pfSekQuellen', 'pfSekKapital'] as const;");
  });

  it('PortfolioStatsDoc kennt byClassQuelle (und das 7-Tage-Fenster), wie snapshotEquity es schreibt', () => {
    expect(data).toContain('byClassQuelle?: Record<string, Record<string, { pnl: number; n: number; fees?: number; notional?: number; kantePct?: number | null }>>;');
    expect(data).toContain('byClassQuelle7t?: Record<string, Record<string, { pnl: number; n: number; fees?: number; notional?: number; kantePct?: number | null }>>;');
  });

  it('Aufbau nach UI-Kritik 08.10.: Legende als Kopfzeile, Gruppen je Klasse mit Summe (schlechteste zuerst), Wege ohne Präfix, Lücken gedämpft', () => {
    const fn = dashboard.slice(dashboard.indexOf('function renderQuellen'));
    const kopf = fn.slice(0, 3600);
    // Legende IN der Tabelle, nicht im Label (dort würde „n" zu „N")
    expect(kopf).toContain(`<div class="fl-row q-row fl-head"><span>${'${t(\'pf.quelleWeg\')}'}</span><span>${'${t(\'pf.quelleTrades\')}'}</span>`);
    // Gruppenkopf mit Klarname und Summe; Klassen nach Summen-P&L aufsteigend
    expect(kopf).toContain('gruppen.sort((a, b) => a.pnl - b.pnl);');
    expect(kopf).toContain('const klasse = CLASS_LABELS[g.klasse] ?? g.klasse.replace(/[^\\w-]/g, \'\');');
    expect(kopf).toContain('<div class="fl-row q-row q-klasse"><span>${klasse}</span>');
    // Wege: schlechteste Kante zuerst, ungemessene ans Ende (nicht in die Mitte)
    expect(kopf).toContain('const ka = a.kantePct ?? Number.POSITIVE_INFINITY;');
    expect(kopf).toContain('const kb = b.kantePct ?? Number.POSITIVE_INFINITY;');
    expect(kopf).toContain('return ka - kb || b.n - a.n;');
    // Messlücke sichtbar gedämpft und erklärt
    expect(kopf).toContain("${z.kantePct === null ? ' q-luecke' : ''}");
    expect(kopf).toContain("title=\"${t('pf.quelleLuecke')}\"");
    // Ampel auf der KANTE, P&L neutral; ein Zahlenformat je Karte (Leerzeichen vor %, „+" am P&L)
    expect(kopf).toContain("const kante = (v: number | null): string => (v === null ? '--' : `${v.toFixed(2)} %`);");
    expect(kopf).toContain("const geld = (v: number): string => (v > 0 ? '+' : '') + money(v);");
    expect(kopf).toContain('<span class="mono ${kanteTon(z.kantePct)}">${kante(z.kantePct)}</span>');
    expect(kopf).toContain('<span class="mono">${geld(z.pnl)}</span></div>');
    expect(kopf).not.toContain('fmtPct(');
    // eigenes Raster: vier Spalten, Zahlen in voller Breite, Name mit Ellipse (Bildbefund 08.10.)
    const css = readFileSync(join(import.meta.dirname, '..', 'src', 'theme.css'), 'utf8');
    expect(css).toContain('.q-row { grid-template-columns: minmax(0, 1fr) max-content max-content max-content; }');
    expect(css).toContain('.q-row span:first-child { overflow: hidden; text-overflow: ellipsis; }');
    expect(css).toContain('.q-luecke { color: var(--t3); }');
    // Entscheidungstabelle: die beste Zeile darf nicht hinter dem 168-px-Scroll liegen (Bildbefund 08.10.)
    expect(css).toContain('.q-tbl { max-height: 360px; }');
  });

  it('alle Anzeige-Zeilen stehen DE und EN im Wörterbuch, alle acht Wege haben einen Klarnamen', () => {
    for (const k of [
      'pf.quellen',
      'pf.quelleWeg',
      'pf.quelleTrades',
      'pf.quelleKante',
      'pf.quelleLuecke',
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
    // Label = Infotip-Titel (ein Name für eine Sache) und kurz genug, dass es mit ⓘ in der 280-px-Seitenspalte einzeilig bleibt
    expect(DE['pf.quellen']).toBe('Ergebnis je Einstiegsweg');
    expect(EN['pf.quellen']).toBe('Result by entry path');
    expect((DE['pf.quellen'] ?? '').length).toBeLessThanOrEqual(34);
    expect((EN['pf.quellen'] ?? '').length).toBeLessThanOrEqual(34);
    expect(INFO_DE['quellen']?.d).toContain('„Nachgebucht" und „Unbekannt" sind keine Wege, sondern Lücken');
    // die Lücke „-- bei echtem Ergebnis" ist erklärt, Projektgeschichte und Jargon („Stempel") sind draußen
    expect(INFO_DE['quellen']?.d).toContain('Steht „--", fehlt älteren Trades der Gebührensatz');
    expect(INFO_DE['quellen']?.d).not.toContain('Stempel');
    expect(INFO_DE['quellen']?.d).not.toContain('Der Anlass');
    expect((INFO_DE['quellen']?.d ?? '').length).toBeLessThan(900);
    expect(INFO_DE['quellen']?.d).toContain('nur dein eigenes Konto');
    expect(INFO_EN['quellen']?.t).toBe('Result by entry path');
    expect(INFO_EN['quellen']?.d).toContain('“Synced” and “Unknown” are not paths but gaps');
    expect(INFO_EN['quellen']?.d).not.toContain('stamp');
    expect(INFO_EN['quellen']?.d).toContain('only your own account');
  });
});
