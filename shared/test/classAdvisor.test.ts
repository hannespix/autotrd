/**
 * Tests des Klassen-Reglers.
 *
 * Er steuert, wie viel Kapital in eine Anlageklasse fließt — ein Fehler hier
 * wirkt auf jeden einzelnen Trade. Schwerpunkte entsprechend:
 *
 *   - eine dünne Stichprobe darf NIE das Gewicht bewegen
 *   - der Auto-Regler springt nicht, er nähert sich an
 *   - Ausnahme: strukturelle Verluste werden sofort abgeschaltet
 *   - die Grenzen halten (kein negatives Gewicht, kein Hebel durch die Hintertür)
 */

import { describe, expect, it } from 'vitest';
import {
  GEWICHT_MAX,
  GEWICHT_MIN,
  KLASSE_MIN_TRADES,
  berateKlassen,
  klemmeGewicht,
  rateKlasse,
  reglerSchritt,
} from '../src/classAdvisor.js';

describe('rateKlasse — Evidenz vor Meinung', () => {
  it('rührt das Gewicht bei zu dünner Stichprobe NICHT an', () => {
    // Am 04.08. hatten `indices` und `stocks_global` je genau einen Trade.
    // Eine Empfehlung darauf wäre Münzwurf mit Nachkommastellen.
    const r = rateKlasse('indices', { n: 1, kantePct: -0.2541 }, 1);
    expect(r.empfehlung).toBe('zu_wenig_daten');
    expect(r.vorschlag).toBe(1); // unverändert
    expect(r.grund).toContain('1 Trades');
  });

  it('zieht auch ein bereits gesenktes Gewicht nicht auf den Standard zurück', () => {
    // Eine Klasse ohne Beleg soll weder belohnt noch bestraft werden — auch
    // nicht durch eine stille Rückkehr zu 1.
    expect(rateKlasse('x', { n: 5, kantePct: 0.5 }, 0.25).vorschlag).toBe(0.25);
    expect(rateKlasse('x', { n: 5, kantePct: -0.5 }, 0).vorschlag).toBe(0);
  });

  it('behandelt eine fehlende Kante wie fehlende Daten', () => {
    // `kantePct: null` heißt „kein Trade trug Volumen" — nicht „Kante ist 0".
    const r = rateKlasse('x', { n: 100, kantePct: null }, 1);
    expect(r.empfehlung).toBe('zu_wenig_daten');
  });
});

describe('rateKlasse — die vier Urteile', () => {
  const viele = (kantePct: number) => ({ n: 100, kantePct });

  it('verstärkt eine Klasse, die ihre Reibung klar trägt', () => {
    // etf_thematic am 04.08.: +0,81 % bei 63 Trades.
    const r = rateKlasse('etf_thematic', viele(0.8111), 1);
    expect(r.empfehlung).toBe('verstaerken');
    expect(r.vorschlag).toBeGreaterThan(1);
    expect(r.vorschlag).toBeLessThanOrEqual(GEWICHT_MAX);
  });

  it('lässt eine knapp positive Klasse laufen, ohne sie zu verstärken', () => {
    // Unter 0,1 % liegt die Kante im Rauschen der Ausführung — ein einziger
    // ungünstiger Spread kippt sie.
    const r = rateKlasse('x', viele(0.05), 1);
    expect(r.empfehlung).toBe('behalten');
    expect(r.vorschlag).toBe(1);
  });

  it('drosselt eine knapp defizitäre Klasse auf halbes Gewicht', () => {
    const r = rateKlasse('x', viele(-0.05), 1);
    expect(r.empfehlung).toBe('drosseln');
    expect(r.vorschlag).toBe(0.5);
  });

  it('schaltet eine strukturell verbrennende Klasse ab', () => {
    // crypto am 04.08.: −0,19 % über 290 Trades.
    const r = rateKlasse('crypto', { n: 290, kantePct: -0.1919 }, 1);
    expect(r.empfehlung).toBe('abschalten');
    expect(r.vorschlag).toBe(0);
    expect(r.grund).toContain('Schatten läuft weiter');
  });

  it('verstärkt nie über die Obergrenze hinaus', () => {
    // Sonst wäre der Regler ein Hebel durch die Hintertür.
    expect(rateKlasse('x', viele(5), 1.5).vorschlag).toBeLessThanOrEqual(GEWICHT_MAX);
  });

  it('holt eine abgeschaltete Klasse zurück, wenn der Schatten sie rechtfertigt', () => {
    // Der Kern des Vorschlags: Gewicht 0 heißt nicht „für immer draußen".
    const r = rateKlasse('crypto', { n: 200, kantePct: 0.4 }, 0);
    expect(r.empfehlung).toBe('verstaerken');
    expect(r.vorschlag).toBeGreaterThan(0);
  });
});

describe('klemmeGewicht', () => {
  it('hält die Grenzen ein', () => {
    expect(klemmeGewicht(-1)).toBe(GEWICHT_MIN);
    expect(klemmeGewicht(99)).toBe(GEWICHT_MAX);
    expect(klemmeGewicht(0.75)).toBe(0.75);
  });

  it('macht aus fehlenden oder kaputten Werten das neutrale Gewicht', () => {
    expect(klemmeGewicht(undefined)).toBe(1);
    expect(klemmeGewicht(Number.NaN)).toBe(1);
    expect(klemmeGewicht(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('reglerSchritt — Annäherung statt Sprung', () => {
  const rat = (empfehlung: string, gewicht: number, vorschlag: number) =>
    ({ klasse: 'x', n: 100, kantePct: 0.5, gewicht, empfehlung, vorschlag, grund: '' }) as never;

  it('bewegt sich höchstens um die Schrittweite auf den Vorschlag zu', () => {
    // Ein Regler, der bei jeder Auswertung voll durchschlägt, schwingt
    // zwischen den Wochen — und jedes Umschalten kostet Trades.
    expect(reglerSchritt(rat('verstaerken', 1, 1.5), 0.25)).toBe(1.25);
    expect(reglerSchritt(rat('drosseln', 1, 0.25), 0.25)).toBe(0.75);
  });

  it('trifft den Vorschlag genau, wenn er in Reichweite liegt', () => {
    expect(reglerSchritt(rat('verstaerken', 1, 1.1), 0.25)).toBe(1.1);
  });

  it('schaltet SOFORT ab, ohne Etappen', () => {
    // Die eine bewusste Ausnahme: Ein Fehlalarm kostet entgangene Chancen,
    // das Zögern kostet echtes Geld.
    expect(reglerSchritt(rat('abschalten', 1.5, 0), 0.25)).toBe(0);
  });

  it('lässt das Gewicht bei fehlender Evidenz unberührt', () => {
    expect(reglerSchritt(rat('zu_wenig_daten', 0.75, 0.75), 0.25)).toBe(0.75);
  });

  it('bleibt in jedem Schritt innerhalb der Grenzen', () => {
    expect(reglerSchritt(rat('verstaerken', 1.5, 1.5), 0.25)).toBeLessThanOrEqual(GEWICHT_MAX);
    expect(reglerSchritt(rat('drosseln', 0, 0.25), 0.25)).toBeGreaterThanOrEqual(GEWICHT_MIN);
  });
});

describe('berateKlassen — der ganze Bericht', () => {
  /** Der reale Stand vom 04.08. */
  const REAL = {
    etf_thematic: { n: 63, kantePct: 0.8111 },
    stocks_us: { n: 38, kantePct: 0.19 },
    stocks_global: { n: 1, kantePct: 0.0988 },
    crypto: { n: 290, kantePct: -0.1919 },
    commodities: { n: 7, kantePct: -0.2179 },
    indices: { n: 1, kantePct: -0.2541 },
    forex: { n: 26, kantePct: -0.3192 },
    rates_bonds: { n: 44, kantePct: -0.3461 },
    etf_sectors: { n: 29, kantePct: -0.403 },
    etf_regions: { n: 27, kantePct: -0.4119 },
  };

  it('sortiert nach Kante — was verdient, steht oben', () => {
    const b = berateKlassen(REAL);
    expect(b.raete[0]?.klasse).toBe('etf_thematic');
    expect(b.raete[b.raete.length - 1]?.klasse).toBe('etf_regions');
  });

  it('empfiehlt für den realen Stand genau das Erwartete', () => {
    const raete = Object.fromEntries(berateKlassen(REAL).raete.map((r) => [r.klasse, r]));
    // Belegt und gut ⇒ verstärken
    expect(raete['etf_thematic']?.empfehlung).toBe('verstaerken');
    expect(raete['stocks_us']?.empfehlung).toBe('verstaerken');
    // Belegt und strukturell defizitär ⇒ abschalten
    expect(raete['crypto']?.empfehlung).toBe('abschalten');
    expect(raete['rates_bonds']?.empfehlung).toBe('abschalten');
    // Zu dünn ⇒ Finger weg, egal wie das Vorzeichen steht
    expect(raete['indices']?.empfehlung).toBe('zu_wenig_daten');
    expect(raete['commodities']?.empfehlung).toBe('zu_wenig_daten');
    expect(raete['etf_regions']?.empfehlung).toBe('zu_wenig_daten'); // 27 < 30
    expect(raete['forex']?.empfehlung).toBe('zu_wenig_daten'); // 26 < 30
  });

  it('nennt die abzuschaltenden Klassen im Fazit', () => {
    const b = berateKlassen(REAL);
    expect(b.fazit).toContain('crypto');
    expect(b.aenderungen).toBeGreaterThan(0);
  });

  it('meldet ehrlich, wenn noch gar nichts belegt ist', () => {
    const b = berateKlassen({ x: { n: 3, kantePct: 5 } });
    expect(b.aenderungen).toBe(0);
    expect(b.fazit).toContain(`${KLASSE_MIN_TRADES} Trades`);
  });

  it('meldet „passt bereits", wenn die Gewichte schon stimmen', () => {
    const b = berateKlassen(
      { crypto: { n: 290, kantePct: -0.1919 }, etf_thematic: { n: 63, kantePct: 0.8111 } },
      { crypto: 0, etf_thematic: GEWICHT_MAX },
    );
    expect(b.aenderungen).toBe(0);
    expect(b.fazit).toContain('passen bereits');
  });

  it('verträgt einen leeren Bericht', () => {
    const b = berateKlassen({});
    expect(b.raete).toEqual([]);
    expect(b.aenderungen).toBe(0);
  });
});
