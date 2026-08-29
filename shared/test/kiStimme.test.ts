/**
 * KI-Stimme (Slice 1): Hier ist der teure Fehler ein Aufruf zu viel, der
 * gefährliche ein Prompt, der Fremdtext transportiert — und der NEUE
 * Fehler eine Antwort, die stillschweigend halb geparst wird und dann wie
 * eine echte Stimme aussieht. Alle drei sind unten abgedeckt.
 */
import { describe, expect, it } from 'vitest';
import {
  KI_STIMME_MAX_LAEUFE_MONAT,
  KI_STIMME_MAX_TOKENS,
  KI_STIMME_SYSTEM,
  baueKiStimmeEingabe,
  entscheideKiStimmeLauf,
  parseKiStimmeAntwort,
  type KiStimmeDoc,
} from '../src/index.js';

const T = new Date('2026-08-25T22:35:00.000Z');

describe('entscheideKiStimmeLauf', () => {
  it('erster Lauf des Monats darf', () => {
    const e = entscheideKiStimmeLauf(undefined, true, true, T);
    expect(e).toMatchObject({ laufen: true, grund: 'ok', laufNr: 1, monat: '2026-08' });
  });

  it('zweiter Lauf am selben Tag ist ein No-Op und verbraucht KEINEN Zähler', () => {
    const vorher: KiStimmeDoc = {
      stand: 'stimmen',
      at: T.toISOString(),
      date: '2026-08-25',
      monat: '2026-08',
      laeufeImMonat: 1,
    };
    const e = entscheideKiStimmeLauf(vorher, true, true, T);
    expect(e.laufen).toBe(false);
    expect(e.grund).toBe('schon_gelaufen');
  });

  it('ein FEHLVERSUCH von heute blockiert den nächsten Anlauf nicht', () => {
    const vorher: KiStimmeDoc = {
      stand: 'fehler',
      at: T.toISOString(),
      date: '2026-08-25',
      monat: '2026-08',
      laeufeImMonat: 1,
    };
    const e = entscheideKiStimmeLauf(vorher, true, true, T);
    expect(e.laufen).toBe(true);
    expect(e.laufNr).toBe(2); // zählt trotzdem gegen den Deckel
  });

  it('ohne Schlüssel wird nicht gerufen', () => {
    expect(entscheideKiStimmeLauf(undefined, true, false, T)).toMatchObject({
      laufen: false,
      grund: 'kein_schluessel',
    });
  });

  it('ohne Rangliste wird nicht gerufen — es gäbe nichts zu bewerten', () => {
    expect(entscheideKiStimmeLauf(undefined, false, true, T)).toMatchObject({
      laufen: false,
      grund: 'keine_daten',
    });
  });

  it('Monatsdeckel greift hart', () => {
    const voll: KiStimmeDoc = {
      stand: 'stimmen',
      at: T.toISOString(),
      date: '2026-08-24', // gestern — der Datums-Check lässt heute durch
      monat: '2026-08',
      laeufeImMonat: KI_STIMME_MAX_LAEUFE_MONAT,
    };
    const e = entscheideKiStimmeLauf(voll, true, true, T);
    expect(e).toMatchObject({ laufen: false, grund: 'monatsdeckel' });
  });

  it('ein neuer Monat setzt den Zähler zurück', () => {
    const septemberT = new Date('2026-09-01T12:00:00.000Z');
    const augustVoll: KiStimmeDoc = {
      stand: 'stimmen',
      at: T.toISOString(),
      date: '2026-08-24',
      monat: '2026-08',
      laeufeImMonat: KI_STIMME_MAX_LAEUFE_MONAT,
    };
    const e = entscheideKiStimmeLauf(augustVoll, true, true, septemberT);
    expect(e).toMatchObject({ laufen: true, grund: 'ok', laufNr: 1, monat: '2026-09' });
  });
});

describe('baueKiStimmeEingabe', () => {
  const fakten = {
    top: [
      { symbol: 'NVDA', score: 0.4123 },
      { symbol: 'AAPL', score: 0.0891 },
    ],
    regime: { state: 'trend', vix: 14.9, aboveSma200: true },
  };

  it('trägt die Rangliste und das Regime hinein', () => {
    const s = baueKiStimmeEingabe(fakten);
    expect(s).toContain('NVDA: Score 0,4123');
    expect(s).toContain('AAPL: Score 0,0891');
    expect(s).toContain('REGIME: trend');
  });

  it('ist deterministisch — gleiche Fakten, gleicher Prompt', () => {
    expect(baueKiStimmeEingabe(fakten)).toBe(baueKiStimmeEingabe(fakten));
  });

  it('verträgt eine leere Rangliste, statt zu werfen', () => {
    expect(() => baueKiStimmeEingabe({ top: [] })).not.toThrow();
  });

  it('bleibt klein genug, dass der Aufruf billig ist', () => {
    const grosseListe = {
      top: Array.from({ length: 8 }, (_, i) => ({ symbol: `SYM${i}`, score: 0.1 * i })),
      regime: fakten.regime,
    };
    expect(baueKiStimmeEingabe(grosseListe).length).toBeLessThan(2000);
  });
});

describe('KI_STIMME_SYSTEM', () => {
  it('verlangt striktes JSON und verbietet erfundene Zahlen', () => {
    expect(KI_STIMME_SYSTEM).toContain('JSON-Array');
    expect(KI_STIMME_SYSTEM).toContain('Erfinde keine Zahlen');
    expect(KI_STIMME_SYSTEM).toContain('Gegenstimme');
  });

  it('der Token-Deckel ist gesetzt und moderat', () => {
    expect(KI_STIMME_MAX_TOKENS).toBeGreaterThan(1000);
    expect(KI_STIMME_MAX_TOKENS).toBeLessThanOrEqual(8000);
  });
});

/* ── parseKiStimmeAntwort — der sicherheitskritische Teil ──────────────────
 *
 * Eine Antwort, die NICHT exakt der erwarteten Form entspricht, muss `null`
 * liefern, NIE eine teilweise geflickte Liste. Sonst wäre eine spätere
 * Auswertung nicht mehr von einer echten Stimme zu unterscheiden.
 */
describe('parseKiStimmeAntwort', () => {
  const symbole = ['NVDA', 'AAPL'];
  const gueltig = JSON.stringify([
    {
      symbol: 'NVDA',
      richtung: 'buy',
      konfidenz: 0.6,
      begruendung: 'Starker 12-1-Score.',
      gegenstimme: 'Score kann sich binnen Tagen drehen.',
      konfidenzNachKritik: 0.45,
    },
    {
      symbol: 'AAPL',
      richtung: 'hold',
      konfidenz: 0.3,
      begruendung: 'Kein klares Signal.',
      gegenstimme: 'Datenlage zu dünn für eine Aussage.',
      konfidenzNachKritik: 0.2,
    },
  ]);

  it('parst eine wohlgeformte Antwort vollständig', () => {
    const votes = parseKiStimmeAntwort(gueltig, symbole);
    expect(votes).toHaveLength(2);
    expect(votes?.[0]).toMatchObject({ symbol: 'NVDA', richtung: 'buy', konfidenz: 0.6 });
  });

  it('kein JSON → null', () => {
    expect(parseKiStimmeAntwort('Das ist keine JSON-Antwort.', symbole)).toBeNull();
  });

  it('Markdown-Codeblock drumherum → null, kein Versuch zu retten', () => {
    expect(parseKiStimmeAntwort('```json\n' + gueltig + '\n```', symbole)).toBeNull();
  });

  it('leeres Array → null', () => {
    expect(parseKiStimmeAntwort('[]', symbole)).toBeNull();
  });

  it('unbekanntes Symbol → null für die GANZE Antwort', () => {
    const mitFremdSymbol = JSON.stringify([
      { symbol: 'TSLA', richtung: 'buy', konfidenz: 0.5, begruendung: 'x', gegenstimme: 'y', konfidenzNachKritik: 0.4 },
    ]);
    expect(parseKiStimmeAntwort(mitFremdSymbol, symbole)).toBeNull();
  });

  it('doppelt genanntes Symbol → null', () => {
    const doppelt = JSON.stringify([
      { symbol: 'NVDA', richtung: 'buy', konfidenz: 0.5, begruendung: 'x', gegenstimme: 'y', konfidenzNachKritik: 0.4 },
      { symbol: 'NVDA', richtung: 'sell', konfidenz: 0.5, begruendung: 'x', gegenstimme: 'y', konfidenzNachKritik: 0.4 },
    ]);
    expect(parseKiStimmeAntwort(doppelt, symbole)).toBeNull();
  });

  it('ungültige Richtung → null', () => {
    const falsch = JSON.stringify([
      { symbol: 'NVDA', richtung: 'long', konfidenz: 0.5, begruendung: 'x', gegenstimme: 'y', konfidenzNachKritik: 0.4 },
    ]);
    expect(parseKiStimmeAntwort(falsch, symbole)).toBeNull();
  });

  it.each([-0.1, 1.1, Number.NaN, Infinity])('Konfidenz außerhalb [0,1] (%s) → null', (k) => {
    const falsch = JSON.stringify([
      { symbol: 'NVDA', richtung: 'buy', konfidenz: k, begruendung: 'x', gegenstimme: 'y', konfidenzNachKritik: 0.4 },
    ]);
    expect(parseKiStimmeAntwort(falsch, symbole)).toBeNull();
  });

  it('konfidenzNachKritik außerhalb [0,1] → null', () => {
    const falsch = JSON.stringify([
      { symbol: 'NVDA', richtung: 'buy', konfidenz: 0.5, begruendung: 'x', gegenstimme: 'y', konfidenzNachKritik: 1.5 },
    ]);
    expect(parseKiStimmeAntwort(falsch, symbole)).toBeNull();
  });

  it('fehlende Begründung → null', () => {
    const falsch = JSON.stringify([
      { symbol: 'NVDA', richtung: 'buy', konfidenz: 0.5, gegenstimme: 'y', konfidenzNachKritik: 0.4 },
    ]);
    expect(parseKiStimmeAntwort(falsch, symbole)).toBeNull();
  });

  it('fehlende Gegenstimme → null', () => {
    const falsch = JSON.stringify([
      { symbol: 'NVDA', richtung: 'buy', konfidenz: 0.5, begruendung: 'x', konfidenzNachKritik: 0.4 },
    ]);
    expect(parseKiStimmeAntwort(falsch, symbole)).toBeNull();
  });

  it('leere Begründung (leerer String) → null', () => {
    const falsch = JSON.stringify([
      { symbol: 'NVDA', richtung: 'buy', konfidenz: 0.5, begruendung: '', gegenstimme: 'y', konfidenzNachKritik: 0.4 },
    ]);
    expect(parseKiStimmeAntwort(falsch, symbole)).toBeNull();
  });

  it('ein Objekt statt eines Arrays → null', () => {
    expect(parseKiStimmeAntwort('{"symbol":"NVDA"}', symbole)).toBeNull();
  });

  it('Konfidenz als String statt Zahl → null', () => {
    const falsch = JSON.stringify([
      { symbol: 'NVDA', richtung: 'buy', konfidenz: '0.5', begruendung: 'x', gegenstimme: 'y', konfidenzNachKritik: 0.4 },
    ]);
    expect(parseKiStimmeAntwort(falsch, symbole)).toBeNull();
  });

  it('eine gültige Teilmenge der erwarteten Symbole ist erlaubt (nicht alle müssen antworten)', () => {
    const nurEins = JSON.stringify([
      { symbol: 'NVDA', richtung: 'buy', konfidenz: 0.5, begruendung: 'x', gegenstimme: 'y', konfidenzNachKritik: 0.4 },
    ]);
    const votes = parseKiStimmeAntwort(nurEins, symbole);
    expect(votes).toHaveLength(1);
  });
});
