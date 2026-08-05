/**
 * Verlaufsprotokoll des Broker-Abgleichs (Owner-Meldung 05.08.: „ca. 1
 * Stunde keine Verbindung" — hinterher war nicht mehr feststellbar, WAS in
 * dieser Stunde war, weil nur der letzte Zustand gespeichert wurde).
 *
 * Die Regeln, die hier festgehalten werden:
 *  - Geschrieben wird NUR bei einem Zustandswechsel (288 Scans/Tag würden
 *    sonst genau die Stunde zuschütten, die man sucht).
 *  - Der Deckel hält die neuesten Einträge, nicht die ältesten.
 *  - Der erste Eintrag eines Kontos hat `von: null`.
 */

import { describe, expect, it, vi } from 'vitest';
import { ergaenzeVerlauf, VERLAUF_MAX, type VerlaufEintrag } from '../src/core/brokerAbgleich.js';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ doc: () => ({ get: vi.fn(), set: vi.fn() }) }),
}));

const eintrag = (nach: VerlaufEintrag['nach'], at = '2026-08-05T13:45:00Z') => ({
  at,
  nach,
  fehlbestand: 0,
  fremdbestand: 0,
});

describe('ergaenzeVerlauf', () => {
  it('gleicher Zustand → null, es wird NICHTS geschrieben', () => {
    expect(ergaenzeVerlauf([], 'sauber', eintrag('sauber'))).toBeNull();
    expect(ergaenzeVerlauf(undefined, 'drift', eintrag('drift'))).toBeNull();
  });

  it('Zustandswechsel wird mit Vorher-Zustand protokolliert', () => {
    const v = ergaenzeVerlauf([], 'sauber', { ...eintrag('drift'), fehlbestand: 2 });
    expect(v).toHaveLength(1);
    expect(v![0]).toMatchObject({ von: 'sauber', nach: 'drift', fehlbestand: 2 });
  });

  it('der erste Eintrag eines Kontos hat von: null', () => {
    const v = ergaenzeVerlauf(undefined, undefined, eintrag('sauber'));
    expect(v![0]!.von).toBeNull();
  });

  it('unbekannte Alt-Zustände werden nicht erfunden — von: null', () => {
    const v = ergaenzeVerlauf([], 'kaputt', eintrag('sauber'));
    expect(v![0]!.von).toBeNull();
  });

  it('der Deckel behält die NEUESTEN Einträge', () => {
    let verlauf: VerlaufEintrag[] = [];
    const zustaende: Array<VerlaufEintrag['nach']> = ['sauber', 'drift'];
    let vorher: string | undefined;
    for (let i = 0; i < VERLAUF_MAX + 6; i += 1) {
      const nach = zustaende[i % 2]!;
      const neu = ergaenzeVerlauf(verlauf, vorher, eintrag(nach, `2026-08-05T${String(10 + Math.floor(i / 12)).padStart(2, '0')}:${String((i * 5) % 60).padStart(2, '0')}:00Z`));
      if (neu) verlauf = neu;
      vorher = nach;
    }
    expect(verlauf).toHaveLength(VERLAUF_MAX);
    // Der letzte Eintrag ist der jüngste Wechsel — nichts wurde vorn abgeschnitten,
    // was jünger wäre als das, was blieb.
    const zeiten = verlauf.map((e) => e.at);
    expect([...zeiten].sort()).toEqual(zeiten);
  });

  it('fehler-Wechsel trägt den Fehlertext', () => {
    const v = ergaenzeVerlauf([], 'sauber', { ...eintrag('fehler'), fehler: 'HTTP 429' });
    expect(v![0]).toMatchObject({ von: 'sauber', nach: 'fehler', fehler: 'HTTP 429' });
  });
});
