/**
 * Abgleich Buch ↔ Broker — asymmetrisch, weil die beiden Fehlerbilder
 * verschieden gefährlich sind:
 *
 *  - Buch hat eine Position, der Broker nicht ⇒ das Buch irrt (Fill nicht
 *    mitbekommen, Stop ausgelöst, Mensch hat im Dashboard verkauft). Das
 *    Buch wird bereinigt: Trade mit Grund 'reconcile', laut geloggt.
 *  - Broker hat eine Position, das Buch nicht (Fremdbestand) ⇒ jemand
 *    handelt am Prozess vorbei. Je Config: 'halt' (keine Einstiege, Exits
 *    weiter möglich) oder 'adopt' (übernehmen mit Schutz-Stop 3 % vom
 *    Kurs weg). Mengenabweichung ⇒ die Broker-Menge gilt.
 *
 * Die Sperre 'reconcile' ist ein Messergebnis, kein Schalter: Sie steht,
 * solange Fremdbestand da ist, und fällt von selbst, wenn er weg ist.
 * Ein gesperrtes Konto (trading_blocked/account_blocked) ⇒ Halt 'errors',
 * ebenfalls selbstlösend. Exits werden hier nie gesperrt.
 */
import type { AlpacaClient, AlpacaPosition } from '../alpaca/types.ts';
import type { Config } from '../core/config.ts';
import type { EngineState, JournalLike } from '../core/journal.ts';
import { errMsg, logger } from '../core/log.ts';
import { openPosition } from '../core/logic.ts';
import { dayKeyFor } from '../core/time.ts';
import type { HaltReason, HaltState, Ms } from '../core/types.ts';
import type { Book } from './book.ts';
import { fallbackStopFor, type NotifyFn } from './orders.ts';

export const BLOCKED_NOTE = 'Konto gesperrt (trading_blocked/account_blocked)';
/** Karenz, bevor eine frische Buch-Position als „fehlt beim Broker" gilt (Fill-Latenz des Bestands). */
export const RECONCILE_GRACE_MS = 30_000;

export interface ReconcileAccount {
  equity: number;
  cash: number;
  daytradeCount: number;
  patternDayTrader: boolean;
  tradingBlocked: boolean;
  accountBlocked: boolean;
}

export interface ReconcileResult {
  /** Fremdbestand beim Broker (nicht im Buch). */
  orphans: string[];
  /** Buch-Positionen, die der Broker nicht (mehr) hat — bereinigt. */
  missing: string[];
  /** Korrigierte Symbole (Menge übernommen, adoptiert, Schutz-Stop gesetzt). */
  fixed: string[];
  /** In diesem Lauf gemessene Sperrursache; null ⇒ keine. */
  haltReason: HaltReason | null;
  account: ReconcileAccount;
}

export interface ReconcileArgs {
  client: AlpacaClient;
  book: Book;
  journal: JournalLike;
  config: Config;
  state: EngineState;
  now: Ms;
  notify?: NotifyFn | undefined;
  log?: typeof logger | undefined;
  /** Letzter bekannter Kurs (Schätzung für Buch-Bereinigungen ohne Fill-Beleg). */
  lastPriceOf?: ((symbol: string) => number | undefined) | undefined;
  /** Nach dem Abgleich fehlende Schutz-Stops setzen (OrderExecutor.ensureProtectiveStops). */
  ensureStops?: (() => Promise<string[]>) | undefined;
}

function setHalt(state: EngineState, reason: HaltReason, note: string, now: Ms): HaltState {
  state.halt = { halted: true, reason, since: now, until: null, note };
  return state.halt;
}

function liftHalt(state: EngineState, note: string): void {
  state.halt = { halted: false, reason: null, since: null, until: null, note };
}

export async function reconcile(a: ReconcileArgs): Promise<ReconcileResult> {
  const log = a.log ?? logger;
  const assetClass = a.config.universe.assetClass;
  const say = async (level: 'info' | 'warn' | 'error', text: string): Promise<void> => {
    a.journal.append('notify', { level, text }, a.now);
    if (!a.notify) return;
    try {
      await a.notify(level, text);
    } catch (e) {
      log.warn('Benachrichtigung fehlgeschlagen', { error: errMsg(e) });
    }
  };

  const acc = await a.client.getAccount();
  const account: ReconcileAccount = {
    equity: acc.equity,
    cash: acc.cash,
    daytradeCount: acc.daytradeCount,
    patternDayTrader: acc.patternDayTrader,
    tradingBlocked: acc.tradingBlocked,
    accountBlocked: acc.accountBlocked,
  };
  let haltReason: HaltReason | null = null;

  // Konto gesperrt ⇒ Halt 'errors' (fail-closed); Sperre weg ⇒ Halt fällt von selbst.
  const blocked = acc.tradingBlocked || acc.accountBlocked;
  if (blocked) {
    haltReason = 'errors';
    if (!a.state.halt.halted) {
      setHalt(a.state, 'errors', BLOCKED_NOTE, a.now);
      a.journal.append('halt', { reason: 'errors', note: BLOCKED_NOTE }, a.now);
      await say('error', `${BLOCKED_NOTE} — keine Einstiege`);
    }
  } else if (a.state.halt.halted && a.state.halt.reason === 'errors' && a.state.halt.note === BLOCKED_NOTE) {
    liftHalt(a.state, 'Kontosperre aufgehoben');
    a.journal.append('resume', { note: 'Kontosperre aufgehoben' }, a.now);
  }

  const brokerList = await a.client.listPositions();
  const broker = new Map<string, AlpacaPosition>();
  for (const p of brokerList) broker.set(p.symbol, p);

  const orphans: string[] = [];
  const missing: string[] = [];
  const fixed: string[] = [];

  // 1. Buch → Broker: fehlende Positionen bereinigen, Mengen übernehmen.
  for (const [sym, pos] of [...a.book.positions]) {
    const bp = broker.get(sym);
    if (bp && bp.side === pos.side) {
      if (Math.abs(bp.qty - pos.qty) > 1e-6 && !a.book.pendingEntries.has(sym)) {
        a.book.positions.set(sym, { ...pos, qty: bp.qty });
        a.journal.append('reconcile', { action: 'qty', symbol: sym, book: pos.qty, broker: bp.qty }, a.now);
        log.warn('Abgleich: Menge vom Broker übernommen', { symbol: sym, book: pos.qty, broker: bp.qty });
        fixed.push(sym);
      }
      continue;
    }
    // Frische Position oder laufender Exit: der Fill ist womöglich nur noch nicht verarbeitet.
    if (a.now - pos.entryTime < RECONCILE_GRACE_MS) continue;
    const pending = a.book.pendingExits.get(sym);
    if (pending && a.now - pending.since < RECONCILE_GRACE_MS) continue;
    const price = a.lastPriceOf?.(sym) ?? pos.stop ?? pos.entryPrice;
    const reason = pending?.reason ?? 'reconcile';
    const closed = a.book.closeTrade(sym, pos.qty, price, a.now, reason, assetClass);
    missing.push(sym);
    a.journal.append('reconcile', { action: 'missing', symbol: sym, side: pos.side, qty: pos.qty, note: 'Buch-Position beim Broker nicht vorhanden — bereinigt (Ausstiegskurs geschätzt)' }, a.now);
    if (closed) {
      a.journal.append('trade_closed', { trade: closed.trade, dayTrade: closed.dayTrade, estimatedPrice: true, note: 'reconcile: Kurs geschätzt, fees=0' }, a.now);
    }
    log.error('Abgleich: Buch-Position fehlt beim Broker — Buch bereinigt', { symbol: sym, side: pos.side, qty: pos.qty, price });
    await say('warn', `Abgleich: ${sym} im Buch, aber nicht beim Broker — Buch bereinigt (${reason})`);
    if (bp) orphans.push(sym); // Gegenrichtung beim Broker ⇒ wie Fremdbestand behandeln
  }

  // 2. Broker → Buch: Fremdbestand.
  for (const sym of broker.keys()) {
    if (a.book.positions.has(sym) || a.book.pendingEntries.has(sym)) continue;
    if (!orphans.includes(sym)) orphans.push(sym);
  }
  if (orphans.length > 0) {
    if (a.config.engine.onOrphan === 'adopt') {
      for (const sym of orphans) {
        const bp = broker.get(sym);
        if (!bp || a.book.positions.has(sym)) continue;
        const ref = bp.currentPrice > 0 ? bp.currentPrice : bp.avgEntryPrice;
        const stop = fallbackStopFor(ref, bp.side);
        a.book.open(
          openPosition({ symbol: sym, side: bp.side, qty: bp.qty, fillPrice: bp.avgEntryPrice, fillTime: a.now, stop, target: null, strategy: 'adopted', entryDay: dayKeyFor(a.now, assetClass) }),
        );
        a.journal.append('reconcile', { action: 'adopt', symbol: sym, side: bp.side, qty: bp.qty, avgEntryPrice: bp.avgEntryPrice, stop }, a.now);
        log.warn('Abgleich: Fremdbestand übernommen', { symbol: sym, side: bp.side, qty: bp.qty, stop });
        await say('warn', `Abgleich: Fremdbestand ${sym} ${bp.side} ${bp.qty} übernommen — Schutz-Stop @ ${stop}`);
        fixed.push(sym);
      }
    } else {
      haltReason = haltReason ?? 'reconcile';
      const note = `Fremdbestand beim Broker: ${orphans.join(', ')} — keine Einstiege bis geklärt`;
      if (!a.state.halt.halted) {
        setHalt(a.state, 'reconcile', note, a.now);
        a.journal.append('halt', { reason: 'reconcile', note, orphans }, a.now);
        log.error('Abgleich: Fremdbestand — Halt', { orphans });
        await say('error', note);
      } else if (a.state.halt.reason === 'reconcile' && a.state.halt.note !== note) {
        a.state.halt = { ...a.state.halt, note };
      }
    }
  }
  const stillOrphaned = a.config.engine.onOrphan === 'halt' && orphans.length > 0;
  if (!stillOrphaned && a.state.halt.halted && a.state.halt.reason === 'reconcile') {
    liftHalt(a.state, 'Fremdbestand geklärt');
    a.journal.append('resume', { note: 'Abgleich: Fremdbestand geklärt — Halt aufgehoben' }, a.now);
    log.info('Abgleich: Fremdbestand geklärt — Halt aufgehoben');
  }

  // 3. Schutz-Stops (Regel 5): fehlt einer, wird er sofort gesetzt.
  if (a.ensureStops) {
    try {
      for (const sym of await a.ensureStops()) if (!fixed.includes(sym)) fixed.push(sym);
    } catch (e) {
      log.error('Abgleich: Schutz-Stops nicht prüfbar', { error: errMsg(e) });
      throw e;
    }
  }

  a.journal.append('reconcile', { action: 'summary', orphans, missing, fixed, haltReason, equity: acc.equity, cash: acc.cash, daytradeCount: acc.daytradeCount }, a.now);
  return { orphans, missing, fixed, haltReason, account };
}
