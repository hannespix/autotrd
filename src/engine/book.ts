/**
 * Das Buch: In-Memory-Sicht auf Positionen, offene Einstiege, Schutz-Stops
 * und laufende Exits — plus die eine Stelle, an der aus einer Position ein
 * abgeschlossener `Trade` wird (Brutto, R-Multiple, Daytrade-Zählung).
 *
 * Grundsatz „nichts buchen ohne Fill": Das Buch wird nur aus Fill-
 * Ereignissen bzw. per REST gelesenen gefüllten Orders verändert — nie
 * aus dem Absenden einer Order. Der Absende-Zustand ist `pendingEntries`.
 *
 * Persistenz: `EngineState` kennt je Symbol die client_order_id der
 * offenen Einstiegs-Order und des Schutz-Stops sowie den laufenden eigenen
 * Exit samt Intent (für den Wiederholversuch nach Neustart/Takt). Der
 * Einstiegs-Intent (Stop/Ziel/Strategie) ist nach einem Neustart `null` und
 * wird beim Nachsehen der Order aus deren Beinen rekonstruiert.
 */
import type { EngineState } from '../core/journal.ts';
import { advancePosition } from '../core/logic.ts';
import { dayKeyFor } from '../core/time.ts';
import type { AssetClass, ExitReason, Ms, OrderIntent, PositionState, Trade } from '../core/types.ts';

export type EnterIntent = Extract<OrderIntent, { kind: 'enter' }>;
export type ExitIntent = Extract<OrderIntent, { kind: 'exit' }>;
export type MoveStopIntent = Extract<OrderIntent, { kind: 'move_stop' }>;

export interface PendingEntry {
  clientId: string;
  /** Broker-ID, sobald bekannt (nach dem Senden bzw. Nachsehen). */
  orderId: string | null;
  /** Der gesendete Intent (Stop/Ziel bereits gerundet); null nach Neustart. */
  intent: EnterIntent | null;
  submittedAt: Ms;
}

export interface ProtectiveOrder {
  orderId: string | null;
  clientId: string;
  stop: number;
}

export interface PendingExit {
  clientId: string | null;
  orderId: string | null;
  reason: ExitReason;
  since: Ms;
  attempts: number;
  lastAttemptAt: Ms;
  lastError: string | null;
  /** Ursprünglicher Intent — für den Wiederholversuch im nächsten Tick. */
  intent: ExitIntent | null;
}

export interface BookStateSlice {
  positions: Record<string, PositionState>;
  pendingEntries: Record<string, string>;
  protectiveOrders: Record<string, string>;
  pendingExits: Record<string, PendingExit>;
  bookedExitQty: Record<string, Record<string, number>>;
  dayTrades: Record<string, number>;
}

export interface ClosedTrade {
  trade: Trade;
  /** true, wenn die Position damit vollständig geschlossen ist. */
  fullyClosed: boolean;
  /** true, wenn dieser Schluss als Daytrade gezählt wurde. */
  dayTrade: boolean;
}

/** Trade-Objekt aus Position + Ausstiegsdaten — Backtest wie Live identisch. Gebühren im Live-Buch nach Kostenmodell (siehe orders.ts). */
export function buildTrade(pos: PositionState, qty: number, exitPrice: number, exitTime: Ms, reason: ExitReason, fees = 0): Trade {
  const grossPnl = (pos.side === 'long' ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice) * qty;
  const netPnl = grossPnl - fees;
  const riskPerUnit = pos.initialStop === null ? 0 : Math.abs(pos.entryPrice - pos.initialStop);
  const risk = riskPerUnit * qty;
  return {
    symbol: pos.symbol,
    side: pos.side,
    qty,
    entryTime: pos.entryTime,
    entryPrice: pos.entryPrice,
    exitTime,
    exitPrice,
    grossPnl,
    fees,
    netPnl,
    rMultiple: risk > 0 ? netPnl / risk : null,
    exitReason: reason,
    strategy: pos.strategy,
    barsHeld: pos.barsHeld,
    mae: null,
    mfe: null,
    ...(pos.stufe !== undefined ? { stufe: pos.stufe } : {}),
  };
}

export class Book {
  readonly positions = new Map<string, PositionState>();
  readonly pendingEntries = new Map<string, PendingEntry>();
  readonly protectiveOrders = new Map<string, ProtectiveOrder>();
  /** Laufende eigene Exits — persistiert (Wiederholversuch überlebt Neustart und Takt), per REST nachgesehen. */
  readonly pendingExits = new Map<string, PendingExit>();
  /** Symbol → (Order-ID → gebuchte Exit-Menge) — persistiert, damit Teilfills nach Neustart nicht doppelt buchen. */
  readonly bookedExitQty = new Map<string, Map<string, number>>();
  /** Lokal gezählte Daytrades je Handelstag. */
  readonly dayTrades = new Map<string, number>();

  static fromState(s: EngineState): Book {
    const b = new Book();
    for (const [sym, pos] of Object.entries(s.positions)) b.positions.set(sym, { ...pos });
    for (const [sym, clientId] of Object.entries(s.pendingEntries)) {
      b.pendingEntries.set(sym, { clientId, orderId: null, intent: null, submittedAt: s.updatedAt });
    }
    for (const [sym, clientId] of Object.entries(s.protectiveOrders)) {
      const pos = b.positions.get(sym);
      b.protectiveOrders.set(sym, { orderId: null, clientId, stop: pos?.stop ?? 0 });
    }
    for (const [sym, pe] of Object.entries(s.pendingExits ?? {})) {
      if (!b.positions.has(sym)) continue; // ohne Position gibt es nichts zu wiederholen
      b.pendingExits.set(sym, { ...pe, intent: pe.intent ? { ...pe.intent } : null });
    }
    for (const [sym, byOrder] of Object.entries(s.bookedExitQty ?? {})) {
      if (!b.positions.has(sym)) continue;
      b.bookedExitQty.set(sym, new Map(Object.entries(byOrder).filter(([, q]) => typeof q === 'number' && q > 0)));
    }
    for (const [day, n] of Object.entries(s.dayTrades)) b.dayTrades.set(day, n);
    return b;
  }

  toState(): BookStateSlice {
    const positions: Record<string, PositionState> = {};
    for (const [sym, pos] of this.positions) positions[sym] = { ...pos };
    const pendingEntries: Record<string, string> = {};
    for (const [sym, pe] of this.pendingEntries) pendingEntries[sym] = pe.clientId;
    const protectiveOrders: Record<string, string> = {};
    for (const [sym, po] of this.protectiveOrders) protectiveOrders[sym] = po.clientId;
    const pendingExits: Record<string, PendingExit> = {};
    for (const [sym, pe] of this.pendingExits) pendingExits[sym] = { ...pe, intent: pe.intent ? { ...pe.intent } : null };
    const bookedExitQty: Record<string, Record<string, number>> = {};
    for (const [sym, byOrder] of this.bookedExitQty) if (byOrder.size > 0) bookedExitQty[sym] = Object.fromEntries(byOrder);
    const dayTrades: Record<string, number> = {};
    for (const [day, n] of this.dayTrades) dayTrades[day] = n;
    return { positions, pendingEntries, protectiveOrders, pendingExits, bookedExitQty, dayTrades };
  }

  open(pos: PositionState): void {
    this.positions.set(pos.symbol, pos);
  }

  /** Position entfernen (samt Schutz-Stop-/Exit-Verweisen). Gibt die entfernte Position zurück. */
  close(symbol: string): PositionState | null {
    const pos = this.positions.get(symbol) ?? null;
    this.positions.delete(symbol);
    this.protectiveOrders.delete(symbol);
    this.pendingExits.delete(symbol);
    this.bookedExitQty.delete(symbol);
    return pos;
  }

  /** Bereits gebuchte Exit-Menge einer Broker-Order (0, wenn unbekannt). */
  bookedExit(symbol: string, orderId: string): number {
    return this.bookedExitQty.get(symbol)?.get(orderId) ?? 0;
  }

  /** Gebuchte Exit-Menge einer Broker-Order festhalten (kumuliert, wie Alpacas `filled_qty`). */
  markBookedExit(symbol: string, orderId: string, qty: number): void {
    let m = this.bookedExitQty.get(symbol);
    if (!m) {
      m = new Map();
      this.bookedExitQty.set(symbol, m);
    }
    if (qty > 0) m.set(orderId, qty);
    else m.delete(orderId);
    // Handvoll Orders je Position — mehr als 50 heißt Müll, ältester Eintrag fliegt.
    if (m.size > 50) m.delete(m.keys().next().value!);
  }

  markPending(symbol: string, entry: PendingEntry): void {
    this.pendingEntries.set(symbol, entry);
  }

  clearPending(symbol: string): void {
    this.pendingEntries.delete(symbol);
  }

  /** Nach einer geschlossenen Bar je Symbol fortschreiben (Haltedauer, Hochwasser). */
  advanceAll(closes: ReadonlyMap<string, number>): void {
    for (const [sym, close] of closes) {
      const pos = this.positions.get(sym);
      if (pos) this.positions.set(sym, advancePosition(pos, close));
    }
  }

  recordDayTrade(day: string): void {
    this.dayTrades.set(day, (this.dayTrades.get(day) ?? 0) + 1);
  }

  /** Summe der lokal gezählten Daytrades über die angegebenen Tage. */
  dayTradesIn(days: Iterable<string>): number {
    let n = 0;
    for (const d of days) n += this.dayTrades.get(d) ?? 0;
    return n;
  }

  /** Tage aus der Zählung entfernen, die vor `keepFromDay` liegen. */
  pruneDayTrades(keepFromDay: string): void {
    for (const day of [...this.dayTrades.keys()]) if (day < keepFromDay) this.dayTrades.delete(day);
  }

  /**
   * Teil- oder Vollschluss buchen: Trade bauen, Position verkleinern bzw.
   * entfernen. Ein Daytrade wird einmal je Position gezählt (beim
   * Vollschluss, wenn Einstiegs- und Ausstiegstag gleich sind) — so zählt
   * Alpaca (Round-Trip), und so gilt die PDT-Regel.
   */
  closeTrade(symbol: string, qty: number, exitPrice: number, exitTime: Ms, reason: ExitReason, assetClass: AssetClass, fees = 0): ClosedTrade | null {
    const pos = this.positions.get(symbol);
    if (!pos || !(qty > 0) || !(exitPrice > 0)) return null;
    const q = Math.min(qty, pos.qty);
    const trade = buildTrade(pos, q, exitPrice, exitTime, reason, fees);
    const fullyClosed = q >= pos.qty - 1e-9;
    let dayTrade = false;
    if (fullyClosed) {
      this.close(symbol);
      const exitDay = dayKeyFor(exitTime, assetClass);
      if (exitDay === pos.entryDay) {
        this.recordDayTrade(exitDay);
        dayTrade = true;
      }
    } else {
      this.positions.set(symbol, { ...pos, qty: Number((pos.qty - q).toFixed(8)) });
    }
    return { trade, fullyClosed, dayTrade };
  }
}
