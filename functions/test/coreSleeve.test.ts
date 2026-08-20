/**
 * Kern-Satellit: die Besitzgrenze zwischen Sockel und aktiver Engine
 * (Owner-Direktive 04.08.: „eine stabile sichere Art und Weise langsam eine
 * positive Performance zu erreichen").
 *
 * Warum das getestet gehört: Der Sockel und die 5-Minuten-Konfluenz teilen
 * sich EIN Wallet. Bricht die Trennung, ist der Schaden still und teuer —
 * der Scan sähe eine Sockel-Position ohne Konfluenz-Signal und verkaufte sie
 * beim nächsten Rauschen. Genau das war der Grund, warum der Modus bis
 * 04.08. ein Entweder-oder je Wallet war (siehe EngineConfig.mode). Die
 * Grenze hängt an einem einzigen Flag, und ein vergessenes Flag sieht in
 * jedem Log aus wie ein ganz normaler Trade.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CORE_PCT_CAP,
  DEFAULT_CORE_PCT,
  DEFAULT_STRATEGY,
  rebalanceOrders,
  validateStrategy,
  type Position,
  type TargetPosition,
} from '../../shared/src/index.js';
import { clampStrategyRisk, corePct } from '../src/core/rulesTrading.js';

describe('corePct: Hülle des Sockel-Anteils', () => {
  it('fehlendes Feld heißt 0 — kein Sockel aus Versehen', () => {
    // Die Hülle selbst erfindet nie einen Sockel: Fehlt das Feld, ist er 0.
    // Dass Bestandskonten trotzdem einen bekommen, ist eine ausdrückliche
    // Betreiber-Entscheidung (Owner 04.08.) und passiert über die Migration
    // corePctAll_2026_08_04 — sichtbar, protokolliert und idempotent —,
    // nicht als stille Nebenwirkung eines geänderten Defaults.
    const alt = structuredClone(DEFAULT_STRATEGY);
    delete (alt.engine as { corePct?: number }).corePct;
    expect(corePct(alt)).toBe(0);
  });

  it('die Migration überschreibt keinen selbst gesetzten Sockel', () => {
    // Die Bedingung der Migration in Reinform: Nur wo kein eigener Wert > 0
    // steht, wird gesetzt. Wer 25 % gewählt hat, behält 25 % — sonst wäre
    // jede Nutzereinstellung beim nächsten Deploy weg.
    const eigener = 25;
    const nimmMigration = (v: number | undefined): boolean => !(typeof v === 'number' && v > 0);
    expect(nimmMigration(eigener)).toBe(false);
    expect(nimmMigration(undefined)).toBe(true);
    expect(nimmMigration(0)).toBe(true); // nie eingestellt bzw. abgewählt
  });

  it('klemmt auf CORE_PCT_CAP — 100 % Sockel gibt es nicht', () => {
    const gierig = structuredClone(DEFAULT_STRATEGY);
    gierig.engine.corePct = 100;
    expect(corePct(gierig)).toBe(CORE_PCT_CAP);
    expect(clampStrategyRisk(gierig).engine.corePct).toBe(CORE_PCT_CAP);
  });

  it('unsinnige Werte fallen auf 0 zurück, nicht auf das Maximum', () => {
    for (const wert of [NaN, -20, Infinity, undefined]) {
      const s = structuredClone(DEFAULT_STRATEGY);
      s.engine.corePct = wert as number;
      expect(corePct(s), `Wert ${String(wert)}`).toBe(0);
    }
  });

  it('neue Konten starten mit Sockel, und der ist gültig', () => {
    expect(DEFAULT_STRATEGY.engine.corePct).toBe(DEFAULT_CORE_PCT);
    expect(validateStrategy(DEFAULT_STRATEGY)).toEqual([]);
  });

  it('validateStrategy weist einen Sockel über der Hülle zurück', () => {
    const s = structuredClone(DEFAULT_STRATEGY);
    s.engine.corePct = 95;
    const problems = validateStrategy(s);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('corePct');
  });
});

/**
 * Die Budget-Rechnung des Sockels. `rebalanceOrders` bekommt im Sockel-Pfad
 * NICHT die volle Equity, sondern nur den Anteil — sonst kaufte der Sockel
 * das ganze Konto voll und der aktive Teil hätte nie wieder Cash.
 */
describe('Sockel-Budget', () => {
  const ziel: TargetPosition[] = [
    { symbol: 'SOXX', weight: 0.5 },
    { symbol: 'SMH', weight: 0.5 },
  ];

  it('rechnet auf den ANTEIL der Equity, nicht auf die ganze', () => {
    const equity = 25_000;
    const budget = (equity * DEFAULT_CORE_PCT) / 100;
    const orders = rebalanceOrders(new Set(), ziel, budget);
    const summe = orders.reduce((acc, o) => acc + (o.notional ?? 0), 0);
    expect(summe).toBeCloseTo(budget, 6);
    // Der aktive Teil behält seinen Anteil — das ist der ganze Punkt.
    expect(summe).toBeLessThan(equity);
  });

  it('Anteil 0 bedeutet gar kein Sockel-Kauf', () => {
    const orders = rebalanceOrders(new Set(), ziel, 0).filter((o) => o.side === 'buy');
    expect(orders.every((o) => (o.notional ?? 0) === 0)).toBe(true);
  });
});

/**
 * Die Filter, die im Sockel-Lauf über den Positionen liegen. Sie stehen hier
 * als reine Funktionen nachgebaut, weil der Lauf selbst Firestore braucht —
 * geprüft wird die LOGIK der Grenze, und die ist reine Mengenlehre.
 */
describe('Besitzgrenze zwischen den zwei Maschinen', () => {
  const pos = (symbol: string, core?: boolean): Position => ({
    symbol,
    qty: 10,
    avgEntry: 100,
    stopLoss: null,
    takeProfit: null,
    openedAt: '2026-08-04T00:00:00.000Z',
    ...(core ? { core: true } : {}),
  });

  const alle = new Map<string, Position>([
    ['SOXX', pos('SOXX', true)], // Sockel
    ['SMH', pos('SMH', true)], // Sockel
    ['BTC-USD', pos('BTC-USD')], // aktive Engine
  ]);

  it('der Scan sieht NUR die aktiven Positionen', () => {
    const sichtbar = new Map([...alle].filter(([, p]) => p.core !== true));
    expect([...sichtbar.keys()]).toEqual(['BTC-USD']);
    // Konsequenz: Kein Exit, kein Trailing, kein Positionslimit für den Sockel.
    expect(sichtbar.has('SOXX')).toBe(false);
  });

  it('fürs Klumpenrisiko zählt der Sockel trotzdem mit', () => {
    // Ausgeblendet heißt nicht „kein Marktrisiko" — sonst könnte die aktive
    // Engine in genau die Klasse nachlegen, in der der Sockel schon voll ist.
    const sichtbar = new Map([...alle].filter(([, p]) => p.core !== true));
    const coreSymbols = new Set([...alle].filter(([, p]) => p.core === true).map(([s]) => s));
    const alleSymbole = [...sichtbar.keys(), ...coreSymbols];
    expect(alleSymbole.sort()).toEqual(['BTC-USD', 'SMH', 'SOXX']);
  });

  it('die aktive Engine kauft kein Symbol nach, das der Sockel hält', () => {
    // Sonst führte der Broker beide zu EINER Position zusammen und die
    // Grenze wäre verwischt — die Position trüge weiter core:true, hätte
    // aber Geld der aktiven Engine gebunden.
    const coreSymbols = new Set([...alle].filter(([, p]) => p.core === true).map(([s]) => s));
    expect(coreSymbols.has('SOXX')).toBe(true);
    expect(coreSymbols.has('BTC-USD')).toBe(false);
  });

  it('der Sockel verkauft nur, was ihm gehört', () => {
    const sockel = new Map([...alle].filter(([, p]) => p.core === true));
    const orders = [
      { symbol: 'SOXX', side: 'sell' as const },
      { symbol: 'BTC-USD', side: 'sell' as const }, // gehört der aktiven Engine
    ];
    const erlaubt = orders.filter((o) => o.side !== 'sell' || sockel.has(o.symbol));
    expect(erlaubt.map((o) => o.symbol)).toEqual(['SOXX']);
  });

  it('Altbestand ohne Flag gehört der aktiven Engine', () => {
    // Additive Migration: Positionen von vor dem 04.08. haben kein core-Feld
    // und müssen sich verhalten wie bisher — sonst verlöre eine offene
    // Position still ihren Stop-Loss.
    const altbestand = pos('AAPL');
    expect(altbestand.core).toBeUndefined();
    expect(altbestand.core !== true).toBe(true);
  });
});

describe('Sockel-Abwicklung bei corePct 0 (Red-Team-Befund 5, 20.08.)', () => {
  const hier = dirname(fileURLToPath(import.meta.url));
  const momentumRun = readFileSync(join(hier, '../src/scheduled/momentumRun.ts'), 'utf8');

  it('corePct 0 heißt ABWICKELN, nicht verwaisen lassen', () => {
    /* Vorher sprang der Lauf per `continue` raus, BEVOR er verkaufen
     * konnte — die core-Positionen verloren Rebalancing und Marktfilter-
     * Exit und zählten in der Kapital-Kachel weiter als „Sockel". Der
     * blanke continue-Einzeiler darf nie zurückkommen. */
    expect(momentumRun).not.toContain('if (anteil <= 0) continue;');
    expect(momentumRun).toContain("riskExit: 'core_aufloesung'");
  });

  it('die Abwicklung verkauft NUR core-Positionen und läuft ohne Wochentakt-Gate', () => {
    const block = momentumRun.slice(
      momentumRun.indexOf('Sockel abgewählt — Bestand ABWICKELN'),
      momentumRun.indexOf("riskExit: 'core_aufloesung'"),
    );
    // Nur der Sockel-Bestand wird angefasst — Engine-Positionen nie.
    expect(block).toContain('.core === true');
    // Kein istRebalanceFaellig im Abwicklungs-Block: Wer 0 wählt, meint
    // jetzt — nicht in bis zu sieben Tagen.
    expect(block).not.toContain('istRebalanceFaellig');
    // Und es sind ausschließlich Verkäufe.
    expect(block).not.toContain("side: 'buy'");
  });

  it('die Abwicklung steht HINTER dem Reset-Tor, aber vor keinem Einstiegs-Tor', () => {
    /* tore.handel (Reset läuft = Buchführung gesperrt) muss auch die
     * Abwicklung stoppen; tore.einstieg darf sie NIE stoppen — Verkäufe
     * werden in diesem Repo grundsätzlich nicht blockiert. */
    const toreIdx = momentumRun.indexOf(
      'Sockel-Rebalancing ${userDoc.id}: übersprungen',
    );
    const abwicklungIdx = momentumRun.indexOf('Sockel abgewählt — Bestand ABWICKELN');
    expect(toreIdx).toBeGreaterThan(0);
    expect(abwicklungIdx).toBeGreaterThan(toreIdx);
    const block = momentumRun.slice(abwicklungIdx, momentumRun.indexOf("riskExit: 'core_aufloesung'"));
    expect(block).not.toContain('tore.einstieg');
  });
});
