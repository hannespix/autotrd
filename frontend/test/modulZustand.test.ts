/**
 * Modulzustand überlebt das Abmelden nicht (Audit-Befunde F9/F10/F11,
 * fortgeschrieben für den Auto-Trader).
 *
 * `unmountDashboard` räumt, was im `st`-Objekt hängt. Alles, was als
 * Modulvariable daneben liegt, bliebe sonst stehen und wäre beim nächsten
 * Anmelden noch da — beim Nutzerwechsel auf demselben Gerät sähe der
 * Nachfolger die Admin-Liste des Vorgängers, ein armierter Admin-Knopf
 * feuerte mit seinem Timer in ein totes DOM, eine offene Kommando-
 * Bestätigung träfe das falsche Konto.
 *
 * Die Funktion ist reines Aufräumen ohne Rückgabewert; prüfbar bleibt, dass
 * sie JEDE nutzergebundene Modulvariable anfasst und dass `unmountDashboard`
 * sie aufruft — genau daran hing der ursprüngliche Fehler.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const quelle = (): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

const resetBlock = (): string => {
  const text = quelle();
  const ab = text.indexOf('export function setzeModulZustandZurueck(): void {');
  expect(ab, 'setzeModulZustandZurueck nicht gefunden').toBeGreaterThan(0);
  return text.slice(ab, text.indexOf('\n}', ab));
};

describe('Nutzergebundene Daten überleben den Wechsel nicht', () => {
  for (const [name, zuweisung] of [
    ['Admin-Liste', 'admZeilen = [];'],
    ['offener Admin-Streifen', 'admOffenerStreifen = null;'],
    ['offene Kommando-Bestätigung', 'cmdOffen = null;'],
    ['Tabellen-Sortierung', 'sortZustand.jn = null;'],
  ] as const) {
    it(`${name} wird zurückgesetzt`, () => {
      expect(resetBlock()).toContain(zuweisung);
    });
  }

  it('der armierte Admin-Knopf wird entschärft — samt Timer', () => {
    /* Nicht nur `admArmiert = null`: Der Timer liefe dann trotzdem und
     * griffe auf Knöpfe zu, die es nicht mehr gibt. admEntwaffne räumt
     * beides. */
    expect(resetBlock()).toContain('admEntwaffne();');
    const text = quelle();
    const ab = text.indexOf('function admEntwaffne(): void {');
    const block = text.slice(ab, text.indexOf('\n}', ab));
    expect(block).toContain('window.clearTimeout(admArmiert.timer);');
    expect(block).toContain('admArmiert = null;');
  });

  it('die anonymen document-Listener werden auf einmal gelöst', () => {
    expect(resetBlock()).toContain('docListenerAbort?.abort();');
    expect(resetBlock()).toContain('docListenerAbort = null;');
  });
});

describe('Die Verdrahtung', () => {
  it('unmountDashboard ruft das Zurücksetzen auf', () => {
    /* Der Kern. Ohne diese Zeile wäre die Funktion richtig und wirkungslos —
     * und alle Tests darüber blieben grün, während in Produktion weiter
     * Listener und Timer überleben. */
    const text = quelle();
    const ab = text.indexOf('export function unmountDashboard(): void {');
    const block = text.slice(ab, text.indexOf('\n}', text.indexOf('st = null;', ab)));
    expect(block).toContain('setzeModulZustandZurueck();');
  });

  it('und zwar VOR st = null', () => {
    // Was im Zurücksetzen noch auf `st` zugreift, muss es vorfinden.
    const text = quelle();
    const ab = text.indexOf('export function unmountDashboard(): void {');
    const reset = text.indexOf('setzeModulZustandZurueck();', ab);
    const nullen = text.indexOf('st = null;', ab);
    expect(reset).toBeGreaterThan(0);
    expect(reset).toBeLessThan(nullen);
  });

  it('das Aufräumen der st-gebundenen Listener und Timer bleibt bestehen', () => {
    // Der Modul-Reset ergänzt das Aufräumen, er ersetzt es nicht: Firestore-
    // Abos (globale + je Positions-Symbol) und Timer hängen an `st`.
    const text = quelle();
    const ab = text.indexOf('export function unmountDashboard(): void {');
    const block = text.slice(ab, text.indexOf('st = null;', ab));
    expect(block).toContain('for (const u of st.subs) u();');
    expect(block).toContain('for (const u of st.positionSubs.values()) u();');
    expect(block).toContain('for (const t of st.timers) clearInterval(t);');
    expect(block).toContain("document.removeEventListener('keydown', onEscape);");
  });

  it('jedes Firestore-Abo des Mounts landet in st.subs — sonst überlebt es das Abmelden', () => {
    const text = quelle();
    const ab = text.indexOf('export function mountDashboard(');
    const mount = text.slice(ab, text.indexOf('\nfunction onEscape', ab));
    for (const w of ['watchUserDoc(', 'watchPositions(', 'watchTrades(', 'watchPortfolioStats(', 'watchEquitySeries(', 'watchHealth(', 'watchEngineConfig(', 'watchChampion(']) {
      expect(mount, `${w} fehlt im Mount`).toContain(w);
    }
    const pushAb = mount.indexOf('st.subs.push(');
    const pushBis = mount.indexOf('\n  );', pushAb);
    const pushBlock = mount.slice(pushAb, pushBis);
    for (const w of ['watchUserDoc(', 'watchPositions(', 'watchTrades(', 'watchPortfolioStats(', 'watchEquitySeries(', 'watchHealth(', 'watchEngineConfig(', 'watchChampion(']) {
      expect(pushBlock, `${w} steht nicht in st.subs.push`).toContain(w);
    }
    // Die Kurs-Abos je Positions-Symbol haben ihre eigene Map — und die wird
    // beim Unmount geleert (s. o.).
    expect(text).toContain('st.positionSubs.set(');
  });
});
