/**
 * autotrd — Strategie-Presets (M10): 5 kuratierte Vorlagen, die zusammen JEDE
 * Knotenart mindestens einmal zeigen (Presets = lebende Doku des Regel-Baums).
 * Geseedet nach meta/strategyPresets (öffentlich lesbar), kopierbar im Studio.
 */

import type { StrategySpec } from './spec.js';

export interface StrategyPreset {
  id: string;
  name: string;
  description: string;
  spec: StrategySpec;
}

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: 'rsi-dip',
    name: 'RSI-Dip-Käufer',
    description:
      'Kauft überverkaufte Rücksetzer (RSI + Bollinger), gewichtet mit der Prognose; verkauft überkaufte Spitzen.',
    spec: {
      buy: {
        type: 'weighted',
        threshold: 2,
        children: [
          { weight: 1, node: { type: 'compare', left: 'rsi', op: 'lt', right: 30 } },
          { weight: 1, node: { type: 'compare', left: 'pctB', op: 'lt', right: 5 } },
          { weight: 2, node: { type: 'forecast', direction: 'up', minAbsPct: 0.5 } },
        ],
      },
      sell: {
        type: 'weighted',
        threshold: 2,
        children: [
          { weight: 1, node: { type: 'compare', left: 'rsi', op: 'gt', right: 70 } },
          { weight: 1, node: { type: 'compare', left: 'pctB', op: 'gt', right: 95 } },
          { weight: 2, node: { type: 'forecast', direction: 'down', minAbsPct: 0.5 } },
        ],
      },
    },
  },
  {
    id: 'macd-momentum',
    name: 'MACD-Momentum',
    description: 'Frisches MACD-Kreuz nach oben mit positivem Histogramm; Exit beim Gegenkreuz.',
    spec: {
      buy: {
        type: 'all',
        children: [
          { type: 'crossover', fast: 'macdLine', slow: 'macdSignal', direction: 'above' },
          { type: 'compare', left: 'macdHistogram', op: 'gt', right: 0 },
        ],
      },
      sell: {
        type: 'any',
        children: [
          { type: 'crossover', fast: 'macdLine', slow: 'macdSignal', direction: 'below' },
          { type: 'compare', left: 'macdHistogram', op: 'lt', right: 0 },
        ],
      },
    },
  },
  {
    id: 'news-regeln',
    name: 'News-Wächter',
    description:
      'Handelt nur vormittags bei positiver Nachrichtenlage — und nie gegen Krisen-Schlagzeilen (not-Regel).',
    spec: {
      buy: {
        type: 'all',
        children: [
          { type: 'timeWindow', start: '09:30', end: '12:00' },
          { type: 'sentiment', op: 'gte', value: 0.2 },
          { type: 'not', child: { type: 'newsEvent', tags: ['lawsuit', 'recall', 'downgrade'] } },
        ],
      },
      sell: {
        type: 'any',
        children: [
          { type: 'sentiment', op: 'lte', value: -0.3 },
          { type: 'newsEvent', tags: ['lawsuit', 'recall', 'bankruptcy'] },
        ],
      },
    },
  },
  {
    id: 'breakout',
    name: 'Breakout-Jäger',
    description: 'Kauft Stärke: 5-Tage-Anstieg plus Lauf ans obere Bollinger-Band; Exit bei Schwäche.',
    spec: {
      buy: {
        type: 'all',
        children: [
          { type: 'changePct', lookbackBars: 5, op: 'gte', pct: 3 },
          { type: 'compare', left: 'pctB', op: 'gt', right: 80 },
        ],
      },
      sell: {
        type: 'weighted',
        threshold: 1,
        children: [
          { weight: 1, node: { type: 'changePct', lookbackBars: 3, op: 'lte', pct: -2 } },
          { weight: 1, node: { type: 'compare', left: 'pctB', op: 'lt', right: 50 } },
        ],
      },
    },
  },
  {
    id: 'gewinnsicherung',
    name: 'Gewinnsicherung',
    description:
      'Kauft Dips nur ohne offene Position; sichert ab +6 % Gewinn, zieht bei −3 % die Notbremse (position-Regeln) oder unter der Beispiel-Marke 50.',
    spec: {
      buy: {
        type: 'all',
        children: [
          { type: 'compare', left: 'rsi', op: 'lt', right: 35 },
          { type: 'position', state: 'none' },
        ],
      },
      sell: {
        type: 'any',
        children: [
          { type: 'position', state: 'open', minUnrealizedPct: 6 },
          { type: 'position', state: 'open', maxUnrealizedPct: -3 },
          { type: 'priceLevel', level: 50, side: 'below' },
        ],
      },
    },
  },
];
