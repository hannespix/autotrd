/**
 * Globaler Teil der Plattform-Config (`meta/engineConfig`) aus einer
 * validierten Config — gemeinsam für `sync-engine-config.mjs` und
 * `umstieg.mjs`, damit beide Wege dasselbe Dokument schreiben.
 *
 * `engine.barGraceSec` bleibt draußen: Der Takt zur vollen Minute braucht
 * eine größere Karenz als der Streaming-Prozess (Functions-Default 20 s,
 * Untergrenze im Takt-Leser `functions/src/engine/config.ts`).
 *
 * `universe.candidates`/`maxSymbols` bleiben ebenfalls draußen: Der Pool ist
 * Sache der nächtlichen Auswahl, nicht der Engine. Er würde das Dokument
 * aufblähen, das jeder Nutzer jede Minute liest, ohne dort je gebraucht zu
 * werden — die Engine handelt, was in `symbols` steht.
 *
 * `broker.adjustment` (Bereinigung der Tagesbars) geht MIT: Der Takt muss auf
 * denselben Bars entscheiden wie der Optimierer (CLAUDE.md §0.1; Prüfbefund
 * M7 gilt live genauso). Der Takt bildet daraus seine eigene Cache-Wurzel
 * (`barStoreRoot`), rohe und bereinigte Tagesbars mischen sich nie.
 */
export function engineConfigDocFrom(cfg, source = 'config/platform.yaml') {
  const { barGraceSec: _barGraceSec, ...engine } = cfg.engine;
  const universe = { assetClass: cfg.universe.assetClass, symbols: cfg.universe.symbols };
  if (cfg.universe.benchmark !== undefined) universe.benchmark = cfg.universe.benchmark;
  return {
    version: 1,
    broker: { mode: 'paper', feed: cfg.broker.feed, adjustment: cfg.broker.adjustment },
    universe,
    timeframe: cfg.timeframe,
    session: cfg.session,
    costs: cfg.costs,
    engine,
    /** Defaults für Nutzer ohne eigene Risiko-Einstellung. */
    riskDefaults: cfg.risk,
    optimizer: { strategies: cfg.optimizer.strategies, lookbackDays: cfg.optimizer.lookbackDays },
    source,
  };
}
