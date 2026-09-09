/**
 * Allokations-Sizing der Basis-Stufe — Messung und Handel sind EIN Pfad
 * (CLAUDE.md §0.1, Prüfbefund K4, 09.09.2026).
 *
 * Der Wächter, an dem alles hängt: Die Vorregistrierung V2 hat mit
 * `riskPerTradePct 4` und `stopPct 20` gemessen — Position = 20 % der Equity.
 * Die Basis-Stufe handelt mit `sizing: allocation, positionPct 20`. Beide
 * Wege müssen auf denselben Bars IDENTISCHE Fills liefern (Stückzahl, Kurs,
 * Zeit), sonst sind Messung und Handel zwei Welten. Dazu: Die Deckel des
 * Nutzers können die Position nur verkleinern, nie vergrößern; der Stop
 * bleibt der Katastrophen-Stop der Strategie.
 */
import { describe, expect, it } from 'vitest';
import { simulate, type SimInput } from '../../src/backtest/simulator.ts';
import type { Bar, SizingSpec, Strategy } from '../../src/core/types.ts';
import { baseConfig, barsMap, strategyOf } from './helpers.ts';
import { msFromET, addDays } from '../../src/core/time.ts';

/** Tagesbars (Sitzungseröffnung als Zeitstempel) mit Auf und Ab — Stop 20 % unter dem Einstand wird mal gerissen, mal nicht. */
function tagesbars(closes: readonly number[], vonTag = '2026-01-05'): Bar[] {
  const out: Bar[] = [];
  let day = vonTag;
  for (const c of closes) {
    // Werktage: Samstag/Sonntag überspringen (Handelstage des Fallback-Kalenders)
    for (;;) {
      const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
      if (wd !== 0 && wd !== 6) break;
      day = addDays(day, 1);
    }
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    out.push({ t: msFromET(y, m, d, 9, 30), o: c * 0.995, h: c * 1.01, l: c * 0.985, c, v: 1_000 });
    day = addDays(day, 1);
  }
  return out;
}

/** Steigt an jeder 10. Bar ein (Stop 20 % unter Close, kein Ziel), Exit per Signal 6 Bars später — wie ein weiter Katastrophen-Stop. */
function allokationsStrategie(id = 'alloc'): Strategy {
  return strategyOf({
    id,
    holdsOvernight: true,
    timeframes: [1440],
    decide: (snap) => {
      const c = snap.bars.c[snap.i]!;
      if (!snap.position) return snap.i % 10 === 3 ? { kind: 'enter', side: 'long', stop: c * 0.8, reason: 'test' } : { kind: 'hold' };
      return snap.position.barsHeld >= 6 ? { kind: 'exit', reason: 'test' } : { kind: 'hold' };
    },
  });
}

const closes = Array.from({ length: 120 }, (_, i) => 100 + 15 * Math.sin(i / 7) + (i % 13 === 0 ? -12 : 0));
const bars = barsMap({ AAA: tagesbars(closes), BBB: tagesbars(closes.map((c) => c * 0.7)) });

function lauf(o: { riskPct: number; maxPositionPct: number; sizing?: SizingSpec; maxGrossExposurePct?: number; initialEquity?: number }) {
  const strategy = allokationsStrategie();
  const input: SimInput = {
    bars,
    strategyFor: () => ({ strategy, params: {}, ...(o.sizing ? { sizing: o.sizing } : {}) }),
    config: baseConfig({ timeframe: 1440, risk: { riskPerTradePct: o.riskPct, maxPositionPct: o.maxPositionPct, maxGrossExposurePct: o.maxGrossExposurePct ?? 100, maxPositions: 4 } }),
    initialEquity: o.initialEquity ?? 25_000,
  };
  return simulate(input);
}

describe('Messung = Handel: 4 % Risiko bei 20 % Stop ⇔ Allokation 20 %', () => {
  it('WÄCHTER: identische Trades (Stückzahl, Kurse, Zeiten, Netto) auf denselben Bars', () => {
    // Die Vorregistrierung V2: riskPerTradePct 4, maxPositionPct 25, stopPct 20 ⇒ 20 % der Equity je Position.
    const messung = lauf({ riskPct: 4, maxPositionPct: 25 });
    // Die Basis-Stufe: Allokation 20 %; riskPerTradePct des Nutzers (0,5 %) ist ohne Wirkung.
    const handel = lauf({ riskPct: 0.5, maxPositionPct: 25, sizing: { mode: 'allocation', positionPct: 20 } });
    expect(messung.trades.length, 'Vorbedingung: es wird gehandelt').toBeGreaterThan(4);
    expect(handel.trades).toEqual(messung.trades);
    expect(handel.equity).toEqual(messung.equity);
    expect(handel.finalEquity).toBe(messung.finalEquity);
    // Jede Position ist 20 % der Equity zum Entscheidungs-Close (Ganzstück-Rundung nach unten).
    for (const t of handel.trades) expect(t.qty * t.entryPrice).toBeLessThanOrEqual(0.2 * 25_000 * 1.6);
  });

  it('GEGENPROBE: das Risiko-Budget des Nutzers (0,5 %) allein ergäbe andere, kleinere Positionen', () => {
    const nutzer = lauf({ riskPct: 0.5, maxPositionPct: 25 });
    const handel = lauf({ riskPct: 0.5, maxPositionPct: 25, sizing: { mode: 'allocation', positionPct: 20 } });
    expect(nutzer.trades).not.toEqual(handel.trades);
    const groesse = (r: ReturnType<typeof simulate>) => r.trades.reduce((s, t) => s + t.qty * t.entryPrice, 0) / Math.max(1, r.trades.length);
    expect(groesse(nutzer)).toBeLessThan(groesse(handel) / 4);
  });

  it('WÄCHTER: der Positionsdeckel des Nutzers verkleinert die Allokation — nie umgekehrt', () => {
    const gedeckelt = lauf({ riskPct: 0.5, maxPositionPct: 10, sizing: { mode: 'allocation', positionPct: 20 } });
    const frei = lauf({ riskPct: 0.5, maxPositionPct: 25, sizing: { mode: 'allocation', positionPct: 20 } });
    expect(gedeckelt.trades.length).toBeGreaterThan(0);
    for (let i = 0; i < gedeckelt.trades.length; i++) {
      const g = gedeckelt.trades[i]!;
      const f = frei.trades[i];
      if (!f || f.entryTime !== g.entryTime) break;
      expect(g.qty).toBeLessThanOrEqual(f.qty);
      expect(g.qty).toBeLessThanOrEqual(Math.floor((0.1 * 25_000 * 1.6) / g.entryPrice));
    }
    // Ein Deckel ÜBER der Allokation ändert nichts: 25 % und 100 % Deckel liefern dieselben Trades.
    const weit = lauf({ riskPct: 0.5, maxPositionPct: 100, sizing: { mode: 'allocation', positionPct: 20 } });
    expect(weit.trades).toEqual(frei.trades);
  });

  it('der Stop bleibt der Katastrophen-Stop der Strategie: 20 % unter dem Entscheidungs-Close, kein anderer', () => {
    const handel = lauf({ riskPct: 0.5, maxPositionPct: 25, sizing: { mode: 'allocation', positionPct: 20 } });
    const messung = lauf({ riskPct: 4, maxPositionPct: 25 });
    // R-Multiple bezieht sich in beiden Welten auf denselben Erst-Stop.
    expect(handel.trades.map((t) => t.rMultiple)).toEqual(messung.trades.map((t) => t.rMultiple));
    expect(handel.trades.some((t) => t.exitReason === 'stop'), 'Vorbedingung: mindestens ein Stop-Fill').toBe(true);
  });
});
