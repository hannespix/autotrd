/**
 * Einheiten-Fix der Kostenschwelle (Audit 13.08., HOCH-4).
 *
 * Der Befund: Der Scan rechnet den ATR auf TAGES-Kerzen, das Kosten-Tor
 * teilte die Haltedauer aber durch die SIGNAL-Kerzenlänge (5 min). Beim
 * Default (Intraday, minHold 1440) hieß das Tages-ATR × √288 ≈ 17× — eine
 * Schwelle, die nie blocken konnte (`unter_kosten: 0` bei jedem Lauf).
 * Real bewegt sich eine US-Aktie über 60 Handelsminuten um
 * Tages-ATR × √(60/390) ≈ 0,39×.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  atrTagesanteile,
  costGate,
  sessionMinutesForClass,
} from '../src/costGate.js';

describe('sessionMinutesForClass', () => {
  it('US-Session-Klassen 390, Rund-um-die-Uhr-Klassen 1440', () => {
    expect(sessionMinutesForClass('stocks_us')).toBe(390);
    expect(sessionMinutesForClass('etf_thematic')).toBe(390);
    expect(sessionMinutesForClass('crypto')).toBe(1440);
    expect(sessionMinutesForClass('forex')).toBe(1440);
    expect(sessionMinutesForClass('commodities')).toBe(1440);
    expect(sessionMinutesForClass(undefined)).toBe(390);
  });
});

describe('atrTagesanteile — Haltedauer in Tages-ATR-Anteilen', () => {
  it('eine Handelsstunde einer US-Aktie ist 60/390 einer Tageskerze', () => {
    expect(atrTagesanteile(60, 390, 5)).toBeCloseTo(60 / 390, 10);
  });

  it('ein voller Tag ist genau EINE Session — nicht 1440/390', () => {
    expect(atrTagesanteile(1440, 390, 5)).toBe(1);
  });

  it('zwei Tage sind zwei Sessions', () => {
    expect(atrTagesanteile(2880, 390, 5)).toBe(2);
  });

  it('Krypto handelt durch: eine Stunde ist 60/1440', () => {
    expect(atrTagesanteile(60, 1440, 5)).toBeCloseTo(60 / 1440, 10);
  });

  it('minHold aus ⇒ Boden ist die Signal-Kerze', () => {
    expect(atrTagesanteile(0, 390, 5)).toBeCloseTo(5 / 390, 10);
    // Tages-Zeitbasis: Boden eine Tageskerze = eine Session.
    expect(atrTagesanteile(0, 390, 1440)).toBe(1);
  });
});

describe('costGate mit Tages-ATR — die Audit-Zahlen', () => {
  const aktie = { minHoldMin: 60, timeframe: 'intraday' as const, feeRate: 0.0005 };

  it('US-Aktie, 60 min Haltezeit: ×0,39 statt ×3,46', () => {
    const neu = costGate({ ...aktie, atrPct: 1.2, atrSessionMin: 390 });
    expect(neu.expectedPct).toBeCloseTo(1.2 * Math.sqrt(60 / 390), 3); // ≈ 0,47
    const alt = costGate({ ...aktie, atrPct: 1.2 });
    expect(alt.expectedPct).toBeCloseTo(1.2 * Math.sqrt(12), 3); // ≈ 4,16 — der Befund
  });

  it('Default-Konfiguration (minHold 1440, intraday): ×1 statt ×17', () => {
    const neu = costGate({ ...aktie, minHoldMin: 1440, atrPct: 1.2, atrSessionMin: 390 });
    expect(neu.expectedPct).toBeCloseTo(1.2, 6);
    const alt = costGate({ ...aktie, minHoldMin: 1440, atrPct: 1.2 });
    expect(alt.expectedPct).toBeCloseTo(1.2 * Math.sqrt(288), 3); // ≈ 20,4 — nie blockend
  });

  it('Krypto kippt vom Durchwinken zum Blocken — genau der Audit-Fall', () => {
    const krypto = {
      atrPct: 3,
      minHoldMin: 60,
      timeframe: 'intraday' as const,
      feeRate: 0.0025, // 0,5 % Roundtrip ⇒ need 1,5 %
    };
    expect(costGate(krypto).ok).toBe(true); // alt: 3×√12 ≈ 10,4 % — passiert
    const neu = costGate({ ...krypto, atrSessionMin: 1440 });
    expect(neu.ok).toBe(false); // neu: 3×0,204 ≈ 0,61 % < 1,5 %
    expect(neu.reason).toBe('bewegung_unter_kosten');
  });

  it('Tages-Zeitbasis bleibt unverändert (bars = 1 wie bisher)', () => {
    const basis = { atrPct: 2, minHoldMin: 1440, timeframe: 'daily' as const, feeRate: 0.0005 };
    expect(costGate({ ...basis, atrSessionMin: 390 }).expectedPct).toBe(
      costGate(basis).expectedPct,
    );
  });
});

describe('Einheiten-Fix — die Verdrahtung (Quelltext-Wächter)', () => {
  const hier = dirname(fileURLToPath(import.meta.url));
  const scan = readFileSync(
    join(hier, '../../functions/src/scheduled/scanMarket.ts'),
    'utf8',
  );

  it('alle drei costGate-Stellen im Scan übergeben die ATR-Session', () => {
    expect(scan.match(/atrSessionMin: sessionMinutesForClass\(/g)?.length).toBe(3);
  });

  it('der Schatten-Nenner trägt die Kerzenlänge des ATR, nicht der Signale', () => {
    expect(scan).toContain('barMin: BAR_MINUTES.daily');
    expect(scan).not.toContain('barMin: BAR_MINUTES[SCHATTEN_TF]');
  });
});
