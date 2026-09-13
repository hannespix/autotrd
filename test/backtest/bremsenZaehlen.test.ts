/**
 * Der Simulator zählt Notbremsen als FLANKEN, nicht als Zyklen.
 *
 * Warum das der Punkt ist: Ein Drawdown-Halt steht, bis jemand `resume` ruft —
 * über Wochen. Zählte man Zyklen, stünde im Bericht „Notbremse 340×", und die
 * eine Frage, die zählt („hat sie überhaupt je ausgelöst, und wann?"), wäre
 * hinter einer Zahl versteckt, die nur die Haltedauer misst.
 *
 * Der Anlass: Die V3-Auswertung der Basis-Stufe schrieb deren Einbruch der
 * Tagesbremse zu, ohne dass irgendein Bericht sagte, ob je eine ausgelöst hat.
 * Läufe #54 und #55 haben die Zuordnung widerlegt. Diese Zahl existiert, damit
 * so ein Schluss nicht noch einmal drei Tage lang stehen bleibt.
 *
 * Kein Gate liest sie.
 */
import { describe, expect, it } from 'vitest';
import { simulate } from '../../src/backtest/simulator.ts';
import { BarSeries } from '../../src/core/bars.ts';
import { msFromET } from '../../src/core/time.ts';
import type { Bar, BarSeriesLike } from '../../src/core/types.ts';
import { baseConfig, strategyOf } from './helpers.ts';

/** Tagesbars (Mo–Fr): erst flach bei 100, ab Bar `sturzAb` täglich −6 %. */
function tagesBars(n: number, sturzAb: number): BarSeries {
  const bars: Bar[] = [];
  const d = new Date(Date.UTC(2024, 0, 2));
  let k = 0;
  let kurs = 100;
  while (bars.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) {
      if (k >= sturzAb) kurs *= 0.94;
      bars.push({ t: msFromET(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 9, 30), o: kurs, h: kurs, l: kurs, c: kurs, v: 100_000 });
      k++;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return BarSeries.from(bars);
}

/** Kauft an Bar 2 und hält — danach entscheidet nur noch das Konto. */
const kaufeUndHalte = strategyOf({
  id: 'halten',
  holdsOvernight: true,
  warmup: 1,
  timeframes: [1440],
  decide: (snap) => (snap.position === null && snap.i === 2 ? { kind: 'enter', side: 'long', stop: snap.bars.c[snap.i]! * 0.9, reason: 'test' } : { kind: 'hold' }),
});

function lauf(over: NonNullable<Parameters<typeof baseConfig>[0]>['risk'], stufe?: string): ReturnType<typeof simulate> {
  const bars: ReadonlyMap<string, BarSeriesLike> = new Map([['AAA', tagesBars(40, 5)]]);
  return simulate({
    bars,
    strategyFor: () => ({ strategy: kaufeUndHalte, params: {}, ...(stufe ? { stufe } : {}) }),
    config: baseConfig({ timeframe: 1440, risk: { maxPositionPct: 100, ...over } }),
    initialEquity: 100_000,
  });
}

/** Globale Bremse eng, Stufe `basis` locker — die Stufe entscheidet. */
const engGlobalLockereBasis = {
  maxDrawdownPct: 2,
  maxDailyLossPct: 90,
  riskPerTradePct: 5,
  tiers: { alpha: { maxDailyLossPct: null, maxDrawdownPct: null }, basis: { maxDailyLossPct: null, maxDrawdownPct: 80 } },
} as const;

describe('Notbremsen-Bilanz des Simulators', () => {
  it('WÄCHTER: ein Drawdown-Halt, der über viele Zyklen steht, zählt GENAU EINMAL', () => {
    // Risiko 5 % bei 10 % Stop-Distanz ⇒ Position von 50 % der Equity; ein
    // Tag mit −6 % kostet dem Konto 3 % und reisst die Schwelle von 2 %. Der
    // Drawdown-Halt endet nur über `resume` — er steht also bis zum Ende des
    // Laufs, und genau darum geht es hier.
    const r = lauf({ maxDrawdownPct: 2, maxDailyLossPct: 90, riskPerTradePct: 5 });
    const dd = Object.entries(r.bremsen.ausloesungen).filter(([k]) => k.endsWith(':drawdown'));
    expect(dd).toHaveLength(1);
    // DIE Zeile: eine Flanke, nicht ein Zähler je Zyklus im Halt.
    expect(dd[0]![1]).toBe(1);
    expect(r.bremsen.erste).not.toBe(null);
    expect(r.bremsen.letzte).toBe(r.bremsen.erste);
  });

  it('WÄCHTER: ohne Auslösung ist die Bilanz leer — und genau das ist die Aussage', () => {
    const r = lauf({ maxDrawdownPct: 90, maxDailyLossPct: 90, riskPerTradePct: 5 });
    expect(r.bremsen.ausloesungen).toEqual({});
    expect(r.bremsen.erste).toBe(null);
    expect(r.bremsen.letzte).toBe(null);
  });

  it('der Zeitpunkt der Auslösung liegt im Lauf, nicht davor oder danach', () => {
    const r = lauf({ maxDrawdownPct: 2, maxDailyLossPct: 90, riskPerTradePct: 5 });
    const erste = r.bremsen.erste!;
    const anfang = r.equity[0]!.t;
    const ende = r.equity[r.equity.length - 1]!.t;
    expect(erste).toBeGreaterThanOrEqual(anfang);
    expect(erste).toBeLessThanOrEqual(ende);
  });
});

describe('Stufe der Wahl erreicht die Notbremse', () => {
  /*
   * DER Wächter für den Fehler, der Lauf #54 wertlos gemacht hat:
   * `WindowSimArgs` reichte keine Stufe durch, jede Position des Optimierers
   * lief als `other`, und `grenzenFuer(risk, 'other')` liefert die GLOBALEN
   * Werte. `risk.tiers.basis` erreichte die Messung nie — sichtbar erst an
   * der Notbremsen-Bilanz (V3 `konto:daily_loss`, V4 `other:daily_loss`,
   * dieselben drei Tage).
   */
  it('WÄCHTER: mit Stufe `basis` gilt die Latte der Stufe — die Bremse löst NICHT aus', () => {
    const r = lauf(engGlobalLockereBasis, 'basis');
    // Drawdown-Latte der Stufe ist 80 %, die globale 2 %. Trägt die Position
    // die Stufe, passiert nichts.
    expect(Object.keys(r.bremsen.ausloesungen)).toEqual([]);
  });

  it('WÄCHTER: OHNE Stufe fällt dieselbe Welt auf `other` zurück — und `other` erbt die globalen 2 %', () => {
    const r = lauf(engGlobalLockereBasis);
    const schluessel = Object.keys(r.bremsen.ausloesungen);
    expect(schluessel).toContain('other:drawdown');
    expect(schluessel).not.toContain('basis:drawdown');
    // Das ist der stille Rückfall: kein Fehler, keine Warnung — nur die alte
    // Schwelle unter einem anderen Namen.
  });
});
