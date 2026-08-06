import { describe, expect, it } from 'vitest';
import {
  BEWAEHRT_MIN_TAGE,
  BEWAEHRT_MIN_TRADES,
  besserAls,
  engineBilanz,
  extrahiereEinstellungen,
  pruefeKandidat,
  uebernehmeEinstellungen,
  vergleicheEinstellungen,
  type EngineBilanz,
  type EngineTrade,
  type Strategy,
} from '../src/index.js';

/** Bilanz-Baukasten: geeigneter Kandidat, einzelne Felder überschreibbar. */
function bilanz(teil: Partial<EngineBilanz> = {}): EngineBilanz {
  return {
    n: 40,
    pnl: 50,
    fees: 20,
    notional: 10_000,
    kantePct: 0.5,
    zeitraumTage: 20,
    ...teil,
  };
}

describe('engineBilanz (Aggregation der Engine-Trades)', () => {
  it('leere Liste → Null-Bilanz mit kantePct null', () => {
    const b = engineBilanz([]);
    expect(b).toEqual({ n: 0, pnl: 0, fees: 0, notional: 0, kantePct: null, zeitraumTage: 0 });
  });

  it('summiert P&L, Gebühren, Volumen und rechnet die Netto-Kante', () => {
    const trades: EngineTrade[] = [
      { pnl: 30, at: '2026-08-01T10:00:00Z', notional: 5_000, feeRate: 0.001 },
      { pnl: -10, at: '2026-08-03T10:00:00Z', notional: 5_000, feeRate: 0.001 },
    ];
    const b = engineBilanz(trades);
    expect(b.n).toBe(2);
    expect(b.pnl).toBe(20);
    expect(b.fees).toBe(20); // 2 × (5000 × 0,001 × 2 Seiten)
    expect(b.notional).toBe(10_000);
    expect(b.kantePct).toBe(0.2); // 20 / 10000 in %
    expect(b.zeitraumTage).toBe(2);
  });

  it('Trades ohne Volumen/Satz zählen ins P&L, aber nicht in den Kanten-Nenner', () => {
    const b = engineBilanz([
      { pnl: 100, at: '2026-08-01T00:00:00Z' },
      { pnl: 10, at: '2026-08-02T00:00:00Z', notional: 1_000, feeRate: 0.001 },
    ]);
    expect(b.n).toBe(2);
    expect(b.pnl).toBe(110);
    expect(b.notional).toBe(1_000);
    // Kante NUR aus dem vollständigen Trade-Volumen — sonst sähe sie zu gut aus.
    expect(b.kantePct).toBe(11);
  });

  it('kaputte P&L-Werte und kaputte Zeitstempel stören nicht', () => {
    const b = engineBilanz([
      { pnl: Number.NaN, at: '2026-08-01T00:00:00Z' },
      { pnl: 5, at: 'kein-datum' },
    ]);
    expect(b.n).toBe(1);
    expect(b.pnl).toBe(5);
    expect(b.zeitraumTage).toBe(0);
  });
});

describe('pruefeKandidat (Glücks-Schutz)', () => {
  it('geeignet nur mit allen drei Belegen', () => {
    expect(pruefeKandidat(bilanz()).geeignet).toBe(true);
    expect(pruefeKandidat(bilanz()).fehlt).toEqual([]);
  });

  it('zu wenige Trades → Klartext-Grund mit Zählerstand', () => {
    const u = pruefeKandidat(bilanz({ n: 12 }));
    expect(u.geeignet).toBe(false);
    expect(u.fehlt).toContain(`12/${BEWAEHRT_MIN_TRADES} Engine-Trades`);
  });

  it('zu kurzer Zeitraum → Grund mit Tagesstand', () => {
    const u = pruefeKandidat(bilanz({ zeitraumTage: 8.7 }));
    expect(u.geeignet).toBe(false);
    expect(u.fehlt).toContain(`8/${BEWAEHRT_MIN_TAGE} Tage Messzeitraum`);
  });

  it('negative oder unmessbare Kante disqualifiziert', () => {
    expect(pruefeKandidat(bilanz({ kantePct: -0.1 })).geeignet).toBe(false);
    expect(pruefeKandidat(bilanz({ kantePct: 0 })).geeignet).toBe(false);
    const ohne = pruefeKandidat(bilanz({ kantePct: null }));
    expect(ohne.geeignet).toBe(false);
    expect(ohne.fehlt.join(' ')).toContain('nicht messbar');
  });

  it('mehrere Mängel werden alle genannt', () => {
    const u = pruefeKandidat(bilanz({ n: 5, zeitraumTage: 2, kantePct: -1 }));
    expect(u.fehlt).toHaveLength(3);
  });
});

describe('besserAls (Ordnung über Konten)', () => {
  it('gegen nichts gewinnt jede Bilanz', () => {
    expect(besserAls(bilanz(), null)).toBe(true);
    expect(besserAls(bilanz(), undefined)).toBe(true);
  });

  it('höhere Kante schlägt mehr Trades', () => {
    expect(besserAls(bilanz({ kantePct: 0.8, n: 30 }), bilanz({ kantePct: 0.5, n: 400 }))).toBe(
      true,
    );
    expect(besserAls(bilanz({ kantePct: 0.2 }), bilanz({ kantePct: 0.5 }))).toBe(false);
  });

  it('bei gleicher Kante entscheidet die breitere Datenbasis', () => {
    expect(besserAls(bilanz({ n: 50 }), bilanz({ n: 40 }))).toBe(true);
    expect(besserAls(bilanz({ n: 40 }), bilanz({ n: 40 }))).toBe(false);
  });

  it('unmessbare Kante verliert immer gegen messbare', () => {
    expect(besserAls(bilanz({ kantePct: null }), bilanz({ kantePct: -5 }))).toBe(false);
  });
});

// Eine vollständige Strategie im flachen Schema — Vorlage der Extraktion.
const STRATEGIE: Strategy = {
  broker: { provider: 'paper', mode: 'paper', initialCapital: 10_000, paperTrading: true },
  watchlist: ['^NDX', 'BTC-USD'],
  engine: {
    checkIntervalMin: 5,
    maxPositionPct: 10,
    stopLossPct: 2,
    takeProfitPct: 4,
    running: true,
    classWeights: { crypto: 0.5 },
  },
  indicators: {
    rsi: { enabled: true, window: 14, thresholdBuy: 30, thresholdSell: 70 },
    macd: { enabled: true, crossoverBuy: true },
    bollinger: { enabled: true, bbBreakoutPct: 95 },
  },
  signals: { minConfluence: 2, period: '3mo', useForecast: true, forecastWeight: 1, forecastThresholdPct: 1 },
};

describe('extrahiereEinstellungen (anonymisierter Snapshot-Auszug)', () => {
  it('nimmt engine/signals/indicators und lässt Watchlist, Broker und running weg', () => {
    const e = extrahiereEinstellungen(STRATEGIE);
    expect(e).not.toBeNull();
    expect(e && 'watchlist' in e).toBe(false);
    expect(e && 'broker' in e).toBe(false);
    expect(e?.engine['running']).toBeUndefined();
    expect(e?.engine['stopLossPct']).toBe(2);
    expect(e?.engine['classWeights']).toEqual({ crypto: 0.5 });
    expect(e?.signals['minConfluence']).toBe(2);
    expect((e?.indicators['rsi'] as Record<string, unknown>)['window']).toBe(14);
  });

  it('fehlt ein Block, gibt es KEINEN halben Snapshot', () => {
    expect(extrahiereEinstellungen({ engine: {}, signals: {} })).toBeNull();
    expect(extrahiereEinstellungen(null)).toBeNull();
    expect(extrahiereEinstellungen('kaputt')).toBeNull();
  });
});

describe('vergleicheEinstellungen (Vorschau-Diff)', () => {
  it('identische Einstellungen → leerer Diff', () => {
    const best = extrahiereEinstellungen(STRATEGIE);
    expect(best && vergleicheEinstellungen(STRATEGIE, best)).toEqual([]);
  });

  it('running zählt nie als Unterschied', () => {
    const best = extrahiereEinstellungen({ ...STRATEGIE, engine: { ...STRATEGIE.engine, running: false } });
    expect(best && vergleicheEinstellungen(STRATEGIE, best)).toEqual([]);
  });

  it('nennt geänderte, fehlende und zusätzliche Felder mit Punkt-Pfad', () => {
    const best = extrahiereEinstellungen({
      ...STRATEGIE,
      engine: { ...STRATEGIE.engine, stopLossPct: 3, cooldownMin: 30 },
      indicators: {
        ...STRATEGIE.indicators,
        rsi: { ...STRATEGIE.indicators.rsi, window: 7 },
      },
    });
    const diff = best ? vergleicheEinstellungen(STRATEGIE, best) : [];
    expect(diff).toContainEqual({ pfad: 'engine.stopLossPct', eigen: 2, bewaehrt: 3 });
    expect(diff).toContainEqual({ pfad: 'engine.cooldownMin', eigen: undefined, bewaehrt: 30 });
    expect(diff).toContainEqual({ pfad: 'indicators.rsi.window', eigen: 14, bewaehrt: 7 });
    expect(diff).toHaveLength(3);
  });
});

describe('uebernehmeEinstellungen (der eigentliche Klick)', () => {
  it('ersetzt engine/signals/indicators, behält running, Watchlist und Broker', () => {
    const best = extrahiereEinstellungen({
      ...STRATEGIE,
      engine: { ...STRATEGIE.engine, stopLossPct: 3, maxPositionPct: 5 },
      signals: { ...STRATEGIE.signals, minConfluence: 3 },
    });
    if (!best) throw new Error('Extraktion darf hier nicht scheitern');
    const eigene = {
      ...STRATEGIE,
      engine: { ...STRATEGIE.engine, running: false, minHoldMin: 120 },
    };
    const neu = uebernehmeEinstellungen(eigene, best);
    expect(neu.engine.running).toBe(false); // eigener Schalter bleibt
    expect((neu.engine as Record<string, unknown>)['stopLossPct']).toBe(3);
    // ERSETZT, nicht gemischt: das eigene minHoldMin stammt nicht vom Besten.
    expect((neu.engine as Record<string, unknown>)['minHoldMin']).toBeUndefined();
    expect((neu.signals as Record<string, unknown>)['minConfluence']).toBe(3);
    expect(neu.watchlist).toEqual(['^NDX', 'BTC-USD']);
    expect(neu.broker).toEqual(STRATEGIE.broker);
  });
});
