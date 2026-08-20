/**
 * Wächter des Teilen-Flusses (Owner-Befund 20.08., Android: „beim Drücken
 * passiert gar nichts").
 *
 * Drei Regeln, die genau diesen Befund verhindern:
 *  1. Kein `url` neben `files` in navigator.share-Nutzlasten — die Kombi ist
 *     der bekannte Android-Stolperstein, geprüft wird mit canShare ohnehin
 *     nur die Datei-Nutzlast, und die Adresse steht im Text.
 *  2. Das Feedback des Video-Teilen-Schritts steht AM KNOPF (#anVideoStatus),
 *     nicht oben im Kopf — dort ist es am Handy aus dem Sichtfeld.
 *  3. Kein stummer Fehlerzweig: auch AbortError zeigt eine sichtbare Meldung
 *     (sh.abgebrochen), alles andere den Fehlernamen samt Plan B.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const wurzel = join(dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = readFileSync(join(wurzel, 'src', 'dashboard.ts'), 'utf8');
const i18n = readFileSync(join(wurzel, 'src', 'i18n.ts'), 'utf8');

describe('Teilen-Fluss (Android-Befund 20.08.)', () => {
  it('keine share-Nutzlast kombiniert files mit url', () => {
    // Jedes navigator.share(…) mit seinem Argumentfenster einsammeln.
    const aufrufe = [...dashboard.matchAll(/navigator\.share\(([\s\S]{0,300}?)\)\s*;/g)];
    expect(aufrufe.length).toBeGreaterThanOrEqual(3);
    for (const [ganz, arg] of aufrufe) {
      if (/files\s*[:\]]/.test(arg!)) {
        expect(ganz, `url neben files in: ${ganz!.slice(0, 120)}`).not.toMatch(/url\s*:/);
      }
    }
  });

  it('Video-Teilen meldet an #anVideoStatus, nicht (nur) oben im Kopf', () => {
    const fn = dashboard.match(/async function teileVideoDatei[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain("$('anVideoStatus')");
    expect(fn).not.toContain("$('anShareStatus')");
    // Markup: die Statuszeile existiert in der Video-Box.
    expect(dashboard).toMatch(/id="anVideoBox"[\s\S]{0,900}id="anVideoStatus"/);
  });

  it('kein stummer Fehlerzweig: AbortError wird sichtbar, Rest mit Plan B', () => {
    const fn = dashboard.match(/async function teileVideoDatei[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain("t('sh.abgebrochen')");
    expect(fn).toContain("t('sh.teilenPlanB')");
    // Der alte Stumm-Zweig (`if (name !== 'AbortError')` ohne else) darf
    // nicht zurückkommen: im Funktionskörper muss JEDER catch-Pfad den
    // Statustext setzen.
    expect(fn).toMatch(/catch[\s\S]*status\.textContent\s*=/);
    expect(fn).not.toMatch(/if\s*\(name !== 'AbortError'\)\s*\{/);
  });

  it('sh.abgebrochen und sh.teilenPlanB existieren in DE und EN', () => {
    for (const key of ["'sh.abgebrochen'", "'sh.teilenPlanB'"]) {
      expect(i18n.split(key).length, `${key} fehlt in DE oder EN`).toBe(3);
    }
    expect(i18n).toMatch(/'sh\.teilenPlanB': '[^']*\{0\}[^']*'/);
  });

  it('Herunterladen meldet ebenfalls an der Video-Box', () => {
    const fn = dashboard.match(/function speichereVideoDatei[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain("$('anVideoStatus')");
  });
});
