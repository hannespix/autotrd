/**
 * Welche Symbole der Scan beobachtet (Owner-Frage 28.07.: „warum gibt's noch
 * die Watchliste?").
 *
 * Die Rangfolge ist sicherheitsrelevant, und ihr Bruch ist unsichtbar: Fällt
 * ein Symbol aus der Auswahl, verschwindet es einfach — es gibt keine
 * Fehlermeldung, keinen roten Lauf, nichts. Bei einer OFFENEN POSITION heißt
 * das, dass Stop-Loss, Take-Profit und Signal-Verkauf nicht mehr greifen: Das
 * Geld hängt in einem Papier, das niemand mehr anschaut. Deshalb steht der
 * Positions-Vorrang hier fest verdrahtet, mit Test.
 */

import { describe, expect, it } from 'vitest';
import { selectScanSymbols } from '../src/scheduled/scanMarket.js';

const auswahl = (args: Partial<Parameters<typeof selectScanSymbols>[0]>): string[] =>
  selectScanSymbols({ positions: [], ranking: [], defaults: [], max: 40, ...args });

describe('selectScanSymbols', () => {
  it('nimmt die Rangliste des Momentum-Laufs, nicht eine gespeicherte Liste', () => {
    expect(auswahl({ ranking: ['BTC-USD', 'AAPL'], defaults: ['QQQ'] })).toEqual([
      'BTC-USD',
      'AAPL',
      'QQQ',
    ]);
  });

  it('offene Positionen stehen VOR dem Ranking', () => {
    const out = auswahl({ positions: ['SOL-USD'], ranking: ['BTC-USD'] });
    expect(out[0]).toBe('SOL-USD');
  });

  it('offene Positionen überleben das Limit — auch wenn das Ranking voll ist', () => {
    // Der eigentliche Sicherheitstest: Ein volles Ranking darf eine offene
    // Position nicht verdrängen, sonst verliert sie ihren Stop-Loss.
    const ranking = Array.from({ length: 50 }, (_, i) => `R${i}`);
    const out = auswahl({ positions: ['SOL-USD', 'ETH-USD'], ranking, max: 10 });
    expect(out).toContain('SOL-USD');
    expect(out).toContain('ETH-USD');
    expect(out.length).toBe(10); // 2 Positionen + 8 aus dem Ranking
  });

  it('viele Positionen dürfen das Limit sprengen — Verkaufen geht vor Sparen', () => {
    const positions = Array.from({ length: 15 }, (_, i) => `P${i}`);
    const out = auswahl({ positions, ranking: ['BTC-USD'], max: 10 });
    expect(out.length).toBe(15);
    expect(out).not.toContain('BTC-USD'); // das Limit greift erst danach
  });

  it('Defaults sind der Boden, wenn noch kein Ranking existiert', () => {
    // Erster Tag: momentumRun hatte noch keinen Lauf. Ohne Boden stünde der
    // Scan ohne ein einziges Symbol da und täte gar nichts.
    expect(auswahl({ defaults: ['QQQ', 'SPY'] })).toEqual(['QQQ', 'SPY']);
  });

  it('dedupliziert über alle drei Quellen', () => {
    const out = auswahl({
      positions: ['AAPL'],
      ranking: ['AAPL', 'BTC-USD'],
      defaults: ['AAPL', 'QQQ'],
    });
    expect(out).toEqual(['AAPL', 'BTC-USD', 'QQQ']);
  });

  it('leere Symbolnamen fallen raus, statt eine Zeile zu belegen', () => {
    expect(auswahl({ ranking: ['', 'AAPL', ''] })).toEqual(['AAPL']);
  });
});

/**
 * Marktzeit-Bewusstsein (Audit-Befund A1, 28.07.).
 *
 * Der Befund war live messbar und kostete ~70 % der Betriebszeit: Die
 * Auswahl nahm die globalen Top-N, `runScan` warf danach alles weg, dessen
 * Klasse geschlossen war — und übrig blieb nichts. Diese Tests halten fest,
 * dass die Marktzeit BEIM Füllen wirkt, nicht dahinter.
 */
describe('selectScanSymbols: Marktzeit', () => {
  // Krypto handelt rund um die Uhr, Aktien nicht — genau die Konstellation
  // vom 28.07., 12:35 UTC.
  const nurKrypto = (s: string): boolean => s.endsWith('-USD');

  it('füllt das Kontingent mit OFFENEN Symbolen statt es zu verschwenden', () => {
    const out = auswahl({
      ranking: ['AAPL', 'TSLA', 'BTC-USD', 'QQQ', 'ETH-USD'],
      max: 3,
      isOpen: nurKrypto,
    });
    expect(out, 'geschlossene Aktien dürfen keinen Platz belegen').toEqual([
      'BTC-USD',
      'ETH-USD',
    ]);
  });

  it('der Katalog ist der letzte Boden, wenn Ranking und Defaults zu sind', () => {
    // Der Live-Fall: kein Ranking, Defaults nur US-Aktien, Nacht in New York.
    // Ohne diesen Boden stand der Scan mit null Symbolen da.
    const out = auswahl({
      ranking: [],
      defaults: ['QQQ', 'AAPL', 'TSLA', '^NDX'],
      catalog: ['MSFT', 'BTC-USD', 'SOL-USD'],
      max: 10,
      isOpen: nurKrypto,
    });
    expect(out).toEqual(['BTC-USD', 'SOL-USD']);
  });

  it('Ranking schlägt Katalog — der Boden greift nur, wo Lücken sind', () => {
    const out = auswahl({
      ranking: ['ETH-USD'],
      catalog: ['BTC-USD', 'SOL-USD'],
      max: 2,
      isOpen: nurKrypto,
    });
    expect(out[0], 'die Rangliste bleibt die Priorität').toBe('ETH-USD');
    expect(out.length).toBe(2);
  });

  it('offene Positionen überleben den Marktzeit-Filter', () => {
    // Bewusst ungefiltert: Aussieben hieße, eine offene Position aus den
    // Augen zu verlieren. Ob gehandelt wird, entscheidet der Handelspfad.
    const out = auswahl({
      positions: ['AAPL'],
      ranking: ['BTC-USD'],
      isOpen: nurKrypto,
    });
    expect(out).toContain('AAPL');
  });

  it('ohne isOpen bleibt alles wie vorher — Marktzeit ist opt-in', () => {
    expect(auswahl({ ranking: ['AAPL', 'BTC-USD'] })).toEqual(['AAPL', 'BTC-USD']);
  });
});
