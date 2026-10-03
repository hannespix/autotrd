/**
 * Wann eine Depot-Übernahme die Messstrecke kostet (Owner-Befund 16.08.).
 *
 * Die Anti-Wasch-Garantie ist der eigentliche Prüfgegenstand: Jede Übernahme,
 * die IRGENDETWAS bewegt, muss weiter stempeln. Entfallen darf nur die
 * Bestrafung für einen Klick ohne Wirkung.
 */
import { describe, expect, it } from 'vitest';
import { BASIS_TOLERANZ, istNoOpUebernahme } from '../src/uebernahmeSchnitt';

const gleich = {
  geloescht: 0,
  importiert: 0,
  neuePositionen: 0,
  basisVorher: 100_000,
  basisNachher: 100_000,
};

describe('istNoOpUebernahme', () => {
  it('identische Lage ⇒ kein Schnitt (der Owner-Fall)', () => {
    expect(istNoOpUebernahme(gleich)).toBe(true);
  });

  it('Rauschen unterhalb der Toleranz ⇒ kein Schnitt', () => {
    // 0,4 % Drift: gebuchte Zinsen, Rundung auf Stückzahlen.
    expect(istNoOpUebernahme({ ...gleich, basisNachher: 100_400 })).toBe(true);
    expect(istNoOpUebernahme({ ...gleich, basisNachher: 99_600 })).toBe(true);
  });

  it('echte Kapitalbewegung ⇒ SCHNITT (Anti-Wasch-Garantie)', () => {
    // Knapp ÜBER der Toleranz, nicht exakt darauf: Auf der Grenze selbst
    // entscheidet Gleitkomma-Rauschen (100_000 × 1,005 ergibt in IEEE-754
    // 100_499,99999999999). Ein Test, der das pinnt, prüft die
    // Rundungsrichtung der Maschine, nicht die Regel — und die Regel ist:
    // spürbare Bewegung stempelt.
    expect(istNoOpUebernahme({ ...gleich, basisNachher: 100_000 * (1 + BASIS_TOLERANZ * 1.2) })).toBe(false);
    expect(istNoOpUebernahme({ ...gleich, basisNachher: 150_000 })).toBe(false);
    expect(istNoOpUebernahme({ ...gleich, basisNachher: 50_000 })).toBe(false);
    // Und die Größenordnung, um die es geht: 500 $ auf 100.000 $ Basis.
    expect(istNoOpUebernahme({ ...gleich, basisNachher: 101_000 })).toBe(false);
  });

  it('jedes bewegte Stück erzwingt den Schnitt — einzeln geprüft', () => {
    expect(istNoOpUebernahme({ ...gleich, geloescht: 1 })).toBe(false);
    expect(istNoOpUebernahme({ ...gleich, importiert: 1 })).toBe(false);
    expect(istNoOpUebernahme({ ...gleich, neuePositionen: 1 })).toBe(false);
  });

  it('die ERSTE Übernahme ist immer eine Zäsur (keine frühere Basis)', () => {
    expect(istNoOpUebernahme({ ...gleich, basisVorher: null })).toBe(false);
    expect(istNoOpUebernahme({ ...gleich, basisVorher: 0 })).toBe(false);
  });

  it('kaputte Zahlen stempeln — im Zweifel die strengere Seite', () => {
    expect(istNoOpUebernahme({ ...gleich, basisNachher: Number.NaN })).toBe(false);
    expect(istNoOpUebernahme({ ...gleich, basisVorher: Number.NaN })).toBe(false);
  });
});
