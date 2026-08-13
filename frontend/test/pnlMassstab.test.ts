/**
 * Maßstab der Gesamt-P&L (Owner-Frage 13.08., „was ist die Realität???").
 *
 * Der Screenshot zeigte „Gesamt P&L +$2.245,47" (grün) neben einer
 * Handels-Analyse mit „−1,79 % / −$1.719,53" (rot) — und las sich wie ein
 * Widerspruch. Tatsächlich sind es zwei Zeiträume: Gesamt P&L = Equity −
 * Kapitalbasis, und die Basis wurde beim Depot-Schnitt (Übernahme 13.08.)
 * neu geankert — die Zahl zählt erst AB dem Schnitt (Realisiert seitdem: 0,
 * Offen: +2.245). Die Handels-Analyse zählt die 9 GESCHLOSSENEN Trades im
 * Zeitfenster — alle vor dem Schnitt (−1.719). Beide stimmen.
 *
 * Eine grüne Zahl, die sich ohne Kontext wie Lebenszeit-Gewinn liest, ist
 * aber ein Anzeige-Fehler in Richtung „gefühlter Gewinn" — deshalb steht der
 * Maßstab jetzt direkt an der Zahl, und der Infotip erklärt beide Fragen.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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

  it('nennt Schnitt-Datum und Basis und grenzt gegen die Handels-Analyse ab', () => {
    expect(dashboard).toContain('Zählt seit Depot-Schnitt am ${datum} (Basis ${money(basis)})');
    expect(dashboard).toContain('Früher geschlossene Trades stehen NICHT in dieser Zahl');
  });

  it('der Infotip an der Zahl erklärt beide Fragen (Gesamt vs. Handels-Analyse)', () => {
    expect(dashboard).toContain("Gesamt P&amp;L ${iBtn('gesamtPnl')}");
    expect(infotips).toContain('gesamtPnl:');
    expect(infotips).toContain('Equity (live) − Kapitalbasis');
    expect(infotips).toContain('Die Handels-Analyse beantwortet eine ANDERE Frage');
  });
});
