/**
 * autotrd — Strategie-Presets: 5 kuratierte Bäume, die zusammen JEDE Knotenart
 * mindestens einmal zeigen.
 *
 * Ursprünglich waren das die Startkarten des Strategie-Studios, nach
 * meta/strategyPresets geseedet und von Hand kopierbar. Das Studio ist am
 * 28.07. ausgebaut worden; die Saat ebenfalls, weil sie niemand mehr las.
 *
 * Die Bäume selbst bleiben — mit neuer Aufgabe: Sie sind die STARTPOPULATION
 * der Struktursuche. Ein Optimierer, der nur vom kompilierten Klassik-Baum
 * ausgeht, sucht im Umkreis genau einer Idee und findet zuverlässig das
 * nächstgelegene lokale Optimum. Fünf bewusst verschiedene Ansätze
 * (Mean-Reversion, Momentum, Ausbruch …) spannen den Suchraum auf, statt ihn
 * auf eine Ecke zu verengen.
 */

import type { StrategySpec } from './spec.ts';

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
    id: 'momentum-relativ',
    name: 'Relative Stärke',
    description:
      'Kauft, was über fünf Tage deutlich gestiegen ist und Momentum bestätigt — außerhalb der teuren ersten Handelsminuten. Verkauft, sobald beides kippt.',
    spec: {
      buy: {
        type: 'all',
        children: [
          // Erst ab 10:00 ET: In der Eröffnungsphase sind die Spreads am
          // weitesten, und ein weiter Spread ist nichts anderes als eine
          // Gebühr, die niemand ausweist.
          { type: 'timeWindow', start: '10:00', end: '15:30' },
          { type: 'changePct', lookbackBars: 5, op: 'gte', pct: 3 },
          { type: 'crossover', fast: 'macdLine', slow: 'macdSignal', direction: 'above' },
        ],
      },
      sell: {
        type: 'any',
        children: [
          { type: 'changePct', lookbackBars: 5, op: 'lte', pct: -2 },
          { type: 'not', child: { type: 'crossover', fast: 'macdLine', slow: 'macdSignal', direction: 'above' } },
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
