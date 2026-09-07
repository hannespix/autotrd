/**
 * Globaler Teil der Plattform-Config (`meta/engineConfig`) aus einer
 * validierten Config — gemeinsam für `sync-engine-config.mjs` und
 * `umstieg.mjs`, damit beide Wege dasselbe Dokument schreiben.
 *
 * `engine.barGraceSec` bleibt draußen: Der Takt zur vollen Minute braucht
 * eine größere Karenz als der Streaming-Prozess (Functions-Default 20 s,
 * Untergrenze im Takt-Leser `functions/src/engine/config.ts`).
 */
export function engineConfigDocFrom(cfg, source = 'config/platform.yaml') {
  const { barGraceSec: _barGraceSec, ...engine } = cfg.engine;
  return {
    version: 1,
    broker: { mode: 'paper', feed: cfg.broker.feed },
    universe: cfg.universe,
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
