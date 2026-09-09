/**
 * Spiegel für das Frontend — nach jedem Nutzer-Takt:
 *
 *  (a) `users/{uid}/positions/{symbol}` aus dem Engine-Buch im alten Schema
 *      (`shared/src/strategy.ts`, `Position`). Docs geschlossener Positionen
 *      werden gelöscht (Diff gegen den Bestand der Sammlung).
 *  (b) `users/{uid}`: `wallet.paperBalance`/`wallet.updatedAt` und das
 *      Objekt `engine` (Merge — `settings` wird nie angefasst).
 *  (c) `market/{symbol}.quote` aus dem letzten Close der Takt-Bars, damit das
 *      Frontend Positionen bewerten kann.
 *
 * Der Spiegel ist Anzeige, nie Wahrheit: Die Wahrheit ist der Engine-State
 * (`private/engineState`) und das Journal. Deshalb schreibt der Takt den
 * Positions-Diff NUR nach einem gelungenen Lauf — nach einem Fehler bliebe
 * sonst ein leeres Buch stehen und löschte Positionen, die es noch gibt.
 */
import type { Ms, PositionState } from '../../../src/core/types.ts';
import type { EngineStatus } from '../../../src/engine/engine.ts';
import { BATCH_MAX, docIdFor, isoOf, plain, round2, type DocData, type FirestoreLike } from './firestoreLike.js';

/**
 * Stufe, die ein Symbol GERADE führt (`strategyFor`): champion, basis oder
 * config — für Positions- und Trade-Docs, damit das Frontend die Quelle
 * „Basis" zeigen kann. Die Wahl muss zur Strategie der Position passen; sonst
 * ist die Stufe unbekannt (Champion über Nacht gewechselt) und bleibt weg.
 */
export type StufeFn = (symbol: string, strategyId: string) => string | undefined;

/** Positions-Doc im alten Schema plus Engine-Felder (additiv). */
export function positionDocOf(p: PositionState, protectiveClientId: string | undefined, now: Ms, stufe?: string | undefined): DocData {
  const schutz = protectiveClientId !== undefined && p.stop !== null ? { orderId: protectiveClientId, stopPreis: p.stop, qty: p.qty } : null;
  return {
    ...(stufe !== undefined ? { stufe } : {}),
    symbol: p.symbol,
    qty: p.qty,
    avgEntry: p.entryPrice,
    stopLoss: p.stop,
    takeProfit: p.target,
    openedAt: isoOf(p.entryTime),
    highWater: p.highWater,
    side: p.side,
    broker: true,
    schutz,
    strategy: p.strategy,
    initialStop: p.initialStop,
    barsHeld: p.barsHeld,
    entryDay: p.entryDay,
    quelle: 'engine',
    updatedAt: isoOf(now),
  };
}

export async function mirrorPositions(db: FirestoreLike, uid: string, status: EngineStatus, now: Ms, stufeFor?: StufeFn | undefined): Promise<{ written: number; deleted: number }> {
  const col = db.collection(`users/${uid}/positions`);
  const existing = await col.get();
  const want = new Map<string, DocData>();
  for (const p of status.positions) want.set(docIdFor(p.symbol), positionDocOf(p, status.protectiveOrders[p.symbol], now, stufeFor?.(p.symbol, p.strategy)));
  const batch = db.batch();
  let written = 0;
  let deleted = 0;
  for (const [id, doc] of want) {
    batch.set(col.doc(id), plain(doc));
    written++;
  }
  for (const d of existing.docs) {
    if (want.has(d.id)) continue;
    batch.delete(d.ref);
    deleted++;
  }
  if (written + deleted > 0) await batch.commit();
  return { written, deleted };
}

export interface UserMirror {
  mode: 'paper' | 'live';
  status: EngineStatus;
  now: Ms;
  lastError: string | null;
  /** `basis`: Symbole, die die Basis-Stufe führt (Teilmenge von `symbols`); fehlt vor der Basis-Stufe. */
  champion: { source: string; symbols: string[]; basis?: string[] | undefined };
  /** Kommando-Doc wurde in diesem Takt geprüft ⇒ `engine.commandAt` zurücksetzen. */
  commandsSeen: boolean;
  configSource?: string | undefined;
  /** Strategie-Notizen des Takts (Champion fehlt, Zeitrahmen, Sperre) — immer gespiegelt, nur bei Änderung journaliert. */
  notes?: readonly string[] | undefined;
}

export function engineFieldOf(m: UserMirror): DocData {
  const s = m.status;
  return {
    mode: m.mode,
    running: true,
    halt: s.halt,
    equity: s.equity,
    cash: s.cash,
    dayStartEquity: s.dayStartEquity,
    peakEquity: s.peakEquity,
    day: s.day,
    dayTradeCount: s.dayTradeCount,
    localDayTrades: s.localDayTrades,
    patternDayTrader: s.patternDayTrader,
    positions: s.positions.map((p) => p.symbol),
    pendingEntries: s.pendingEntries,
    pendingExits: s.pendingExits,
    deferred: s.deferredIntents,
    consecutiveErrors: s.consecutiveErrors,
    entryLock: s.entryLock,
    lastTickAt: isoOf(m.now),
    lastError: m.lastError,
    champion: { source: m.champion.source, symbols: m.champion.symbols, ...(m.champion.basis !== undefined ? { basis: m.champion.basis } : {}) },
    notes: [...(m.notes ?? [])],
    ...(m.configSource !== undefined ? { configSource: m.configSource } : {}),
    ...(m.commandsSeen ? { commandAt: null } : {}),
  };
}

/** `users/{uid}`: Wallet-Spiegel + `engine` (Merge; `settings` bleibt unberührt). */
export async function mirrorUser(db: FirestoreLike, uid: string, m: UserMirror): Promise<void> {
  await db.doc(`users/${uid}`).set(
    plain({
      wallet: { paperBalance: round2(m.status.cash), updatedAt: isoOf(m.now) },
      engine: engineFieldOf(m),
    }),
    { merge: true },
  );
}

/** Nach einem gescheiterten Nutzer-Takt: nur den Fehler spiegeln, kein Positions-Diff. */
export async function mirrorError(db: FirestoreLike, uid: string, error: string, now: Ms): Promise<void> {
  await db.doc(`users/${uid}`).set(plain({ engine: { running: true, lastError: error, lastTickAt: isoOf(now) } }), { merge: true });
}

export interface QuoteMark {
  symbol: string;
  price: number;
  /** Zeitpunkt, für den der Kurs gilt (Ende der letzten Bar). */
  at: Ms;
}

/** `market/{symbol}.quote` (Merge) — einmal je Takt, nicht je Nutzer. */
export async function mirrorQuotes(db: FirestoreLike, quotes: readonly QuoteMark[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < quotes.length; i += BATCH_MAX) {
    const batch = db.batch();
    let inBatch = 0;
    for (const q of quotes.slice(i, i + BATCH_MAX)) {
      if (!(q.price > 0)) continue;
      batch.set(db.doc(`market/${docIdFor(q.symbol)}`), { quote: { price: q.price, updatedAt: isoOf(q.at), quelle: 'engine' } }, { merge: true });
      inBatch++;
    }
    if (inBatch > 0) await batch.commit();
    n += inBatch;
  }
  return n;
}
