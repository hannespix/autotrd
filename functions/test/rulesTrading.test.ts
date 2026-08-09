/**
 * Tests der puren Regelbaum-Trading-Bausteine (M10): Risiko-Hülle (Clamps,
 * Cooldown), RuleContext-Builder und die Richtungsentscheidung.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_OPEN_POSITIONS,
  DEFAULT_STRATEGY,
  MAX_LEVERAGE,
  MAX_OPEN_POSITIONS_CAP,
  compileClassic,
  type IndicatorSnapshot,
  type Strategy,
} from '../../shared/src/index.js';
import {
  RISK_LIMITS,
  buildRuleContext,
  clampLeverage,
  clampStrategyRisk,
  maxOpenPositions,
  cooldownActive,
  minHoldActive,
  decideTree,
  applyPredictionVote,
  minuteOfDayEt,
  planPromotion,
  predictionVote,
  shadowEquity,
  shadowTrade,
} from '../src/core/rulesTrading.js';

const SNAPSHOT: IndicatorSnapshot = {
  rsi: 22,
  macd: { line: 1.2, signal: 1.0, histogram: 0.2 },
  bollinger: { upper: 110, middle: 100, lower: 90, pctB: 3 },
};

describe('Risiko-Hülle (von keinem Knoten überschreibbar)', () => {
  it('klemmt maxPositionPct hart auf 25 und erzwingt einen Stop-Loss', () => {
    const greedy = structuredClone(DEFAULT_STRATEGY);
    greedy.engine.maxPositionPct = 80;
    greedy.engine.stopLossPct = 0;
    const clamped = clampStrategyRisk(greedy);
    expect(clamped.engine.maxPositionPct).toBe(RISK_LIMITS.maxPositionPct);
    expect(clamped.engine.stopLossPct).toBe(RISK_LIMITS.emergencyStopPct);
    // Original bleibt unangetastet (pure)
    expect(greedy.engine.maxPositionPct).toBe(80);
  });

  it('lässt konservative Configs unverändert', () => {
    const c = clampStrategyRisk(DEFAULT_STRATEGY);
    expect(c.engine.maxPositionPct).toBe(DEFAULT_STRATEGY.engine.maxPositionPct);
    expect(c.engine.stopLossPct).toBe(DEFAULT_STRATEGY.engine.stopLossPct);
  });

  it('Cooldown: aktiv innerhalb des Fensters, danach frei, robust bei Müll', () => {
    const now = new Date('2026-07-24T15:00:00Z');
    const within = new Date(now.getTime() - (RISK_LIMITS.cooldownMin - 1) * 60_000).toISOString();
    const past = new Date(now.getTime() - (RISK_LIMITS.cooldownMin + 1) * 60_000).toISOString();
    expect(cooldownActive(within, now)).toBe(true);
    expect(cooldownActive(past, now)).toBe(false);
    expect(cooldownActive(undefined, now)).toBe(false);
    expect(cooldownActive('kein-datum', now)).toBe(false);
  });
});

describe('buildRuleContext + decideTree', () => {
  it('mappt Snapshot-Werte vollständig in den Kontext', () => {
    const ctx = buildRuleContext({
      price: 100,
      snapshot: SNAPSHOT,
      prevSnapshot: { ...SNAPSHOT, rsi: 35 },
      prevPrice: 99,
      closes: [95, 97, 99, 100],
      minuteOfDayEt: 600,
      forecastPct: 1.5,
      position: { open: false },
    });
    expect(ctx.values['rsi']).toBe(22);
    expect(ctx.values['macdSignal']).toBe(1.0);
    expect(ctx.values['pctB']).toBe(3);
    expect(ctx.prevValues?.['rsi']).toBe(35);
    expect(ctx.prevValues?.['price']).toBe(99);
    expect(ctx.forecastPct).toBe(1.5);
  });

  it('null-Indikatoren werden zu unbekannt, nicht zu 0', () => {
    const ctx = buildRuleContext({
      price: 100,
      snapshot: { rsi: null, macd: null, bollinger: null },
      closes: [100],
      minuteOfDayEt: null,
      position: null,
    });
    expect(ctx.values['rsi']).toBeNull();
    expect(ctx.values['macdLine']).toBeUndefined();
  });

  it('decideTree: kompilierte Classic-Spec kauft im klaren Buy-Setup', () => {
    const spec = compileClassic(DEFAULT_STRATEGY);
    const ctx = buildRuleContext({
      price: 100,
      snapshot: SNAPSHOT, // RSI 22 (buy), MACD-Cross (buy), pctB 3 (buy)
      closes: [95, 97, 99, 100],
      minuteOfDayEt: 600,
      forecastPct: 2, // Forecast-Vote buy (w2)
      position: { open: false },
    });
    expect(decideTree(spec, ctx)).toBe('buy');
  });

  it('decideTree: Sell-Setup verkauft, Patt hält', () => {
    const spec = compileClassic(DEFAULT_STRATEGY);
    const sellCtx = buildRuleContext({
      price: 100,
      snapshot: {
        rsi: 85,
        macd: { line: 0.8, signal: 1.0, histogram: -0.2 },
        bollinger: { upper: 110, middle: 100, lower: 90, pctB: 99 },
      },
      closes: [105, 103, 101, 100],
      minuteOfDayEt: 600,
      forecastPct: -2,
      position: { open: true, unrealizedPct: -1 },
    });
    expect(decideTree(spec, sellCtx)).toBe('sell');

    const mixedCtx = buildRuleContext({
      price: 100,
      snapshot: { rsi: 50, macd: { line: 1, signal: 1, histogram: 0 }, bollinger: { upper: 110, middle: 100, lower: 90, pctB: 50 } },
      closes: [100],
      minuteOfDayEt: 600,
      forecastPct: 0,
      position: { open: false },
    });
    expect(decideTree(spec, mixedCtx)).toBe('hold');
  });
});

describe('minuteOfDayEt', () => {
  it('rechnet UTC korrekt nach ET um (EDT im Juli, EST im Januar)', () => {
    expect(minuteOfDayEt(new Date('2026-07-22T16:00:00Z'))).toBe(12 * 60); // 12:00 EDT
    expect(minuteOfDayEt(new Date('2026-01-21T14:30:00Z'))).toBe(9 * 60 + 30); // 09:30 EST
  });
});

describe('Shadow-Konto (M11): pure Buchführung', () => {
  it('Entry dimensioniert nach maxPositionPct, Exit stellt komplett glatt — mit Paper-Gebühren', () => {
    // Realismus (User-Wunsch 25.07.), seit 04.08. KLASSENECHT: QQQ ist ein
    // ETF und kostet 0,05 % je Seite statt des alten Pauschalsatzes von
    // 0,15 % — effektiver Preis = 500 × 1,0005 = 500.25
    const start = { balance: 25_000, positions: {} };
    const buy = shadowTrade(start, 'QQQ', 'buy', 500, 10); // 2500 / 500.25 → 4 Stück
    expect(buy.executed).toBe(true);
    expect(buy.book.positions['QQQ']).toEqual({ qty: 4, avgEntry: 500.25, highWater: 500.25 });
    expect(buy.book.balance).toBeCloseTo(25_000 - 4 * 500.25, 6);
    // nie nachkaufen
    expect(shadowTrade(buy.book, 'QQQ', 'buy', 480, 10).executed).toBe(false);
    // Verkauf zu 520 → effektiv 520 × 0,9995 = 519.74 je Stück zurück
    const sell = shadowTrade(buy.book, 'QQQ', 'sell', 520, 10);
    expect(sell.executed).toBe(true);
    expect(sell.book.balance).toBeCloseTo(buy.book.balance + 4 * 519.74, 6);
    expect(sell.book.positions['QQQ']).toBeUndefined();
    // Original bleibt unangetastet (pure)
    expect(start.positions).toEqual({});
  });

  it('Sell ohne Position und Buy ohne Budget sind No-ops', () => {
    expect(shadowTrade({ balance: 100, positions: {} }, 'QQQ', 'sell', 500, 10).executed).toBe(false);
    expect(shadowTrade({ balance: 100, positions: {} }, 'QQQ', 'buy', 500, 10).executed).toBe(false);
  });

  it('shadowEquity = Balance + Positionswert (fehlender Preis → Einstand)', () => {
    const book = { balance: 1_000, positions: { QQQ: { qty: 5, avgEntry: 500 }, AAPL: { qty: 2, avgEntry: 200 } } };
    expect(shadowEquity(book, new Map([['QQQ', 520]]))).toBe(1_000 + 2_600 + 400);
  });
});

describe('Trade-Frequenz-Parameter (Owner 26.07.)', () => {
  it('cooldownMin wird in die Hülle geklemmt: 5–1440, fehlend → 60', () => {
    // Der Rückfallwert lag bis 27.07. bei 15 min. Die Auswertung der beiden
    // Testkonten zeigte, dass die hohe Frequenz die Kostenschwelle nicht
    // trägt (Ø-Gewinn 0,49 % gegen 0,30 % Roundtrip) — deshalb 60.
    const mk = (v?: number): number | undefined => {
      const s = structuredClone(DEFAULT_STRATEGY);
      if (v === undefined) delete s.engine.cooldownMin;
      else s.engine.cooldownMin = v;
      return clampStrategyRisk(s).engine.cooldownMin;
    };
    expect(mk(undefined)).toBe(60);
    expect(mk(1)).toBe(5); // unter dem Scan-Takt wäre die Pause wirkungslos
    expect(mk(90)).toBe(90);
    expect(mk(5000)).toBe(1440); // über 1 Tag wäre ein verstecktes Handelsverbot
  });

  it('minHoldMin wird in die Hülle geklemmt: 0–1440, fehlend → 60', () => {
    const mk = (v?: number): number | undefined => {
      const s = structuredClone(DEFAULT_STRATEGY);
      if (v === undefined) delete s.engine.minHoldMin;
      else s.engine.minHoldMin = v;
      return clampStrategyRisk(s).engine.minHoldMin;
    };
    expect(mk(undefined)).toBe(60);
    expect(mk(0)).toBe(0); // 0 darf abschalten — anders als beim Cooldown
    expect(mk(-5)).toBe(0);
    expect(mk(5000)).toBe(1440); // über 1 Tag wäre die Position eingesperrt
  });

  it('cooldownActive respektiert die konfigurierten Minuten', () => {
    const now = new Date('2026-07-26T12:00:00Z');
    const vor10 = new Date('2026-07-26T11:50:00Z').toISOString();
    expect(cooldownActive(vor10, now, 5)).toBe(false); // 10 min > 5er-Pause
    expect(cooldownActive(vor10, now, 15)).toBe(true); // 10 min < 15er-Pause
  });
});

describe('Shadow-Duell-Parität (MA4, 26.07.)', () => {
  it("Sizing-Basis 'initial' via capital-Override — wie der echte Broker", () => {
    // Startkapital 25 000, aber nur noch 3 000 Cash: 10 % von 25 000 = 2 500
    // → 4 Stück à 500.25 = 2 001 ≤ 3 000 Deckung → Kauf geht durch.
    const book = { balance: 3_000, positions: {} };
    const r = shadowTrade(book, 'QQQ', 'buy', 500, 10, { capital: 25_000 });
    expect(r.executed).toBe(true);
    expect(r.book.positions['QQQ']?.qty).toBe(4);
  });

  it('Deckung prüft IMMER der Shadow-Cash (zu_wenig_cash-Parität)', () => {
    // 10 % von 25 000 wollen 4 Stück (2 001) — Cash deckt nur 1 500 → No-op
    const book = { balance: 1_500, positions: {} };
    expect(shadowTrade(book, 'QQQ', 'buy', 500, 10, { capital: 25_000 }).executed).toBe(false);
  });

  it('Kauf stempelt highWater (= Einstand) und openedAt für Trailing/Zeitgrenze', () => {
    const now = new Date('2026-07-26T12:00:00.000Z');
    const r = shadowTrade({ balance: 25_000, positions: {} }, 'QQQ', 'buy', 500, 10, { now });
    expect(r.book.positions['QQQ']).toEqual({
      qty: 4,
      avgEntry: 500.25,
      highWater: 500.25,
      openedAt: '2026-07-26T12:00:00.000Z',
    });
  });

  it('negatives capital kauft nichts (Math.max-Guard)', () => {
    expect(shadowTrade({ balance: 25_000, positions: {} }, 'QQQ', 'buy', 500, 10, { capital: -1 }).executed).toBe(false);
  });
});

describe('Shadow-Shorts (R2, 26.07.) — Parität zum echten Broker', () => {
  it('Short-Open: 100-%-Margin vom Cash, side/lowWater gestempelt', () => {
    // sell-Abschlag (ETF, 0,05 %): 500 × 0.9995 = 499.75; 10 % von 25 000 → 5 Stück
    const r = shadowTrade({ balance: 25_000, positions: {} }, 'QQQ', 'sell', 500, 10, { openShort: true });
    expect(r.executed).toBe(true);
    expect(r.book.positions['QQQ']).toMatchObject({ qty: 5, avgEntry: 499.75, side: 'short', lowWater: 499.75 });
    expect(r.book.balance).toBeCloseTo(25_000 - 5 * 499.75, 6);
  });

  it('ohne openShort bleibt sell ohne Position ein No-op (Opt-in-Parität)', () => {
    expect(shadowTrade({ balance: 25_000, positions: {} }, 'QQQ', 'sell', 500, 10).executed).toBe(false);
  });

  it('Cover (buy) bucht Margin + P&L zurück — Gewinn bei gefallenem Kurs', () => {
    const open = shadowTrade({ balance: 25_000, positions: {} }, 'QQQ', 'sell', 500, 10, { openShort: true });
    const cover = shadowTrade(open.book, 'QQQ', 'buy', 480, 10); // buy-Aufschlag: 480×1.0005 = 480.24
    expect(cover.executed).toBe(true);
    const pnl = (499.75 - 480.24) * 5;
    expect(cover.book.balance).toBeCloseTo(open.book.balance + 5 * 499.75 + pnl, 6);
    expect(cover.book.positions['QQQ']).toBeUndefined();
  });

  it('kein Nachverkauf auf offene Shorts (sell = No-op)', () => {
    const open = shadowTrade({ balance: 25_000, positions: {} }, 'QQQ', 'sell', 500, 10, { openShort: true });
    expect(shadowTrade(open.book, 'QQQ', 'sell', 490, 10, { openShort: true }).executed).toBe(false);
  });

  it('shadowEquity: Short steckt mit Margin + unrealisiertem P&L im Depotwert', () => {
    const book = { balance: 1_000, positions: { QQQ: { qty: 5, avgEntry: 500, side: 'short' as const, lowWater: 480 } } };
    // Kurs 480: Margin 2 500 + P&L (500−480)×5 = 100 → 2 600
    expect(shadowEquity(book, new Map([['QQQ', 480]]))).toBe(1_000 + 2_600);
    // fehlender Preis → Einstand → nur die Margin
    expect(shadowEquity(book, new Map())).toBe(1_000 + 2_500);
  });
});

describe('Befördern (M11 A/B): purer Rollentausch-Plan', () => {
  const S = (id: string, mode: 'paper' | 'shadow', symbols: string[], status = 'published') => ({
    id,
    status,
    mode,
    symbols,
  });

  it('demotet genau die überlappenden Paper-Strategien', () => {
    const list = [
      S('a', 'paper', ['QQQ', 'AAPL']),
      S('b', 'shadow', ['QQQ']),
      S('c', 'paper', ['TSLA']), // keine Überlappung → bleibt
      S('d', 'paper', ['AAPL'], 'draft'), // nicht publiziert → handelt eh nicht
    ];
    expect(planPromotion(list, 'b')).toEqual({ demote: ['a'] });
  });

  it('ohne Überlappung wird niemand demotet', () => {
    expect(planPromotion([S('x', 'shadow', ['BTC-USD']), S('y', 'paper', ['QQQ'])], 'x')).toEqual({ demote: [] });
  });

  it('lehnt ungültige Ziele ab (fehlt / draft / paper / ohne Symbole)', () => {
    expect(() => planPromotion([], 'nix')).toThrow(/existiert nicht/);
    expect(() => planPromotion([S('a', 'shadow', ['QQQ'], 'draft')], 'a')).toThrow(/publizieren/);
    expect(() => planPromotion([S('a', 'paper', ['QQQ'])], 'a')).toThrow(/Shadow/);
    expect(() => planPromotion([S('a', 'shadow', [])], 'a')).toThrow(/Symbole/);
  });
});

describe('User-Prognose-Stimme (Chart-Pfeile)', () => {
  const pred = (over: Partial<import('../../shared/src/index.js').UserPrediction> = {}) => ({
    symbol: 'QQQ',
    targetPrice: 620,
    targetDate: '2026-08-15',
    confidence: 2 as const,
    basePrice: 600,
    baseDate: '2026-07-24',
    createdAt: '2026-07-24T20:00:00Z',
    ...over,
  });
  const NOW = '2026-07-24T20:30:00Z';

  it('Richtung + Gewicht aus Ziel vs. Kurs; Mini-Abstände zählen nicht', () => {
    expect(predictionVote(pred(), 600, NOW)).toEqual({ dir: 'buy', weight: 2 });
    expect(predictionVote(pred({ targetPrice: 580, confidence: 3 }), 600, NOW)).toEqual({ dir: 'sell', weight: 3 });
    expect(predictionVote(pred({ targetPrice: 600.5 }), 600, NOW)).toBeNull(); // < ±0,2 %
    expect(predictionVote(undefined, 600, NOW)).toBeNull();
  });

  it('abgelaufene Prognosen zählen nicht (Stichtag inklusiv)', () => {
    expect(predictionVote(pred({ targetDate: '2026-07-23' }), 600, NOW)).toBeNull();
    expect(predictionVote(pred({ targetDate: '2026-07-24' }), 600, NOW)).not.toBeNull();
  });

  it('kippt die Konfluenz-Entscheidung nach der Engine-Regel', () => {
    const base = { direction: 'hold' as const, buyVotes: 1, sellVotes: 0, requiredConfluence: 2 };
    // +2 buy → 3 ≥ 2 und > 0 → buy
    expect(applyPredictionVote(base, { dir: 'buy', weight: 2 })).toBe('buy');
    // Gegenstimme reicht nicht für sell (1 < 2) → hold
    expect(applyPredictionVote(base, { dir: 'sell', weight: 1 })).toBe('hold');
    // Patt bleibt hold: buy 2 vs sell 2
    expect(
      applyPredictionVote({ direction: 'hold', buyVotes: 2, sellVotes: 0, requiredConfluence: 2 }, { dir: 'sell', weight: 2 }),
    ).toBe('hold');
    // ohne Stimme bleibt die Engine-Entscheidung
    expect(applyPredictionVote({ ...base, direction: 'sell' }, null)).toBe('sell');
  });
});

/**
 * Mindest-Haltedauer (Owner-Auswertung 27.07.).
 *
 * Zwei Testkonten zeigten Ø-Gewinne von 0,49 % und Ø-Verluste von 0,36 % —
 * beide weit unter Stop (1,5 %) und Take-Profit (3 %). Praktisch KEIN Trade
 * erreichte seine Risiko-Marken; alle starben am Signal-Ausstieg. Bei 0,30 %
 * Roundtrip-Kosten fraß die Reibung 54 % bzw. 86 % des Verlusts.
 */
describe('minHoldActive', () => {
  const now = new Date('2026-07-27T15:00:00.000Z');

  it('bremst den Ausstieg innerhalb der Haltedauer', () => {
    expect(minHoldActive('2026-07-27T14:30:00.000Z', now, 60)).toBe(true);
  });

  it('lässt ihn nach Ablauf durch', () => {
    expect(minHoldActive('2026-07-27T13:30:00.000Z', now, 60)).toBe(false);
    expect(minHoldActive('2026-07-27T14:00:00.000Z', now, 60)).toBe(false); // exakt 60 min
  });

  it('ist mit 0 Minuten abgeschaltet — Verhalten wie vorher', () => {
    expect(minHoldActive('2026-07-27T14:59:59.000Z', now, 0)).toBe(false);
  });

  it('bremst nichts, wenn der Eröffnungszeitpunkt fehlt oder kaputt ist', () => {
    // Altbestand ohne openedAt darf nicht plötzlich unverkäuflich werden.
    expect(minHoldActive(undefined, now, 60)).toBe(false);
    expect(minHoldActive('kein Datum', now, 60)).toBe(false);
    expect(minHoldActive('2026-07-27T14:30:00.000Z', now, Number.NaN)).toBe(false);
  });
});

describe('Standardwerte nach der Kosten-Auswertung', () => {
  it('verlangt zum Ausstieg MEHR Konfluenz als zum Einstieg (Exit-Umbau 09.08.)', () => {
    // 1 (bis 30.07.) → 2 → 3. Bei 2 war der Ausstieg genauso leicht wie der
    // Einstieg: Dieselben zwei Stimmen, die eine Position eröffnen, schlossen
    // sie wieder. Ergebnis in 317 Trades: 86,8 % starben am Signal, mit
    // 26,9 % Trefferquote. Jetzt bekommt die Position den Zweifel.
    expect(DEFAULT_STRATEGY.signals.exitConfluence).toBe(3);
    expect(DEFAULT_STRATEGY.signals.exitConfluence).toBeGreaterThan(
      DEFAULT_STRATEGY.signals.minConfluence,
    );
  });

  it('hält Positionen mindestens einen TAG (Exit-Umbau 09.08.)', () => {
    // 60 min waren bei `timeframe: 'daily'` fast nichts — ein Tagessignal
    // wurde widerrufen, bevor es sich zeigen konnte. Der Cooldown bleibt bei
    // 60: Er schützt vor sofortigem Wiedereinstieg, nicht vor zu frühem
    // Ausstieg, und diese beiden Fragen sind verschieden.
    expect(DEFAULT_STRATEGY.engine.minHoldMin).toBe(1440);
    expect(DEFAULT_STRATEGY.engine.cooldownMin).toBe(60);
  });

  it('lässt die Halte-Obergrenze bei 0 — sie würde alte Positionen schlagartig schließen', () => {
    expect(DEFAULT_STRATEGY.engine.maxHoldDays).toBe(0);
  });

  it('lässt Stop und Take unangetastet — das Sicherheitsnetz bleibt scharf', () => {
    expect(DEFAULT_STRATEGY.engine.stopLossPct).toBe(2);
    expect(DEFAULT_STRATEGY.engine.takeProfitPct).toBe(4);
    expect(DEFAULT_STRATEGY.engine.trailingStopPct).toBe(3);
  });
});

/* ── Positionslimit + Hebel in der Risiko-Hülle (28.07.) ────────────────── */

describe('maxOpenPositions: konfigurierbar, aber geklemmt', () => {
  const mit = (v: number | undefined): Strategy => {
    const s = structuredClone(DEFAULT_STRATEGY);
    if (v === undefined) delete s.engine.maxOpenPositions;
    else s.engine.maxOpenPositions = v;
    return s;
  };

  it('fehlender Wert ⇒ bisheriges Verhalten (10)', () => {
    expect(maxOpenPositions(mit(undefined))).toBe(DEFAULT_MAX_OPEN_POSITIONS);
  });

  it('ein gesetzter Wert gilt', () => {
    expect(maxOpenPositions(mit(3))).toBe(3);
    expect(maxOpenPositions(mit(25))).toBe(25);
  });

  it('über der Obergrenze wird geklemmt', () => {
    expect(maxOpenPositions(mit(999))).toBe(MAX_OPEN_POSITIONS_CAP);
  });

  it('0 oder negativ ⇒ mindestens 1 (nie „handelt gar nicht mehr")', () => {
    expect(maxOpenPositions(mit(0))).toBe(1);
    expect(maxOpenPositions(mit(-5))).toBe(1);
  });

  it('Bruchzahlen werden abgerundet, Unsinn fällt auf den Default', () => {
    expect(maxOpenPositions(mit(4.9))).toBe(4);
    expect(maxOpenPositions(mit(Number.NaN))).toBe(DEFAULT_MAX_OPEN_POSITIONS);
  });

  it('clampStrategyRisk schreibt den geklemmten Wert fest', () => {
    expect(clampStrategyRisk(mit(999)).engine.maxOpenPositions).toBe(MAX_OPEN_POSITIONS_CAP);
  });
});

describe('clampLeverage: im Zweifel kein Hebel', () => {
  it('fehlend, 1 oder kleiner ⇒ 1', () => {
    expect(clampLeverage(undefined)).toBe(1);
    expect(clampLeverage(1)).toBe(1);
    expect(clampLeverage(0)).toBe(1);
    expect(clampLeverage(-3)).toBe(1);
  });

  it('gültige Werte bleiben stehen', () => {
    expect(clampLeverage(2)).toBe(2);
    expect(clampLeverage(MAX_LEVERAGE)).toBe(MAX_LEVERAGE);
  });

  it('zu viel wird auf das Maximum geklemmt', () => {
    expect(clampLeverage(50)).toBe(MAX_LEVERAGE);
  });

  it('Unsinn ergibt 1, NICHT das Maximum', () => {
    // Die Richtung ist der ganze Punkt: Ein kaputter Wert darf nie in
    // mehr Risiko münden.
    expect(clampLeverage(Number.NaN)).toBe(1);
    expect(clampLeverage(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('der Standard ist hebelfrei', () => {
    expect(clampStrategyRisk(structuredClone(DEFAULT_STRATEGY)).broker.leverage).toBe(1);
  });
});
