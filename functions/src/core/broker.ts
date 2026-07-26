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
import { PAPER_FEE_RATE, paperEffectivePrice, resolveRisk } from '../../../shared/src/index.js';
import type { Position, RiskConfig, Strategy, Trade } from '../../../shared/src/index.js';

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

/**
 * Positionsgröße eines Kaufs (pure, testbar) — MA-Audit 26.07.:
 * Basis ist per Default der VERFÜGBARE Cash ('balance'), nicht mehr das
 * Startkapital. Grund (Owner-Feedback): Mit fixen Startkapital-Tranchen
 * scheiterte jeder Kauf still an 'zu_wenig_cash', sobald der Rest-Cash die
 * Tranche nicht mehr deckte — das Wallet stand dann groß im Depot, aber der
 * Auto-Trader handelte nicht mehr. Cash-Basis kann IMMER kaufen, solange
 * floor(cash·pct/price) ≥ 1 Stück ergibt. 'initial' bleibt als bewusste
 * Option für fixe Tranchen (Referenz-Verhalten).
 */
export function sizeOrder(strategy: Strategy, balance: number, effPrice: number): number {
  const base = strategy.broker.sizingBase ?? 'balance';
  const capital = base === 'initial' ? strategy.broker.initialCapital : Math.max(0, balance);
  return Math.floor((capital * strategy.engine.maxPositionPct) / 100 / effPrice);
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
  /** Risiko-Exit-Grund (stop_loss/take_profit/trailing_stop/max_hold). */
  riskExit?: string;
  /** Asset-Klasse für klassen-spezifische Risiko-Level (MA6). */
  assetClass?: string | null;
}

/**
 * Paper-Trade transaktional ausführen (Port von _execute_trade):
 * - buy: nie nachkaufen (Position existiert → no-op); Größe via sizeOrder()
 *   (maxPositionPct vom Cash bzw. Startkapital) oder explizite qty;
 *   Cash-Deckung nötig.
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
      const qty = req.qty ?? sizeOrder(strategy, balance, eff);
      if (qty < 1) return { executed: false, reason: 'qty_unter_1' };
      const cost = qty * eff;
      if (cost > balance) return { executed: false, reason: 'zu_wenig_cash' };

      // Level klassen-aufgelöst festschreiben (MA6): Krypto bekommt weitere
      // Stops als ein Index. Der Aufrufer reicht die Klasse durch; ohne
      // Angabe gelten die globalen Werte.
      const risk = resolveRisk(strategy.engine, req.assetClass ?? null);
      const position: Position = {
        symbol: req.symbol,
        qty,
        avgEntry: eff,
        stopLoss: risk.stopLossPct > 0 ? eff * (1 - risk.stopLossPct / 100) : null,
        takeProfit: risk.takeProfitPct > 0 ? eff * (1 + risk.takeProfitPct / 100) : null,
        openedAt: now,
        highWater: eff, // Startpunkt des nachziehenden Stops
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
export interface RiskExitContext {
  /** Effektive Risiko-Parameter (klassen-aufgelöst, MA6). */
  risk: RiskConfig;
  /** ATR in Prozent des Kurses — für volatilitätsadaptive Stops. */
  atrPct?: number | null | undefined;
  /** Bezugszeitpunkt (Testbarkeit); Default: jetzt. */
  now?: Date;
}

export function riskExitReason(
  pos: Position,
  price: number,
  strategyOrCtx: Strategy | RiskExitContext,
): string | null {
  if (!(pos.avgEntry > 0) || !(price > 0)) return null;

  // Aufruf mit Strategy (Altpfad) oder mit aufgelöstem Kontext (MA6)
  const ctx: RiskExitContext =
    'engine' in strategyOrCtx
      ? { risk: resolveRisk(strategyOrCtx.engine, null) }
      : strategyOrCtx;
  const r = ctx.risk;
  const now = ctx.now ?? new Date();

  const level = (v: number | null | undefined): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  const pct = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  // Schwellen mit Toleranz vergleichen: `92/100 - 1` ergibt in Gleitkomma
  // -0.07999999999999996 und verfehlt einen 8-%-Stop damit knapp. Wer 8 %
  // einstellt, will bei exakt 8 % raus — nicht bei 8,0000001 %.
  const atMost = (v: number, limit: number): boolean => v <= limit + Math.abs(limit) * 1e-9 + 1e-12;
  const atLeast = (v: number, limit: number): boolean => v >= limit - Math.abs(limit) * 1e-9 - 1e-12;

  // ATR-Stops haben Vorrang vor festen Prozenten: Ein 2-%-Stop ist bei BTC
  // Rauschen, bei einem Index ein echtes Signal. atrPct kommt aus den Bars.
  const atrOk = typeof ctx.atrPct === 'number' && Number.isFinite(ctx.atrPct) && ctx.atrPct > 0;
  const stopPct = atrOk && pct(r.atrStopMult) > 0 ? pct(r.atrStopMult) * (ctx.atrPct as number) : pct(r.stopLossPct);
  const takePct = atrOk && pct(r.atrTakeMult) > 0 ? pct(r.atrTakeMult) * (ctx.atrPct as number) : pct(r.takeProfitPct);

  // 1) Nachziehender Stop — SICHERT GEWINNE, ersetzt aber nicht den festen
  // Stop. Er greift deshalb erst, wenn die Position im Plus war (Höchstkurs
  // über dem Einstand); solange sie nie im Gewinn stand, ist allein der
  // feste bzw. ATR-Stop zuständig. Ohne diese Trennung würde ein enger
  // Trailing-Wert ein bewusst weit gesetztes Stop-Level überstimmen.
  const trailPct = pct(r.trailingStopPct);
  if (trailPct > 0) {
    const peak = level(pos.highWater) ?? 0;
    if (peak > pos.avgEntry && atMost(price, peak * (1 - trailPct / 100))) return 'trailing_stop';
  }

  // 2) Fester Stop: gespeichertes Level schlägt den Prozentwert
  const stopLevel = level(pos.stopLoss);
  if (stopLevel !== null) {
    if (atMost(price, stopLevel)) return 'stop_loss';
  } else if (stopPct > 0 && atMost(price / pos.avgEntry - 1, -stopPct / 100)) {
    return 'stop_loss';
  }

  // 3) Take-Profit: ebenso Level vor Prozent
  const takeLevel = level(pos.takeProfit);
  if (takeLevel !== null) {
    if (atLeast(price, takeLevel)) return 'take_profit';
  } else if (takePct > 0 && atLeast(price / pos.avgEntry - 1, takePct / 100)) {
    return 'take_profit';
  }

  // 4) Zeitgrenze: eine ewig seitwärts laufende Position bindet Kapital
  const maxDays = pct(r.maxHoldDays);
  if (maxDays > 0) {
    const opened = Date.parse(pos.openedAt);
    if (Number.isFinite(opened) && now.getTime() - opened >= maxDays * 86_400_000) return 'max_hold';
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
