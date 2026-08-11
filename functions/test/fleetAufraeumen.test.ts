/**
 * Audit-Befund 11.08. (B3): Die Schatten-Flotte wurde nie kleiner.
 *
 * ── Was schiefging ────────────────────────────────────────────────────────
 *
 * `stepFleet` räumt Varianten aus dem Zustand, die es nicht mehr gibt (Achse
 * geändert, Basis verschoben) — mit `delete state[id]`. Der Aufrufer schrieb
 * das Ergebnis mit `set({ variants: state }, { merge: true })`, und Firestore
 * merged Maps FELDWEISE: Was im geschriebenen Objekt fehlt, bleibt im
 * Dokument stehen. Das Aufräumen wirkte also nur im Arbeitsspeicher.
 *
 * Sichtbar wurde davon nichts. Das Dokument wuchs still: jede je gefahrene
 * Variante mit bis zu 400 `pnls` plus Schattenbuch. Bei der 1-MB-Grenze
 * scheitert der Schreibvorgang — und der `catch` um die Flotte schluckt ihn
 * als `logger.warn`. Ab da stünde die Selbstoptimierung dieses Kontos
 * dauerhaft still, während alles andere weiterläuft.
 *
 * ── Warum die Aufräumliste eine Rückgabe ist ──────────────────────────────
 *
 * Ein stilles `delete` im Zustand SIEHT aus wie Aufräumen und ist keins.
 * Als `entfernt`-Liste muss der Aufrufer etwas damit tun — und dass er es
 * tut, ist prüfbar (unten, letzter Block).
 *
 * Dass Firestore sich so verhält wie hier angenommen, belegt
 * `rules-test/fleetMerge.rules.test.ts` am echten Emulator. Eine Attrappe
 * hätte nur meine Vorstellung von Firestore geprüft — genau die
 * Fehlerfamilie, aus der dieser Befund stammt.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FieldValue } from 'firebase-admin/firestore';
import { DEFAULT_STRATEGY, type Strategy, type Variant } from '../../shared/src/index.js';
import { emptyVariantState, stepFleet, type FleetState } from '../src/core/tuneFleet.js';
import { fleetSchreibfeld } from '../src/scheduled/scanMarket.js';

const T0 = new Date('2026-08-11T14:00:00.000Z');

const variante = (id: string): Variant => ({
  id,
  axis: 'test',
  label: 'Test',
  value: id,
  strategy: structuredClone(DEFAULT_STRATEGY) as Strategy,
});

/** Ist der Wert der Lösch-Sentinel des Admin-SDK? */
const istLoeschung = (wert: unknown): boolean =>
  wert instanceof FieldValue && FieldValue.delete().isEqual(wert);

describe('stepFleet meldet, was aufgeräumt werden muss', () => {
  it('nennt eine Variante, die es nicht mehr gibt', () => {
    const vorher: FleetState = { alt: emptyVariantState(T0), neu: emptyVariantState(T0) };
    const r = stepFleet([variante('neu')], new Map(), vorher, [], T0);
    expect(r.entfernt).toEqual(['alt']);
    expect(Object.keys(r.state)).toEqual(['neu']);
  });

  it('meldet nichts, wenn sich die Achse nicht geändert hat', () => {
    const vorher: FleetState = { a: emptyVariantState(T0) };
    expect(stepFleet([variante('a')], new Map(), vorher, [], T0).entfernt).toEqual([]);
  });

  it('meldet auch beim ersten Lauf nichts', () => {
    expect(stepFleet([variante('a')], new Map(), {}, [], T0).entfernt).toEqual([]);
  });

  it('bei einem kompletten Achsenwechsel fällt die ganze alte Flotte', () => {
    const vorher: FleetState = {
      'rsi:20': emptyVariantState(T0),
      'rsi:25': emptyVariantState(T0),
      'rsi:30': emptyVariantState(T0),
    };
    const r = stepFleet([variante('macd:9')], new Map(), vorher, [], T0);
    expect(r.entfernt.sort()).toEqual(['rsi:20', 'rsi:25', 'rsi:30']);
    // Genau dieser Fall ist der Alltag: Jede Parameter-Änderung des Nutzers
    // erzeugt neue Kennungen, die alten bleiben ohne Fix für immer liegen.
    expect(Object.keys(r.state)).toEqual(['macd:9']);
  });

  it('was entfernt gemeldet wird, steht NICHT mehr im Zustand', () => {
    // Sonst schriebe der Aufrufer denselben Schlüssel gleichzeitig als Wert
    // und als Löschung — Firestore lehnt das ab, und der Fehler landete im
    // stillen `catch`.
    const vorher: FleetState = { alt: emptyVariantState(T0), b: emptyVariantState(T0) };
    const r = stepFleet([variante('b')], new Map(), vorher, [], T0);
    for (const id of r.entfernt) expect(id in r.state).toBe(false);
  });
});

describe('fleetSchreibfeld baut das Feld, das wirklich aufräumt', () => {
  const zustand = { a: { book: { balance: 1 } }, b: { book: { balance: 2 } } } as unknown as FleetState;

  it('reicht die aktuellen Varianten unverändert durch', () => {
    const feld = fleetSchreibfeld(zustand, []);
    expect(Object.keys(feld).sort()).toEqual(['a', 'b']);
    expect(feld['a']).toBe(zustand['a']);
  });

  it('setzt für jede entfernte Kennung einen Lösch-Sentinel', () => {
    const feld = fleetSchreibfeld(zustand, ['alt', 'älter']);
    expect(istLoeschung(feld['alt'])).toBe(true);
    expect(istLoeschung(feld['älter'])).toBe(true);
  });

  it('die aktuellen Varianten bleiben dabei echte Werte', () => {
    // Der Fehler, der hier am teuersten wäre: ein Sentinel auf einer
    // Variante, die gerade läuft. Ihre 30 Ergebnisse wären weg, und die
    // Evidenzschwelle liefe von vorn los.
    const feld = fleetSchreibfeld(zustand, ['alt']);
    expect(istLoeschung(feld['a'])).toBe(false);
    expect(istLoeschung(feld['b'])).toBe(false);
  });

  it('überschreibt niemals eine Variante, die im Zustand steht', () => {
    // Kann `stepFleet` nicht liefern (Test oben), aber die Folge wäre der
    // Verlust echter Messdaten — deshalb hier hart abgefangen statt auf den
    // Aufrufer vertraut.
    const feld = fleetSchreibfeld(zustand, ['a']);
    expect(feld['a']).toBe(zustand['a']);
  });

  it('ohne Aufräumliste ist das Feld eine reine Kopie', () => {
    const feld = fleetSchreibfeld(zustand, []);
    expect(feld).not.toBe(zustand);
    expect(feld).toEqual(zustand);
  });

  it('ein leerer Zustand mit Löschungen ist zulässig', () => {
    // Kommt vor, wenn die Flotte auf null Varianten schrumpft.
    const feld = fleetSchreibfeld({} as FleetState, ['alt']);
    expect(istLoeschung(feld['alt'])).toBe(true);
  });
});

describe('Quelltext: der Aufrufer benutzt die Aufräumliste', () => {
  const pfad = join(import.meta.dirname, '..', 'src', 'scheduled', 'scanMarket.ts');
  const block = (): string => {
    const text = readFileSync(pfad, 'utf8');
    const ab = text.indexOf('const { state, entfernt } = stepFleet(');
    expect(ab, 'stepFleet-Aufruf nicht gefunden').toBeGreaterThan(0);
    return text.slice(ab, text.indexOf('catch', ab));
  };

  it('schreibt fleetSchreibfeld statt state', () => {
    /* Der Kern des Fixes. Ohne diese Zeile wäre `entfernt` ein totes Feld —
     * und die sieben Tests darüber blieben grün, während sich das Dokument
     * in Produktion weiter füllt. Genau so ist der Befund entstanden. */
    expect(block()).toContain('variants: fleetSchreibfeld(state, entfernt)');
  });

  it('und schreibt nirgends mehr das nackte state-Objekt', () => {
    expect(block()).not.toContain('variants: state');
  });
});
