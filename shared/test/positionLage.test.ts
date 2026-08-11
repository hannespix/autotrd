/**
 * Audit-Befund 11.08. (F6): Der Positionswert hatte drei Antworten.
 *
 * ── Was auf demselben Bildschirm stand ────────────────────────────────────
 *
 * Das Dashboard rechnete den Wert an drei Stellen selbst nach: in der
 * Kennzahlen-Summe, in der Positionstabelle und im Stop-Dialog. Die Formel
 * war überall dieselbe — der Umgang mit einem FEHLENDEN Kurs nicht:
 *
 *   - Die Summe setzte still den Einstand ein und zeigte „±0,00".
 *   - Die Tabelle zeigte ehrlich „—".
 *   - Der Stop-Dialog zeigte wieder 0.
 *
 * Die gefährlichere Antwort war die Summe. Ein Depotwert auf
 * Einstandspreisen sieht aus wie ein Depotwert; er bedeutet aber „hier hat
 * sich nichts bewegt", während in Wahrheit niemand weiß, wo die Position
 * steht. Genau die Lage aus dem Owner-Screenshot vom 10.08.: 128 von 132
 * Symbolen ohne Kurs.
 */
import { describe, expect, it } from 'vitest';
import { positionLage, positionValue } from '../src/portfolio.js';

const long = { qty: 10, avgEntry: 100 } as const;
const short = { qty: 10, avgEntry: 100, side: 'short' } as const;

describe('positionLage — Long', () => {
  it('gestiegener Kurs ⇒ Gewinn und höherer Wert', () => {
    expect(positionLage(long, 110)).toEqual({ wert: 1_100, pnl: 100, kursBekannt: true });
  });

  it('gefallener Kurs ⇒ Verlust', () => {
    expect(positionLage(long, 90)).toEqual({ wert: 900, pnl: -100, kursBekannt: true });
  });

  it('Kurs genau auf Einstand ⇒ echte Null', () => {
    // Der Unterschied zum Fall darunter: HIER ist ±0 eine Aussage.
    expect(positionLage(long, 100)).toEqual({ wert: 1_000, pnl: 0, kursBekannt: true });
  });
});

describe('positionLage — Short (gespiegelt)', () => {
  it('gefallener Kurs ⇒ Gewinn', () => {
    expect(positionLage(short, 90)).toEqual({ wert: 1_100, pnl: 100, kursBekannt: true });
  });

  it('gestiegener Kurs ⇒ Verlust; im Wert steckt die Margin', () => {
    // Margin (Einstand × Stück) plus unrealisiertes Ergebnis — dieselbe
    // Spiegelung wie im Schattenbuch.
    expect(positionLage(short, 110)).toEqual({ wert: 900, pnl: -100, kursBekannt: true });
  });
});

describe('Ohne Kurs: unbekannt ist nicht null', () => {
  it('der Wert bleibt konservativ auf Einstand', () => {
    /* Eine Position aus der Equity zu streichen, weil ihr Kurs fehlt, wäre
     * schlimmer als sie zum Einstand zu führen: Der Depotwert bräche
     * scheinbar ein, und die Notbremse rechnete gegen eine Bezugsgröße, die
     * es nie gab. */
    expect(positionLage(long, null).wert).toBe(1_000);
    expect(positionLage(short, null).wert).toBe(1_000);
  });

  it('das Ergebnis ist null, nicht 0', () => {
    // Der Kern des Befunds.
    expect(positionLage(long, null).pnl).toBe(null);
    expect(positionLage(long, undefined).pnl).toBe(null);
    expect(positionLage(short, null).pnl).toBe(null);
  });

  it('kursBekannt macht es zählbar', () => {
    expect(positionLage(long, null).kursBekannt).toBe(false);
    expect(positionLage(long, 110).kursBekannt).toBe(true);
  });

  it('ein unbrauchbarer Kurs zählt als „kein Kurs"', () => {
    // 0 und negative Werte kommen aus kaputten Quellen; NaN aus einer
    // Division, die niemand geprüft hat. Alle drei dürfen nicht als
    // Marktpreis durchgehen.
    for (const p of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(positionLage(long, p).kursBekannt, String(p)).toBe(false);
      expect(positionLage(long, p).pnl, String(p)).toBe(null);
    }
  });
});

describe('positionValue bleibt kompatibel', () => {
  it('liefert weiter denselben Wert wie vorher', () => {
    // Der Backend-Pfad (snapshotEquity, Broker-Abgleich) hängt daran. Eine
    // stille Änderung hier verschöbe die Equity-Kurve aller Konten.
    expect(positionValue(long, 110)).toBe(1_100);
    expect(positionValue(long, null)).toBe(1_000);
    expect(positionValue(short, 90)).toBe(1_100);
    expect(positionValue(short, null)).toBe(1_000);
  });

  it('ist genau die wert-Hälfte von positionLage', () => {
    for (const pos of [long, short]) {
      for (const preis of [null, 50, 100, 150]) {
        expect(positionValue(pos, preis)).toBe(positionLage(pos, preis).wert);
      }
    }
  });
});

describe('Bruchstücke und Randwerte', () => {
  it('rechnet mit Bruchteilen (Krypto)', () => {
    const btc = { qty: 0.02, avgEntry: 60_000 } as const;
    expect(positionLage(btc, 61_000).pnl).toBeCloseTo(20, 6);
  });

  it('eine leere Position ergibt Nullen, keinen NaN', () => {
    expect(positionLage({ qty: 0, avgEntry: 100 }, 110)).toEqual({
      wert: 0,
      pnl: 0,
      kursBekannt: true,
    });
  });
});
