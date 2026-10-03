/**
 * Audit-Befunde 11.08. (F9, F10, F11): Modulzustand überlebte das Abmelden.
 *
 * ── Eine Ursache, drei Wirkungen ──────────────────────────────────────────
 *
 * `unmountDashboard` räumte gründlich auf — aber nur, was im `st`-Objekt
 * hing. Alles, was als Modulvariable daneben liegt, blieb stehen und war
 * beim nächsten Anmelden noch da:
 *
 *  - **F11 (Listener-Leck):** `mtState.subs` hält einen `onSnapshot` auf den
 *    Kurs des zuletzt gewählten Handels-Symbols. Nach dem Abmelden lief er
 *    weiter — Firestore-Verbindung, Kosten, und ein Callback, das in ein
 *    geleertes DOM schreibt.
 *  - **F11 (scharfe Order):** `mtState.arm` ist der Zwei-Klick-Schutz mit
 *    Zeitfenster. Sein `setTimeout` feuerte nach dem Abmelden in Knöpfe, die
 *    es nicht mehr gibt.
 *  - **F9 (fremde Loadouts):** `eigeneLoadouts` und `loGewaehlt` gehören dem
 *    Konto. Meldet sich auf demselben Gerät jemand anders an, sah er bis zum
 *    ersten Nachladen die Loadouts seines Vorgängers.
 *  - **F10 (Tour einmal je Gerät):** `tourAutostartGeprueft` blieb `true`.
 *    Der zweite Nutzer bekam die Einführung nie zu sehen — genau der, der
 *    sie am nötigsten hätte.
 *
 * ── Warum das hier als Quelltext-Test steht ───────────────────────────────
 *
 * Die Funktion ist reines Aufräumen ohne Rückgabewert; ihr Ergebnis ist
 * modulinterner Zustand, den kein Test von außen sieht. Was prüfbar bleibt
 * und den Befund tatsächlich abdeckt: dass sie JEDE nutzergebundene
 * Modulvariable anfasst und dass `unmountDashboard` sie aufruft. Genau
 * daran hing der Fehler — nicht am Zurücksetzen selbst, sondern daran, dass
 * es niemand tat.
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

describe('Das Trade-Fenster lässt nichts zurück', () => {
  it('löst seine Listener', () => {
    const b = resetBlock();
    expect(b).toContain('for (const u of mtState.subs) u();');
    expect(b).toContain('mtState.subs.length = 0;');
  });

  it('löscht den Timer der scharfen Order', () => {
    /* Nicht nur `arm = null`: Der Timer läuft dann trotzdem und greift auf
     * Knöpfe zu, die es nicht mehr gibt. */
    const b = resetBlock();
    expect(b).toContain('window.clearTimeout(mtState.arm.timer)');
    expect(b).toContain('mtState.arm = null;');
  });

  it('vergisst Symbol und Kurs', () => {
    const b = resetBlock();
    expect(b).toContain('mtState.sym = null;');
    expect(b).toContain('mtState.price = null;');
  });
});

describe('Nutzergebundene Daten überleben den Wechsel nicht', () => {
  for (const [name, zuweisung] of [
    ['Loadouts', 'eigeneLoadouts = [];'],
    ['gewähltes Loadout', 'loGewaehlt = null;'],
    ['bewährte Einstellungen', 'bestPractice = null;'],
    ['Zeichnungen-Cache', 'zeichnungenCache = null;'],
    ['Tour-Merker', 'tourAutostartGeprueft = false;'],
  ] as const) {
    it(`${name} wird zurückgesetzt`, () => {
      expect(resetBlock()).toContain(zuweisung);
    });
  }
});

describe('Freilaufende Timer werden gestoppt', () => {
  it('der Auflösungs-Timer', () => {
    // Er hängt an keinem `st` und feuert nach dem Abmelden in eine
    // Oberfläche, die es nicht mehr gibt.
    const b = resetBlock();
    expect(b).toContain('window.clearTimeout(autoResTimer)');
    expect(b).toContain('autoResTimer = null;');
  });

  it('der Ereignis-Tooltip-Timer', () => {
    const b = resetBlock();
    expect(b).toContain('window.clearTimeout(evTipTimer)');
    expect(b).toContain('evTipTimer = null;');
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

  it('das Aufräumen der st-gebundenen Listener bleibt bestehen', () => {
    // Der neue Teil ergänzt den alten, er ersetzt ihn nicht.
    const text = quelle();
    const ab = text.indexOf('export function unmountDashboard(): void {');
    const block = text.slice(ab, text.indexOf('st = null;', ab));
    for (const feld of ['st.subs', 'st.symbolSubs', 'st.chart2Subs', 'st.watchlistSubs']) {
      expect(block, feld).toContain(`clearSubs(${feld})`);
    }
    expect(block).toContain('for (const u of st.positionSubs.values()) u();');
    expect(block).toContain('for (const t of st.timers) clearInterval(t);');
  });
});
