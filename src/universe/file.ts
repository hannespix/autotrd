/**
 * `var/universe.json` — das Ergebnis der nächtlichen Auswahl, gemeinsame
 * Sprache zwischen `autotrd universe`, `fetch`, `optimize` und
 * `scripts/sync-engine-config.mjs`.
 *
 * Beim Laden wird misstraut: Die Datei kommt aus dem Actions-Cache und wird
 * von einem anderen Schritt geschrieben. Ein Symbol, das nicht im
 * Kandidatenpool der Config steht, kommt hier nicht durch — sonst könnte eine
 * kaputte oder untergeschobene Datei die Plattform auf beliebige Werte
 * umstellen. Kein Fund ⇒ die Config gilt weiter (der erste Lauf hat noch
 * keine Datei); Fund mit Fehler ⇒ Abbruch, damit `meta/engineConfig`
 * unverändert stehen bleibt statt Unsinn zu bekommen.
 */
import { existsSync } from 'node:fs';
import { normalizeUserSymbol } from '../alpaca/symbols.ts';
import type { Config } from '../core/config.ts';
import { readJson, writeJsonAtomic } from '../core/journal.ts';
import type { Ms } from '../core/types.ts';
import type { UniverseAuswahl, UniverseBewertung, UniverseRegeln } from './select.ts';

export const UNIVERSE_FILE_VERSION = 1;

export interface UniverseFile {
  version: number;
  updatedAt: Ms;
  /** Gewähltes Universum, nach Liquidität absteigend. */
  symbols: string[];
  benchmark?: string;
  regeln: UniverseRegeln;
  zugang: string[];
  abgang: string[];
  bewertung: UniverseBewertung[];
}

export function schreibeUniverseDatei(pfad: string, auswahl: UniverseAuswahl, regeln: UniverseRegeln, benchmark: string | undefined, jetzt: Ms): UniverseFile {
  const doc: UniverseFile = {
    version: UNIVERSE_FILE_VERSION,
    updatedAt: jetzt,
    symbols: auswahl.symbols,
    regeln,
    zugang: auswahl.zugang,
    abgang: auswahl.abgang,
    bewertung: auswahl.bewertung,
  };
  if (benchmark !== undefined) doc.benchmark = benchmark;
  writeJsonAtomic(pfad, doc);
  return doc;
}

/** Erlaubte Symbole: der Kandidatenpool, der immer auch das Config-Universum enthält. */
export function erlaubteSymbole(config: Config): Set<string> {
  return new Set(config.universe.candidates ?? config.universe.symbols);
}

/**
 * Auswahl laden und gegen die Config prüfen. `null`, wenn die Datei fehlt.
 * Wirft bei jeder Unstimmigkeit — eine halb verstandene Auswahl wird nicht
 * gehandelt.
 */
export function ladeUniverseDatei(pfad: string, config: Config): string[] | null {
  if (!existsSync(pfad)) return null;
  const roh = readJson<Partial<UniverseFile>>(pfad);
  if (roh === null) throw new Error(`Universum-Datei ${pfad} ist leer oder unlesbar.`);
  if (roh.version !== UNIVERSE_FILE_VERSION) {
    throw new Error(`Universum-Datei ${pfad} hat Version ${String(roh.version)}, erwartet ${UNIVERSE_FILE_VERSION}.`);
  }
  const liste = roh.symbols;
  if (!Array.isArray(liste) || liste.length === 0 || !liste.every((s): s is string => typeof s === 'string' && s.length > 0)) {
    throw new Error(`Universum-Datei ${pfad} enthält keine gültige Symbolliste.`);
  }
  const symbols = liste.map((s) => normalizeUserSymbol(s, config.universe.assetClass));
  if (new Set(symbols).size !== symbols.length) throw new Error(`Universum-Datei ${pfad} enthält doppelte Symbole.`);
  if (symbols.length > config.universe.maxSymbols) {
    throw new Error(`Universum-Datei ${pfad} hat ${symbols.length} Symbole, erlaubt sind ${config.universe.maxSymbols}.`);
  }
  const erlaubt = erlaubteSymbole(config);
  const fremd = symbols.filter((s) => !erlaubt.has(s));
  if (fremd.length > 0) {
    throw new Error(`Universum-Datei ${pfad} nennt Symbole außerhalb des Kandidatenpools: ${fremd.join(', ')}. Pool ändern heißt Commit, nicht Datei.`);
  }
  const bench = config.universe.benchmark;
  if (bench !== undefined && !symbols.includes(bench)) {
    throw new Error(`Universum-Datei ${pfad} enthält den Benchmark ${bench} nicht — ohne ihn greift kein Marktfilter.`);
  }
  return symbols;
}

/** Config mit dem gewählten Universum — alles andere bleibt, wie es committet ist. */
export function mitUniverse(config: Config, symbols: string[]): Config {
  return { ...config, universe: { ...config.universe, symbols } };
}
