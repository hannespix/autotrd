/**
 * autotrd — Struktur-Mutationen im Regelbaum (MO Teil 2 Schritt 2).
 *
 * Der Suchraum der Struktursuche: kleine, benennbare Veränderungen an einer
 * StrategySpec. Fünf Operatoren — Parameter drehen, Blatt tauschen, Zweig
 * streichen, Bedingung ergänzen, Operator kippen. Jede Mutation liefert eine
 * KLARTEXT-Beschreibung fürs Journal; eine Beförderung ohne benennbare
 * Änderung wäre nicht nachvollziehbar.
 *
 * Drei harte Eigenschaften, auf denen die Tests bestehen:
 *
 * 1. DETERMINISTISCH. Gleiche Spec + gleicher Seed ⇒ exakt dieselbe Mutation
 *    (mulberry32-PRNG, kein Math.random). Nur so sind Läufe reproduzierbar
 *    und Fehler nachstellbar — ein Optimierer, dessen Schritte niemand
 *    wiederholen kann, ist nicht debugbar.
 *
 * 2. GUARDS SIND VETO, KEINE REPARATUR. Nach jeder Mutation läuft
 *    validateStrategySpec (Schema + Tiefe ≤ 5 + ≤ 25 Knoten + erreichbare
 *    Thresholds). Verletzt das Ergebnis einen Guard, wird die Mutation
 *    VERWORFEN (null) — nie „passend gemacht". Der Knoten-Deckel ist die
 *    Sparsamkeits-Bremse gegen Bäume, die auf der Historie glänzen und
 *    nichts können (MILESTONES MO, Abnahme-Punkt).
 *
 * 3. PURE. Die Eingabe-Spec bleibt unangetastet (tiefe Kopie); das Modul
 *    kennt weder Firestore noch Uhrzeit.
 *
 * Die Startpopulation der Suche (kompilierter Klassik-Baum + 5 Presets)
 * liefert `startPopulation` — fünf bewusst verschiedene Ansätze spannen den
 * Suchraum auf, statt ihn auf ein lokales Optimum zu verengen (presets.ts).
 */

import type { Strategy } from '../strategy.js';
import { compileClassic } from './compileClassic.js';
import { STRATEGY_PRESETS } from './presets.js';
import type { RuleLeaf, RuleNode, WeightedNode } from './schema.js';
import { countRuleNodes, MAX_NODES } from './schema.js';
import { validateStrategySpec, type StrategySpec } from './spec.js';

export type MutationsOp = 'parameter' | 'tausch' | 'streichen' | 'ergaenzen' | 'kippen';

export const MUTATIONS_OPS: readonly MutationsOp[] = [
  'parameter',
  'tausch',
  'streichen',
  'ergaenzen',
  'kippen',
];

export interface MutationsErgebnis {
  spec: StrategySpec;
  op: MutationsOp;
  /** Klartext fürs Journal, z. B. „buy: Bedingung ergänzt — rsi < 30". */
  beschreibung: string;
}

/* ── Deterministischer Zufall ──────────────────────────────────────────────
 * mulberry32: winzig, gut genug fürs Ziehen aus kleinen Mengen, und vor
 * allem SEEDBAR — Math.random wäre hier ein Reproduzierbarkeits-Leck. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wahl = <T>(rnd: () => number, arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;

/* ── Blatt-Katalog ─────────────────────────────────────────────────────────
 * Quelle der „tauschen"/„ergänzen"-Operatoren: kanonische Bedingungen aus
 * den Presets. Bewusst ein KLEINER Katalog — jeder Eintrag ist eine fachlich
 * lesbare Idee, kein Zufallsrauschen über freie Schlüssel. */
export const BLATT_KATALOG: readonly RuleLeaf[] = [
  { type: 'compare', left: 'rsi', op: 'lt', right: 30 },
  { type: 'compare', left: 'rsi', op: 'gt', right: 70 },
  { type: 'compare', left: 'pctB', op: 'lt', right: 5 },
  { type: 'compare', left: 'pctB', op: 'gt', right: 95 },
  { type: 'compare', left: 'macdHistogram', op: 'gt', right: 0 },
  { type: 'compare', left: 'macdHistogram', op: 'lt', right: 0 },
  { type: 'compare', left: 'price', op: 'gt', right: { key: 'bbMiddle' } },
  { type: 'compare', left: 'price', op: 'lt', right: { key: 'bbMiddle' } },
  { type: 'crossover', fast: 'macdLine', slow: 'macdSignal', direction: 'above' },
  { type: 'crossover', fast: 'macdLine', slow: 'macdSignal', direction: 'below' },
  { type: 'changePct', lookbackBars: 5, op: 'gte', pct: 3 },
  { type: 'changePct', lookbackBars: 5, op: 'lte', pct: -2 },
  { type: 'forecast', direction: 'up', minAbsPct: 0.5 },
  { type: 'forecast', direction: 'down', minAbsPct: 0.5 },
  { type: 'timeWindow', start: '10:00', end: '15:30' },
];

/* ── Baum-Navigation ───────────────────────────────────────────────────── */

interface Fundstelle {
  node: RuleNode;
  /** Elternknoten (null = Wurzel) + Kind-Index für Ersetzen/Streichen. */
  parent: RuleNode | null;
  index: number;
}

function sammle(node: RuleNode, parent: RuleNode | null, index: number, out: Fundstelle[]): void {
  out.push({ node, parent, index });
  switch (node.type) {
    case 'all':
    case 'any':
      node.children.forEach((c, i) => sammle(c, node, i, out));
      break;
    case 'not':
      sammle(node.child, node, 0, out);
      break;
    case 'weighted':
      node.children.forEach((c, i) => sammle(c.node, node, i, out));
      break;
    default:
      break;
  }
}

function alleStellen(root: RuleNode): Fundstelle[] {
  const out: Fundstelle[] = [];
  sammle(root, null, 0, out);
  return out;
}

const istBlatt = (n: RuleNode): boolean =>
  n.type !== 'all' && n.type !== 'any' && n.type !== 'not' && n.type !== 'weighted';

/** Kind an Position `index` des Elternknotens ersetzen. */
function ersetzeKind(parent: RuleNode, index: number, neu: RuleNode): void {
  if (parent.type === 'all' || parent.type === 'any') parent.children[index] = neu;
  else if (parent.type === 'not') parent.child = neu;
  else if (parent.type === 'weighted') parent.children[index]!.node = neu;
}

const klon = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Kompakter Klartext eines Blatts fürs Journal. */
export function blattText(n: RuleNode): string {
  switch (n.type) {
    case 'compare':
      return `${n.left} ${n.op} ${typeof n.right === 'number' ? n.right : n.right.key}`;
    case 'crossover':
      return `${n.fast} kreuzt ${n.direction === 'above' ? 'über' : 'unter'} ${n.slow}`;
    case 'priceLevel':
      return `Preis ${n.side === 'above' ? 'über' : 'unter'} ${n.level}`;
    case 'changePct':
      return `Δ${n.lookbackBars} Bars ${n.op} ${n.pct} %`;
    case 'timeWindow':
      return `Zeitfenster ${n.start}–${n.end}`;
    case 'forecast':
      return `Prognose ${n.direction === 'up' ? '↑' : '↓'} ≥ ${n.minAbsPct} %`;
    case 'position':
      return `Position ${n.state}`;
    default:
      return n.type;
  }
}

/* ── Die fünf Operatoren ───────────────────────────────────────────────────
 * Jeder arbeitet IN PLACE auf einer Kopie und liefert die Beschreibung —
 * oder null, wenn er auf diesem Baum nichts Sinnvolles findet. */

function opParameter(root: RuleNode, rnd: () => number): string | null {
  const kandidaten = alleStellen(root).filter(({ node }) => {
    if (node.type === 'compare') return typeof node.right === 'number';
    return (
      node.type === 'changePct' ||
      node.type === 'forecast' ||
      node.type === 'priceLevel' ||
      node.type === 'weighted'
    );
  });
  if (kandidaten.length === 0) return null;
  const { node } = wahl(rnd, kandidaten);
  const faktor = rnd() < 0.5 ? 0.8 : 1.25;
  const runde = (v: number): number => Math.round(v * 100) / 100;
  if (node.type === 'compare' && typeof node.right === 'number') {
    // Um 0 herum (MACD-Histogramm) skaliert ein Faktor nichts — dann additiv.
    const alt = node.right;
    node.right = alt === 0 ? (rnd() < 0.5 ? -0.05 : 0.05) : runde(alt * faktor);
    return `Schwelle ${node.left} ${node.op} ${alt} → ${node.right}`;
  }
  if (node.type === 'changePct') {
    const alt = node.pct;
    node.pct = runde(alt * faktor) || (rnd() < 0.5 ? -0.5 : 0.5);
    return `Δ${node.lookbackBars}-Bars-Schwelle ${alt} → ${node.pct} %`;
  }
  if (node.type === 'forecast') {
    const alt = node.minAbsPct;
    node.minAbsPct = Math.min(50, Math.max(0, runde(alt * faktor)));
    return `Prognose-Mindestbewegung ${alt} → ${node.minAbsPct} %`;
  }
  if (node.type === 'priceLevel') {
    const alt = node.level;
    node.level = runde(alt * (rnd() < 0.5 ? 0.9 : 1.1));
    return `Preis-Marke ${alt} → ${node.level}`;
  }
  if (node.type === 'weighted') {
    if (rnd() < 0.5) {
      const alt = node.threshold;
      node.threshold = Math.max(0.5, runde(alt + (rnd() < 0.5 ? -1 : 1)));
      return `Abstimmungs-Schwelle ${alt} → ${node.threshold}`;
    }
    const kind = wahl(rnd, node.children);
    const alt = kind.weight;
    kind.weight = Math.min(100, Math.max(0.5, runde(alt * (rnd() < 0.5 ? 0.5 : 2))));
    return `Stimmgewicht (${blattText(kind.node)}) ${alt} → ${kind.weight}`;
  }
  return null;
}

function opTausch(root: RuleNode, rnd: () => number): string | null {
  const blaetter = alleStellen(root).filter((s) => s.parent !== null && istBlatt(s.node));
  if (blaetter.length === 0) return null;
  const stelle = wahl(rnd, blaetter);
  const alt = blattText(stelle.node);
  // Nicht durch sich selbst tauschen — sonst ist die „Mutation" ein No-op.
  const pool = BLATT_KATALOG.filter((b) => blattText(b) !== alt);
  const neu = klon(wahl(rnd, pool));
  ersetzeKind(stelle.parent!, stelle.index, neu);
  return `Blatt getauscht — ${alt} → ${blattText(neu)}`;
}

function opStreichen(root: RuleNode, rnd: () => number): string | null {
  // Streichbar: Kind eines all/any/weighted mit ≥ 2 Kindern (Schema-Minimum
  // bleibt 1) — oder ein not-Wrapper, der durch sein Kind ersetzt wird.
  const stellen = alleStellen(root);
  const kandidaten = stellen.filter(
    ({ parent, node }) =>
      (parent !== null &&
        (parent.type === 'all' || parent.type === 'any' || parent.type === 'weighted') &&
        parent.children.length >= 2) ||
      node.type === 'not',
  );
  if (kandidaten.length === 0) return null;
  const stelle = wahl(rnd, kandidaten);
  if (stelle.node.type === 'not') {
    const kind = stelle.node.child;
    if (stelle.parent === null) return null; // Wurzel-not: Ersatz wäre Vorzeichenwechsel des ganzen Baums
    ersetzeKind(stelle.parent, stelle.index, kind);
    return `not-Wrapper entfernt um „${blattText(kind)}"`;
  }
  const parent = stelle.parent!;
  if (parent.type === 'all' || parent.type === 'any') parent.children.splice(stelle.index, 1);
  else if (parent.type === 'weighted') parent.children.splice(stelle.index, 1);
  return `Zweig gestrichen — ${blattText(stelle.node)}`;
}

function opErgaenzen(root: RuleNode, rnd: () => number, spielraum: number): string | null {
  if (spielraum < 1) return null; // Knoten-Deckel: gar nicht erst versuchen
  const container = alleStellen(root).filter(
    ({ node }) => node.type === 'all' || node.type === 'any' || node.type === 'weighted',
  );
  if (container.length === 0) return null;
  const ziel = wahl(rnd, container).node;
  const neu = klon(wahl(rnd, BLATT_KATALOG));
  if (ziel.type === 'weighted') (ziel as WeightedNode).children.push({ weight: 1, node: neu });
  else if (ziel.type === 'all' || ziel.type === 'any') ziel.children.push(neu);
  return `Bedingung ergänzt (${ziel.type}) — ${blattText(neu)}`;
}

function opKippen(root: RuleNode, rnd: () => number): string | null {
  const kandidaten = alleStellen(root).filter(({ node }) =>
    node.type === 'all' ||
    node.type === 'any' ||
    node.type === 'crossover' ||
    node.type === 'changePct' ||
    node.type === 'priceLevel' ||
    (node.type === 'compare' && typeof node.right === 'number'),
  );
  if (kandidaten.length === 0) return null;
  const { node } = wahl(rnd, kandidaten);
  if (node.type === 'all') {
    (node as { type: string }).type = 'any';
    return 'Verknüpfung gekippt — alle → mindestens eine';
  }
  if (node.type === 'any') {
    (node as { type: string }).type = 'all';
    return 'Verknüpfung gekippt — mindestens eine → alle';
  }
  if (node.type === 'crossover') {
    node.direction = node.direction === 'above' ? 'below' : 'above';
    return `Kreuzungsrichtung gekippt (${node.fast}/${node.slow})`;
  }
  if (node.type === 'changePct') {
    node.op = node.op === 'gte' ? 'lte' : 'gte';
    return `Δ-Vergleich gekippt (${node.lookbackBars} Bars)`;
  }
  if (node.type === 'priceLevel') {
    node.side = node.side === 'above' ? 'below' : 'above';
    return `Preis-Seite gekippt (Marke ${node.level})`;
  }
  if (node.type === 'compare') {
    const flip = { lt: 'gt', lte: 'gte', gt: 'lt', gte: 'lte' } as const;
    node.op = flip[node.op];
    return `Vergleich gekippt — ${blattText(node)}`;
  }
  return null;
}

/* ── Öffentliche API ─────────────────────────────────────────────────────── */

/**
 * Eine Mutation mit VORGEGEBENEM Operator auf einem der beiden Bäume.
 * null = verworfen (Operator findet nichts, oder das Ergebnis verletzt
 * einen Guard). Für Tests und gezielte Suche; `mutiereSpec` wählt zufällig.
 */
export function mutiereSpecMitOp(
  spec: StrategySpec,
  op: MutationsOp,
  seed: number,
): MutationsErgebnis | null {
  const rnd = mulberry32(seed);
  const kopie = klon(spec);
  const seite: 'buy' | 'sell' = rnd() < 0.5 ? 'buy' : 'sell';
  const root = kopie[seite];
  // Knoten-Deckel gilt JE Baum (validateRuleTree prüft buy und sell einzeln);
  // fürs Ergänzen zählt also der Spielraum des mutierten Baums.
  const frei = MAX_NODES - countRuleNodes(root);
  let text: string | null = null;
  switch (op) {
    case 'parameter':
      text = opParameter(root, rnd);
      break;
    case 'tausch':
      text = opTausch(root, rnd);
      break;
    case 'streichen':
      text = opStreichen(root, rnd);
      break;
    case 'ergaenzen':
      text = opErgaenzen(root, rnd, frei);
      break;
    case 'kippen':
      text = opKippen(root, rnd);
      break;
  }
  if (text === null) return null;
  // Guards sind Veto, keine Reparatur: ungültig ⇒ Mutation verworfen.
  if (validateStrategySpec(kopie).length > 0) return null;
  return { spec: kopie, op, beschreibung: `${seite}: ${text}` };
}

/**
 * Eine zufällige Mutation (Operator + Ziel aus dem Seed). null = verworfen —
 * der Aufrufer versucht es mit dem nächsten Seed; bei einem Deckel-Riss ist
 * das Verwerfen genau das gewünschte Verhalten (Sparsamkeits-Bremse).
 */
export function mutiereSpec(spec: StrategySpec, seed: number): MutationsErgebnis | null {
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const op = wahl(rnd, MUTATIONS_OPS);
  return mutiereSpecMitOp(spec, op, seed);
}

/**
 * Startpopulation der Struktursuche: der kompilierte Klassik-Baum des Nutzers
 * plus die fünf Preset-Bäume (Diversität gegen lokale Optima, MILESTONES MO).
 */
export function startPopulation(strategy: Strategy): StrategySpec[] {
  return [compileClassic(strategy), ...STRATEGY_PRESETS.map((p) => klon(p.spec))];
}
