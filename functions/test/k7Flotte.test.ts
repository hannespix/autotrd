/**
 * K-7: Scan und Tuner wählen DIESELBE Flotte (Audit 13.08., B1 Lernen).
 *
 * Der Befund: Der Scan steppte die ersten sechs Varianten in FESTER
 * Ordnung, der Tuner bewertete die Top-6 NACH Priors. Sobald das Kollektiv
 * (meta/tuneGlobal) Priors hatte, die die Top-6 ändern, bewertete der
 * Tuner Varianten ohne Schattenkonto — dauerhaft „Zu wenig Evidenz:
 * 0 gegen X" —, stepFleet löschte die Zustände der prior-gestützten
 * Varianten bei jedem Scan, und die 0-Evidenz-Urteile flossen ins globale
 * Aggregat zurück: Sobald das Kollektiv etwas gelernt hatte, fror die
 * lokale Selbstverbesserung ein.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STRATEGY,
  TUNE_AXES,
  buildVariants,
  type GlobalPrior,
} from '../../shared/src/index.js';
import { clampStrategyRisk } from '../src/core/rulesTrading.js';
import { FLEET_SIZE, flottenAuswahl } from '../src/scheduled/autoTune.js';

const base = clampStrategyRisk(structuredClone(DEFAULT_STRATEGY));

describe('flottenAuswahl — die eine Auswahl', () => {
  it('ohne Priors: die ersten Varianten in Ursprungsordnung', () => {
    const naiv = buildVariants(base, FLEET_SIZE).map((v) => v.id);
    expect(flottenAuswahl(base, []).map((v) => v.id)).toEqual(naiv);
  });

  it('mit Priors rückt eine bewährte Nachzügler-Variante in die Flotte', () => {
    const alle = buildVariants(base, TUNE_AXES.length * 8);
    // Eine Variante, die in der festen Ordnung NICHT unter den ersten sechs
    // wäre — genau der Fall, in dem Scan und Tuner vorher auseinanderliefen.
    const nachzuegler = alle[FLEET_SIZE + 3]!.id;
    const priors: GlobalPrior[] = [
      { variantId: nachzuegler, meanEdge: 1, promoteRate: 1, confidence: 1 },
    ];
    const auswahl = flottenAuswahl(base, priors).map((v) => v.id);
    expect(auswahl).toHaveLength(FLEET_SIZE);
    expect(auswahl[0]).toBe(nachzuegler);
  });
});

describe('K-7 — die Verdrahtung (Quelltext-Wächter)', () => {
  const hier = dirname(fileURLToPath(import.meta.url));
  const scan = readFileSync(join(hier, '../src/scheduled/scanMarket.ts'), 'utf8');
  const tune = readFileSync(join(hier, '../src/scheduled/autoTune.ts'), 'utf8');

  it('der Scan steppt die prior-gerankte Flotte — nicht mehr die feste Ordnung', () => {
    expect(scan).toContain('flottenAuswahl(clamped, tunePriors)');
    expect(scan).not.toContain('buildVariants(clamped, FLEET_SIZE)');
    // Die Priors werden EINMAL je Lauf geladen, nicht je Konto.
    const laden = scan.indexOf('await ladeTunePriors()');
    const schleife = scan.indexOf('for (const userDoc of users.docs)');
    expect(laden).toBeGreaterThan(-1);
    expect(laden).toBeLessThan(schleife);
  });

  it('der Tuner bewertet über DIESELBE Funktion', () => {
    expect(tune).toContain('flottenAuswahl(base, priors)');
    // Die alte Zwei-Wege-Form (orderByPrior direkt im Lauf) darf nicht
    // zurückkommen — sie war die Quelle der Diskrepanz. Der einzige
    // erlaubte Aufruf steht in flottenAuswahl selbst.
    const lauf = tune.slice(tune.indexOf('export async function tuneAll'));
    expect(lauf).not.toContain('orderByPrior(');
  });
});
