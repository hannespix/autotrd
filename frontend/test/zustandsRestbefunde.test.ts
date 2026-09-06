/**
 * Frontend-Zustandslogik — die Restbefunde aus dem Audit vom 11.08.
 * (Task 125), soweit sie den Auto-Trader noch betreffen: F12 (finally nach
 * Abmeldung) und der F11-Rest (anonyme document-Listener). F7/F8 (Chart-
 * Raster, Markt-Browser) sind mit ihren Modulen gegangen.
 *
 * F6 (eine Antwort auf den Positionswert) und der F9/F10/F11-Kern
 * (Modulzustand beim Abmelden) sind in positionAnzeige.test.ts bzw.
 * modulZustand.test.ts verriegelt.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

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

  it('nach jedem await wird geprüft, ob der Nutzer noch da ist', () => {
    const fn = dashboard.slice(dashboard.indexOf('async function ladeAeltereTrades'));
    const ende = fn.slice(0, fn.indexOf('\n}') + 2);
    expect(ende).toContain('if (!st) return; // Abmeldung während der Abfrage');
  });
});

describe('F11-Rest — anonyme document-Listener am Abbruch-Signal', () => {
  it('jeder anonyme document-Listener trägt das Signal', () => {
    // Benannte Handler (onEscape) werden per removeEventListener gelöst —
    // alle übrigen document.addEventListener müssen das Abbruch-Signal
    // tragen, sonst sammeln sie sich je Login-Zyklus an und schreiben nach
    // dem Abmelden in ein totes DOM.
    const aufrufe = dashboard.match(/document\.addEventListener\(/g) ?? [];
    const benannt = (dashboard.match(/document\.addEventListener\('keydown', on[A-Z]\w+\)/g) ?? []).length;
    const mitSignal = (dashboard.match(/\}, \{ signal: docListenerSignal\(\) \}\)/g) ?? []).length;
    expect(aufrufe.length).toBe(benannt + mitSignal);
    expect(mitSignal).toBeGreaterThanOrEqual(1);
    expect(benannt).toBe(1);
  });

  it('das Abmelden löst alle auf einmal (abort im Modulzustands-Reset)', () => {
    const reset = dashboard.slice(dashboard.indexOf('export function setzeModulZustandZurueck'));
    expect(reset.slice(0, 600)).toContain('docListenerAbort?.abort();');
  });

  it('der nächste Mount bekommt ein frisches Signal', () => {
    // `??=` statt fester Zuweisung: Nach dem abort() steht null, der erste
    // Aufruf im neuen Mount legt einen neuen Controller an.
    expect(dashboard).toContain('docListenerAbort ??= new AbortController();');
  });
});
