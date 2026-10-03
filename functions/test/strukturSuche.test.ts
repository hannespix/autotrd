/**
 * Struktursuche-Anbindung (MO Teil 2 Schritt 3) — die puren Teile:
 * Renditen-Ausleitung des Backtests, 1/N-Portfolio-Schnitt, Spec-Bewertung
 * über Walk-Forward-Fenster, deterministische Mutations-Kette — und der
 * Abnahme-Fall des Milestones: Ein Kandidat, der im Suchfenster glänzt und
 * im Testfenster verliert, wird NICHT befördert.
 */
import { describe, expect, it } from 'vitest';
import {
  WALK_FORWARD_WARMUP,
  beurteileBefoerderung,
  teileWalkForward,
  type StrategySpec,
} from '../../shared/src/index.js';
import { backtestSpec, type BacktestBar } from '../src/core/backtest.js';
import { bewerteSpec, mittleRenditen, naechsteMutation } from '../src/scheduled/strukturSuche.js';

/** Immer investiert: Kauf sobald es einen Preis gibt, Verkauf nie. */
const immerLong: StrategySpec = {
  buy: { type: 'compare', left: 'price', op: 'gt', right: 0 },
  sell: { type: 'compare', left: 'price', op: 'lt', right: 0 },
};

const tag = (i: number): string =>
  new Date(Date.parse('2023-01-02T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10);

/** n Bars mit Tagesfaktor `drift` (+ leichtem Wobble, damit sd > 0). */
function serie(n: number, drift: number, start = 100, offset = 0): BacktestBar[] {
  const bars: BacktestBar[] = [];
  let close = start;
  for (let i = 0; i < n; i++) {
    close *= drift * (1 + 0.0012 * Math.sin(i * 1.7));
    bars.push({ date: tag(offset + i), close: Math.round(close * 100) / 100 });
  }
  return bars;
}

describe('backtestSpec mitRenditen', () => {
  it('liefert bar-alignierte Renditen: Warmup exakt 0, Einstiegs-Gebühr sichtbar', () => {
    const bars = serie(60, 1); // flache Serie: nur die Gebühr bewegt die Equity
    const r = backtestSpec(immerLong, bars, { mitRenditen: true });
    expect(r.renditen).toBeDefined();
    expect(r.renditen!.length).toBe(bars.length - 1);
    // Vor dem Warmup kann nichts handeln — Übergänge sind exakt 0
    for (let i = 0; i < 24; i++) expect(r.renditen![i]).toBe(0);
    // Der Einstieg an Bar 26 kostet Gebühr + Slippage → negativer Übergang 25→26
    expect(r.renditen![25]).toBeLessThan(0);
    // Rekonstruktion: Produkt aller (1+r) ergibt die End-Equity
    const equity = r.renditen!.reduce((e, x) => e * (1 + x), 10_000);
    expect(equity).toBeCloseTo(r.finalEquity, 0);
  });

  it('ohne die Option bleibt das Ergebnis unverändert schlank', () => {
    const r = backtestSpec(immerLong, serie(60, 1));
    expect(r.renditen).toBeUndefined();
  });
});

describe('mittleRenditen', () => {
  it('mittelt je Datum über die verfügbaren Symbole und sortiert chronologisch', () => {
    const gemittelt = mittleRenditen([
      [
        { date: '2024-01-03', r: 0.02 },
        { date: '2024-01-02', r: 0.01 },
      ],
      [{ date: '2024-01-03', r: -0.01 }],
    ]);
    // 02.: nur Symbol A (0.01) · 03.: Schnitt aus 0.02 und −0.01
    expect(gemittelt).toEqual([0.01, 0.005]);
  });
});

describe('bewerteSpec', () => {
  it('steigende Serie: immer-long verdient in Suche UND Test', () => {
    const bars = new Map([['AAPL', serie(400, 1.002)]]);
    const bew = bewerteSpec(immerLong, bars);
    expect(bew).not.toBeNull();
    expect(bew!.suchSharpe).not.toBeNull();
    expect(bew!.suchSharpe!).toBeGreaterThan(0);
    expect(bew!.testSharpe!).toBeGreaterThan(0);
    // Fensterlängen: 400 Bars → Suche 280, Test 120 (+ Warmup-Vorlauf)
    expect(bew!.suchRenditen.length).toBe(280 - WALK_FORWARD_WARMUP);
    expect(bew!.testRenditen.length).toBe(120);
  });

  it('zu kurze Serien tragen kein Urteil (null statt Würfeln)', () => {
    expect(bewerteSpec(immerLong, new Map([['X', serie(150, 1.001)]]))).toBeNull();
    expect(teileWalkForward(serie(150, 1.001))).toBeNull();
  });

  it('ABNAHME: Suchsieger mit Walk-Forward-Verlust wird NICHT befördert', () => {
    // Suchfenster steigt (immer-long glänzt), Testfenster fällt.
    const auf = serie(280, 1.003);
    const ab = serie(120, 0.997, auf[auf.length - 1]!.close, 280);
    const bars = new Map([['QQQ', [...auf, ...ab]]]);
    const bew = bewerteSpec(immerLong, bars);
    expect(bew).not.toBeNull();
    expect(bew!.suchSharpe!).toBeGreaterThan(0); // im Suchfenster ein „Sieger“
    expect(bew!.testSharpe!).toBeLessThan(0); // danach nur auswendig gelernt
    const urteil = beurteileBefoerderung({
      suchRenditen: bew!.suchRenditen,
      testRenditen: bew!.testRenditen,
      nVersuche: 5,
    });
    expect(urteil.befoerdern).toBe(false);
    expect(urteil.gruende.some((g) => g.includes('Walk-Forward'))).toBe(true);
  });
});

describe('naechsteMutation', () => {
  const spec: StrategySpec = {
    buy: {
      type: 'all',
      children: [
        { type: 'compare', left: 'rsi', op: 'lt', right: 30 },
        { type: 'compare', left: 'macdHistogram', op: 'gt', right: 0 },
      ],
    },
    sell: { type: 'compare', left: 'rsi', op: 'gt', right: 70 },
  };

  it('ist deterministisch und rückt den Seed-Zähler vor', () => {
    const a = naechsteMutation(spec, 0);
    const b = naechsteMutation(spec, 0);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.erg.beschreibung).toBe(b!.erg.beschreibung);
    expect(a!.erg.spec).toEqual(b!.erg.spec);
    expect(a!.naechsterSeed).toBeGreaterThan(0);
    // Anderer Startpunkt ⇒ (in aller Regel) anderer Kandidat — vor allem
    // aber: reproduzierbar ohne globalen Zustand.
    const c = naechsteMutation(spec, a!.naechsterSeed);
    expect(c).not.toBeNull();
  });
});
