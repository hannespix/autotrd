/**
 * KI-Lagebericht: Hier ist der teure Fehler ein Aufruf zu viel, und der
 * gefährliche ein Prompt, der Fremdtext transportiert. Beide Klassen sind
 * unten abgedeckt — die Guards sind pur, also ohne Netz prüfbar.
 */
import { describe, expect, it } from 'vitest';
import {
  KI_MAX_LAEUFE_MONAT,
  KI_MAX_TOKENS,
  KI_SYSTEM,
  baueEingabe,
  entscheideLauf,
  schreibeChronik,
  type KiBerichtDoc,
  type KiFakten,
} from '../src/index.js';

const T = new Date('2026-08-08T22:25:00.000Z');
const chronik = schreibeChronik(
  undefined,
  {
    trading: {
      trades: 317,
      feeShare: 2.96,
      exits: { signal: { share: 0.8675, winRate: 0.269, n: 275 } },
      klassen: { crypto: { n: 144, kantePct: -0.1238 } },
    },
  },
  T.toISOString(),
);

describe('entscheideLauf', () => {
  it('erster Lauf des Monats darf', () => {
    const e = entscheideLauf(undefined, true, true, T);
    expect(e).toMatchObject({ laufen: true, grund: 'ok', laufNr: 1, monat: '2026-08' });
  });

  it('zweiter Lauf am selben Tag ist ein No-Op und verbraucht KEINEN Zähler', () => {
    const vorher: KiBerichtDoc = {
      stand: 'bericht',
      at: T.toISOString(),
      date: '2026-08-08',
      monat: '2026-08',
      laeufeImMonat: 1,
    };
    const e = entscheideLauf(vorher, true, true, T);
    expect(e.laufen).toBe(false);
    expect(e.grund).toBe('schon_gelaufen');
  });

  it('ein FEHLVERSUCH von heute blockiert den nächsten Anlauf nicht', () => {
    const vorher: KiBerichtDoc = {
      stand: 'fehler',
      at: T.toISOString(),
      date: '2026-08-08',
      monat: '2026-08',
      laeufeImMonat: 1,
    };
    const e = entscheideLauf(vorher, true, true, T);
    expect(e.laufen).toBe(true);
    expect(e.laufNr).toBe(2); // der Fehlversuch zählt trotzdem gegen den Deckel
  });

  it('ohne Schlüssel wird nicht gerufen', () => {
    expect(entscheideLauf(undefined, true, false, T)).toMatchObject({
      laufen: false,
      grund: 'kein_schluessel',
    });
  });

  it('ohne Chronik wird nicht gerufen — es gäbe nichts zu berichten', () => {
    expect(entscheideLauf(undefined, false, true, T)).toMatchObject({
      laufen: false,
      grund: 'keine_chronik',
    });
  });

  it('Monatsdeckel greift hart', () => {
    const voll: KiBerichtDoc = {
      stand: 'bericht',
      at: '2026-08-07T22:25:00.000Z',
      date: '2026-08-07',
      monat: '2026-08',
      laeufeImMonat: KI_MAX_LAEUFE_MONAT,
    };
    expect(entscheideLauf(voll, true, true, T)).toMatchObject({
      laufen: false,
      grund: 'monatsdeckel',
    });
  });

  it('der Zähler startet im neuen Monat bei 1', () => {
    const alterMonat: KiBerichtDoc = {
      stand: 'bericht',
      at: '2026-07-31T22:25:00.000Z',
      date: '2026-07-31',
      monat: '2026-07',
      laeufeImMonat: KI_MAX_LAEUFE_MONAT,
    };
    const e = entscheideLauf(alterMonat, true, true, T);
    expect(e).toMatchObject({ laufen: true, laufNr: 1, monat: '2026-08' });
  });
});

describe('baueEingabe', () => {
  const fakten: KiFakten = {
    trading: {
      trades: 317,
      winRatePct: 32.49,
      profitFactor: 0.5689,
      feeShare: 2.9631,
      klassen: { crypto: { n: 144, kantePct: -0.1238 }, stocks_us: { n: 37, kantePct: -0.054 } },
      exits: { signal: { share: 0.8675, winRate: 0.2691, n: 275 } },
    },
    signalSchatten: { live: { n: 523, trefferquote: 0.5277, kantePct: -0.3269 } },
    regime: { state: 'trend', vix: 14.9, aboveSma200: true },
  };

  it('trägt Thesen samt Status und Belegen hinein', () => {
    const s = baueEingabe(chronik, fakten);
    expect(s).toContain('Stand: 2026-08-08');
    expect(s).toContain('[gilt,');
    expect(s).toContain('anteilSignalPct=86,80');
    expect(s).toContain('Klasse crypto: n=144');
    expect(s).toContain('live: n=523');
    expect(s).toContain('REGIME: trend');
  });

  it('ist deterministisch — gleiche Fakten, gleicher Prompt', () => {
    expect(baueEingabe(chronik, fakten)).toBe(baueEingabe(chronik, fakten));
  });

  it('bleibt klein genug, dass der Aufruf billig ist', () => {
    // Grobe Schranke gegen unbemerktes Wachstum: 6 000 Zeichen sind rund
    // 2 000 Token — ein Bruchteil des Token-Deckels der Antwort.
    expect(baueEingabe(chronik, fakten).length).toBeLessThan(6000);
  });

  it('verträgt fehlende Abschnitte, statt zu werfen', () => {
    expect(() => baueEingabe(chronik, {})).not.toThrow();
  });
});

describe('KI_SYSTEM', () => {
  it('verbietet Anlageempfehlungen und begrenzt die Länge', () => {
    expect(KI_SYSTEM).toContain('empfehlung');
    expect(KI_SYSTEM).toContain('200 Wörtern');
    expect(KI_SYSTEM).toContain('Deutsch');
  });

  it('der Token-Deckel ist gesetzt und moderat', () => {
    expect(KI_MAX_TOKENS).toBeGreaterThan(1000);
    expect(KI_MAX_TOKENS).toBeLessThanOrEqual(8000);
  });
});
