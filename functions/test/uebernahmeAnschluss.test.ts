/**
 * Anschluss-Wächter: Hängt der Schnitt in `adoptBroker` wirklich an der
 * Wirkungs-Prüfung? (Owner-Befund 16.08.)
 *
 * Die pure Entscheidung steht in shared/src/uebernahmeSchnitt.ts und ist
 * dort getestet. Was diese Datei prüft, ist das, was eine reine
 * Funktions-Prüfung nie sehen kann: dass die drei Stempel — `resetAt`,
 * `vortagEquity` und das Schneiden der Equity-Serie — tatsächlich an ihr
 * hängen. Eine Entscheidungsfunktion, die niemand fragt, ist der alte
 * Zustand mit einer zusätzlichen Datei.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const quelle = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/callable/adoptBroker.ts'),
  'utf8',
);

describe('adoptBroker: Schnitt nur bei Wirkung (Quelltext-Wächter)', () => {
  it('die Wirkung wird aus ECHTEN Zählern gebildet, nicht aus Absicht', () => {
    expect(quelle).toContain('const ohneWirkung = istNoOpUebernahme(wirkung);');
    for (const feld of [
      'geloescht,',
      'importiert,',
      'neuePositionen,',
      "basisVorher: typeof alteBasis === 'number' ? alteBasis : null,",
      'basisNachher: basisKapital,',
    ]) {
      expect(quelle, `Wirkungs-Feld fehlt: ${feld}`).toContain(feld);
    }
    // Neue Positionen werden gegen den BUCH-Bestand gezählt, nicht geraten.
    expect(quelle).toContain('if (!buchSymbole.has(p.symbol)) neuePositionen += 1;');
  });

  it('resetAt/uebernahmeAt werden nur bei Wirkung gestempelt', () => {
    expect(quelle).toContain(
      "...(ohneWirkung ? {} : { 'wallet.resetAt': now, 'wallet.uebernahmeAt': now }),",
    );
  });

  it('die Equity-Serie — die Messstrecke — wird nur bei Wirkung geschnitten', () => {
    const schnittAb = quelle.indexOf('if (!ohneWirkung) {');
    const loeschung = quelle.indexOf('for (const d of alteSerie.docs) ops.push((b) => b.delete(d.ref));');
    expect(schnittAb, 'Wirkungs-Gate vor der Serien-Löschung fehlt').toBeGreaterThan(0);
    expect(loeschung).toBeGreaterThan(schnittAb);
  });

  it('die Kapitalbasis wird IMMER geschrieben — nur der Schnitt ist bedingt', () => {
    // Cash und Basis folgen dem Broker in jedem Fall; sonst bliebe das Buch
    // falsch, nur um die Messstrecke zu retten.
    expect(quelle).toContain("'wallet.paperBalance': cashRund,");
    expect(quelle).toContain("'wallet.baseCapital': basisKapital,");
  });

  it('die Antwort sagt dem Nutzer, ob geschnitten wurde', () => {
    expect(quelle).toContain('schnitt: !ohneWirkung,');
    expect(quelle).toContain('die Messstrecke der Live-Reife läuft weiter');
  });
});
