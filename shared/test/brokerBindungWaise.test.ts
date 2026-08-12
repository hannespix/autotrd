/**
 * Verwaiste Depot-Bindungen erkennen.
 *
 * Owner-Direktive 12.08.: „Pro User muss mindestens ein Alpaca-Account
 * verknüpfbar sein — unkompliziert, mit möglichst wenig Verwaltungsaufwand."
 *
 * Ohne Selbstheilung wäre der Riegel aus #263 genau das Gegenteil: Wird ein
 * Konto gelöscht oder zurückgesetzt, ohne vorher zu trennen, bliebe seine
 * Bindung stehen — und das Depot wäre für immer belegt. Niemand könnte es je
 * wieder verbinden, auch der ursprüngliche Besitzer nicht. Jeder solche Fall
 * landete als Support-Fall beim Owner.
 *
 * Die Gegenprobe ist der eigentliche Inhalt dieser Tests: Eine Bindung darf
 * NUR fallen, wenn nachgewiesen ist, dass ihr Konto kein Broker-Dokument
 * mehr hat. „Im letzten Scan nicht vorgekommen" ist kein Nachweis — ein
 * pausiertes, gesperrtes oder gerade zurücksetzendes Konto kommt dort auch
 * nicht vor, und ihm das Depot wegzunehmen wäre schlimmer als eine
 * hängengebliebene Bindung.
 */
import { describe, expect, it } from 'vitest';

import { verwaisteBindungen, type Bindung } from '../src/brokerBindung.js';

const b = (uid: string): Bindung => ({ uid, at: '2026-08-01T10:00:00.000Z' });

describe('verwaisteBindungen', () => {
  it('gibt eine Bindung frei, deren Konto kein Broker-Dokument mehr hat', () => {
    const waisen = verwaisteBindungen({ 'fp-1': b('user-1') }, { 'user-1': false });
    expect(waisen).toEqual(['fp-1']);
  });

  it('lässt eine Bindung mit lebendem Broker-Dokument stehen', () => {
    expect(verwaisteBindungen({ 'fp-1': b('user-1') }, { 'user-1': true })).toEqual([]);
  });

  it('fasst ein Konto OHNE Befund nicht an — das ist die wichtige Richtung', () => {
    // Kein Eintrag heißt „nicht geprüft", nicht „nicht vorhanden". Ein
    // pausiertes oder gesperrtes Konto taucht im Scan nicht auf; ihm das
    // Depot zu nehmen wäre ein Datenverlust aus einer Nichtinformation.
    expect(verwaisteBindungen({ 'fp-1': b('user-1') }, {})).toEqual([]);
    expect(verwaisteBindungen({ 'fp-1': b('user-1') }, { 'user-2': false })).toEqual([]);
  });

  it('trennt mehrere Fälle sauber', () => {
    const waisen = verwaisteBindungen(
      { a: b('u1'), c: b('u3'), d: b('u4') },
      { u1: false, u2: false, u3: true },
    );
    expect(waisen).toEqual(['a']); // u3 lebt, u4 ungeprüft
  });

  it('gibt eine Bindung ohne uid frei — die kann niemandem gehören', () => {
    const kaputt = { uid: '', at: '2026-08-01T10:00:00.000Z' };
    expect(verwaisteBindungen({ 'fp-1': kaputt }, {})).toEqual(['fp-1']);
  });

  it('kommt mit leeren Eingaben zurecht', () => {
    expect(verwaisteBindungen({}, {})).toEqual([]);
    expect(verwaisteBindungen(undefined, undefined)).toEqual([]);
  });

  it('ist stabil sortiert, damit der Schreibvorgang vergleichbar bleibt', () => {
    const waisen = verwaisteBindungen(
      { z: b('u1'), a: b('u2'), m: b('u3') },
      { u1: false, u2: false, u3: false },
    );
    expect(waisen).toEqual(['a', 'm', 'z']);
  });
});
