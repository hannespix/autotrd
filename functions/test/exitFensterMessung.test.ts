/**
 * Exit-Umbau messbar machen (Task 115): 7-Tage-Fenster der Exit-Verteilung.
 *
 * Der Befund: `trading.verdict` urteilte über die KUMULATIVE Verteilung
 * aller Trades. Nach 356 Alt-Trades kann der Exit-Umbau vom 09.08. dort
 * rechnerisch erst nach Wochen sichtbar werden — bis dahin stünde „81 %
 * enden am Signal" als scheinbare Widerlegung eines Umbaus da, den die
 * Zahl gar nicht misst. Hier steht beides: die pure Fenster-Logik und die
 * Verdrahtung in snapshotEquity (ohne die die Funktionen tote Helfer wären).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  aggregateTradingHealth,
  EXIT_FENSTER_MIN_TRADES,
  EXIT_FENSTER_TAGE,
  exitBreakdownSeit,
  tradingVerdict,
  type AccountContribution,
} from '../../shared/src/index.js';

const hier = dirname(fileURLToPath(import.meta.url));
const snapshot = readFileSync(join(hier, '../src/scheduled/snapshotEquity.ts'), 'utf8');

const SEIT = '2026-08-06T14:00:00.000Z';

describe('exitBreakdownSeit — die pure Fenster-Logik', () => {
  it('zählt nur Trades ab der Fenstergrenze (Grenze einschließlich)', () => {
    const out = exitBreakdownSeit(
      [
        { symbol: 'A', pnl: 10, at: '2026-08-01T00:00:00.000Z' }, // davor
        { symbol: 'B', pnl: -5, at: SEIT }, // exakt auf der Grenze
        { symbol: 'C', pnl: 7, at: '2026-08-12T00:00:00.000Z', riskExit: 'take_profit' },
      ],
      SEIT,
    );
    expect(out['signal']).toEqual({ n: 1, pnl: -5, wins: 0 });
    expect(out['take_profit']).toEqual({ n: 1, pnl: 7, wins: 1 });
  });

  it('Trades ohne Zeitstempel fallen heraus, statt einem Fenster zugeschlagen zu werden', () => {
    const out = exitBreakdownSeit([{ symbol: 'A', pnl: 10 }], SEIT);
    expect(Object.keys(out)).toHaveLength(0);
  });
});

/** Beitrag mit steuerbarer kumulativer und 7-Tage-Verteilung. */
function beitrag(
  exits: Record<string, { n: number; pnl: number; wins: number }>,
  exits7t: Record<string, { n: number; pnl: number; wins: number }>,
): AccountContribution {
  const n = Object.values(exits).reduce((a, b) => a + b.n, 0);
  return { stats: { n, wins: Math.round(n * 0.4) }, exits, exits7t };
}

describe('aggregateTradingHealth — trägt das Fenster durch', () => {
  it('exits7t und trades7t stehen im Gesamtbild', () => {
    const h = aggregateTradingHealth([
      beitrag(
        { signal: { n: 81, pnl: -100, wins: 20 }, stop_loss: { n: 19, pnl: -50, wins: 0 } },
        { signal: { n: 4, pnl: -4, wins: 1 }, take_profit: { n: 8, pnl: 40, wins: 8 } },
      ),
    ]);
    expect(h.trades7t).toBe(12);
    expect(h.exits7t['signal']?.share).toBeCloseTo(4 / 12, 3);
    // Die kumulative Sicht bleibt unverändert daneben stehen.
    expect(h.exits['signal']?.share).toBeCloseTo(0.81, 3);
  });
});

describe('tradingVerdict — urteilt über das Fenster, nicht über die Geschichte', () => {
  const kumulativ81 = { signal: { n: 81, pnl: -100, wins: 20 }, stop_loss: { n: 19, pnl: -50, wins: 0 } };

  it('genug frische Trades + gesunde Fenster-Verteilung ⇒ das alte 81-%-Urteil verschwindet', () => {
    const h = aggregateTradingHealth([
      beitrag(kumulativ81, {
        signal: { n: 4, pnl: -4, wins: 1 },
        take_profit: { n: 8, pnl: 40, wins: 8 },
      }),
    ]);
    expect(h.trades7t).toBeGreaterThanOrEqual(EXIT_FENSTER_MIN_TRADES);
    expect(tradingVerdict(h)).not.toContain('enden am Signal');
  });

  it('genug frische Trades + weiter >80 % Signal ⇒ das Urteil nennt das Fenster', () => {
    const h = aggregateTradingHealth([
      beitrag(kumulativ81, {
        signal: { n: 11, pnl: -20, wins: 2 },
        take_profit: { n: 1, pnl: 5, wins: 1 },
      }),
    ]);
    expect(tradingVerdict(h)).toContain('der letzten 7 Tage');
  });

  it('zu wenige frische Trades ⇒ kumulative Sicht wie bisher (3 Trades sind keine Verteilung)', () => {
    const h = aggregateTradingHealth([
      beitrag(kumulativ81, { take_profit: { n: 3, pnl: 15, wins: 3 } }),
    ]);
    expect(h.trades7t).toBeLessThan(EXIT_FENSTER_MIN_TRADES);
    const urteil = tradingVerdict(h);
    expect(urteil).toContain('81 % der Trades enden am Signal');
    expect(urteil).not.toContain('der letzten 7 Tage');
  });
});

describe('snapshotEquity — die Verdrahtung (Quelltext-Wächter)', () => {
  it('der Schlusszeitpunkt wandert in die ClosedTrades', () => {
    expect(snapshot).toContain("...(typeof at === 'string' ? { at } : {})");
  });

  it('der Feldname passt zur Buchung: executedAt, nicht at (Befund 14.08.)', () => {
    // Die erste Fassung las `t.get('at')` — den Namen des ClosedTrade-FELDS,
    // nicht des Trade-Dokuments (broker.ts schreibt `executedAt`). Ergebnis:
    // trades7t blieb strukturell 0, obwohl am 14.08. sechs frische Abschlüsse
    // die Kumulativ-Zahlen bewegten (PF 0,96→1,18). Beide Seiten gepinnt:
    expect(snapshot).toContain("const at = t.get('executedAt') as string | undefined;");
    expect(snapshot).not.toContain("t.get('at')");
    const broker = readFileSync(join(hier, '../src/core/broker.ts'), 'utf8');
    expect(broker).toContain('executedAt: now,');
  });

  it('das Fenster wird EINMAL je Lauf gerechnet und je Konto angewandt', () => {
    expect(snapshot).toContain('EXIT_FENSTER_TAGE * 24 * 60 * 60 * 1000');
    expect(snapshot).toContain('exitBreakdownSeit(closed, fensterSeit)');
  });

  it('Fenster-Verteilung erreicht Konto-Stats, Aggregat-Beitrag und meta/health', () => {
    // Konto-Stats + health tragen beide den seit-Stempel — eine Fensterzahl
    // ohne Fenstergrenze wäre nicht interpretierbar.
    const stellen = snapshot.match(/exits7tSeit: fensterSeit/g) ?? [];
    expect(stellen).toHaveLength(2);
    // Beitrag zum Aggregat: exits7t neben exits.
    const beitragBlock = snapshot.slice(snapshot.indexOf('beitraege.push'));
    expect(beitragBlock.slice(0, 400)).toContain('exits7t,');
  });

  it('das Fenster ist 7 Tage', () => {
    expect(EXIT_FENSTER_TAGE).toBe(7);
  });
});
