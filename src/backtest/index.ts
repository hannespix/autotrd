/** Öffentliche Oberfläche des Backtesters — der Optimierer programmiert nur gegen diese Datei. */
export { simulate, sessionInfoIncremental, type SimConfig, type SimInput } from './simulator.ts';
export { fillCosts, slippedPrice, borrowCost, regulatoryFees, type FillCosts, type FillSide } from './costs.ts';
export {
  computeMetrics,
  sharpeRatio,
  sortinoRatio,
  maxDrawdownPct,
  skewness,
  kurtosis,
  normalCdf,
  normalInv,
  probabilisticSharpe,
  expectedMaxSharpe,
  deflatedSharpe,
  EULER_MASCHERONI,
} from './metrics.ts';
export { mulberry32, gaussian, sessionBucketTimes, randomWalkBars, trendingBars, type SyntheticArgs } from './synthetic.ts';
