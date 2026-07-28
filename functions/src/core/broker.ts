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
import {
  DEFAULT_MARGIN_RATE,
  PAPER_FEE_RATE,
  classify,
  marginInterest,
  paperEffectivePrice,
  resolveRisk,
  riskBasedQty,
  sizeWithMargin,
} from '../../../shared/src/index.js';
import type { Position, RiskConfig, Strategy, Trade } from '../../../shared/src/index.js';

/**
 * Margin-Budget, das der AUFRUFER mitbringt (Scan bzw. Puls).
 *
 * Warum nicht im Broker selbst gerechnet: Die Nachschuss-Mathematik braucht
 * den MARKTWERT aller offenen Positionen, und den kennt nur der Scan — er hat
 * die Kurse gerade geholt. Der Broker läuft in einer Transaktion über GENAU
 * EIN Positions-Dokument; er müsste alle anderen nachladen und hätte trotzdem
 * keine Kurse dazu, sondern nur Einstände. Mit Einständen gerechnet wäre das
 * Budget aber systematisch zu groß, sobald das Depot im Minus steht — also
 * genau dann, wenn es darauf ankommt.
 *
 * FEHLT das Feld, handelt der Broker bar gedeckt wie bisher. Das ist kein
 * Fallback, sondern der Normalfall: Ohne Hebel gibt es nichts zu rechnen.
 */
export interface MarginBudget {
  /** Eigenkapital (Cash + Marktwert der Positionen) — Basis der Tranche. */
  equity: number;
  /** Verbleibende Kaufkraft unter dem für DIESE Order geltenden Hebel. */
  buyingPower: number;
  /**
   * Der für DIESE Order geltende Hebel. Er gehört mit ins Budget, weil die
   * Tranche mit ihm skaliert — ohne ihn käme trotz voller Kaufkraft immer
   * nur eine bar gedeckte Positionsgröße heraus, und der Hebel bliebe
   * folgenlos (siehe `sizeWithMargin`).
   */
  leverage: number;
}

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
export function sizeOrder(
  strategy: Strategy,
  balance: number,
  effPrice: number,
  fractional = false,
  margin?: MarginBudget,
  stopDistancePct?: number,
): number {
  // Risiko-Sizing hat Vorrang, wenn es eingeschaltet IST und der Stop-Abstand
  // bekannt ist (28.07.): Dann bestimmt nicht mehr der Depotanteil die
  // Stückzahl, sondern der Betrag, der im Stop-Fall verloren gehen darf —
  // für jede Position derselbe. Fehlt der Stop-Abstand, fällt es bewusst auf
  // den alten Weg zurück statt auf einer unbekannten Zahl zu rechnen.
  const risikoPct = strategy.engine.riskPerTradePct ?? 0;
  if (risikoPct > 0 && typeof stopDistancePct === 'number' && stopDistancePct > 0) {
    const eigenkapital = margin ? margin.equity : Math.max(0, balance);
    const q = riskBasedQty({
      equity: eigenkapital,
      riskPerTradePct: risikoPct,
      stopDistancePct,
      effPrice,
      maxPositionPct: strategy.engine.maxPositionPct,
      ...(margin ? { buyingPower: margin.buyingPower } : {}),
      fractional,
    });
    if (q > 0) return q;
  }
  // Mit Hebel entscheidet nicht mehr der Cash, sondern das EIGENKAPITAL über
  // die Tranche — sonst schrumpfte sie mit jedem Kauf gegen null und der
  // Hebel wäre nach der ersten Handvoll Positionen wirkungslos, obwohl noch
  // Kaufkraft da ist. Die Kaufkraft deckelt zusätzlich (sizeWithMargin).
  if (margin) {
    return sizeWithMargin(margin, strategy.engine.maxPositionPct, effPrice, fractional, margin.leverage);
  }
  const base = strategy.broker.sizingBase ?? 'balance';
  const capital = base === 'initial' ? strategy.broker.initialCapital : Math.max(0, balance);
  const raw = (capital * strategy.engine.maxPositionPct) / 100 / effPrice;
  // Krypto handelt real in BRUCHTEILEN (MA-Fund 26.07.): floor auf ganze
  // Stücke ergab bei BTC (~64 000 $) mit einer 2 500-$-Tranche IMMER 0 —
  // die Engine konnte teure Coins schlicht nie kaufen ('qty_unter_1').
  // µ-Einheiten (6 Nachkommastellen) sind Kauf-Standard der Krypto-Börsen.
  if (fractional) return Math.floor(raw * 1e6) / 1e6;
  return Math.floor(raw);
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
  /**
   * Leerverkauf erlauben (Owner 26.07.): sell OHNE Position eröffnet dann
   * einen Short statt mit 'keine_position' abzulehnen. Buy auf eine
   * Short-Position deckt IMMER ein (kein Flag nötig — die Position sagt es).
   */
  openShort?: boolean;
  /**
   * Kaufkraft unter Hebel (Owner-Wunsch 28.07.). Ohne dieses Feld ist der
   * Trade strikt BAR gedeckt — exakt das Verhalten von vorher. Der Aufrufer
   * setzt es nur, wenn `broker.leverage > 1` UND das Signal überzeugend
   * genug ist (`effectiveLeverage`).
   */
  margin?: MarginBudget;
  /**
   * Abstand vom Einstieg bis zum Stop in % — Basis des Risiko-Sizings.
   * Der Aufrufer löst ihn auf (ATR-Vielfaches vor festem Prozentwert),
   * damit die Position mit demselben Abstand DIMENSIONIERT wird, mit dem
   * sie später GESTOPPT wird.
   */
  stopDistancePct?: number;
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
      // Buy auf eine SHORT-Position = Eindecken (Cover): Margin + P&L zurück.
      // P&L eines Shorts = (Einstand − Rückkaufkurs) × Stück — verdient,
      // wenn der Kurs seit dem Leerverkauf GEFALLEN ist.
      if (posSnap.exists && (posSnap.data() as Position).side === 'short') {
        const pos = posSnap.data() as Position;
        const qty = pos.qty;
        const pnl = (pos.avgEntry - eff) * qty;
        const margin = qty * pos.avgEntry;
        const trade: Trade & { pnl: number; riskExit?: string; cover: boolean } = {
          symbol: req.symbol,
          side: 'buy',
          qty,
          price: eff,
          executedAt: now,
          source: req.source,
          paper: true,
          pnl: Math.round(pnl * 100) / 100,
          cover: true,
          ...(req.riskExit ? { riskExit: req.riskExit } : {}),
        };
        tx.delete(posRef);
        tx.set(tradeRef, { ...trade, at: Timestamp.now(), rawPrice: req.price, feeRate: PAPER_FEE_RATE });
        tx.update(userRef, { 'wallet.paperBalance': roundCents(balance + margin + pnl), 'wallet.updatedAt': now });
        return { executed: true, trade: { ...trade, id: tradeRef.id } };
      }
      if (posSnap.exists) return { executed: false, reason: 'position_existiert' };
      const cls = req.assetClass ?? classify(req.symbol);
      const fractional = cls === 'crypto';
      const qty = req.qty ?? sizeOrder(strategy, balance, eff, fractional, req.margin, req.stopDistancePct);
      if (qty < (fractional ? 1e-6 : 1)) return { executed: false, reason: 'qty_unter_1' };
      const cost = qty * eff;
      // Ohne Hebel prüft der Cash, mit Hebel die Kaufkraft. Der Cash darf
      // dabei NEGATIV werden — das ist der geliehene Betrag, auf den
      // accrueMarginInterest täglich Zinsen bucht.
      if (req.margin) {
        if (cost > req.margin.buyingPower + 1e-9) return { executed: false, reason: 'zu_wenig_kaufkraft' };
      } else if (cost > balance) {
        return { executed: false, reason: 'zu_wenig_cash' };
      }
      const borrowed = roundCents(Math.max(0, cost - Math.max(0, balance)));

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
      // `borrowed` steht am Trade, damit im Nachhinein nachvollziehbar ist,
      // welcher Einstieg auf Kredit lief — im Kontostand allein ist das
      // später nicht mehr auseinanderzuhalten.
      tx.set(tradeRef, {
        ...trade,
        at: Timestamp.now(),
        rawPrice: req.price,
        feeRate: PAPER_FEE_RATE,
        ...(borrowed > 0 ? { borrowed } : {}),
      });
      // Auf Cent runden (Audit 26.07.): Ohne das sammelt der Float-Rest jedes
      // Trades im Kontostand an — nach vielen Zyklen driftet er sichtbar.
      tx.update(userRef, { 'wallet.paperBalance': roundCents(balance - cost), 'wallet.updatedAt': now });
      return { executed: true, trade: { ...trade, id: tradeRef.id } };
    }

    // sell
    if (!posSnap.exists) {
      // Leerverkauf (Opt-in via openShort): Verkaufs-Signal ohne Position
      // eröffnet einen Short. Buchhaltung als 100-%-Margin: Der Cash sinkt
      // um qty×eff (Sicherheitsleistung) — so bläht der Leerverkaufs-Erlös
      // weder den Cash noch das Cash-Sizing auf, und beim Eindecken kommt
      // Margin + P&L zurück. Level gespiegelt: Stop ÜBER dem Einstand
      // (steigender Kurs = Verlust), Take darunter, lowWater fürs Trailing.
      if (!req.openShort) return { executed: false, reason: 'keine_position' };
      const cls = req.assetClass ?? classify(req.symbol);
      const fractional = cls === 'crypto';
      const qty = req.qty ?? sizeOrder(strategy, balance, eff, fractional, req.margin, req.stopDistancePct);
      if (qty < (fractional ? 1e-6 : 1)) return { executed: false, reason: 'qty_unter_1' };
      const margin = qty * eff;
      // Gleiche Deckungsprüfung wie beim Kauf: Der Short bindet Sicherheit,
      // und ob die aus Cash oder aus Kaufkraft kommt, entscheidet der Hebel.
      if (req.margin) {
        if (margin > req.margin.buyingPower + 1e-9) return { executed: false, reason: 'zu_wenig_kaufkraft' };
      } else if (margin > balance) {
        return { executed: false, reason: 'zu_wenig_cash' };
      }
      const risk = resolveRisk(strategy.engine, cls);
      const position: Position = {
        symbol: req.symbol,
        qty,
        avgEntry: eff,
        side: 'short',
        stopLoss: risk.stopLossPct > 0 ? eff * (1 + risk.stopLossPct / 100) : null,
        takeProfit: risk.takeProfitPct > 0 ? eff * (1 - risk.takeProfitPct / 100) : null,
        openedAt: now,
        lowWater: eff, // Startpunkt des Short-Trailings
      };
      const trade: Trade & { short: boolean } = {
        symbol: req.symbol,
        side: 'sell',
        qty,
        price: eff,
        executedAt: now,
        source: req.source,
        paper: true,
        short: true,
      };
      tx.set(posRef, position);
      tx.set(tradeRef, { ...trade, at: Timestamp.now(), rawPrice: req.price, feeRate: PAPER_FEE_RATE });
      tx.update(userRef, { 'wallet.paperBalance': roundCents(balance - margin), 'wallet.updatedAt': now });
      return { executed: true, trade: { ...trade, id: tradeRef.id } };
    }
    const pos = posSnap.data() as Position;
    if (pos.side === 'short') return { executed: false, reason: 'short_nachverkauf_verboten' };
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
  const trailPct = pct(r.trailingStopPct);

  if (pos.side === 'short') {
    // SHORT-Spiegelung (Owner 26.07.): Verlust bei STEIGENDEM Kurs.
    // 1) Trailing über lowWater — sichert Gewinne, sobald der Kurs unter
    //    dem Einstand war; Exit, wenn er vom Tief wieder hochläuft.
    if (trailPct > 0) {
      const trough = level(pos.lowWater);
      if (trough !== null && trough < pos.avgEntry && atLeast(price, trough * (1 + trailPct / 100))) {
        return 'trailing_stop';
      }
    }
    // 2) Stop ÜBER dem Einstand: Level vor Prozent
    const sLevel = level(pos.stopLoss);
    if (sLevel !== null) {
      if (atLeast(price, sLevel)) return 'stop_loss';
    } else if (stopPct > 0 && atLeast(price / pos.avgEntry - 1, stopPct / 100)) {
      return 'stop_loss';
    }
    // 3) Take UNTER dem Einstand: Level vor Prozent
    const tLevel = level(pos.takeProfit);
    if (tLevel !== null) {
      if (atMost(price, tLevel)) return 'take_profit';
    } else if (takePct > 0 && atMost(price / pos.avgEntry - 1, -takePct / 100)) {
      return 'take_profit';
    }
  } else {
    // 1) Nachziehender Stop — SICHERT GEWINNE, ersetzt aber nicht den festen
    // Stop. Er greift deshalb erst, wenn die Position im Plus war (Höchstkurs
    // über dem Einstand); solange sie nie im Gewinn stand, ist allein der
    // feste bzw. ATR-Stop zuständig. Ohne diese Trennung würde ein enger
    // Trailing-Wert ein bewusst weit gesetztes Stop-Level überstimmen.
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
  }

  // 4) Zeitgrenze: eine ewig seitwärts laufende Position bindet Kapital
  const maxDays = pct(r.maxHoldDays);
  if (maxDays > 0) {
    const opened = Date.parse(pos.openedAt);
    if (Number.isFinite(opened) && now.getTime() - opened >= maxDays * 86_400_000) return 'max_hold';
  }

  return null;
}

/**
 * Höchstzahl Tage, die eine einzelne Abrechnung nachholt.
 *
 * Ohne Deckel würde ein Konto, dessen letzte Abrechnung Monate zurückliegt
 * (neues Feld, pausierter Scheduler, Wiederherstellung), auf einen Schlag mit
 * einem Jahreszins belastet. Der Fehler ginge dann zu Lasten des Users, und
 * zwar für ein Versäumnis auf unserer Seite.
 */
const MAX_INTEREST_CATCHUP_DAYS = 7;

/**
 * Margin-Zinsen für einen Tag buchen — der dritte Teil, ohne den Hebel eine
 * Schönfärberei wäre (margin.ts, Modul-Kopf).
 *
 * Idempotent über `wallet.marginInterestDate`: Ein zweiter Lauf am selben Tag
 * bucht nichts. Läuft transaktional, weil der Scan parallel Trades schreibt —
 * lesen und schreiben dürfen hier nicht auseinanderfallen.
 *
 * Verzinst wird der NEGATIVE Cash, nicht der Positionswert: Geliehen ist
 * genau der Betrag, den das Konto über sein Bargeld hinaus ausgegeben hat.
 * Ein Konto mit positivem Cash zahlt nichts, auch wenn Hebel erlaubt ist.
 */
export async function accrueMarginInterest(
  uid: string,
  day: string,
  annualRate = DEFAULT_MARGIN_RATE,
): Promise<number> {
  const db = getFirestore();
  const userRef = db.doc(`users/${uid}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) return 0;
    const balance = snap.get('wallet.paperBalance') as number | undefined;
    if (typeof balance !== 'number' || !Number.isFinite(balance)) return 0;
    const last = snap.get('wallet.marginInterestDate') as string | undefined;
    if (last === day) return 0; // heute schon abgerechnet

    const borrowed = Math.max(0, -balance);
    // Auch ohne Schuld das Datum fortschreiben: Sonst sammelt ein Konto, das
    // lange bar geführt wurde, eine riesige Lücke an und zahlt beim ersten
    // Kredit rückwirkend für Tage ohne Kredit.
    let days = 1;
    if (last && /^\d{4}-\d{2}-\d{2}$/.test(last)) {
      const diff = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86_400_000);
      if (Number.isFinite(diff) && diff > 0) days = Math.min(MAX_INTEREST_CATCHUP_DAYS, diff);
      else days = 0; // Datum in der Zukunft/kaputt ⇒ nichts buchen
    }
    const zins = days > 0 ? marginInterest(borrowed, days, annualRate) : 0;
    tx.set(
      userRef,
      {
        wallet: {
          marginInterestDate: day,
          ...(zins > 0
            ? {
                paperBalance: roundCents(balance - zins),
                marginInterestTotal: FieldValue.increment(zins),
                updatedAt: new Date().toISOString(),
              }
            : {}),
        },
      },
      { merge: true },
    );
    return zins;
  });
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
