/** Öffentliche Oberfläche der Engine (für cli.ts/app.ts und Tests). */
export { Engine, warmupWindowMs, type EngineDeps, type EngineStatus, type EngineTimers } from './engine.ts';
export { Book, buildTrade, type BookStateSlice, type ClosedTrade, type EnterIntent, type ExitIntent, type MoveStopIntent, type PendingEntry, type PendingExit, type ProtectiveOrder } from './book.ts';
export {
  OrderExecutor,
  cryptoStopLimitFor,
  exitSideOf,
  fallbackStopFor,
  flattenOrders,
  reasonForOrder,
  roundDirected,
  roundQtyFor,
  roundStopFor,
  roundTargetFor,
  type ExecResult,
  type NotifyFn,
  type OrderExecutorArgs,
} from './orders.ts';
export { reconcile, BLOCKED_NOTE, RECONCILE_GRACE_MS, type ReconcileAccount, type ReconcileArgs, type ReconcileResult } from './reconcile.ts';
export { MarketClock, type ClockSnapshot, type MarketClockArgs } from './clock.ts';
export {
  clientIdMatchesSymbol,
  decisionBucketStart,
  entryClientId,
  exitClientId,
  isOwnClientId,
  parseClientId,
  stopClientId,
  symbolSafe,
  CLIENT_ID_MAX_LEN,
  CLIENT_ID_PREFIX,
  type ClientIdKind,
  type ClientIdMode,
  type ParsedClientId,
} from './ids.ts';
