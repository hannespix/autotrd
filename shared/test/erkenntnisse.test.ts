/**
 * Erkenntnis-Chronik: Die gefährlichen Fehler sind hier zeitlicher Natur —
 * ein `seitAt`, das bei jedem Lauf neu gesetzt wird, macht aus der Chronik
 * einen Tagesstempel; eine Historie ohne Deckel ein zweites Log; eine
 * These, die bei n=2 urteilt, einen Rauschgenerator.
 */
import { describe, expect, it } from 'vitest';
import {
  ERKENNTNIS_HISTORIE_MAX,
  MIN_N_TAGESKANTE,
  schreibeChronik,
  type ErkenntnisChronik,
  type ErkenntnisFakten,
} from '../src/erkenntnisse.js';

/** Fakten, die dem Live-Stand vom 08.08. nachempfunden sind. */
const fakten = (over: Partial<ErkenntnisFakten> = {}): ErkenntnisFakten => ({
  trading: {
    trades: 317,
    feeShare: 2.9631,
    exits: { signal: { share: 0.8675, winRate: 0.2691, n: 275 } },
    klassen: {
      etf_thematic: { n: 58, kantePct: -0.7639 },
      crypto: { n: 144, kantePct: -0.1238 },
      stocks_us: { n: 37, kantePct: -0.054 },
      indices: { n: 1, kantePct: -0.2541 }, // unter Mindest-n → zählt nie
    },
  },
  signalSchatten: {
    live: { n: 523, treffer: 276, trefferquote: 0.5277, rohPct: 0.0217, kantePct: -0.3269 },
    live_tag: { n: 2, treffer: 2, trefferquote: 1, rohPct: 1.3755, kantePct: 0.8755 },
  },
  strukturSuche: { geprueft: 5, befoerdert: 0, date: '2026-08-07' },
  ...over,
});

const T1 = '2026-08-08T21:15:00.000Z';
const T2 = '2026-08-09T21:15:00.000Z';

describe('schreibeChronik', () => {
  it('leitet aus dem Live-Stand die erwarteten Status ab', () => {
    const c = schreibeChronik(undefined, fakten(), T1);
    expect(c.date).toBe('2026-08-08');
    const s = (k: string) => c.eintraege[k]!.status;
    expect(s('exit_am_signal')).toBe('gilt'); // 87 % ≥ 75 %
    expect(s('kosten_dominieren')).toBe('gilt'); // feeShare 2,96 ≥ 0,5
    expect(s('richtung_vs_kante')).toBe('gilt'); // 52,8 % bei n=523, Kante < 0
    expect(s('tages_kante')).toBe('wartet_auf_daten'); // n=2 < 30
    expect(s('klasse_verlustquelle')).toBe('gilt'); // etf_thematic −0,76
    expect(s('klasse_traegt')).toBe('gilt_nicht'); // beste Klasse negativ
    expect(s('struktursuche_latte')).toBe('gilt'); // 5 geprüft, 0 befördert
    // Die Sätze tragen die Zahlen — nicht nur Behauptungen.
    expect(c.eintraege.exit_am_signal!.these).toContain('87 %');
    expect(c.eintraege.klasse_verlustquelle!.these).toContain('etf_thematic');
    expect(c.eintraege.tages_kante!.these).toContain(`n=${MIN_N_TAGESKANTE}`);
  });

  it('unter Mindest-n wird NICHTS behauptet', () => {
    const c = schreibeChronik(undefined, {}, T1);
    for (const e of Object.values(c.eintraege)) expect(e.status).toBe('wartet_auf_daten');
  });

  it('gleicher Status ⇒ seitAt bleibt stehen, zuletztAt frischt auf', () => {
    const c1 = schreibeChronik(undefined, fakten(), T1);
    const c2 = schreibeChronik(c1, fakten(), T2);
    const e = c2.eintraege.exit_am_signal!;
    expect(e.seitAt).toBe(T1);
    expect(e.zuletztAt).toBe(T2);
    expect(e.historie).toBeUndefined(); // kein Wechsel → keine Historie
  });

  it('Statuswechsel ⇒ Widerlegung landet mit altem Wortlaut in der Historie', () => {
    const c1 = schreibeChronik(undefined, fakten(), T1);
    const alteThese = c1.eintraege.exit_am_signal!.these;
    // Stop/Ziel greifen plötzlich: Signal-Anteil fällt unter die Schwelle.
    const c2 = schreibeChronik(
      c1,
      fakten({
        trading: {
          ...fakten().trading!,
          exits: { signal: { share: 0.4, winRate: 0.5, n: 130 } },
        },
      }),
      T2,
    );
    const e = c2.eintraege.exit_am_signal!;
    expect(e.status).toBe('gilt_nicht');
    expect(e.seitAt).toBe(T2);
    expect(e.historie).toHaveLength(1);
    expect(e.historie![0]).toMatchObject({ at: T2, von: 'gilt', nach: 'gilt_nicht' });
    expect(e.historie![0]!.these).toBe(alteThese);
  });

  it('Historie ist gedeckelt', () => {
    let c: ErkenntnisChronik | undefined;
    // Abwechselnd über/unter der Schwelle ⇒ jeder Lauf ein Wechsel.
    for (let i = 0; i < ERKENNTNIS_HISTORIE_MAX + 5; i++) {
      const share = i % 2 === 0 ? 0.9 : 0.4;
      c = schreibeChronik(
        c,
        fakten({
          trading: {
            ...fakten().trading!,
            exits: { signal: { share, winRate: 0.3, n: 200 } },
          },
        }),
        `2026-08-${String(10 + i).padStart(2, '0')}T21:15:00.000Z`,
      );
    }
    expect(c!.eintraege.exit_am_signal!.historie!.length).toBeLessThanOrEqual(
      ERKENNTNIS_HISTORIE_MAX,
    );
  });

  it('ist deterministisch', () => {
    expect(schreibeChronik(undefined, fakten(), T1)).toEqual(
      schreibeChronik(undefined, fakten(), T1),
    );
  });

  it('Tages-Kante ab Mindest-n: positiv ⇒ gilt', () => {
    const c = schreibeChronik(
      undefined,
      fakten({
        signalSchatten: {
          live_tag: { n: 40, treffer: 26, trefferquote: 0.65, rohPct: 0.9, kantePct: 0.4 },
        },
      }),
      T1,
    );
    expect(c.eintraege.tages_kante!.status).toBe('gilt');
    expect(c.eintraege.tages_kante!.these).toContain('+0,40');
  });
});
