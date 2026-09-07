/**
 * Maßstab der Gesamt-P&L (Owner-Frage 13.08., „was ist die Realität???").
 *
 * Gesamt P&L = Equity − Kapitalbasis, und die Basis wird beim Depot-Schnitt
 * (Reset) neu geankert — die Zahl zählt erst AB dem Schnitt. Eine grüne
 * Zahl, die sich ohne Kontext wie Lebenszeit-Gewinn liest, ist ein
 * Anzeige-Fehler in Richtung „gefühlter Gewinn" — deshalb steht der
 * Maßstab direkt an der Zahl, und der Infotip erklärt beide Fragen.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DE } from '../src/i18n.js';
import { join } from 'node:path';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');
const infotips = readFileSync(join(import.meta.dirname, '..', 'src', 'infotips.ts'), 'utf8');

describe('Gesamt-P&L-Maßstab — Markup und Logik', () => {
  it('die Maßstab-Zeile sitzt direkt an der Zahl (zwischen Gesamt P&L und Realisiert)', () => {
    const pnl = dashboard.indexOf('id="vPnl"');
    const basis = dashboard.indexOf('id="vPnlBasis"');
    const realisiert = dashboard.indexOf('id="vClosed"');
    expect(basis, 'vPnlBasis fehlt im Markup').toBeGreaterThan(pnl);
    expect(basis).toBeLessThan(realisiert);
  });

  it('erscheint NUR nach einem Depot-Schnitt (wallet.resetAt)', () => {
    const render = dashboard.slice(dashboard.indexOf('function renderPortfolio'));
    const stelle = render.indexOf('const resetAt = st.wallet?.resetAt;');
    expect(stelle, 'resetAt-Bedingung fehlt').toBeGreaterThan(0);
    expect(render.slice(stelle, stelle + 700)).toContain('basisHint.hidden = !datum');
  });

  it('nennt Schnitt-Datum und Basis und grenzt gegen die Historie ab', () => {
    expect(dashboard).toContain("${t('pf.seitSchnittA')} ${datum} (${t('pf.basis')} ${money(basis)})");
    expect(DE['pf.seitSchnittB']).toContain('Früher geschlossene Trades stehen NICHT in dieser Zahl');
  });

  it('die Basis ist wallet.baseCapital, sonst das Startkapital der Strategie', () => {
    expect(dashboard).toContain('const basis = st.wallet?.baseCapital ?? st.strategy.broker.initialCapital;');
  });

  it('der Infotip an der Zahl erklärt beide Fragen (Gesamt vs. Historie)', () => {
    expect(dashboard).toContain("${t('pf.gesamtPnl')} ${iBtn('gesamtPnl')}");
    expect(infotips).toContain('gesamtPnl:');
    expect(infotips).toContain('Equity (live) − Kapitalbasis');
    expect(infotips).toContain('Die Handelshistorie beantwortet eine ANDERE Frage');
  });
});
