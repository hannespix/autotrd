/**
 * Champion/Challenger: Wer darf live handeln? Der Champion je Symbol steht
 * in `champion.json`; ein Kandidat ersetzt ihn nur, wenn er die Gates
 * besteht UND den amtierenden Champion — auf SAUBEREM OOS neu bewertet —
 * um eine Marge schlägt. "Kein Handel" ist ein vollwertiger Zustand
 * (`noTrade`), kein Fehlerfall.
 *
 * Sauber heißt: nur OOS-Folds, die NACH dem Fit-Fenster des Champions
 * beginnen (`fitEnd`). Red-Team-Befund: finalParams entstehen auf dem
 * letzten Suchfenster; beim Folgelauf liegen die meisten OOS-Folds genau
 * dort — ein Re-Score darauf wäre In-Sample.
 */
import type { Journal } from '../core/journal.ts';
import { readJson, writeJsonAtomic } from '../core/journal.ts';
import { logger } from '../core/log.ts';
import { TIMEFRAMES, type Ms, type Params, type TimeframeMin } from '../core/types.ts';
import type { GateResult } from './robustness.ts';
import type { OosAggregate, TimeRange } from './walkForward.ts';

export interface ChampionEntry {
  strategy: string;
  params: Params;
  timeframe: TimeframeMin;
  /** OOS-Objective-Median zum Zeitpunkt der Beförderung. */
  score: number;
  oos: OosAggregate;
  gates: GateResult[];
  decidedAt: Ms;
  trials: number;
  dataRange: TimeRange;
  /** Ende des Fensters, aus dem `params` stammen — OOS davor ist für den Re-Score tabu. Fehlt es (alte Datei): decidedAt. */
  fitEnd?: Ms;
  /**
   * Mit welcher Korb-Zugehörigkeit der Score gemessen wurde (§5a.13). Fehlt
   * es (alte Datei): `fixed` — die Auswahl von heute, rückwärts angewandt. Ein
   * Champion aus dem einen Regime ist mit einem Kandidaten aus dem anderen
   * nicht vergleichbar und tritt ab, bis einer neu besteht (Prüfbefund 4.2).
   */
  foldMembership?: 'point_in_time' | 'fixed';
  /**
   * Aus einem Festkandidaten befördert (`optimizer.fixedCandidates`): Die
   * Parameter wurden vorregistriert, nicht gesucht — `trials` ist 1. Fehlt
   * das Feld (alte Datei oder gesuchte Strategie): gesucht.
   */
  fixed?: true;
}

/** Fit-Ende eines Champions; alte Dateien ohne Feld: Beförderungszeitpunkt (konservativ). */
export function fitEndOf(entry: ChampionEntry): Ms {
  return entry.fitEnd ?? entry.decidedAt;
}

export interface NoTradeEntry {
  reason: string;
  decidedAt: Ms;
  bestScore: number | null;
}

/**
 * Die Basis-Stufe der Champion-Datei: das Ergebnis der Basis-Latte
 * (`basisGates`, Gate-Gruppe `basis`) für den Festkandidaten mit
 * `tier: basis`. Sie konkurriert NICHT mit `symbols` — sie ist keine
 * Alpha-Behauptung, sondern „Marktexposition mit Trendfilter statt nichts".
 * `pass` entscheidet, ob eine spätere Engine-Stufe sie benutzen darf; die
 * Messung schreibt den Block bei bestanden UND nicht bestanden, damit der
 * Befund nachlesbar bleibt. Fehlt der Basis-Kandidat in der Config, räumt
 * der nächste Lauf den Block (kein veralteter Befund überlebt).
 */
export interface ChampionBasis {
  version: 1;
  strategy: string;
  params: Params;
  /** Der Korb, auf dem gemessen wurde — fest, kein Korb je Fold. */
  symbols: string[];
  label: string;
  timeframe: TimeframeMin;
  pass: boolean;
  gates: GateResult[];
  measuredAt: Ms;
  /**
   * Sizing-Semantik, mit der gemessen wurde und mit der die Basis-Stufe
   * handelt: Position = dieser Anteil der Equity je Symbol
   * (`optimizer.basis.positionPct`, `SizingSpec` allocation). Fehlt das Feld
   * (Block aus einem Lauf vor der Basis-Stufe), ist die Semantik unbekannt und
   * der Block wird NICHT gehandelt (core/basisTier.ts) — bis ein Lauf ihn neu
   * schreibt.
   */
  positionPct?: number;
  /** Commit der Config/Vorregistrierung, mit der gemessen wurde (falls der Aufrufer ihn kennt). */
  configCommit?: string;
}

/**
 * Ein DURCHGEFALLENER Kandidat, den ein Papier-Konto trotzdem handeln darf
 * (Owner-Entscheidung 14.09.2026, `src/core/erprobung.ts`).
 *
 * Er ist keine Beförderung und wird nie eine: Das Symbol bleibt in
 * `noTrade`, kein Gate wird gelockert, und Echtgeld sieht diesen Block nie.
 * Der Block existiert, damit überhaupt ein Journal entsteht, solange nichts
 * die Gates nimmt — `failed` nennt beim Namen, woran es lag, damit niemand
 * den Eintrag später für einen Champion hält.
 */
export interface ErprobungEntry {
  version: 1;
  strategy: string;
  params: Params;
  timeframe: TimeframeMin;
  /** OOS-Objective-Median des Kandidaten; null, wenn nicht endlich (0 Trades). */
  score: number | null;
  /** Namen der gefallenen Gates — der Grund, warum das hier keine Beförderung ist. */
  failed: string[];
  decidedAt: Ms;
  /**
   * Geschlossene OOS-Trades je 30,44 Kalendertage der OOS-Kette — die Zahl
   * der Maßstab-Zeile. Additiv (18.09.2026); fehlt in älteren Blöcken.
   * null: keine OOS-Tage oder nicht ermittelbar.
   */
  tradesPerMonth?: number | null;
  /**
   * Warum GENAU dieser Kandidat (`waehleErprobung`): Score-bester, oder
   * Score-bester über der Untergrenze der Handelsaktivität mit den
   * übersprungenen Kandidaten, oder Rückfall, weil keiner sie erreicht.
   * Additiv; ohne das Feld galt allein der Score.
   */
  auswahl?: string;
}

/* ───────────────────────── Erprobung: Wahl ───────────────────────── */

/** Was die Wahl je Kandidat braucht — strukturell, damit sie ohne den ganzen `StrategyRun` prüfbar ist. */
export interface ErprobungKandidatSicht {
  strategyId: string;
  /** OOS-Objective-Median; −∞ bei 0 Trades. */
  score: number;
  /** Trades je Monat der OOS-Kette (Maßstab-Zeile); null ⇒ erreicht nie eine Untergrenze. */
  tradesPerMonth: number | null;
}

export interface ErprobungWahl<T extends ErprobungKandidatSicht> {
  wahl: T | null;
  /** Für Journal, Champion-Block und Log: warum dieser. */
  auswahl: string;
  /** Kandidaten, die die Untergrenze reißen — der Bericht nennt sie. */
  unterGrenze: T[];
}

const f1 = (x: number | null): string => (x === null ? '–' : x.toFixed(1));

/**
 * Wer läuft auf Papier? (Owner-Entscheidung 18.09.2026,
 * docs/wissen/vorregistrierung/2026-09-18-erprobung-nach-handelsaktivitaet.md)
 *
 * Bis dahin: der Score-beste. Der Score ist aber blind dafür, ob ein
 * Kandidat je handelt — Lauf #17 wählte `regime_allocation` mit 1,4 Trades
 * je Monat über den ganzen Korb, und die Erprobung, die es gibt, „damit
 * überhaupt ein Journal entsteht" (§0.9), erzeugte keines.
 *
 * Jetzt: der Score-beste UNTER DENEN, die `minTradesPerMonth` erreichen.
 * Erreicht sie keiner, der Score-beste — und `auswahl` sagt das. Mit
 * `minTradesPerMonth` 0 ist die Wahl die alte.
 *
 * Was hier NICHT entschieden wird: Beförderung, Gates, `symbols`, `noTrade`.
 * Die Funktion sortiert selbst (Score absteigend, dann Name), damit sie
 * nicht von der Reihenfolge des Aufrufers abhängt.
 */
export function waehleErprobung<T extends ErprobungKandidatSicht>(kandidaten: readonly T[], minTradesPerMonth: number): ErprobungWahl<T> {
  const sortiert = [...kandidaten].sort((a, b) => {
    if (a.score !== b.score) return a.score > b.score ? -1 : 1;
    return a.strategyId < b.strategyId ? -1 : a.strategyId > b.strategyId ? 1 : 0;
  });
  const beste = sortiert[0] ?? null;
  if (beste === null) return { wahl: null, auswahl: 'kein Kandidat', unterGrenze: [] };
  if (!(minTradesPerMonth > 0)) {
    return { wahl: beste, auswahl: `Score-bester (${f3(beste.score)}); keine Untergrenze der Handelsaktivität`, unterGrenze: [] };
  }
  const erreicht = (k: T): boolean => k.tradesPerMonth !== null && k.tradesPerMonth >= minTradesPerMonth;
  const unterGrenze = sortiert.filter((k) => !erreicht(k));
  const wahl = sortiert.find(erreicht) ?? null;
  const nennen = (xs: readonly T[]): string => xs.map((k) => `${k.strategyId} (${f1(k.tradesPerMonth)})`).join(', ');
  if (wahl === null) {
    return {
      wahl: beste,
      auswahl:
        `kein Kandidat erreicht ≥ ${minTradesPerMonth} Trades je Monat — Rückfall auf den Score-besten ${beste.strategyId} ` +
        `(Score ${f3(beste.score)}, ${f1(beste.tradesPerMonth)} je Monat); unter der Grenze: ${nennen(unterGrenze)}`,
      unterGrenze,
    };
  }
  const uebersprungen = sortiert.slice(0, sortiert.indexOf(wahl)).filter((k) => !erreicht(k));
  return {
    wahl,
    auswahl:
      `Score-bester unter ≥ ${minTradesPerMonth} Trades je Monat: ${wahl.strategyId} (Score ${f3(wahl.score)}, ${f1(wahl.tradesPerMonth)} je Monat)` +
      (uebersprungen.length ? `; übersprungen trotz höherem Score: ${nennen(uebersprungen)}` : ''),
    unterGrenze,
  };
}

export interface ChampionFile {
  version: 1;
  updatedAt: Ms;
  symbols: Record<string, ChampionEntry>;
  noTrade: Record<string, NoTradeEntry>;
  /** Basis-Stufe (siehe `ChampionBasis`); fehlt in alten Dateien und ohne Basis-Kandidat. */
  basis?: ChampionBasis;
  /** Papier-Erprobung je Symbol (siehe `ErprobungEntry`); fehlt in alten Dateien. */
  erprobung?: Record<string, ErprobungEntry>;
}

/**
 * Den Block `erprobung` lesen, ohne die Datei mitzureißen — dieselbe Regel
 * wie bei `basis` (Prüfbefund M9): Ein additiver Block darf nicht mehr
 * Schaden anrichten können als sein Fehlen. Unlesbare EINZELEINTRÄGE fallen
 * weg, der Rest bleibt; ist gar nichts lesbar, gibt es den Block nicht.
 */
export function parseErprobung(raw: unknown): { entries: Record<string, ErprobungEntry>; verworfen: string[] } {
  const entries: Record<string, ErprobungEntry> = {};
  const verworfen: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { entries, verworfen };
  for (const [symbol, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      verworfen.push(symbol);
      continue;
    }
    const o = v as Record<string, unknown>;
    const params = o.params;
    const ok =
      o.version === 1 &&
      typeof o.strategy === 'string' &&
      o.strategy.length > 0 &&
      typeof o.timeframe === 'number' &&
      typeof params === 'object' &&
      params !== null &&
      !Array.isArray(params) &&
      Object.values(params as Record<string, unknown>).every((x) => typeof x === 'number' && Number.isFinite(x));
    if (!ok) {
      verworfen.push(symbol);
      continue;
    }
    entries[symbol] = {
      version: 1,
      strategy: o.strategy as string,
      params: params as Params,
      timeframe: o.timeframe as TimeframeMin,
      score: finiteOrNull(typeof o.score === 'number' ? o.score : null),
      failed: Array.isArray(o.failed) ? o.failed.filter((x): x is string => typeof x === 'string') : [],
      decidedAt: typeof o.decidedAt === 'number' ? o.decidedAt : 0,
      // Additiv (18.09.2026): fehlt beides, war es ein Block der alten Regel — dann bleibt es weg.
      ...(typeof o.tradesPerMonth === 'number' || o.tradesPerMonth === null ? { tradesPerMonth: finiteOrNull(o.tradesPerMonth as number | null) } : {}),
      ...(typeof o.auswahl === 'string' ? { auswahl: o.auswahl } : {}),
    };
  }
  return { entries, verworfen };
}

export function emptyChampionFile(now: Ms): ChampionFile {
  return { version: 1, updatedAt: now, symbols: {}, noTrade: {} };
}

/**
 * Den Block `basis` lesen, ohne zu raten — und ohne den Champion mitzureißen.
 *
 * Prüfbefund M9 (09.09.2026): Ein Block mit fremder oder fehlender `version`
 * warf bisher die GANZE Datei bzw. das ganze Doc — im Takt handelte dann
 * niemand mehr, im Dauerprozess starb jedes CLI-Kommando. Ein additiver
 * Block darf nicht mehr Schaden anrichten können als sein Fehlen. Also:
 * unlesbar ⇒ kein Block (die Basis handelt nicht), der Grund geht als Text
 * an den Aufrufer; `symbols`/`noTrade` bleiben gültig. Geprüft wird, was die
 * Engine braucht (Version, Strategie, Parameter als Zahlen, Korb, Zeitrahmen,
 * Urteil); Beiwerk (Label, Gates, Messzeit) wird notfalls ergänzt.
 */
export function parseChampionBasis(raw: unknown): { ok: true; basis: ChampionBasis } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error: `Basis-Block unlesbar (${error}) — die Basis wird nicht gehandelt, der Alpha-Champion gilt weiter` });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('kein Objekt');
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) return fail(`unbekannte Basis-Version ${String(o.version)}`);
  if (typeof o.strategy !== 'string' || o.strategy.length === 0) return fail('strategy fehlt');
  if (typeof o.params !== 'object' || o.params === null || Array.isArray(o.params)) return fail('params ist kein Objekt');
  const params: Params = {};
  for (const [k, v] of Object.entries(o.params as Record<string, unknown>)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return fail(`params.${k} ist keine Zahl`);
    params[k] = v;
  }
  if (!Array.isArray(o.symbols) || !o.symbols.every((x): x is string => typeof x === 'string')) return fail('symbols ist keine Symbolliste');
  if (typeof o.timeframe !== 'number' || !(TIMEFRAMES as readonly number[]).includes(o.timeframe)) return fail(`timeframe ${String(o.timeframe)} unbekannt`);
  if (typeof o.pass !== 'boolean') return fail('pass ist kein Wahrheitswert');
  if (o.positionPct !== undefined && (typeof o.positionPct !== 'number' || !Number.isFinite(o.positionPct))) return fail('positionPct ist keine Zahl');
  const basis: ChampionBasis = {
    version: 1,
    strategy: o.strategy,
    params,
    symbols: [...o.symbols],
    label: typeof o.label === 'string' ? o.label : o.strategy,
    timeframe: o.timeframe as TimeframeMin,
    pass: o.pass,
    gates: Array.isArray(o.gates) ? (o.gates as GateResult[]) : [],
    measuredAt: typeof o.measuredAt === 'number' ? o.measuredAt : 0,
    ...(o.positionPct !== undefined ? { positionPct: o.positionPct as number } : {}),
    ...(typeof o.configCommit === 'string' ? { configCommit: o.configCommit } : {}),
  };
  return { ok: true, basis };
}

/**
 * Champion-Datei laden. Fehlt sie ⇒ null; fremde DATEI-Version ⇒ Fehler (nie
 * raten). Der Block `basis` ist additiv und darf die Datei nicht mitreißen
 * (`parseChampionBasis`): unlesbar ⇒ ohne Block, `warn` bekommt den Grund
 * (Default: Logger).
 */
export function loadChampion(path: string, warn: (text: string) => void = (t) => logger.warn(t)): ChampionFile | null {
  const raw = readJson<Partial<ChampionFile>>(path);
  if (raw === null) return null;
  if (raw.version !== 1) throw new Error(`${path}: unbekannte Champion-Version ${String(raw.version)} — Datei prüfen statt überschreiben`);
  const file: ChampionFile = {
    version: 1,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    symbols: raw.symbols ?? {},
    noTrade: raw.noTrade ?? {},
  };
  if (raw.basis !== undefined && raw.basis !== null) {
    const b = parseChampionBasis(raw.basis);
    if (b.ok) file.basis = b.basis;
    else warn(`${path}: ${b.error}`);
  }
  if (raw.erprobung !== undefined && raw.erprobung !== null) {
    const e = parseErprobung(raw.erprobung);
    if (Object.keys(e.entries).length) file.erprobung = e.entries;
    if (e.verworfen.length) warn(`${path}: Erprobungs-Einträge unlesbar und verworfen: ${e.verworfen.join(', ')} — diese Symbole handeln auch auf Papier nicht`);
  }
  return file;
}

/** Basis-Block setzen (gemessen) oder räumen (kein Basis-Kandidat mehr) — neues Objekt, `symbols`/`noTrade` unberührt. */
export function mitBasis(file: ChampionFile, basis: ChampionBasis | null, now: Ms): ChampionFile {
  const { basis: _alt, ...rest } = file;
  return basis ? { ...rest, updatedAt: now, basis } : { ...rest, updatedAt: now };
}

export function saveChampion(path: string, file: ChampionFile): void {
  writeJsonAtomic(path, file);
}

/* ───────────────────────── Entscheidung ───────────────────────── */

export type PromotionAction = 'promote' | 'keep' | 'demote_to_notrade' | 'stay_notrade';

export interface PromotionDecision {
  action: PromotionAction;
  reason: string;
}

export interface PromotionInput {
  incumbent: ChampionEntry | null;
  /**
   * Score des Amtsinhabers JETZT: OOS-Median auf sauberen Folds nach fitEnd;
   * bei zu wenig sauberem OOS der Beförderungs-Score; null = nicht bewertbar
   * (Strategie/Zeitrahmen unbekannt).
   */
  incumbentRescore: number | null;
  /** Gates des Amtsinhabers auf sauberem OOS: true/false; null = nicht geprüft (zu wenig sauberes OOS oder nicht bewertbar). */
  incumbentPass: boolean | null;
  candidate: { entry: ChampionEntry; pass: boolean } | null;
  /** Kandidat muss den Incumbent um diesen Faktor schlagen (0.1 = 10 %). */
  margin: number;
}

const f3 = (x: number | null): string => (x === null ? '–' : x === -Infinity ? '−∞' : x === Infinity ? '∞' : x.toFixed(3));

/**
 * Regeln (eine Änderung je Symbol je Lauf):
 * - Kandidat besteht: ohne Incumbent ⇒ promote; Incumbent reißt die Gates ⇒
 *   promote; sonst nur, wenn score ≥ rescore × (1 + margin) — bei rescore ≤ 0
 *   (oder nicht bewertbar) reicht score > 0; sonst keep.
 * - Kandidat fällt durch (oder fehlt): Incumbent reißt die Gates ⇒
 *   demote_to_notrade; Incumbent mit rescore > 0 ⇒ keep (auch ungeprüft bei zu
 *   wenig sauberem OOS); rescore ≤ 0 oder nicht bewertbar ⇒ demote_to_notrade;
 *   kein Incumbent ⇒ stay_notrade.
 */
export function decidePromotion(a: PromotionInput): PromotionDecision {
  const { incumbent, incumbentRescore, incumbentPass, candidate, margin } = a;
  const cand = candidate && candidate.pass ? candidate.entry : null;

  if (cand) {
    if (!incumbent) {
      return { action: 'promote', reason: `erste Beförderung: ${cand.strategy} besteht alle Gates (Score ${f3(cand.score)})` };
    }
    if (incumbentPass === false) {
      return {
        action: 'promote',
        reason: `Incumbent ${incumbent.strategy} reißt die Gates auf sauberem OOS (Score ${f3(incumbentRescore)}); Kandidat ${cand.strategy} besteht sie (Score ${f3(cand.score)})`,
      };
    }
    const rescore = incumbentRescore;
    if (rescore === null || rescore <= 0) {
      if (cand.score > 0) {
        return {
          action: 'promote',
          reason: `Incumbent ${incumbent.strategy} liefert ${rescore === null ? 'keinen bewertbaren Score' : `Score ${f3(rescore)} ≤ 0`}, Kandidat ${cand.strategy} Score ${f3(cand.score)} > 0`,
        };
      }
      return { action: 'keep', reason: `Kandidat ${cand.strategy} besteht die Gates, aber Score ${f3(cand.score)} ≤ 0 — Incumbent bleibt` };
    }
    const needed = rescore * (1 + margin);
    const basis = incumbentPass === null ? 'Beförderungs-Score, kein sauberes OOS' : 'sauberes OOS';
    if (cand.score >= needed) {
      return {
        action: 'promote',
        reason: `Kandidat ${cand.strategy} Score ${f3(cand.score)} ≥ ${f3(needed)} (Incumbent ${incumbent.strategy} ${f3(rescore)} × ${(1 + margin).toFixed(2)}, ${basis})`,
      };
    }
    return {
      action: 'keep',
      reason: `Kandidat ${cand.strategy} Score ${f3(cand.score)} < ${f3(needed)} (Incumbent ${incumbent.strategy} ${f3(rescore)} × ${(1 + margin).toFixed(2)}, ${basis}) — Marge nicht erreicht`,
    };
  }

  const why = candidate ? `bester Kandidat ${candidate.entry.strategy} (Score ${f3(candidate.entry.score)}) fällt durch die Gates` : 'kein bewertbarer Kandidat';
  if (incumbent) {
    if (incumbentPass === false) {
      return { action: 'demote_to_notrade', reason: `${why}; Incumbent ${incumbent.strategy} reißt die Gates auf sauberem OOS (Score ${f3(incumbentRescore)}) — kein Handel` };
    }
    if (incumbentRescore !== null && incumbentRescore > 0) {
      const how = incumbentPass === true ? 'besteht die Gates auf sauberem OOS' : 'ungeprüft (zu wenig sauberes OOS), Beförderungs-Score gilt weiter';
      return { action: 'keep', reason: `${why}; Incumbent ${incumbent.strategy} hält Score ${f3(incumbentRescore)} > 0 — ${how}` };
    }
    return {
      action: 'demote_to_notrade',
      reason: `${why}; Incumbent ${incumbent.strategy} ${incumbentRescore === null ? 'nicht mehr bewertbar' : `Score ${f3(incumbentRescore)} ≤ 0 auf sauberem OOS`} — kein Handel`,
    };
  }
  return { action: 'stay_notrade', reason: `${why}; kein Champion — kein Handel` };
}

/* ───────────────────────── Anwenden ───────────────────────── */

/** Nicht-endliche Scores (−∞ bei 0 Trades) als null persistieren — JSON kennt kein Infinity. */
export function finiteOrNull(x: number | null | undefined): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/** Entscheidung auf die Champion-Datei anwenden (neues Objekt; nur dieses Symbol ändert sich). */
export function applyDecision(a: {
  file: ChampionFile;
  symbol: string;
  decision: PromotionDecision;
  candidate: ChampionEntry | null;
  bestScore: number | null;
  now: Ms;
  /**
   * Wer auf Papier läuft (`waehleErprobung`) — seit 18.09.2026 nicht mehr
   * zwingend `candidate`. Fehlt das Feld (alte Aufrufer, Tests), gilt die
   * alte Regel: der Kandidat der Beförderungsfrage.
   */
  erprobung?: { entry: ChampionEntry; tradesPerMonth: number | null; auswahl: string } | undefined;
}): ChampionFile {
  const symbols = { ...a.file.symbols };
  const noTrade = { ...a.file.noTrade };
  const erprobung = { ...(a.file.erprobung ?? {}) };
  const note: NoTradeEntry = { reason: a.decision.reason, decidedAt: a.now, bestScore: finiteOrNull(a.bestScore) };
  // Der Erprobungs-Eintrag des Symbols wird bei JEDER Entscheidung neu gesetzt
  // oder geräumt. Ein stehengebliebener Eintrag wäre schlimmer als keiner: Ein
  // Papier-Konto handelte sonst Parameter, die kein Lauf mehr nachgerechnet hat
  // — derselbe Fehler, gegen den `stay_notrade` unten `symbols` räumt
  // (Prüfbefund 4.1).
  delete erprobung[a.symbol];
  const alsErprobung = (): void => {
    const e = a.erprobung ? a.erprobung.entry : a.candidate;
    if (!e) return;
    erprobung[a.symbol] = {
      version: 1,
      strategy: e.strategy,
      params: e.params,
      timeframe: e.timeframe,
      score: finiteOrNull(e.score),
      failed: (e.gates ?? []).filter((g) => !g.pass).map((g) => g.name),
      decidedAt: a.now,
      ...(a.erprobung ? { tradesPerMonth: finiteOrNull(a.erprobung.tradesPerMonth), auswahl: a.erprobung.auswahl } : {}),
    };
  };
  switch (a.decision.action) {
    case 'promote':
      if (!a.candidate) throw new Error(`promote ohne Kandidat für ${a.symbol}`);
      symbols[a.symbol] = { ...a.candidate, score: finiteOrNull(a.candidate.score) ?? 0, decidedAt: a.now };
      delete noTrade[a.symbol];
      break;
    case 'keep':
      break;
    case 'demote_to_notrade':
      delete symbols[a.symbol];
      noTrade[a.symbol] = note;
      alsErprobung();
      break;
    case 'stay_notrade':
      // Ein alter Eintrag darf nicht stehen bleiben: „kein Handel" gilt für das
      // Symbol, auch wenn es früher Teil eines geprüften Korbs war. Nach einem
      // Korbwechsel ist das der Normalfall — sonst handelte es weiter mit
      // einem Champion, den kein Lauf mehr nachgerechnet hat (Prüfbefund 4.1).
      delete symbols[a.symbol];
      noTrade[a.symbol] = note;
      alsErprobung();
      break;
  }
  // Der Basis-Block gehört nicht zur Alpha-Entscheidung: Er bleibt, wie er ist —
  // auch bei stay_notrade und demote. Geräumt wird er nur, wenn die Config
  // keinen Basis-Kandidaten mehr hat (`mitBasis`).
  return { version: 1, updatedAt: a.now, symbols, noTrade, ...(a.file.basis ? { basis: a.file.basis } : {}), ...(Object.keys(erprobung).length ? { erprobung } : {}) };
}

/** Journal-Eintrag 'champion' — die Wahrheit darüber, wer wann warum handeln durfte. */
export function journalDecision(
  journal: Journal,
  a: {
    symbol: string;
    decision: PromotionDecision;
    chosen: ChampionEntry | null;
    candidate: ChampionEntry | null;
    candidatePass: boolean;
    incumbentRescore: number | null;
    incumbentPass?: boolean | null | undefined;
    now: Ms;
    /** Wer auf Papier läuft und warum (`waehleErprobung`); fehlt, wenn nichts auf Papier läuft. */
    erprobung?: { strategy: string; tradesPerMonth: number | null; auswahl: string } | undefined;
  },
): void {
  journal.append(
    'champion',
    {
      symbol: a.symbol,
      action: a.decision.action,
      reason: a.decision.reason,
      strategy: a.chosen?.strategy ?? null,
      params: a.chosen?.params ?? null,
      fitEnd: a.chosen ? fitEndOf(a.chosen) : null,
      candidateStrategy: a.candidate?.strategy ?? null,
      candidateScore: finiteOrNull(a.candidate?.score),
      candidatePass: a.candidatePass,
      incumbentRescore: finiteOrNull(a.incumbentRescore),
      incumbentPass: a.incumbentPass ?? null,
      erprobungStrategy: a.erprobung?.strategy ?? null,
      erprobungTradesPerMonth: a.erprobung ? finiteOrNull(a.erprobung.tradesPerMonth) : null,
      erprobungAuswahl: a.erprobung?.auswahl ?? null,
    },
    a.now,
  );
}

/**
 * Journal-Eintrag 'champion' für eine gemessene Ensemble-Einheit.
 *
 * Ein Ensemble wird in diesem Lauf NIE befördert (Vorregistrierung
 * `2026-09-12-ensemble.md` Punkt 4: dreimal dasselbe Urteil auf getrennten
 * Fenstern, und `ChampionEntry` trägt ohnehin nur eine Strategie je Symbol).
 * Der Eintrag ist deshalb ein reiner MESSBEFUND — er sagt, was gemessen
 * wurde, mit welcher Zusammensetzung und welcher Gewichtsregel, und ob die
 * zehn Alpha-Gates hielten. Ohne ihn stünde ein bestandenes Ensemble nur im
 * Bericht, und Berichte werden überschrieben.
 */
export function journalEnsemble(
  journal: Journal,
  a: {
    symbol: string;
    label: string;
    regel: string;
    sleeves: readonly { strategy: string; params: Params }[];
    pass: boolean;
    failed: readonly string[];
    reason: string;
    now: Ms;
  },
): void {
  journal.append(
    'champion',
    {
      symbol: a.symbol,
      action: 'ensemble_measured',
      reason: a.reason,
      label: a.label,
      weighting: a.regel,
      sleeves: a.sleeves.map((s) => ({ strategy: s.strategy, params: s.params })),
      ensemblePass: a.pass,
      ensembleFailed: [...a.failed],
    },
    a.now,
  );
}

/** Journal-Eintrag 'champion' für die Basis-Stufe: gemessen (mit Urteil) oder geräumt. */
export function journalBasis(
  journal: Journal,
  a: { symbol: string; basis: ChampionBasis | null; reason: string; now: Ms },
): void {
  journal.append(
    'champion',
    {
      symbol: a.symbol,
      action: a.basis ? 'basis_measured' : 'basis_removed',
      reason: a.reason,
      strategy: a.basis?.strategy ?? null,
      params: a.basis?.params ?? null,
      label: a.basis?.label ?? null,
      basisPass: a.basis?.pass ?? null,
      basisFailed: a.basis ? a.basis.gates.filter((g) => !g.pass).map((g) => g.name) : null,
    },
    a.now,
  );
}
