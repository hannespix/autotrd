/**
 * Die Basis-Stufe: Welche Symbole handelt der Champion-Block `basis`, und wie?
 *
 * EIN Kern für beide Betriebsarten: `src/app.ts` (`strategyChoice`, eigener
 * Prozess) und `functions/src/engine/strategyFor.ts` (`buildStrategyFor`,
 * Plattform) fragen hier nach — dieselbe Reihenfolge, dieselben Bedingungen.
 *
 * Reihenfolge je Symbol (Owner-Anweisung, 09.09.2026):
 *   1. Alpha-Champion (`champion.symbols[symbol]`) — er führt das Symbol; die
 *      Basis übersteuert NIE ein Symbol, das der Alpha-Champion handelt.
 *   2. Basis (`champion.basis`), wenn der Block FÜHRBAR ist: vorhanden ·
 *      Zeitrahmen des Blocks = Zeitrahmen der Config · `positionPct` im Block
 *      (Sizing-Semantik der Messung, Prüfbefund K4) · Korb nicht leer. Dann
 *      führt die Basis-Strategie ihre Symbole — mit EINSTIEGSRECHT nur, wenn
 *      außerdem `pass === true` (die Basis-Latte, §0.9) und der Schalter an
 *      ist (`strategy.basis`; auf der Plattform global ∧ Nutzer).
 *   3. `noTrade` / nichts (bzw. die Config-Strategie mit
 *      `allowWithoutChampion`, wie bisher).
 *
 * Zwei Zustände der Basis, seit Prüfbefund M6/M8 (09.09.2026):
 *   - HANDELBAR (`tradable`): Korb ins Universum, Einstiege und Exits.
 *   - FÜHRBAR ohne Einstiegsrecht (`fuehrung`): pass gefallen, Schalter aus.
 *     Keine neuen Basis-Einstiege — aber offene Basis-Positionen führt die
 *     Basis-Strategie zu Ende (eigene Exits: Regimebruch, Momentum, Rang;
 *     Broker-Stop bleibt), bis sie von selbst aussteigen. Dafür bleibt der
 *     GANZE Korb im Universum, solange eine Position darin offen ist (Rang
 *     braucht den Korb). Vorher hieß „aus" Zwangs-Liquidation am nächsten
 *     Open auf allen Konten — ein nie gemessener Handelsweg, ausgelöst von
 *     Messrauschen um die Latte. Zwangs-Liquidation (`unmanaged`, engine.ts)
 *     gibt es nur noch für Symbole ohne jede Strategie: Block geräumt,
 *     Zeitrahmen fremd, Block unlesbar — dann kann niemand die Position nach
 *     einer gemessenen Regel führen.
 *
 * Der Korb wird gegen den KANDIDATENPOOL geprüft (Prüfbefund M11): Symbole
 * des Blocks außerhalb `universe.candidates` werden verworfen und genannt —
 * wer `meta/champion.basis.symbols` schreibt, schreibt sonst das gehandelte
 * Universum am Pool vorbei. Ohne Pool (Config ohne `candidates`) gibt es
 * nichts zu prüfen: Der Korb ist dann eine eigene Einheit.
 *
 * Die Basis handelt den Korb als Ganzes: Auf der Plattform wählt der Nutzer
 * Alpha-Symbole aus, die Basis kommt als Block dazu (`universeWithBasis`)
 * oder gar nicht — ein Teilkorb wäre eine andere Strategie als die gemessene
 * (Rang über weniger Symbole).
 *
 * Bekannte Grenze, nicht wegdefiniert: Führt der Alpha-Champion ein Symbol des
 * Basis-Korbs (SPY etwa), fehlt es der Basis — sie rangiert dann über einen
 * um dieses Symbol kleineren Korb als gemessen. Unter MIN_KORB hält sie still
 * (regimeAllocation.ts). Das steht im Journal (`note`).
 */
import type { Config } from './config.ts';
import type { Params, SizingSpec, TimeframeMin } from './types.ts';
import type { ChampionBasis, ChampionFile } from '../optimize/promote.ts';

/** Was die Basis-Strategie führen kann: Korb (im Pool), Sizing, Beschreibung, verworfene Symbole. */
export interface BasisFuehrung {
  symbols: readonly string[];
  sizing: SizingSpec;
  /** Beschreibung des Blocks (Symbole, Strategie, Position je Symbol, wirksamer Deckel). */
  note: string;
  /** Korb-Symbole außerhalb des Kandidatenpools — nicht geführt, nicht gehandelt. */
  verworfen: readonly string[];
}

/** Die handelbare Basis eines Champions — oder der Grund, warum nicht (mit oder ohne Führung des Bestands). */
export type BasisStatus =
  | ({ tradable: true; basis: ChampionBasis } & BasisFuehrung)
  | {
      tradable: false;
      basis: ChampionBasis | null;
      reason: string | null;
      /** Gesetzt, wenn der Block führbar ist, aber kein Einstiegsrecht hat (pass gefallen, Schalter aus). */
      fuehrung?: BasisFuehrung;
    };

/** Wahl der Basis-Stufe für EIN Symbol (Strategie-ID und Parameter des Blocks, Allokations-Sizing, Einstiegsrecht). */
export interface BasisChoice {
  strategyId: string;
  params: Params;
  sizing: SizingSpec;
  label: string;
  /** false ⇒ keine neuen Einstiege in diesem Symbol; eine offene Position wird weiter geführt. */
  entriesAllowed: boolean;
  /** Grund der Einstiegssperre (fürs Journal), wenn `entriesAllowed` false ist. */
  entryLockReason?: string;
}

export interface BasisStatusArgs {
  champion: ChampionFile | null;
  timeframe: TimeframeMin;
  /** Schalter `strategy.basis` (Plattform: global ∧ Nutzer). */
  enabled: boolean;
  /** Kandidatenpool (`universe.candidates`); fehlt er, wird der Korb nicht geprüft. */
  pool?: readonly string[] | undefined;
  /** `risk.maxPositionPct` des Nutzers — deckelt die Allokation (risk/sizing.ts); die Notiz nennt den wirksamen Wert. */
  maxPositionPct?: number | undefined;
}

/**
 * Ist die Basis des Champions handelbar, führbar oder nichts davon? Prüft
 * alles außer der Symbolfrage. `reason` ist null, wenn es schlicht keinen
 * Block gibt (kein Journal-Rauschen); sonst der Text fürs Journal.
 */
export function basisStatus(a: BasisStatusArgs): BasisStatus {
  const basis = a.champion?.basis ?? null;
  if (!basis) return { tradable: false, basis: null, reason: null };
  const name = `Basis-Allokation „${basis.label}"`;
  // Nicht führbar: ohne gemessene Regel kann niemand eine Position führen.
  if (basis.timeframe !== a.timeframe) return { tradable: false, basis, reason: `${name}: Zeitrahmen ${basis.timeframe} ≠ Config ${a.timeframe} — nicht gehandelt` };
  const pct = basis.positionPct;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0) {
    return { tradable: false, basis, reason: `${name}: Block ohne positionPct (Lauf vor der Basis-Stufe) — Sizing-Semantik unbekannt, nicht gehandelt` };
  }
  if (!Array.isArray(basis.symbols) || basis.symbols.length === 0) return { tradable: false, basis, reason: `${name}: Block ohne Symbole — nicht gehandelt` };
  // Korb gegen den Kandidatenpool (M11): Fremde Symbole fliegen raus, laut.
  const pool = a.pool ? new Set(a.pool) : null;
  const symbols = pool ? basis.symbols.filter((s) => pool.has(s)) : [...basis.symbols];
  const verworfen = pool ? basis.symbols.filter((s) => !pool.has(s)) : [];
  if (symbols.length === 0) {
    return { tradable: false, basis, reason: `${name}: kein Korb-Symbol im Kandidatenpool (${verworfen.join(', ')}) — nicht gehandelt` };
  }
  const sizing: SizingSpec = { mode: 'allocation', positionPct: pct };
  // Der wirksame Deckel (Prüfbefund G15): risk.maxPositionPct kann die Allokation nur verkleinern.
  const cap = typeof a.maxPositionPct === 'number' && Number.isFinite(a.maxPositionPct) && a.maxPositionPct < pct ? a.maxPositionPct : null;
  const position = cap === null ? `Position ${pct} % der Equity je Symbol` : `Position ${pct} % der Equity je Symbol, durch risk.maxPositionPct auf ${cap} % gedeckelt`;
  const note =
    `${name}: ${symbols.length} Symbole (${symbols.join(', ')}), ${basis.strategy}, ${position} (Allokation; Risiko je Trade ohne Wirkung)` +
    (verworfen.length ? ` — außerhalb des Kandidatenpools verworfen: ${verworfen.join(', ')}` : '');
  const fuehrung: BasisFuehrung = { symbols, sizing, note, verworfen };
  // Führbar, aber ohne Einstiegsrecht: Latte nicht bestanden oder Schalter aus.
  const sperre = basis.pass !== true ? `${name}: Latte nicht bestanden — keine neuen Einstiege` : !a.enabled ? `${name}: Schalter aus (strategy.basis) — keine neuen Einstiege` : null;
  if (sperre !== null) return { tradable: false, basis, reason: `${sperre}; offene Basis-Positionen führt die Basis-Strategie zu Ende (eigene Exits, Broker-Stop bleibt)`, fuehrung };
  return { tradable: true, basis, ...fuehrung };
}

/** Führung der Basis (handelbar oder gesperrt) — null, wenn der Block nicht führbar ist. */
export function basisFuehrungOf(status: BasisStatus): BasisFuehrung | null {
  if (status.tradable) return status;
  return status.fuehrung ?? null;
}

/**
 * Die Basis-Wahl für ein Symbol — nur, wenn kein Alpha-Champion es führt
 * (`alphaLeads`), die Basis führbar ist und das Symbol im Korb steht. Ohne
 * Einstiegsrecht (`tradable: false`, aber `fuehrung`) kommt die Wahl mit
 * `entriesAllowed: false`: Sie führt eine offene Position, eröffnet keine.
 */
export function basisChoiceFor(a: { status: BasisStatus; symbol: string; alphaLeads: boolean }): BasisChoice | null {
  if (a.alphaLeads) return null;
  const fuehrung = basisFuehrungOf(a.status);
  if (!fuehrung || !a.status.basis) return null;
  if (!fuehrung.symbols.includes(a.symbol)) return null;
  const basis = a.status.basis;
  const choice: BasisChoice = { strategyId: basis.strategy, params: basis.params, sizing: fuehrung.sizing, label: basis.label, entriesAllowed: a.status.tradable };
  if (!a.status.tradable && a.status.reason !== null) choice.entryLockReason = a.status.reason;
  return choice;
}

/**
 * Das Universum der Engine mit dem Basis-Korb: `universe.symbols` ∪ Korb,
 * wenn die Basis handelbar ist — oder wenn sie nur noch FÜHRT und eine
 * offene Position (bzw. laufende Einstiegs-Order, `held`) im Korb steht:
 * Die Engine (`src/engine/engine.ts`) führt nur Symbole ihres Universums, und
 * die Rang-Exits brauchen den ganzen Korb. Ohne Position und ohne
 * Einstiegsrecht bleibt das Universum unverändert. Gilt für `run` und den
 * Takt, NICHT für den Optimierer: Dort ist der Basis-Korb eine eigene
 * Einheit (`optimizer.basisUniverse`), die Alpha-Einheit bleibt der Korb der
 * Config.
 */
export function universeWithBasis(config: Config, champion: ChampionFile | null, held: readonly string[] = []): Config {
  const status = basisStatus({ champion, timeframe: config.timeframe, enabled: config.strategy.basis, pool: config.universe.candidates });
  const fuehrung = basisFuehrungOf(status);
  if (!fuehrung) return config;
  if (!status.tradable && !held.some((s) => fuehrung.symbols.includes(s))) return config;
  const symbols = [...new Set([...config.universe.symbols, ...fuehrung.symbols])];
  if (symbols.length === config.universe.symbols.length) return config;
  return { ...config, universe: { ...config.universe, symbols } };
}
