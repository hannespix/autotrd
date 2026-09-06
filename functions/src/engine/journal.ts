/**
 * Journal des Takts: puffert im Speicher und schreibt am Ende des Nutzer-
 * Takts EINEN Batch nach `users/{uid}/journal` — plus, je abgeschlossenem
 * Trade, zwei Trade-Docs im ALTEN Schema nach `users/{uid}/trades`
 * (`shared/src/strategy.ts`, `Trade`): Einstiegs-Fill und Ausstiegs-Fill,
 * genau so, wie Frontend und `taxReport` sie seit M12 lesen.
 *
 * Was NICHT nach Firestore geht (Takt-Rauschen): `start`/`stop` (jeder Takt
 * startet und stoppt die Engine), die Abgleich-Zusammenfassung (jeder Takt
 * gleicht ab) und die Notiz „Halt aktiv" je Symbol und Bar — sonst
 * entstünden 2 880 + n Dokumente am Tag für die Information „nichts
 * passiert".
 *
 * EZB-Kurs: Jede Seite eines Trades bekommt den Kurs IHRES Tages
 * eingefroren (Steuerregel, siehe `shared/src/fx.ts`). Ist er nicht
 * belegbar, stehen die Felder auf null — nie ein Ersatzwert.
 */
import type { JournalEvent, JournalEventKind, JournalLike } from '../../../src/core/journal.ts';
import { errMsg, logger } from '../../../src/core/log.ts';
import { DAY } from '../../../src/core/time.ts';
import type { AssetClass, ExitReason, Ms, Trade } from '../../../src/core/types.ts';
import { createHash } from 'node:crypto';
import { BATCH_MAX, isoOf, plain, round2, type DocData, type FirestoreLike, type WriteBatchLike, type WriteGuard } from './firestoreLike.js';

/**
 * Deterministische Doc-IDs (Secreview 3, #5): Ein Nachschreiben nach teilweise committetem Batch (oder
 * einer Function, die zwischen zwei Batches starb) trifft dieselben Docs wieder — `set` ist dann idempotent,
 * statt Journal- und Trade-Docs zu verdoppeln. Zwei bis aufs Byte gleiche Ereignisse fallen zusammen; das
 * ist gewollt (dieselbe Information zweimal ist keine zweite Information).
 */
export function journalDocId(uid: string, ev: JournalEvent): string {
  return 'j' + createHash('sha256').update(`${uid}|${ev.ts}|${ev.kind}|${JSON.stringify(plain(ev))}`).digest('hex').slice(0, 24);
}

export function tradeDocId(uid: string, t: Trade, leg: 'entry' | 'exit'): string {
  const key = [uid, t.symbol, t.side, t.qty, t.entryTime, t.entryPrice, t.exitTime, t.exitPrice, t.exitReason, leg].join('|');
  return 't' + createHash('sha256').update(key).digest('hex').slice(0, 24);
}

export interface FxFelder {
  fxRate?: number;
  fxDate?: string;
  fxSource?: string;
}

/** `functions/src/core/fx.ts#fxFelder` — injizierbar, damit Tests ohne Netz und Firestore laufen. */
export type FxFn = (executedAtIso: string, waehrung: string) => Promise<FxFelder>;

export interface FirestoreJournalOptions {
  db: FirestoreLike;
  mode: 'paper' | 'live';
  assetClass: AssetClass;
  fx: FxFn;
  log?: typeof logger | undefined;
  /** Stempel `at` der Trade-Docs; Default `Timestamp.now()` des Admin-SDK (erst beim Schreiben geladen). */
  timestampNow?: (() => unknown) | undefined;
}

/** Takt-Rauschen bleibt draußen; alles andere wird geschrieben. */
export function keepEvent(ev: JournalEvent): boolean {
  if (ev.kind === 'start' || ev.kind === 'stop') return false;
  if (ev.kind === 'reconcile' && ev.action === 'summary') return false;
  if (ev.kind === 'decision' && ev.note === 'blocked' && typeof ev.text === 'string' && ev.text.startsWith('Halt aktiv')) return false;
  return true;
}

/**
 * `riskExit` im Vokabular des Frontends (`tradeStoryVideo.netzZeile`):
 * gesetzt (und damit wahr) genau bei Stop, Tages-Notbremse und Drawdown-Halt.
 */
export function riskExitOf(reason: ExitReason): string | null {
  switch (reason) {
    case 'stop':
      return 'stop_loss';
    case 'kill_switch':
      return 'daily_loss';
    case 'drawdown':
      return 'drawdown';
    default:
      return null;
  }
}

export function isTrade(x: unknown): x is Trade {
  if (typeof x !== 'object' || x === null) return false;
  const t = x as Record<string, unknown>;
  return (
    typeof t.symbol === 'string' &&
    (t.side === 'long' || t.side === 'short') &&
    typeof t.qty === 'number' &&
    typeof t.entryPrice === 'number' &&
    typeof t.exitPrice === 'number' &&
    typeof t.entryTime === 'number' &&
    typeof t.exitTime === 'number' &&
    typeof t.exitReason === 'string'
  );
}

function fxOrNull(f: FxFelder | null): { fxRate: number | null; fxDate: string | null; fxSource: string | null } {
  if (f && typeof f.fxRate === 'number' && f.fxRate > 0) return { fxRate: f.fxRate, fxDate: f.fxDate ?? null, fxSource: f.fxSource ?? null };
  return { fxRate: null, fxDate: null, fxSource: null };
}

export interface TradeDocOptions {
  mode: 'paper' | 'live';
  assetClass: AssetClass;
  /** Teilschluss (Position verkleinert, nicht geschlossen). */
  partial: boolean;
  /** Ausstiegskurs geschätzt (Abgleich ohne Fill-Beleg). */
  estimated: boolean;
  fxEntry: FxFelder | null;
  fxExit: FxFelder | null;
  /** `Timestamp.now()` — wird NICHT durch die JSON-Rundreise geschickt. */
  at: unknown;
  orderId: string | null;
}

/** Ein abgeschlossener Engine-Trade als zwei Fills im alten Schema (Einstieg, Ausstieg). */
export function tradeDocsFor(trade: Trade, o: TradeDocOptions): { entry: DocData; exit: DocData } {
  const long = trade.side === 'long';
  const base = {
    symbol: trade.symbol,
    source: 'engine' as const,
    paper: o.mode === 'paper',
    assetClass: o.assetClass,
    currency: 'USD',
    strategy: trade.strategy,
    preisQuelle: 'broker' as const,
    engineMode: o.mode,
  };
  const entry: DocData = {
    ...base,
    side: long ? 'buy' : 'sell',
    ...(long ? {} : { short: true }),
    qty: trade.qty,
    price: trade.entryPrice,
    rawPrice: trade.entryPrice,
    executedAt: isoOf(trade.entryTime),
    fee: 0,
    ...fxOrNull(o.fxEntry),
  };
  const riskExit = riskExitOf(trade.exitReason);
  const exit: DocData = {
    ...base,
    side: long ? 'sell' : 'buy',
    ...(long ? {} : { cover: true }),
    qty: trade.qty,
    price: trade.exitPrice,
    rawPrice: trade.exitPrice,
    executedAt: isoOf(trade.exitTime),
    fee: round2(trade.fees),
    pnl: round2(trade.netPnl),
    grossPnl: round2(trade.grossPnl),
    entryPrice: trade.entryPrice,
    acquiredAt: isoOf(trade.entryTime),
    holdingDays: round2((trade.exitTime - trade.entryTime) / DAY),
    exitReason: trade.exitReason,
    ...(riskExit ? { riskExit } : {}),
    rMultiple: trade.rMultiple,
    barsHeld: trade.barsHeld,
    ...(o.partial ? { teilSchluss: true } : {}),
    ...(o.estimated ? { preisQuelle: 'modell', kursGeschaetzt: true } : {}),
    ...(o.orderId ? { brokerOrderId: o.orderId } : {}),
    ...fxOrNull(o.fxExit),
  };
  return { entry: { ...plain(entry), at: o.at }, exit: { ...plain(exit), at: o.at } };
}

export class FirestoreJournal implements JournalLike {
  private readonly db: FirestoreLike;
  private readonly mode: 'paper' | 'live';
  private readonly assetClass: AssetClass;
  private readonly fx: FxFn;
  private readonly log: typeof logger;
  private readonly timestampNow: (() => unknown) | undefined;
  private readonly buffer: JournalEvent[] = [];

  constructor(o: FirestoreJournalOptions) {
    this.db = o.db;
    this.mode = o.mode;
    this.assetClass = o.assetClass;
    this.fx = o.fx;
    this.log = o.log ?? logger;
    this.timestampNow = o.timestampNow;
  }

  append(kind: JournalEventKind, data: Record<string, unknown> = {}, ts: Ms = Date.now()): void {
    // `ts`/`kind` gewinnen — wie im Datei-Journal.
    this.buffer.push({ ...data, ts, kind });
  }

  readAll(): JournalEvent[] {
    return [...this.buffer];
  }

  trades(): Trade[] {
    return this.buffer.filter((e) => e.kind === 'trade_closed' && isTrade(e.trade)).map((e) => e.trade as Trade);
  }

  /** Ungeschriebene Ereignisse (für Tests und Diagnose). */
  pending(): number {
    return this.buffer.length;
  }

  /** Ungeschriebene Ereignisse — der State-Speicher schreibt sie als Puffer mit ins State-Doc. */
  pendingEvents(): JournalEvent[] {
    return [...this.buffer];
  }

  /** Puffer aus dem State-Doc eines früheren Takts VORNE einreihen (ältere Ereignisse zuerst). */
  restore(events: JournalEvent[]): void {
    if (events.length === 0) return;
    this.buffer.unshift(...events);
    this.log.warn('Journal-Puffer aus dem State-Doc übernommen — Ereignisse eines früheren Takts werden nachgeschrieben', { events: events.length });
  }

  /**
   * Puffer als Batch(es) nach Firestore; bei Erfolg geleert, bei Fehler bleibt er stehen und der Fehler
   * fliegt. `finalOp` (Puffer auf dem State-Doc leeren) landet im LETZTEN Batch — atomar mit dessen Docs.
   */
  async flush(uid: string, finalOp: ((b: WriteBatchLike) => void) | null = null, guard: WriteGuard | null = null): Promise<{ events: number; trades: number }> {
    const events = [...this.buffer];
    const journalCol = this.db.collection(`users/${uid}/journal`);
    const tradesCol = this.db.collection(`users/${uid}/trades`);
    const ops: Array<(b: WriteBatchLike) => void> = [];
    let kept = 0;
    for (const ev of events) {
      if (!keepEvent(ev)) continue;
      const doc = plain({ ...ev, mode: this.mode });
      const id = journalDocId(uid, ev);
      ops.push((b) => b.set(journalCol.doc(id), doc));
      kept++;
    }
    let trades = 0;
    for (const ev of events) {
      if (ev.kind !== 'trade_closed' || !isTrade(ev.trade)) continue;
      const t = ev.trade;
      const [fxEntry, fxExit] = await Promise.all([this.fxFor(t.entryTime), this.fxFor(t.exitTime)]);
      const docs = tradeDocsFor(t, {
        mode: this.mode,
        assetClass: this.assetClass,
        partial: ev.partial === true,
        estimated: ev.estimatedPrice === true,
        fxEntry,
        fxExit,
        at: await this.stamp(),
        orderId: typeof ev.orderId === 'string' ? ev.orderId : null,
      });
      ops.push((b) => b.set(tradesCol.doc(tradeDocId(uid, t, 'entry')), docs.entry));
      ops.push((b) => b.set(tradesCol.doc(tradeDocId(uid, t, 'exit')), docs.exit));
      trades++;
    }
    if (finalOp) ops.push(finalOp);
    for (let i = 0; i < ops.length; i += BATCH_MAX) {
      guard?.assert('Journal');
      const batch = this.db.batch();
      for (const op of ops.slice(i, i + BATCH_MAX)) op(batch);
      await batch.commit();
    }
    this.buffer.length = 0;
    return { events: kept, trades };
  }

  private async fxFor(ms: Ms): Promise<FxFelder | null> {
    const iso = isoOf(ms);
    try {
      const f = await this.fx(iso, 'USD');
      if (typeof f.fxRate === 'number' && f.fxRate > 0) return f;
      this.log.warn('EZB-Kurs nicht belegbar — Trade-Doc ohne fx-Felder (null)', { tag: iso.slice(0, 10) });
      return null;
    } catch (e) {
      this.log.warn('EZB-Kurs-Abruf fehlgeschlagen — Trade-Doc ohne fx-Felder (null)', { tag: iso.slice(0, 10), error: errMsg(e) });
      return null;
    }
  }

  private async stamp(): Promise<unknown> {
    if (this.timestampNow) return this.timestampNow();
    const { Timestamp } = await import('firebase-admin/firestore');
    return Timestamp.now();
  }
}
