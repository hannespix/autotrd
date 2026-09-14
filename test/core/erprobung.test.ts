/**
 * Wächter der Papier-Erprobung.
 *
 * Die Stufe ist die einzige im Haus, die einen DURCHGEFALLENEN Kandidaten
 * handeln lässt. Sie ist deshalb nur so viel wert wie ihre drei Sperren:
 * nur Papier, Schalter aus per Vorgabe, und kein Weg in die Live-Reife.
 * Jede dieser Sperren bekommt hier einen Test mit dem Fall, in dem sie
 * Geld kostet.
 */
import { describe, expect, it } from 'vitest';
import { ERPROBUNG_QUELLE, erprobungChoiceFor, erprobungSperre, istErprobung } from '../../src/core/erprobung.ts';
import { assessReadiness } from '../../src/readiness.ts';
import type { ChampionFile, ErprobungEntry } from '../../src/optimize/promote.ts';
import type { Ms, Trade } from '../../src/core/types.ts';

const EINTRAG: ErprobungEntry = {
  version: 1,
  strategy: 'mean_reversion',
  params: { rsiLen: 4 },
  timeframe: 1440,
  score: -0.2,
  failed: ['beats_market', 'fold_concentration'],
  decidedAt: 1,
};

function champion(erprobung: Record<string, ErprobungEntry> = { AAA: EINTRAG }): ChampionFile {
  return { version: 1, updatedAt: 1, symbols: {}, noTrade: { AAA: { reason: 'durchgefallen', decidedAt: 1, bestScore: -0.2 } }, erprobung };
}

const BASIS = { champion: champion(), timeframe: 1440 as const, enabled: true, mode: 'paper' as string | undefined, symbol: 'AAA', alphaLeads: false, basisLeads: false };

describe('Papier-Erprobung — die Sperren', () => {
  it('greift auf Papier mit Schalter an', () => {
    const c = erprobungChoiceFor(BASIS);
    expect(c).not.toBeNull();
    expect(c!.strategyId).toBe('mean_reversion');
    expect(c!.note, 'die Notiz muss sagen, dass der Kandidat durchgefallen ist').toContain('DURCHGEFALLEN');
    expect(c!.note).toContain('beats_market');
  });

  it('LIVE handelt sie NIE — auch nicht mit jedem Schalter an', () => {
    for (const mode of ['live', 'LIVE', 'echt', undefined]) {
      const c = erprobungChoiceFor({ ...BASIS, mode });
      expect(c, `Modus ${String(mode)} darf die Erprobung nicht bekommen`).toBeNull();
    }
    expect(erprobungSperre({ champion: champion(), timeframe: 1440, enabled: true, mode: 'live' })).toContain('ausschließlich für Papier');
  });

  it('der Modus wird VOR dem Schalter geprüft — die Sperre darf nie hinter einer anderen verschwinden', () => {
    const sperre = erprobungSperre({ champion: champion(), timeframe: 1440, enabled: false, mode: 'live' });
    expect(sperre, 'bei live muss der Modus der genannte Grund sein, nicht der Schalter').toContain('Modus');
  });

  it('Schalter aus ⇒ nichts', () => {
    expect(erprobungChoiceFor({ ...BASIS, enabled: false })).toBeNull();
  });

  it('Champion und Basis übersteuert sie nie', () => {
    expect(erprobungChoiceFor({ ...BASIS, alphaLeads: true })).toBeNull();
    expect(erprobungChoiceFor({ ...BASIS, basisLeads: true })).toBeNull();
  });

  it('fremder Zeitrahmen ⇒ nichts (die Parameter wurden für einen anderen gemessen)', () => {
    expect(erprobungChoiceFor({ ...BASIS, timeframe: 60 })).toBeNull();
  });

  it('kein Eintrag für das Symbol ⇒ nichts', () => {
    expect(erprobungChoiceFor({ ...BASIS, symbol: 'ZZZ' })).toBeNull();
  });
});

/* ── Der Weg zu Echtgeld, der nicht entstehen darf ── */

const T = (over: Partial<Trade>): Trade => ({
  symbol: 'AAA',
  side: 'long',
  qty: 1,
  entryTime: 1_000,
  entryPrice: 100,
  exitTime: 2_000,
  exitPrice: 110,
  grossPnl: 10,
  fees: 1,
  netPnl: 9,
  rMultiple: 1,
  exitReason: 'target',
  strategy: 'mean_reversion',
  barsHeld: 3,
  mae: null,
  mfe: null,
  ...over,
});

describe('Papier-Erprobung — kein Weg in die Live-Reife', () => {
  const now: Ms = 10_000;

  it('istErprobung liest die Stufe, nicht die Strategie', () => {
    expect(istErprobung({ stufe: ERPROBUNG_QUELLE })).toBe(true);
    expect(istErprobung({ stufe: 'champion' })).toBe(false);
    expect(istErprobung({}), 'ohne Stufe: Champion-Betrieb, zählt weiter').toBe(false);
  });

  it('readiness schliesst Erprobungs-Trades aus — und sagt es', () => {
    const trades = [...Array(300)].map(() => T({ stufe: ERPROBUNG_QUELLE }));
    const r = assessReadiness(trades, now, { minDays: 0 });
    expect(r.erprobung, '300 Erprobungs-Trades müssen ausgeschlossen sein').toBe(300);
    expect(r.evaluated, 'nichts darf übrig bleiben').toBe(0);
    expect(r.ready, 'aus 300 durchgefallenen Trades darf NIE Live-Reife werden').toBe(false);
    expect(r.summary).toContain('AUSGESCHLOSSEN');
  });

  it('sie verbessern die Reife nicht — dieselbe Lage mit und ohne', () => {
    const echte = [...Array(200)].map(() => T({ stufe: 'champion' }));
    const ohne = assessReadiness(echte, now, { minDays: 0 });
    const mit = assessReadiness([...echte, ...[...Array(500)].map(() => T({ stufe: ERPROBUNG_QUELLE, netPnl: 99, grossPnl: 100 }))], now, { minDays: 0 });
    expect(mit.evaluated, 'die Erprobung darf die Stichprobe nicht aufblähen').toBe(ohne.evaluated);
    expect(mit.checks.map((c) => `${c.name}:${c.pass}`)).toEqual(ohne.checks.map((c) => `${c.name}:${c.pass}`));
  });

  it('sie verschlechtern die Reife auch nicht — weder dafür noch dagegen', () => {
    const echte = [...Array(250)].map(() => T({ stufe: 'champion' }));
    const ohne = assessReadiness(echte, now, { minDays: 0 });
    const mit = assessReadiness([...echte, ...[...Array(400)].map(() => T({ stufe: ERPROBUNG_QUELLE, netPnl: -50, grossPnl: -49, fees: 1 }))], now, { minDays: 0 });
    expect(mit.ready).toBe(ohne.ready);
    expect(mit.maxDrawdown).toBe(ohne.maxDrawdown);
  });

  it('`ignored` bleibt „kaputt", nicht „Erprobung" — zwei Auskünfte, zwei Zähler', () => {
    const kaputt = T({ exitTime: 500, entryTime: 900, stufe: 'champion' });
    const r = assessReadiness([T({ stufe: 'champion' }), T({ stufe: ERPROBUNG_QUELLE }), kaputt], now, { minDays: 0 });
    expect(r.erprobung).toBe(1);
    expect(r.ignored).toBe(1);
    expect(r.evaluated).toBe(1);
  });
});

describe('Papier-Erprobung — die Plattform schliesst denselben Weg', () => {
  it('snapshotEquity zählt Erprobungs-Trades nicht in stats/main (Grundlage von liveGate)', async () => {
    const { readFileSync } = await import('node:fs');
    const code = readFileSync(new URL('../../functions/src/scheduled/snapshotEquity.ts', import.meta.url), 'utf8');
    expect(code, 'ohne diesen Filter bahnt die Erprobung einen Weg zu Echtgeld').toContain('istErprobung(');
  });

  it('der Takt reicht den AUFGELÖSTEN Modus an buildStrategyFor durch', async () => {
    const { readFileSync } = await import('node:fs');
    const code = readFileSync(new URL('../../functions/src/engine/tick.ts', import.meta.url), 'utf8');
    expect(code, 'ohne den Modus kennt die Plattform die einzige Sperre nicht').toMatch(/buildStrategyFor\(\{[^}]*mode:\s*zugang\.verbindung\.mode/s);
  });
});
