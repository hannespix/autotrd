/**
 * Globaler Teil der Plattform-Config (`meta/engineConfig`) aus einer
 * validierten Config — gemeinsam für `sync-engine-config.mjs` und
 * `umstieg.mjs`, damit beide Wege dasselbe Dokument schreiben.
 *
 * `engine.barGraceSec` bleibt draußen: Der Takt zur vollen Minute braucht
 * eine größere Karenz als der Streaming-Prozess (Functions-Default 20 s,
 * Untergrenze im Takt-Leser `functions/src/engine/config.ts`).
 *
 * `universe.maxSymbols` bleibt draußen: Sache der nächtlichen Auswahl.
 * `universe.reserve` (reservierte Plätze je Gruppe) ebenso, und aus demselben
 * Grund: Es ist eine AUSWAHLREGEL, und die Auswahl läuft im Workflow gegen
 * `config/platform.yaml` (`optimize.yml` ⇒ `autotrd universe`). Der Takt
 * wählt nie selbst; er bekommt das ERGEBNIS als `universe.symbols`. Stünde
 * die Regel zusätzlich im Doc, gäbe es zwei Orte, an denen sie steht, und
 * einer davon wirkte nie — das ist die stille Sorte Fehler.
 * `universe.candidates` (der Kandidatenpool) geht seit Prüfbefund M11 MIT:
 * Der Takt prüft den Korb des Champion-Blocks `basis` dagegen und verwirft
 * Symbole außerhalb des Pools (core/basisTier.ts) — sonst schriebe, wer
 * `meta/champion.basis.symbols` schreibt, das gehandelte Universum am Pool
 * vorbei, und niemand sähe es. Das Doc wird EINMAL je Takt gelesen (nicht je
 * Nutzer); rund 140 Symbole sind ein Kilobyte.
 *
 * `strategy.basis` (globaler Schalter der Basis-Stufe) geht mit: Er wird im
 * Takt mit dem Nutzer-Schalter UND-verknüpft (Prüfbefund M8) — ein
 * plattformweites „aus" heißt „keine neuen Basis-Einstiege" für alle. Die
 * übrigen Felder von `strategy` (Fallback-Strategie, allowWithoutChampion)
 * bleiben bewusst draußen: `allowWithoutChampion: true` in einer Probe-Config
 * würde sonst jeden Nutzer ohne Champion handeln lassen.
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
  if (cfg.universe.candidates !== undefined) universe.candidates = cfg.universe.candidates;
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
    /**
     * Globale Schalter: Basis-Stufe (∧ Nutzer-Schalter im Takt) und
     * Papier-Erprobung. `erprobung` MUSS hier mit — sonst setzt `parseConfig`
     * im Takt stillschweigend den zod-Default `false`, und ein von Hand in
     * `meta/engineConfig` gesetzter Wert verschwindet beim nächsten Sync
     * (`set()` ohne merge). Die Plattform-Hälfte der Stufe wäre damit tot,
     * ohne dass es jemand merkt (Prüfbefund M4).
     */
    strategy: { basis: cfg.strategy.basis, erprobung: cfg.strategy.erprobung },
    optimizer: { strategies: cfg.optimizer.strategies, lookbackDays: cfg.optimizer.lookbackDays },
    source,
  };
}
