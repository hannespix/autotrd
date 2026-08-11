/**
 * Audit-Befund 11.08.: Der Backtest konnte keine Shorts, die Live-Engine schon.
 *
 * ── Was das bedeutet hat ──────────────────────────────────────────────────
 *
 * `backtestSpec` verwarf ein `sell`-Signal, wenn keine Position offen war
 * (`shares > 0` als Bedingung). Die Live-Engine eröffnet daraus bei
 * `broker.allowShort` einen Short. Wer im Studio eine Strategie mit
 * Short-Regeln baute und backtestete, bekam eine Bewertung, die nur die
 * Kaufseite maß — ohne Hinweis.
 *
 * Die Richtung ist nicht neutral: Die Katalog-Messung vom 10.08. zeigt
 * Verkaufssignale bei jeder Haltedauer über einem Tag im Minus (−0,78 % auf
 * zehn Tage). Der Backtest zeigte also systematisch die BESSERE Hälfte.
 *
 * ── Warum opt-in ──────────────────────────────────────────────────────────
 *
 * Der Backtest ist ein Port der Referenz-Implementierung und hat einen
 * Paritätstest gegen sie. Ohne `allowShort` muss er sich Bar für Bar
 * verhalten wie vorher — sonst tauscht der Fix einen stillen Fehler gegen
 * einen anderen.
 */
import { describe, expect, it } from 'vitest';
import { backtestSpec, type BacktestBar } from '../src/core/backtest.js';
import type { StrategySpec } from '../../shared/src/index.js';

/** Genug Bars für den MACD-Warmup (26), danach der eigentliche Verlauf. */
function bars(verlauf: number[]): BacktestBar[] {
  const alle = [...Array.from({ length: 30 }, () => 100), ...verlauf];
  return alle.map((close, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    close,
  }));
}

/** Regelbaum, der ab einem Schwellenkurs kauft bzw. verkauft. */
const spec = (kaufUnter: number, verkaufUeber: number): StrategySpec => ({
  buy: { type: 'compare', left: 'price', op: 'lt', right: kaufUnter },
  sell: { type: 'compare', left: 'price', op: 'gt', right: verkaufUeber },
});

describe('Ohne allowShort bleibt alles wie vorher', () => {
  it('ein Verkaufssignal ohne Position löst KEINEN Trade aus', () => {
    // Kurse steigen — die Verkaufsregel feuert dauernd, die Kaufregel nie.
    const r = backtestSpec(spec(50, 105), bars([110, 120, 130, 140]));
    expect(r.numTrades).toBe(0);
    expect(r.finalEquity).toBe(10_000);
  });

  it('und die Equity-Kurve bleibt flach', () => {
    const r = backtestSpec(spec(50, 105), bars([110, 120, 130]));
    expect(new Set(r.equityCurve.map((p) => p.value))).toEqual(new Set([10_000]));
  });
});

describe('Mit allowShort wird die andere Hälfte bewertet', () => {
  it('ein Verkaufssignal ohne Position eröffnet einen Short', () => {
    const r = backtestSpec(spec(50, 105), bars([110, 120, 130, 140]), { allowShort: true });
    expect(r.numTrades).toBe(1);
  });

  it('ein fallender Kurs nach dem Short ergibt GEWINN', () => {
    // Short bei 110, Ende bei 90 — der Short verdient am Rückgang.
    const r = backtestSpec(spec(50, 105), bars([110, 105, 95, 90]), { allowShort: true });
    expect(r.trades[0]?.pnl).toBeGreaterThan(0);
    expect(r.finalEquity).toBeGreaterThan(10_000);
  });

  it('ein steigender Kurs nach dem Short ergibt VERLUST', () => {
    // Genau der Fall, den der alte Backtest verschwieg: Die Strategie
    // verliert, und das Ergebnis sah aus wie „keine Trades, kein Verlust".
    const r = backtestSpec(spec(50, 105), bars([110, 130, 150, 170]), { allowShort: true });
    expect(r.trades[0]?.pnl).toBeLessThan(0);
    expect(r.finalEquity).toBeLessThan(10_000);
  });

  it('ein Kaufsignal deckt den Short ein — und dreht dann auf Long', () => {
    // Erst über 105 (Short), dann unter 50: Das Kaufsignal deckt ein UND
    // eröffnet im Folge-Bar einen Long, der am Ende glattgestellt wird.
    // Zwei Trades sind hier richtig, nicht einer — dasselbe täte die
    // Live-Engine, weil `buy` nach dem Cover weiter feuert.
    const r = backtestSpec(spec(50, 105), bars([110, 120, 40, 45, 48]), { allowShort: true });
    expect(r.numTrades).toBe(2);
    // Der SHORT hat verdient: eröffnet bei 110, gedeckt bei 40.
    expect(r.trades[0]?.pnl).toBeGreaterThan(0);
  });

  it('der offene Short wird am Ende glattgestellt, nicht verschluckt', () => {
    const r = backtestSpec(spec(50, 105), bars([110, 120]), { allowShort: true });
    expect(r.numTrades).toBe(1);
    expect(r.trades[0]?.exitDate).toBe(r.equityCurve[r.equityCurve.length - 1]?.date);
  });

  it('die Equity-Kurve bewegt sich während des Shorts', () => {
    // Sonst wäre der Verlust erst beim Glattstellen sichtbar, und der
    // Max-Drawdown — die wichtigste Risikozahl — bliebe bei null.
    //
    // Der Wert ist beachtlich und richtig: Ein ungehebelter Short bei 110,
    // der bis 200 läuft, kostet rund 80 % des Kontos. Genau diese Zahl hat
    // der alte Backtest nie gezeigt — er meldete „keine Trades".
    const r = backtestSpec(spec(50, 105), bars([110, 140, 170, 200]), { allowShort: true });
    expect(r.maxDrawdownPct).toBeLessThan(-50);
  });

  it('und bewertet den Short als Margin plus Gewinn, nicht als negative Stückzahl', () => {
    /* Der Unterschied, den der Drawdown-Test allein nicht sieht.
     *
     * Naiv gerechnet (`capital + shares * price` mit shares < 0) wäre die
     * Equity während eines Shorts stark NEGATIV — ein Konto mit −12.000 €,
     * das es nie gab. Der Drawdown-Test bestünde trotzdem, er prüft ja nur
     * „stark gefallen". Deshalb hier der Betrag: Ein ungehebelter Short kann
     * höchstens die eingesetzte Margin kosten, die Equity bleibt positiv. */
    const r = backtestSpec(spec(50, 105), bars([110, 140]), { allowShort: true });
    for (const p of r.equityCurve) expect(p.value, `${p.date}`).toBeGreaterThan(0);
  });
});

describe('Position-Regeln sehen den Short', () => {
  it('eine „nur wenn flach"-Regel feuert nicht, während ein Short offen ist', () => {
    // `ctx.position` prüfte `shares > 0` — mit Longs allein gleichbedeutend,
    // mit Shorts falsch: Die Regel hätte eine offene Position als „flach"
    // gelesen und nachgekauft.
    const nurWennFlach: StrategySpec = {
      buy: {
        type: 'all',
        children: [
          { type: 'compare', left: 'price', op: 'lt', right: 100 },
          { type: 'position', state: 'none' },
        ],
      },
      sell: { type: 'compare', left: 'price', op: 'gt', right: 105 },
    };
    /* Der Verlauf ist so gewählt, dass er die zwei Fälle TRENNT.
     *
     * 110 eröffnet den Short. Danach fällt der Kurs unter 100, die
     * Preis-Bedingung der Kaufregel ist erfüllt — es hängt allein an
     * `position: none`, ob sie feuert. Meldet der Kontext den Short
     * fälschlich als „flach", deckt die Regel ein und eröffnet gleich darauf
     * einen Long: zwei Trades statt einem. */
    const r = backtestSpec(nurWennFlach, bars([110, 95, 90, 85]), { allowShort: true });
    expect(r.numTrades).toBe(1);
    // Und der eine Trade ist der Short, der bis zum Schluss lief.
    expect(r.trades[0]?.exitDate).toBe(r.equityCurve[r.equityCurve.length - 1]?.date);
  });
});
