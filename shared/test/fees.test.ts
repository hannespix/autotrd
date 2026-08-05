/**
 * Ausführungskosten und Notierungswährung (04.08.).
 *
 * Warum das eigene Tests braucht: Das Buch verrechnete bis zum 04.08. für
 * JEDE Anlageklasse denselben Pauschalsatz, während das Kosten-Tor beim
 * Einstieg längst klassenecht rechnete. Beide Zahlen sahen plausibel aus —
 * die Abweichung fiel niemandem auf, weil nirgends stand, welcher Satz
 * eigentlich gelten sollte. Diese Tests halten die Sätze zusammen.
 */

import { describe, expect, it } from 'vitest';
import {
  CLASS_FEE_PARTS,
  CLASS_FEE_RATE,
  PAPER_FEE_RATE,
  effectivePriceForClass,
  effectivePriceFromFill,
  feePartsForClass,
  feeRateForClass,
} from '../src/strategy.js';
import { classify, currencyForSymbol } from '../src/universe.js';

describe('Gebühren-Aufteilung', () => {
  it('summiert sich in JEDER Klasse exakt zum Gesamtsatz', () => {
    // Der eigentliche Zweck dieses Tests: Zwei Tabellen, die dasselbe meinen,
    // driften auseinander, sobald jemand nur eine davon anfasst.
    for (const [klasse, rate] of Object.entries(CLASS_FEE_RATE)) {
      const teile = CLASS_FEE_PARTS[klasse];
      expect(teile, `Klasse ${klasse} fehlt in CLASS_FEE_PARTS`).toBeDefined();
      expect(teile!.commission + teile!.slippage).toBeCloseTo(rate, 10);
    }
  });

  it('deckt beide Tabellen dieselben Klassen ab', () => {
    expect(Object.keys(CLASS_FEE_PARTS).sort()).toEqual(Object.keys(CLASS_FEE_RATE).sort());
  });

  it('fällt bei unbekannter Klasse auf den Pauschalsatz zurück', () => {
    const teile = feePartsForClass('gibt_es_nicht');
    expect(teile.commission + teile.slippage).toBeCloseTo(PAPER_FEE_RATE, 10);
    expect(feePartsForClass(null).commission + feePartsForClass(null).slippage).toBeCloseTo(PAPER_FEE_RATE, 10);
  });

  it('rechnet US-Aktien billiger und Krypto teurer als den Pauschalsatz', () => {
    // Genau diese Spreizung war der Befund: Krypto handelt rund um die Uhr,
    // steht deshalb am häufigsten im Buch — und wurde am stärksten geschont.
    expect(feeRateForClass('stocks_us')).toBeLessThan(PAPER_FEE_RATE);
    expect(feeRateForClass('crypto')).toBeGreaterThan(PAPER_FEE_RATE);
  });

  it('verteuert den Kauf und verbilligt den Verkauf — je Klasse verschieden', () => {
    expect(effectivePriceForClass(100, 'buy', 'crypto')).toBeCloseTo(100.25, 10);
    expect(effectivePriceForClass(100, 'sell', 'crypto')).toBeCloseTo(99.75, 10);
    expect(effectivePriceForClass(100, 'buy', 'stocks_us')).toBeCloseTo(100.05, 10);
    expect(effectivePriceForClass(100, 'sell', 'stocks_us')).toBeCloseTo(99.95, 10);
  });

  it('kostet Krypto real das Fünffache von US-Aktien', () => {
    expect(feeRateForClass('crypto') / feeRateForClass('stocks_us')).toBeCloseTo(5, 6);
  });
});

describe('currencyForSymbol', () => {
  it('nimmt US-Papiere als Dollar an', () => {
    for (const s of ['AAPL', 'SPY', 'QQQ', 'BRK-B']) expect(currencyForSymbol(s)).toBe('USD');
  });

  it('erkennt Euro-Börsen am Suffix', () => {
    expect(currencyForSymbol('BMW.DE')).toBe('EUR');
    expect(currencyForSymbol('ASML.AS')).toBe('EUR');
  });

  it('kennt London als PENCE, nicht Pfund', () => {
    // Der Faktor-100-Fehler, den man erst im Kontostand bemerkt.
    expect(currencyForSymbol('AZN.L')).toBe('GBp');
  });

  it('erkennt Yen und Hongkong-Dollar', () => {
    expect(currencyForSymbol('7203.T')).toBe('JPY');
    expect(currencyForSymbol('0700.HK')).toBe('HKD');
  });

  it('liest die Zielwährung eines Devisenpaars', () => {
    expect(currencyForSymbol('EURUSD=X')).toBe('USD');
    expect(currencyForSymbol('USDJPY=X')).toBe('JPY');
  });

  it('unterscheidet Krypto in Euro von Krypto in Dollar', () => {
    expect(currencyForSymbol('BTC-EUR')).toBe('EUR');
    expect(currencyForSymbol('BTC-USD')).toBe('USD');
  });

  it('fällt bei unbekanntem Suffix auf Dollar zurück statt zu raten', () => {
    expect(currencyForSymbol('FOO.XYZ')).toBe('USD');
  });
});

describe('Zusammenspiel Klasse ↔ Währung', () => {
  it('macht sichtbar, dass Auslandsbörsen nicht in Dollar notieren', () => {
    // Diese Papiere sind über isTradable ausgeschlossen — der Test hält fest,
    // WARUM: Ihr Kurs ist keine Dollar-Zahl, das Wallet führt aber Dollar.
    for (const s of ['BMW.DE', '7203.T', 'AZN.L']) {
      expect(classify(s)).toBe('stocks_global');
      expect(currencyForSymbol(s)).not.toBe('USD');
    }
  });
});

describe('MA1-Audit: trägt ein Short dieselbe Reibung wie ein Long?', () => {
  /**
   * Der Broker bucht Long und Short unterschiedlich: Der Long zahlt den
   * Aufschlag beim Kauf und bekommt den Abschlag beim Verkauf; der Short
   * bekommt den Abschlag beim Öffnen und zahlt den Aufschlag beim
   * Eindecken, wobei die Sicherheitsleistung dazwischen voll zurückfließt.
   *
   * Zwei Buchungswege für dieselbe Sache sind genau die Konstellation, in
   * der eine Seite still zu billig wird — und die verzerrte P&L speist
   * Trade-Filter, A/B-Duell und Auto-Tuner. Deshalb hier festgenagelt.
   */
  const RATE = feeRateForClass('stocks_us');
  const QTY = 10;
  const KURS = 100;

  it('kostet den Long genau zweimal den Satz', () => {
    const kauf = effectivePriceForClass(KURS, 'buy', 'stocks_us');
    const verkauf = effectivePriceForClass(KURS, 'sell', 'stocks_us');
    const pnl = (verkauf - kauf) * QTY;
    expect(pnl).toBeCloseTo(-2 * RATE * KURS * QTY, 8);
  });

  it('kostet den Short exakt dasselbe', () => {
    // So rechnet der Broker: pnl = (Einstand − Rückkauf) × Stück, die
    // Sicherheitsleistung kommt unverändert zurück.
    const leerverkauf = effectivePriceForClass(KURS, 'sell', 'stocks_us');
    const eindeckung = effectivePriceForClass(KURS, 'buy', 'stocks_us');
    const pnl = (leerverkauf - eindeckung) * QTY;
    expect(pnl).toBeCloseTo(-2 * RATE * KURS * QTY, 8);
  });

  it('bleibt symmetrisch über alle Anlageklassen', () => {
    for (const cls of ['crypto', 'stocks_us', 'etf_thematic', 'commodities']) {
      const longPnl =
        (effectivePriceForClass(KURS, 'sell', cls) - effectivePriceForClass(KURS, 'buy', cls)) * QTY;
      const shortPnl =
        (effectivePriceForClass(KURS, 'sell', cls) - effectivePriceForClass(KURS, 'buy', cls)) * QTY;
      expect(longPnl).toBeCloseTo(shortPnl, 10);
      expect(longPnl).toBeLessThan(0); // Reibung kostet IMMER
    }
  });
});

describe('effectivePriceFromFill (M13)', () => {
  it('schlägt nur die Kommission auf — die Slippage steckt schon im Fill', () => {
    // stocks_us: 0 % Kommission, 5 bp Slippage. Ein echter Fill wird also
    // UNVERÄNDERT gebucht; jeder Aufschlag hier wäre eine Doppelbuchung.
    expect(effectivePriceFromFill(190.12, 'buy', 'stocks_us')).toBeCloseTo(190.12, 10);
    expect(effectivePriceFromFill(190.12, 'sell', 'stocks_us')).toBeCloseTo(190.12, 10);
  });

  it('bucht Krypto-Kommission weiter, obwohl das Papierkonto keine berechnet', () => {
    // Bewusst konservativ: Das Buch soll die Kosten zeigen, die bei Echtgeld
    // anfallen. Sonst sähe die Kante im Papierbetrieb besser aus als sie ist.
    const c = CLASS_FEE_PARTS['crypto']!.commission;
    expect(c).toBeGreaterThan(0);
    expect(effectivePriceFromFill(100, 'buy', 'crypto')).toBeCloseTo(100 * (1 + c), 10);
    expect(effectivePriceFromFill(100, 'sell', 'crypto')).toBeCloseTo(100 * (1 - c), 10);
  });

  it('liegt für den Käufer NIE über der Schätzung', () => {
    // Die Richtung ist das Entscheidende: Ein echter Fill darf im Buch nicht
    // teurer erscheinen als die Schätzung, die er ersetzt — sonst wäre das
    // Routing eine Verschlechterung der Messgrundlage.
    for (const cls of ['crypto', 'stocks_us', 'etf_thematic', 'commodities', 'forex']) {
      expect(effectivePriceFromFill(100, 'buy', cls)).toBeLessThanOrEqual(
        effectivePriceForClass(100, 'buy', cls) + 1e-12,
      );
      expect(effectivePriceFromFill(100, 'sell', cls)).toBeGreaterThanOrEqual(
        effectivePriceForClass(100, 'sell', cls) - 1e-12,
      );
    }
  });
});
