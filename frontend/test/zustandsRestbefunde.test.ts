/**
 * Frontend-Zustandslogik — die Restbefunde aus dem Audit vom 11.08.
 * (Task 125): F7, F8, F12 und der F11-Rest (anonyme document-Listener).
 *
 * F6 (drei Antworten auf den Positionswert) und der F9/F10/F11-Kern
 * (Modulzustand beim Abmelden) sind früher behoben und in
 * positionAnzeige.test.ts bzw. modulZustand.test.ts verriegelt — hier
 * stehen die vier Stellen, die damals offen blieben.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

describe('F7 — Intraday-Stufenwechsel im Grid-Panel', () => {
  it('loadPanelIntraday hält die STUFE fest und verwirft veraltete Antworten', () => {
    const fn = dashboard.slice(dashboard.indexOf('async function loadPanelIntraday'));
    const kopf = fn.slice(0, 900);
    // Die Stufe wird VOR dem await festgehalten …
    const merken = kopf.indexOf('const stufe = p.intradayDays;');
    const laden = kopf.indexOf('await loadIntraday(');
    expect(merken, 'Stufen-Merker fehlt').toBeGreaterThan(0);
    expect(merken).toBeLessThan(laden);
    // … und NACH dem await verglichen: 1T→1W darf die langsamere
    // 1T-Antwort die 1W-Daten nicht mehr überschreiben.
    expect(kopf).toContain('p.intradayDays !== stufe');
  });
});

describe('F8 — Markt-Browser: Tab-Wechsel-Rennen und ehrliches Scheitern', () => {
  it('renderMarketGrid hält die Klasse VOR dem await fest und vergleicht danach', () => {
    const fn = dashboard.slice(dashboard.indexOf('async function renderMarketGrid'));
    const kopf = fn.slice(0, 1400);
    const merken = kopf.indexOf('const klasse = st.marketClass;');
    const laden = kopf.indexOf('await loadMarketQuotes()');
    expect(merken, 'Klassen-Merker fehlt').toBeGreaterThan(0);
    expect(merken).toBeLessThan(laden);
    expect(kopf).toContain('st.marketClass !== klasse');
  });

  it('Kurs- und Katalog-Fehler enden in einer Klartext-Meldung, nicht im alten Inhalt', () => {
    expect(dashboard).toContain('Kurse gerade nicht ladbar');
    expect(dashboard).toContain('Katalog gerade nicht ladbar');
  });
});

describe('F12 — ladeAeltereTrades: finally nach Abmeldung', () => {
  it('das finally greift nur mit vorhandenem st auf tradesLoading zu', () => {
    const fn = dashboard.slice(dashboard.indexOf('async function ladeAeltereTrades'));
    const ende = fn.slice(0, fn.indexOf('\n}') + 2);
    const finallyAb = ende.indexOf('} finally {');
    expect(finallyAb).toBeGreaterThan(0);
    const block = ende.slice(finallyAb);
    expect(block).toContain('if (st) {');
    // Der alte Fehler in Reinform darf nicht zurückkommen: ein nacktes
    // st.tradesLoading direkt nach dem finally-Kopf.
    expect(block).not.toMatch(/\} finally \{\s*st\.tradesLoading/);
  });
});

describe('F11-Rest — anonyme document-Listener am Abbruch-Signal', () => {
  it('jeder anonyme document-Listener trägt das Signal', () => {
    // Benannte Handler (onEscape, onGlobalHotkey) werden per
    // removeEventListener gelöst — alle übrigen document.addEventListener
    // müssen das Abbruch-Signal tragen, sonst sammeln sie sich je
    // Login-Zyklus an und schreiben nach dem Abmelden in ein totes DOM.
    const aufrufe = dashboard.match(/document\.addEventListener\(/g) ?? [];
    const benannt = (dashboard.match(/document\.addEventListener\('keydown', on[A-Z]\w+\)/g) ?? []).length;
    const mitSignal = (dashboard.match(/\}, \{ signal: docListenerSignal\(\) \}\)/g) ?? []).length;
    expect(aufrufe.length).toBe(benannt + mitSignal);
    expect(mitSignal).toBeGreaterThanOrEqual(5);
  });

  it('das Abmelden löst alle auf einmal (abort im Modulzustands-Reset)', () => {
    const reset = dashboard.slice(dashboard.indexOf('export function setzeModulZustandZurueck'));
    expect(reset.slice(0, 600)).toContain('docListenerAbort?.abort();');
  });
});
