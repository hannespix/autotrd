/**
 * Pattern-Day-Trader-Regel (FINRA): Unter 25 000 $ Equity sind höchstens
 * drei Daytrades in fünf Handelstagen erlaubt; der vierte markiert das
 * Konto als PDT und Alpaca sperrt den Handel. Der alte Code hat die Zahl
 * nur angezeigt — hier ist sie ein Gate.
 *
 * Wahrheit ist die Broker-Zahl (`daytrade_count`); lokal wird ergänzend
 * gezählt, weil die Broker-Zahl erst nach dem Fill steigt und die Engine
 * mehrere Einstiege in einem Zyklus plant.
 */
import type { AssetClass, Trade } from '../core/types.ts';
import { dayKey, prevTradingDayOrNull, type Calendar } from '../core/time.ts';

export interface PdtInput {
  respect: boolean;
  minEquity: number;
  maxDayTrades: number;
  equity: number;
  /** Broker-Zahl (rollierend 5 Handelstage). */
  brokerCount: number;
  /** Lokal gezählte Daytrades im selben Fenster. */
  localCount: number;
  /** Anzahl in diesem Zyklus bereits geplanter Intraday-Einstiege. */
  plannedIntradayEntries: number;
  /** Wird die geplante Position voraussichtlich am selben Tag geschlossen? */
  intraday: boolean;
  assetClass: AssetClass;
}

export interface PdtVerdict {
  allowed: boolean;
  reason: string | null;
  /** Verbleibende Daytrades im Fenster (Infinity, wenn Regel nicht greift). */
  remaining: number;
}

export function pdtCheck(inp: PdtInput): PdtVerdict {
  if (!inp.respect || inp.assetClass === 'crypto') return { allowed: true, reason: null, remaining: Number.POSITIVE_INFINITY };
  if (inp.equity >= inp.minEquity) return { allowed: true, reason: null, remaining: Number.POSITIVE_INFINITY };
  const used = Math.max(inp.brokerCount, inp.localCount) + inp.plannedIntradayEntries;
  const remaining = Math.max(0, inp.maxDayTrades - used);
  if (inp.intraday) {
    if (remaining <= 0) {
      return {
        allowed: false,
        reason: `PDT: ${used}/${inp.maxDayTrades} Daytrades im 5-Tage-Fenster verbraucht (Equity < ${inp.minEquity})`,
        remaining,
      };
    }
    return { allowed: true, reason: null, remaining };
  }
  // Übernacht-Strategien: Ein Stop am selben Tag wäre ein Daytrade — ohne Rest kein Einstieg.
  if (remaining <= 0) {
    return {
      allowed: false,
      reason: `PDT: kein Daytrade mehr frei — auch ein Stop am Einstiegstag zählt (Equity < ${inp.minEquity})`,
      remaining,
    };
  }
  return { allowed: true, reason: null, remaining };
}

/** Daytrades (Ein- und Ausstieg am selben ET-Tag) in den letzten fünf Handelstagen bis `today` (inkl.). */
export function countDayTrades(trades: readonly Trade[], today: string, assetClass: AssetClass, calendar?: Calendar): number {
  let start = today;
  // Am Kalenderanfang kürzer statt Abbruch — wie im Simulator (ein Pfad).
  for (let i = 0; i < 4; i++) {
    const prev = prevTradingDayOrNull(start, assetClass, calendar);
    if (prev === null) break;
    start = prev;
  }
  let n = 0;
  for (const t of trades) {
    const d1 = dayKey(t.entryTime);
    const d2 = dayKey(t.exitTime);
    if (d1 === d2 && d1 >= start && d1 <= today) n++;
  }
  return n;
}
