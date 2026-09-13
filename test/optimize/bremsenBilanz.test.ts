/**
 * Bilanz der Notbremsen: hat überhaupt je eine ausgelöst?
 *
 * Warum es diesen Wächter gibt — der teuerste Analysefehler dieses Projekts,
 * nicht der teuerste Bug: Die V3-Auswertung der Basis-Stufe schrieb deren
 * Einbruch der Tagesbremse von 2 % zu. Gestützt war das allein darauf, dass
 * die Fold-Scheiben bis Juni 2024 auf den Cent identisch mit V2 waren und
 * danach auseinanderliefen. Drei Tage lang blockierte diese Zuordnung eine
 * Owner-Entscheidung; dann zeigten Lauf #54 (Notbremsen der Stufe auf den
 * V2-Werten) und #55 (zusätzlich der Positionsdeckel), dass beide NICHT die
 * Ursache sind — sie reproduzierten V3.
 *
 * Ein Divergenzpunkt in der Zeit identifiziert keine Ursache. Er grenzt nur
 * ein, wann die erste von mehreren Abweichungen zu wirken begann. Was gefehlt
 * hat, war die Zahl: ob eine Bremse je ausgelöst hat. Seitdem wandert sie mit.
 *
 * Entschieden wird damit nichts — kein Gate liest sie.
 */
import { describe, expect, it } from 'vitest';
import { bremsenUeberFolds } from '../../src/optimize/run.ts';
import { OHNE_BREMSEN } from '../../src/core/types.ts';
import type { HaltBilanz, SimResult } from '../../src/core/types.ts';

const leer = (): Omit<SimResult, 'bremsen'> => ({
  trades: [],
  equity: [],
  dailyReturns: [],
  metrics: {} as SimResult['metrics'],
  finalEquity: 0,
  notes: [],
});

const fold = (b: HaltBilanz): SimResult => ({ ...leer(), bremsen: b });

describe('bremsenUeberFolds', () => {
  it('WÄCHTER: ohne Auslösung bleibt die Bilanz LEER — und das ist die Aussage, nicht ein fehlender Wert', () => {
    const b = bremsenUeberFolds([fold(OHNE_BREMSEN), fold(OHNE_BREMSEN)]);
    expect(b.ausloesungen).toEqual({});
    expect(b.erste).toBe(null);
    expect(b.letzte).toBe(null);
    // Genau diese Auskunft hat im Bericht der Basis-Stufe gefehlt: „keine
    // Bremse hat ausgelöst" muss sagbar sein, sonst liest man Schweigen als
    // Zustimmung zur eigenen These.
  });

  it('WÄCHTER: Auslösungen ADDIEREN sich je Schlüssel über die Folds', () => {
    const b = bremsenUeberFolds([
      fold({ ausloesungen: { 'konto:daily_loss': 2, 'basis:drawdown': 1 }, erste: 100, letzte: 500 }),
      fold({ ausloesungen: { 'konto:daily_loss': 3 }, erste: 700, letzte: 900 }),
    ]);
    expect(b.ausloesungen).toEqual({ 'konto:daily_loss': 5, 'basis:drawdown': 1 });
  });

  it('WÄCHTER: die Zeitpunkte sind Extrema über alle Folds — auch bei umgekehrter Reihenfolge', () => {
    const a = fold({ ausloesungen: { 'konto:daily_loss': 1 }, erste: 100, letzte: 500 });
    const c = fold({ ausloesungen: { 'konto:daily_loss': 1 }, erste: 700, letzte: 900 });
    for (const reihe of [[a, c], [c, a]]) {
      const b = bremsenUeberFolds(reihe);
      expect(b.erste).toBe(100);
      expect(b.letzte).toBe(900);
    }
  });

  it('Folds ohne Auslösung verschieben die Zeitpunkte nicht', () => {
    const b = bremsenUeberFolds([
      fold(OHNE_BREMSEN),
      fold({ ausloesungen: { 'alpha:drawdown': 1 }, erste: 400, letzte: 400 }),
      fold(OHNE_BREMSEN),
    ]);
    expect(b.erste).toBe(400);
    expect(b.letzte).toBe(400);
    expect(b.ausloesungen).toEqual({ 'alpha:drawdown': 1 });
  });
});
