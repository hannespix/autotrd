/**
 * Varianten-Erzeugung des Auto-Tuners (MT2).
 *
 * Die Eigenschaften, die hier festgehalten werden, sind keine Kosmetik:
 * Stabile Kennungen entscheiden darüber, ob eine Variante über Wochen
 * dieselbe Evidenz weitersammelt oder bei jedem Scan von vorn beginnt — und
 * ohne Evidenz beurteilt autotune.ts sie nie.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY, buildVariants, describeVariant, TUNE_AXES } from '../src/index.js';

const basis = () => JSON.parse(JSON.stringify(DEFAULT_STRATEGY)) as typeof DEFAULT_STRATEGY;

describe('buildVariants', () => {
  it('lässt den amtierenden Wert aus — man vergleicht nichts mit sich selbst', () => {
    const b = basis(); // minHoldMin 60, exitConfluence 2, timeframe intraday
    const ids = buildVariants(b, 20).map((v) => v.id);
    expect(ids).not.toContain('minHoldMin=60');
    expect(ids).not.toContain('exitConfluence=2');
    expect(ids).not.toContain('timeframe=intraday');
  });

  it('verteilt die Flotte über die Achsen statt eine auszuschöpfen', () => {
    // Sonst bekäme die erste Achse alle Plätze und Zeitrahmen oder
    // Konfluenz würden nie geprüft.
    const achsen = new Set(buildVariants(basis(), 5).map((v) => v.axis));
    expect(achsen.size).toBeGreaterThanOrEqual(4);
  });

  it('hält die Obergrenze ein', () => {
    expect(buildVariants(basis(), 3)).toHaveLength(3);
    expect(buildVariants(basis(), 0)).toHaveLength(0);
  });

  it('vergibt stabile Kennungen — gleiche Basis, gleiche Liste', () => {
    // Ohne das würde jede Variante bei jedem Scan ein neues Schattenkonto
    // bekommen und nie die 30 Trades der Evidenzschwelle erreichen.
    const a = buildVariants(basis(), 6).map((v) => v.id);
    const b = buildVariants(basis(), 6).map((v) => v.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length); // keine Dubletten
  });

  it('ändert je Variante GENAU einen Wert', () => {
    // Nur so lässt sich später sagen, woran eine Verbesserung lag.
    const b = basis();
    for (const v of buildVariants(b, 8)) {
      const abweichungen = TUNE_AXES.filter((ax) => ax.read(v.strategy) !== ax.read(b));
      expect(abweichungen.map((x) => x.key)).toEqual([v.axis]);
    }
  });

  it('schaltet jede Variante auf nicht-handelnd — die Flotte fasst kein Wallet an', () => {
    const b = basis();
    b.engine.running = true;
    for (const v of buildVariants(b, 6)) expect(v.strategy.engine.running).toBe(false);
  });

  it('lässt die Basis unberührt', () => {
    const b = basis();
    const vorher = JSON.stringify(b);
    buildVariants(b, 6);
    expect(JSON.stringify(b)).toBe(vorher);
  });

  it('fasst Positionsgröße und Stop/Take NICHT an', () => {
    // Risikosteuerung ist Sache des Owners, nicht eines Automaten.
    const b = basis();
    for (const v of buildVariants(b, 8)) {
      expect(v.strategy.engine.maxPositionPct).toBe(b.engine.maxPositionPct);
      expect(v.strategy.engine.stopLossPct).toBe(b.engine.stopLossPct);
      expect(v.strategy.engine.takeProfitPct).toBe(b.engine.takeProfitPct);
      expect(v.strategy.engine.trailingStopPct).toBe(b.engine.trailingStopPct);
    }
  });
});

describe('describeVariant', () => {
  it('beschreibt die Änderung so, wie sie im Journal stehen soll', () => {
    const b = basis();
    // Ausdrücklich viele Varianten, damit die Achse tief genug ausgereizt
    // wird — der Rundlauf verteilt sonst nur je einen Wert je Achse.
    const v = buildVariants(b, 20).find((x) => x.id === 'minHoldMin=120')!;
    expect(v).toBeDefined();
    expect(describeVariant(b, v)).toBe('Mindest-Haltedauer 60 → 120');
  });
});
