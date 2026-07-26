/**
 * autotrd — Compiler „classic → Regelbaum" (M10 Teil 3).
 *
 * Übersetzt das flache Classic-Schema (broker/watchlist/engine/indicators/
 * signals) in eine StrategySpec aus buy-/sell-Baum, die auf VOLLSTÄNDIGEN
 * Indikator-Daten exakt die Entscheidung der Konfluenz-Engine reproduziert:
 *
 *   buy  ⟺ buyVotes ≥ minConfluence ∧ buyVotes > sellVotes
 *
 * Der Margin-Teil (buyVotes > sellVotes) nutzt, dass jeder Indikator pro
 * Auswertung höchstens EINE Seite wählt (Votes sind paarweise exklusiv):
 * Für die Kinder [B_i (w_i), not(S_i) (w_i)] gilt
 *   Σ wahr = W + (buyVotes − sellVotes)   mit W = Σ w_i,
 * denn ein Buy-Vote zählt 2·w_i (B_i ∧ ¬S_i), Hold w_i (nur ¬S_i), Sell 0.
 * „buy schlägt sell" ist damit exakt `weighted(threshold = W + 1)`.
 *
 * Dokumentierte Abweichungen (bewusst, Gates werden NICHT aufgeweicht):
 *  - Fehlen Indikator-Daten zur Laufzeit, wertet der Baum „unbekannt" und
 *    handelt NICHT — die Classic-Engine überspringt den Indikator dagegen
 *    und handelt mit dem Rest. Der Baum ist also strikt konservativer.
 *  - Degenerierte Configs mit überlappenden Schwellen (rsi.thresholdBuy ≥
 *    thresholdSell, bollinger.bbBreakoutPct < 50, forecastThresholdPct = 0)
 *    verletzen die Vote-Exklusivität; die Engine löst sie per if-else-
 *    Präzedenz. Solche Configs sind fachlich sinnfrei und nicht paritätisch.
 *  - forecastThresholdPct wird auf die Schema-Grenze 50 % geklemmt.
 *
 * Stop-Loss/Take-Profit sind bewusst NICHT Teil des Baums — sie leben in der
 * Risiko-Hülle außerhalb (MILESTONES M10) und greifen vor jeder Auswertung.
 */

import type { Strategy } from '../strategy.js';
import type { RuleNode } from './schema.js';
import type { StrategySpec } from './spec.js';

interface VotePair {
  buy: RuleNode;
  sell: RuleNode;
  weight: number;
  /** Abweichendes Gewicht der Verkaufs-Seite (Forecast-Deckel, MA2). */
  weightSell?: number;
}

/** Bewusst unerfüllbares Blatt (Preis < 1e-6 gibt es nicht). */
const NEVER: RuleNode = { type: 'priceLevel', level: 1e-6, side: 'below' };

function cmp(left: string, op: 'lt' | 'lte' | 'gt' | 'gte', right: number): RuleNode {
  return { type: 'compare', left, op, right };
}

function cmpKey(left: string, op: 'lt' | 'lte' | 'gt' | 'gte', rightKey: string): RuleNode {
  return { type: 'compare', left, op, right: { key: rightKey } };
}

export function compileClassic(strategy: Strategy): StrategySpec {
  const { indicators, signals } = strategy;
  const pairs: VotePair[] = [];

  if (indicators.rsi.enabled) {
    pairs.push({
      buy: cmp('rsi', 'lt', indicators.rsi.thresholdBuy),
      sell: cmp('rsi', 'gt', indicators.rsi.thresholdSell),
      weight: 1,
    });
  }
  if (indicators.macd.enabled && indicators.macd.crossoverBuy) {
    pairs.push({
      buy: { type: 'all', children: [cmpKey('macdLine', 'gt', 'macdSignal'), cmp('macdHistogram', 'gt', 0)] },
      sell: { type: 'all', children: [cmpKey('macdLine', 'lt', 'macdSignal'), cmp('macdHistogram', 'lt', 0)] },
      weight: 1,
    });
  }
  if (indicators.bollinger.enabled) {
    pairs.push({
      buy: cmp('pctB', 'lt', 100 - indicators.bollinger.bbBreakoutPct),
      sell: cmp('pctB', 'gt', indicators.bollinger.bbBreakoutPct),
      weight: 1,
    });
  }
  // Forecast-Deckel wie in computeSignal (MA2): Beim EINSTIEG darf die
  // Prognose die Konfluenz nicht allein reißen, beim Ausstieg zählt sie voll.
  const fcWeight = Math.trunc(signals.forecastWeight);
  if (signals.useForecast && fcWeight > 0) {
    const thr = Math.min(signals.forecastThresholdPct, 50);
    const capped = signals.forecastSolo === true
      ? fcWeight
      : Math.max(1, Math.min(fcWeight, signals.minConfluence - 1));
    pairs.push({
      buy: { type: 'forecast', direction: 'up', minAbsPct: thr },
      sell: { type: 'forecast', direction: 'down', minAbsPct: thr },
      weight: capped,
      weightSell: fcWeight,
    });
  }

  const totalWeight = pairs.reduce((s, p) => s + Math.max(p.weight, p.weightSell ?? p.weight), 0);
  const required = signals.minConfluence;
  // Ohne Stimmen bzw. mit unerreichbarer Konfluenz hält die Engine für immer.
  if (pairs.length === 0 || required > totalWeight) {
    return { buy: NEVER, sell: NEVER };
  }

  // Gewichte können sich je Seite unterscheiden (Forecast-Deckel), deshalb
  // wird die „meine Stimmen > deine Stimmen"-Bedingung mit dem Gesamtgewicht
  // der GEGENSEITE aufgebaut: M + (T_total − T) ≥ T_total + 1 ⟺ M > T.
  const wOf = (p: VotePair, sellSide: boolean): number => (sellSide ? (p.weightSell ?? p.weight) : p.weight);
  const sumW = (sellSide: boolean): number => pairs.reduce((acc, p) => acc + wOf(p, sellSide), 0);
  const side = (
    mine: (p: VotePair) => RuleNode,
    theirs: (p: VotePair) => RuleNode,
    sellSide: boolean,
  ): RuleNode => ({
    type: 'all',
    children: [
      {
        type: 'weighted',
        threshold: required,
        children: pairs.map((p) => ({ weight: wOf(p, sellSide), node: mine(p) })),
      },
      {
        type: 'weighted',
        threshold: sumW(!sellSide) + 1,
        children: [
          ...pairs.map((p) => ({ weight: wOf(p, sellSide), node: mine(p) })),
          ...pairs.map((p) => ({ weight: wOf(p, !sellSide), node: { type: 'not', child: theirs(p) } as RuleNode })),
        ],
      },
    ],
  });

  return {
    buy: side((p) => p.buy, (p) => p.sell, false),
    sell: side((p) => p.sell, (p) => p.buy, true),
  };
}
