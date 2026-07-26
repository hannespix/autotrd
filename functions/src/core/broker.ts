/**
 * Broker-Schicht — Port von reference/scripts/broker.py auf Firestore.
 *
 * Paper-Ausführung läuft als Firestore-TRANSAKTION über users/{uid}:
 * wallet-Feld (Cash), positions/{symbol}, trades/{tradeId} — alles Felder,
 * die Clients per Rules NICHT schreiben können (ARCHITECTURE §5).
 *
 * SICHERHEIT (Port der Python-Guards, niemals lockern):
 * - Default ist immer Paper.
 * - Echtgeld erfordert BEIDES: strategy.broker.mode === 'live' UND
 *   env ALPACA_ALLOW_LIVE === '1' — sonst automatischer Downgrade auf Paper.
 *   Der Alpaca-Slot selbst kommt in M13/M14; resolveBrokerMode() ist heute
 *   schon die einzige Stelle, die über den Modus entscheidet.
 * - Keys nur aus env/Secret Manager, nie geloggt.
 */

import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { PAPER_FEE_RATE, paperEffectivePrice } from '../../../shared/src/index.js';
import type { Position, Strategy, Trade } from '../../../shared/src/index.js';

export type BrokerMode = 'paper' | 'live';

/** Einzige Stelle, die den effektiven Broker-Modus bestimmt (Doppel-Guard). */
export function resolveBrokerMode(strategy: Strategy): BrokerMode {
  const wantLive = strategy.broker.mode === 'live';
  if (wantLive && process.env.ALPACA_ALLOW_LIVE === '1') return 'live';
  return 'paper';
}

/** Geldbeträge auf Cent runden — Float-Drift hat im Kontostand nichts zu suchen. */
function roundCents(v: number): number {
  return Math.round(v * 100) / 100;
}

export interface TradeResult {
  executed: boolean;
  reason?: string;
  trade?: Trade & { id: string };
}

export interface TradeRequest {
  uid: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  /** Stückzahl; ohne Angabe beim Kauf: Positionsgröße aus maxPositionPct. */
  qty?: number;
  source: 'engine' | 'manual';
  /** Risiko-Exit-Grund (stop_loss/take_profit), nur für Engine-Verkäufe. */
  riskExit?: string;
}

/**
 * Paper-Trade transaktional ausführen (Port von _execute_trade):
 * - buy: nie nachkaufen (Position existiert → no-op); Größe = maxPositionPct
 *   vom Startkapital (wie Referenz) bzw. explizite qty; Cash-Deckung nötig.
 * - sell: nur mit Position; realisiert P&L in den Trade-Record.
 */
export async function executePaperTrade(req: TradeRequest, strategy: Strategy): Promise<TradeResult> {
  const db = getFirestore();
  const userRef = db.doc(`users/${req.uid}`);
  const posRef = userRef.collection('positions').doc(req.symbol);
  const tradeRef = userRef.collection('trades').doc();

  if (!(req.price > 0) || !Number.isFinite(req.price)) {
    return { executed: false, reason: 'kein_preis' };
  }

  return db.runTransaction(async (tx) => {
    const [userSnap, posSnap] = await Promise.all([tx.get(userRef), tx.get(posRef)]);
    if (!userSnap.exists) return { executed: false, reason: 'kein_profil' };
    const balance = (userSnap.get('wallet.paperBalance') as number | undefined) ?? 0;
    const now = new Date().toISOString();

    // Realismus (User-Wunsch 25.07.): Ausführung zum EFFEKTIVEN Preis —
    // Kommission + Slippage wie im Backtest; rawPrice bleibt im Record.
    const eff = Math.round(paperEffectivePrice(req.price, req.side) * 10_000) / 10_000;

    if (req.side === 'buy') {
      if (posSnap.exists) return { executed: false, reason: 'position_existiert' };
      const capital = strategy.broker.initialCapital;
      const maxPct = strategy.engine.maxPositionPct / 100;
      const qty = req.qty ?? Math.floor((capital * maxPct) / eff);
      if (qty < 1) return { executed: false, reason: 'qty_unter_1' };
      const cost = qty * eff;
      if (cost > balance) return { executed: false, reason: 'zu_wenig_cash' };

      const position: Position = {
        symbol: req.symbol,
        qty,
        avgEntry: eff,
        stopLoss: strategy.engine.stopLossPct > 0
          ? eff * (1 - strategy.engine.stopLossPct / 100)
          : null,
        takeProfit: strategy.engine.takeProfitPct > 0
          ? eff * (1 + strategy.engine.takeProfitPct / 100)
          : null,
        openedAt: now,
      };
      const trade: Trade = {
        symbol: req.symbol,
        side: 'buy',
        qty,
        price: eff,
        executedAt: now,
        source: req.source,
        paper: true,
      };
      tx.set(posRef, position);
      tx.set(tradeRef, { ...trade, at: Timestamp.now(), rawPrice: req.price, feeRate: PAPER_FEE_RATE });
      // Auf Cent runden (Audit 26.07.): Ohne das sammelt der Float-Rest jedes
      // Trades im Kontostand an — nach vielen Zyklen driftet er sichtbar.
      tx.update(userRef, { 'wallet.paperBalance': roundCents(balance - cost), 'wallet.updatedAt': now });
      return { executed: true, trade: { ...trade, id: tradeRef.id } };
    }

    // sell
    if (!posSnap.exists) return { executed: false, reason: 'keine_position' };
    const pos = posSnap.data() as Position;
    const qty = pos.qty;
    const proceeds = qty * eff;
    const pnl = (eff - pos.avgEntry) * qty;
    const trade: Trade & { pnl: number; riskExit?: string } = {
      symbol: req.symbol,
      side: 'sell',
      qty,
      price: eff,
      executedAt: now,
      source: req.source,
      paper: true,
      pnl: Math.round(pnl * 100) / 100,
      ...(req.riskExit ? { riskExit: req.riskExit } : {}),
    };
    tx.delete(posRef);
    tx.set(tradeRef, { ...trade, at: Timestamp.now(), rawPrice: req.price, feeRate: PAPER_FEE_RATE });
    tx.update(userRef, { 'wallet.paperBalance': roundCents(balance + proceeds), 'wallet.updatedAt': now });
    return { executed: true, trade: { ...trade, id: tradeRef.id } };
  });
}

/**
 * Stop-Loss/Take-Profit einer offenen Position prüfen (Port von _check_risk).
 * Liefert den Exit-Grund oder null.
 *
 * Engine-Audit 26.07. (MA1) — zwei Härtungen gegenüber dem Port:
 *  1. Die beim Kauf gespeicherten LEVEL der Position haben Vorrang vor den
 *     heutigen Prozenten. Sonst verschiebt eine Settings-Änderung rückwirkend
 *     die Stops aller offenen Positionen, während die UI die alten Level zeigt.
 *  2. Prozentwert ≤ 0 heißt „diese Seite ist AUS" (wie `null` beim Level) —
 *     vorher feuerte takeProfitPct = 0 wegen `change >= 0` bei jedem
 *     Nicht-Verlust sofort, stopLossPct = 0 analog bei jedem Minus.
 */
export function riskExitReason(pos: Position, price: number, strategy: Strategy): string | null {
  if (!(pos.avgEntry > 0) || !(price > 0)) return null;

  const level = (v: number | null | undefined): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  const stopLevel = level(pos.stopLoss);
  const takeLevel = level(pos.takeProfit);

  if (stopLevel !== null) {
    if (price <= stopLevel) return 'stop_loss';
  } else if (strategy.engine.stopLossPct > 0) {
    if (price / pos.avgEntry - 1 <= -strategy.engine.stopLossPct / 100) return 'stop_loss';
  }

  if (takeLevel !== null) {
    if (price >= takeLevel) return 'take_profit';
  } else if (strategy.engine.takeProfitPct > 0) {
    if (price / pos.avgEntry - 1 >= strategy.engine.takeProfitPct / 100) return 'take_profit';
  }

  return null;
}

/** Tages-Quota (admin/quotas/{uid}) transaktional erhöhen; false = Limit erreicht. */
export async function consumeQuota(uid: string, kind: string, dailyLimit: number): Promise<boolean> {
  const db = getFirestore();
  const day = new Date().toISOString().slice(0, 10);
  const ref = db.doc(`admin/quotas-${uid}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const key = `${kind}_${day}`;
    const used = (snap.get(key) as number | undefined) ?? 0;
    if (used >= dailyLimit) return false;
    tx.set(ref, { [key]: FieldValue.increment(1) }, { merge: true });
    return true;
  });
}
