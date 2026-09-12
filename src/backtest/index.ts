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
// Auswertung — reine Messung über abgeschlossene Trades und fertige Kurven,
// nie Teil einer Entscheidung (siehe Modulköpfe).
export {
  EXIT_KATEGORIEN,
  exitAnatomie,
  exitKategorie,
  exkursionAuswertung,
  exkursionVon,
  median,
  medianHaltedauer,
  quartile,
  stopNachlauf,
  type ExitAnatomie,
  type ExitKategorie,
  type ExitZeile,
  type Exkursion,
  type ExkursionAuswertung,
  type NachlaufErgebnis,
  type Quartile,
} from './anatomie.ts';
export {
  aktivitaet,
  kalendertage,
  korrelationsmatrix,
  pearson,
  renditeketteVon,
  tagesrenditen,
  type Aktivitaet,
  type Korrelationsmatrix,
  type Renditereihe,
} from './aktivitaet.ts';
