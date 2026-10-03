/**
 * Seitwärts-Bremse (Hebel 2, Owner 15.08. „rund um die Uhr").
 *
 * Die neutrale Ampel sperrt nichts — aber ohne Trend kippt die Konfluenz im
 * Rauschen, und genau dieses Hin und Her ist der Umschlag, der über die
 * Gebühren Geld verbrennt. Die Bremse handelt dort seltener (Cooldown ×2,
 * mindestens 30 min) und kleiner (halbe Größe).
 *
 * Die Tests kodieren vor allem die RICHTUNG: nie kürzer, nie größer — und
 * `trend`/`stress` bleiben byte-gleich beim Basiswert (stress sperrt
 * Einstiege ohnehin komplett, die Bremse ist NUR die Antwort auf neutral).
 */
import { describe, expect, it } from 'vitest';
import {
  SEITWAERTS_COOLDOWN_FAKTOR,
  SEITWAERTS_COOLDOWN_MIN,
  SEITWAERTS_GROESSEN_FAKTOR,
  regimeCooldownMin,
  regimeGroessenFaktor,
  type MarketRegime,
} from '../src/regime.js';

const ALLE: MarketRegime[] = ['trend', 'seitwaerts', 'stress'];

describe('regimeCooldownMin', () => {
  it('verdoppelt im Seitwärtsmarkt und hält den 30-min-Boden', () => {
    expect(regimeCooldownMin(15, 'seitwaerts')).toBe(30); // ×2 = Boden
    expect(regimeCooldownMin(60, 'seitwaerts')).toBe(120);
    // Auch „Cooldown aus" (0) bekommt im Seitwärtsmarkt den Whipsaw-Schutz.
    expect(regimeCooldownMin(0, 'seitwaerts')).toBe(SEITWAERTS_COOLDOWN_MIN);
  });

  it('lässt trend und stress exakt beim Basiswert', () => {
    for (const state of ['trend', 'stress'] as const) {
      expect(regimeCooldownMin(15, state)).toBe(15);
      expect(regimeCooldownMin(0, state)).toBe(0);
    }
  });

  it('Invariante: NIE kürzer als die Basis, in keinem Regime', () => {
    for (const state of ALLE) {
      for (const basis of [0, 5, 15, 60, 240]) {
        expect(regimeCooldownMin(basis, state)).toBeGreaterThanOrEqual(basis);
      }
    }
  });

  it('unsinnige Basis (NaN, negativ) wird wie 0 behandelt — nie NaN', () => {
    expect(regimeCooldownMin(Number.NaN, 'seitwaerts')).toBe(SEITWAERTS_COOLDOWN_MIN);
    expect(regimeCooldownMin(-10, 'trend')).toBe(0);
  });
});

describe('regimeGroessenFaktor', () => {
  it('halbiert im Seitwärtsmarkt, sonst neutral', () => {
    expect(regimeGroessenFaktor('seitwaerts')).toBe(SEITWAERTS_GROESSEN_FAKTOR);
    expect(regimeGroessenFaktor('trend')).toBe(1);
    expect(regimeGroessenFaktor('stress')).toBe(1);
  });

  it('Invariante: NIE verstärkend, nie null — dämpfen ist kein Blocken', () => {
    for (const state of ALLE) {
      const f = regimeGroessenFaktor(state);
      expect(f).toBeLessThanOrEqual(1);
      expect(f).toBeGreaterThan(0);
    }
  });
});

describe('die Konstanten selbst', () => {
  it('Faktor > 1, Boden > 0, Dämpfer in (0, 1) — sonst wäre die Bremse keine', () => {
    expect(SEITWAERTS_COOLDOWN_FAKTOR).toBeGreaterThan(1);
    expect(SEITWAERTS_COOLDOWN_MIN).toBeGreaterThan(0);
    expect(SEITWAERTS_GROESSEN_FAKTOR).toBeGreaterThan(0);
    expect(SEITWAERTS_GROESSEN_FAKTOR).toBeLessThan(1);
  });
});
