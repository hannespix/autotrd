/**
 * Maker-Einstieg in der Kostenrechnung (17.08.) — und was dabei NICHT
 * verbilligt werden darf.
 *
 * Seit Hebel 1b (15.08.) gehen Krypto-Einstiege als Limit-Order raus und
 * zahlen bei Alpaca den Maker-Satz (0,15 % statt 0,25 %). Exits bleiben
 * Market und zahlen Taker — das ist die Sicherheitszusage „Exits werden
 * niemals erschwert", und sie steht hier mit im Test.
 *
 * Der eigentliche Prüfgegenstand ist aber die Grenze: Die Vergünstigung gilt
 * für die MESSUNG (Schatten-Kante), nicht für das BUCH. Ein Buch, das sich
 * den günstigeren Satz gutschreibt, sähe besser aus als die Realität — und an
 * ihm hängen Trade-Filter, A/B-Duell und Auto-Tuner.
 */
import { describe, expect, it } from 'vitest';
import {
  CLASS_FEE_RATE,
  CLASS_MAKER_FEE_RATE,
  effectivePriceForClass,
  entryFeeRateForClass,
  feeRateForClass,
  PAPER_FEE_RATE,
  roundtripFeeRateForClass,
} from '../src/strategy.js';

describe('entryFeeRateForClass', () => {
  it('gibt Krypto den Maker-Satz', () => {
    expect(entryFeeRateForClass('crypto')).toBe(0.0015);
  });

  it('lässt jede Klasse ohne Limit-Einstieg unverändert', () => {
    // Ein Maker-Satz für eine Order-Art, die es dort nicht gibt, wäre eine
    // geschenkte Kostensenkung — und die Klasse würde die Kostenhürde mit
    // einer Gebühr bestehen, die sie nie zahlt.
    for (const kl of Object.keys(CLASS_FEE_RATE)) {
      if (kl === 'crypto') continue;
      expect(entryFeeRateForClass(kl), kl).toBe(feeRateForClass(kl));
    }
    expect(entryFeeRateForClass(undefined)).toBe(PAPER_FEE_RATE);
    expect(entryFeeRateForClass('gibt_es_nicht')).toBe(PAPER_FEE_RATE);
  });

  it('trägt genau EINEN Maker-Eintrag — jeder weitere braucht einen echten Limit-Pfad', () => {
    expect(Object.keys(CLASS_MAKER_FEE_RATE)).toEqual(['crypto']);
  });
});

describe('roundtripFeeRateForClass', () => {
  it('Krypto: Maker rein, Taker raus ⇒ 0,40 % statt 0,50 %', () => {
    expect(roundtripFeeRateForClass('crypto')).toBeCloseTo(0.004, 10);
    // Die Zahl, gegen die der Schatten bis zum 17.08. gerechnet hat.
    expect(feeRateForClass('crypto') * 2).toBeCloseTo(0.005, 10);
  });

  it('ist für alle anderen Klassen unverändert das Doppelte der Seite', () => {
    for (const kl of Object.keys(CLASS_FEE_RATE)) {
      if (kl === 'crypto') continue;
      expect(roundtripFeeRateForClass(kl), kl).toBeCloseTo(feeRateForClass(kl) * 2, 10);
    }
  });

  it('senkt die Kosten NIE unter den Maker-Satz beider Seiten', () => {
    // Richtungs-Wächter: Der Ausstieg ist Taker, weil Exits Market bleiben.
    // Würde hier jemand beide Seiten auf Maker setzen, wäre das keine
    // Kostenkorrektur mehr, sondern eine Annahme, die live nicht gilt.
    expect(roundtripFeeRateForClass('crypto')).toBeGreaterThan(
      entryFeeRateForClass('crypto') * 2,
    );
  });
});

describe('das BUCH bleibt konservativ — Taker auf beiden Seiten', () => {
  it('feeRateForClass für Krypto ist unverändert der Taker-Satz', () => {
    expect(feeRateForClass('crypto')).toBe(0.0025);
    expect(CLASS_FEE_RATE['crypto']).toBe(0.0025);
  });

  it('effectivePriceForClass rechnet weiter mit dem Taker-Satz', () => {
    // Das ist der Preis, mit dem Positionen gebucht werden. Er darf sich
    // durch diese Änderung um keinen Basispunkt bewegt haben: Ein Limit, das
    // im Wartefenster nicht füllt, wird storniert — gebucht wird der teure
    // Fall, nicht der erhoffte.
    expect(effectivePriceForClass(100, 'buy', 'crypto')).toBeCloseTo(100.25, 10);
    expect(effectivePriceForClass(100, 'sell', 'crypto')).toBeCloseTo(99.75, 10);
  });
});
