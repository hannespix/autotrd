/** Task 19, Teil 2c: Fundamental-Schatten — pure Beurteilung und Deckung. */
import { describe, expect, it } from 'vitest';
import {
  DOLLARVOL_MIN_USD,
  GEWINNTERMIN_SPERRTAGE,
  MARKTKAP_MIN_MIO,
  fundamentalBefund,
  fundamentalSchattenStand,
  tageBis,
} from '../src/fundamentalSchatten.js';

describe('fundamentalBefund', () => {
  const heute = '2026-10-08';

  it('Gewinntermin: nah bei 0…SPERRTAGE Kalendertagen, sonst nicht; vergangener Termin = veraltet = keine Aussage', () => {
    expect(fundamentalBefund({ gewinntermin: '2026-10-08' }, null, 10, heute)).toMatchObject({ tageBisZahlen: 0, gewinnterminNah: true });
    expect(fundamentalBefund({ gewinntermin: '2026-10-10' }, null, 10, heute)).toMatchObject({ tageBisZahlen: 2, gewinnterminNah: true });
    expect(fundamentalBefund({ gewinntermin: '2026-10-11' }, null, 10, heute)).toMatchObject({ tageBisZahlen: 3, gewinnterminNah: false });
    expect(fundamentalBefund({ gewinntermin: '2026-10-07' }, null, 10, heute)).toMatchObject({ tageBisZahlen: null, gewinnterminNah: false });
    expect(fundamentalBefund({ gewinntermin: null }, null, 10, heute)).toMatchObject({ tageBisZahlen: null, gewinnterminNah: false });
    expect(fundamentalBefund({ gewinntermin: 'bald' }, null, 10, 'heute')).toMatchObject({ tageBisZahlen: null });
    expect(GEWINNTERMIN_SPERRTAGE).toBe(2);
    expect(tageBis('2026-10-31', '2026-11-01')).toBe(1); // Monatsgrenze, DST-frei (UTC-Mitternacht)
  });

  it('Liquidität: Ø-Volumen × Kurs; fehlt eins davon, ist nichts messbar (nicht „illiquide")', () => {
    expect(fundamentalBefund(null, { volDurchschnitt3M: 100_000 }, 15, heute)).toMatchObject({ dollarVolUsd: 1_500_000, illiquide: true });
    expect(fundamentalBefund(null, { volDurchschnitt3M: 100_000 }, 25, heute)).toMatchObject({ dollarVolUsd: 2_500_000, illiquide: false });
    expect(fundamentalBefund(null, { volDurchschnitt3M: null }, 25, heute)).toMatchObject({ dollarVolUsd: null, illiquide: false });
    expect(fundamentalBefund(null, { volDurchschnitt3M: 100_000 }, 0, heute)).toMatchObject({ dollarVolUsd: null, illiquide: false });
    expect(fundamentalBefund(null, null, null, heute)).toMatchObject({ profilVorhanden: false, dollarVolUsd: null, illiquide: false, kleinstwert: false });
    expect(DOLLARVOL_MIN_USD).toBe(2_000_000);
  });

  it('Kleinstwert: Marktkap unter der Schwelle; 0/null = unbekannt', () => {
    expect(fundamentalBefund({ marktkapMio: 14.5 }, null, 1, heute)).toMatchObject({ profilVorhanden: true, kleinstwert: true });
    expect(fundamentalBefund({ marktkapMio: MARKTKAP_MIN_MIO }, null, 1, heute).kleinstwert).toBe(false);
    expect(fundamentalBefund({ marktkapMio: null }, null, 1, heute).kleinstwert).toBe(false);
    expect(fundamentalBefund({}, null, 1, heute).profilVorhanden).toBe(true);
  });
});

describe('fundamentalSchattenStand', () => {
  it('zählt Deckung aus den Befunden und übernimmt die Tor-Zähler samt Parametern', () => {
    const b = [
      fundamentalBefund({ marktkapMio: 10 }, { volDurchschnitt3M: 1000 }, 5, '2026-10-08'),
      fundamentalBefund(null, { volDurchschnitt3M: 1000 }, 5, '2026-10-08'),
      fundamentalBefund(null, null, null, '2026-10-08'),
      null,
      undefined,
    ];
    expect(fundamentalSchattenStand(b, { gewinntermin_wuerde_blocken: 3, illiquide_wuerde_blocken: 1, kleinstwert_wuerde_blocken: 0 })).toEqual({
      mitProfil: 1,
      ohneProfil: 2,
      mitVolumen: 2,
      gewinnterminNah: 3,
      illiquide: 1,
      kleinstwert: 0,
      parameter: { sperrtage: 2, dollarVolMinUsd: 2_000_000, marktkapMinMio: 300 },
    });
  });
});
