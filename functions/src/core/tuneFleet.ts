/**
 * tuneFleet.ts — die Schatten-Flotte des Auto-Tuners (MT2, Ausführung).
 *
 * Jede Variante aus `buildVariants` führt hier ein eigenes virtuelles Konto.
 * Sie sieht dieselben Kurse und benutzt dieselbe Entscheidungslogik wie der
 * echte Pfad — nur mit ihren eigenen Parametern. Nach ein paar Wochen hat
 * jede Variante genug abgeschlossene Trades, damit `judgeCandidate` sagen
 * kann, ob sie die amtierende Einstellung schlägt.
 *
 * **Warum Schatten und nicht Backtest.** Ein Parametergitter über die
 * Vergangenheit findet zuverlässig die Kombination, die vergangenes Rauschen
 * am besten erklärt — und versagt danach. Die Flotte handelt dagegen auf
 * Kursen, die zum Zeitpunkt der Entscheidung noch niemand kannte. Das ist
 * echte Out-of-Sample-Evidenz und kostet nichts außer Rechenzeit: Die
 * Marktdaten sind ohnehin schon geladen, es kommt kein einziger Fetch dazu.
 *
 * Der Kern ist BEWUSST pur — ein Schritt der Flotte ist eine Funktion von
 * (Zustand, Marktdaten, Zeit) auf einen neuen Zustand. Dadurch lässt sich
 * das Zusammenspiel aus Ein-/Ausstieg, Haltefrist und Kauf-Pause testen,
 * ohne eine Datenbank zu starten, und der Aufrufer kümmert sich nur ums
 * Speichern.
 */

import {
  PAPER_FEE_RATE,
  classify,
  describeVariant,
  judgeCandidate,
  resolveRisk,
  type EvidenceOptions,
  type Strategy,
  type Variant,
} from '../../../shared/src/index.js';
// Dieselbe Konfluenz-Funktion wie der echte Pfad — eine zweite Rechnung
// würde die Vergleichbarkeit zerstören, die der ganze Zweck der Flotte ist.
import { computeSignal } from './engine.js';
import { cooldownActive, minHoldActive, shadowTrade, type ShadowBook } from './rulesTrading.js';

/** Was die Flotte je Symbol braucht — eine Teilmenge der Scan-Daten. */
export interface FleetSymbolData {
  closes: number[];
  closes5m?: number[] | undefined;
  price: number;
  forecast?: { predictedPct: number } | null | undefined;
  intradayPct?: number | null | undefined;
}

/** Zustand EINER Variante. Wird als JSON am User-Dokument gehalten. */
export interface VariantState {
  book: ShadowBook;
  /**
   * Ergebnisse abgeschlossener Trades, jüngste zuletzt. Genau das braucht
   * `judgeCandidate` — mehr wird nicht aufgehoben, damit das Dokument nicht
   * unbegrenzt wächst.
   */
  pnls: number[];
  /** Letzter Trade je Symbol — Grundlage der Kauf-Pause. */
  lastTrades: Record<string, string>;
  startedAt: string;
}

export type FleetState = Record<string, VariantState>;

/** Startkapital eines Schattenkontos — gleich dem Paper-Default. */
export const FLEET_START_BALANCE = 25_000;
/** Obergrenze der aufgehobenen Ergebnisse je Variante. */
export const MAX_PNLS = 400;

export function emptyVariantState(now: Date): VariantState {
  return {
    book: { balance: FLEET_START_BALANCE, positions: {} },
    pnls: [],
    lastTrades: {},
    startedAt: now.toISOString(),
  };
}

function signalCloses(d: FleetSymbolData, tf: 'daily' | 'intraday'): number[] {
  if (tf === 'intraday' && (d.closes5m?.length ?? 0) >= 35) return d.closes5m!;
  return d.closes;
}

/**
 * Risiko-Ausstiege einer Schatten-Position prüfen.
 *
 * Bewusst mit denselben Marken wie der echte Pfad (`resolveRisk` je
 * Asset-Klasse): Eine Variante, die großzügigere Stops bekäme, wäre nicht
 * vergleichbar — und genau die Vergleichbarkeit ist der ganze Zweck.
 */
function riskExitReason(
  strategy: Strategy,
  symbol: string,
  entry: number,
  price: number,
  side: 'long' | 'short',
): string | null {
  const r = resolveRisk(strategy.engine, classify(symbol));
  const pct = side === 'short' ? (entry / price - 1) * 100 : (price / entry - 1) * 100;
  if (pct <= -r.stopLossPct) return 'stop_loss';
  if (pct >= r.takeProfitPct) return 'take_profit';
  return null;
}

export interface FleetStepResult {
  state: FleetState;
  /** Abgeschlossene Trades dieses Schrittes — nur fürs Protokoll. */
  closed: number;
}

/**
 * Einen Scan-Schritt für die ganze Flotte rechnen.
 *
 * Die Reihenfolge spiegelt den echten Pfad: erst Risiko-Ausstiege (die
 * greifen immer und sofort), dann die Signal-Entscheidung (die Haltefrist
 * und Kauf-Pause respektiert). Andersherum wären die Ergebnisse nicht
 * vergleichbar — und ein nicht vergleichbares Ergebnis ist schlimmer als
 * gar keines, weil es zu einer falschen Beförderung führen kann.
 */
export function stepFleet(
  variants: Variant[],
  market: Map<string, FleetSymbolData>,
  vorher: FleetState,
  symbols: string[],
  now: Date,
): FleetStepResult {
  const state: FleetState = { ...vorher };
  let closed = 0;

  for (const variant of variants) {
    const s = variant.strategy;
    let st = state[variant.id] ?? emptyVariantState(now);
    let book = st.book;
    const lastTrades = { ...st.lastTrades };
    const pnls = [...st.pnls];
    const tf = s.signals.timeframe === 'daily' ? 'daily' : 'intraday';
    const cdMin = s.engine.cooldownMin ?? 60;
    const minHold = s.engine.minHoldMin ?? 0;

    for (const symbol of symbols) {
      const data = market.get(symbol);
      if (!data || !(data.price > 0)) continue;
      const pos = book.positions[symbol];

      // 1. Risiko-Ausstiege — immer und unabhängig von jeder Frist.
      if (pos) {
        const seite = pos.side === 'short' ? 'short' : 'long';
        const grund = riskExitReason(s, symbol, pos.avgEntry, data.price, seite);
        if (grund) {
          const vorBalance = book.balance;
          const r = shadowTrade(book, symbol, seite === 'short' ? 'buy' : 'sell', data.price, s.engine.maxPositionPct);
          if (r.executed) {
            book = r.book;
            lastTrades[symbol] = now.toISOString();
            pnls.push(Math.round((book.balance - vorBalance - pos.qty * pos.avgEntry) * 100) / 100);
            closed += 1;
            continue;
          }
        }
      }

      // 2. Signal-Entscheidung mit den Parametern DIESER Variante.
      const nachPos = book.positions[symbol];
      const sig = computeSignal(
        signalCloses(data, tf),
        data.price,
        s.indicators,
        s.signals,
        tf === 'intraday'
          ? data.intradayPct != null
            ? { predictedPct: data.intradayPct }
            : null
          : (data.forecast ?? null),
        {
          hasPosition: nachPos !== undefined,
          ...(nachPos?.side === 'short' ? { positionSide: 'short' as const } : {}),
        },
      );

      if (sig.direction === 'buy' && !nachPos) {
        if (cooldownActive(lastTrades[symbol], now, cdMin)) continue;
        const r = shadowTrade(book, symbol, 'buy', data.price, s.engine.maxPositionPct, {
          now,
          fractional: classify(symbol) === 'crypto',
        });
        if (r.executed) {
          book = r.book;
          lastTrades[symbol] = now.toISOString();
        }
      } else if (sig.direction === 'sell' && nachPos && nachPos.side !== 'short') {
        // Die Haltefrist bremst NUR hier — Risiko-Ausstiege liefen oben.
        if (minHoldActive(nachPos.openedAt, now, minHold)) continue;
        const vorBalance = book.balance;
        const einstand = nachPos.qty * nachPos.avgEntry;
        const r = shadowTrade(book, symbol, 'sell', data.price, s.engine.maxPositionPct);
        if (r.executed) {
          book = r.book;
          lastTrades[symbol] = now.toISOString();
          pnls.push(Math.round((book.balance - vorBalance - einstand) * 100) / 100);
          closed += 1;
        }
      }
    }

    st = {
      book,
      // Nur die jüngsten Ergebnisse aufheben: Die Evidenzschwelle braucht 30,
      // und ein unbegrenzt wachsendes Feld sprengte irgendwann das Dokument.
      pnls: pnls.slice(-MAX_PNLS),
      lastTrades,
      startedAt: st.startedAt,
    };
    state[variant.id] = st;
  }

  // Varianten, die es nicht mehr gibt (Achse geändert, Basis verschoben),
  // fallen raus — sonst sammelte sich Ballast, dessen Zahlen zu Parametern
  // gehören, die niemand mehr fährt.
  const aktuell = new Set(variants.map((v) => v.id));
  for (const id of Object.keys(state)) if (!aktuell.has(id)) delete state[id];

  return { state, closed };
}

/**
 * Roundtrip-Kosten der Flotte in Prozent — dieselbe Annahme wie beim
 * Paper-Broker, damit die Schatten-Ergebnisse mit den echten vergleichbar
 * sind. `shadowTrade` rechnet sie bereits in den Ausführungspreis.
 */
export const FLEET_ROUNDTRIP_PCT = PAPER_FEE_RATE * 2 * 100;

/* ── Entscheiden und Protokollieren (MT4/MT5) ─────────────────────────────── */

export interface JournalEntry {
  at: string;
  variantId: string;
  /** Klartext der Änderung: „Mindest-Haltedauer 60 → 120". */
  change: string;
  /** Begründung aus judgeCandidate — mit Zahlen, nachprüfbar. */
  reason: string;
  promoted: boolean;
  p: number | null;
  edge: number;
  nCandidate: number;
  nIncumbent: number;
}

export interface TuneDecision {
  winner: Variant | null;
  /** Ein Eintrag JE geprüfter Variante — auch für die abgelehnten. */
  entries: JournalEntry[];
}

/**
 * Prüft alle Varianten gegen die amtierende Einstellung und wählt höchstens
 * EINE Siegerin.
 *
 * Warum nur eine je Durchgang: Zwei gleichzeitige Änderungen lassen sich
 * hinterher nicht mehr auseinanderhalten — man wüsste nicht, welche geholfen
 * hat. Und die neue Einstellung muss sich erst wieder Evidenz erarbeiten,
 * bevor der nächste Vergleich Sinn ergibt.
 *
 * Protokolliert wird JEDE geprüfte Variante, auch die abgelehnten. Ein
 * Journal, das nur Erfolge zeigt, verschweigt genau das Interessante: Wie
 * viele Ideen ausprobiert und verworfen wurden — und warum.
 */
export function decideTuning(
  base: Strategy,
  variants: Variant[],
  fleet: FleetState,
  livePnls: number[],
  now: Date,
  opts: EvidenceOptions = {},
): TuneDecision {
  const entries: JournalEntry[] = [];
  let winner: Variant | null = null;
  let bestEdge = 0;

  for (const v of variants) {
    const st = fleet[v.id];
    const verdict = judgeCandidate(
      { pnls: st?.pnls ?? [], label: v.id },
      { pnls: livePnls, label: 'aktuell' },
      opts,
    );
    entries.push({
      at: now.toISOString(),
      variantId: v.id,
      change: describeVariant(base, v),
      reason: verdict.reason,
      promoted: false,
      p: verdict.p,
      edge: verdict.edge,
      nCandidate: verdict.nCandidate,
      nIncumbent: verdict.nIncumbent,
    });
    if (verdict.promote && verdict.edge > bestEdge) {
      bestEdge = verdict.edge;
      winner = v;
    }
  }

  if (winner) {
    const treffer = entries.find((e) => e.variantId === winner!.id);
    if (treffer) treffer.promoted = true;
  }
  return { winner, entries };
}
