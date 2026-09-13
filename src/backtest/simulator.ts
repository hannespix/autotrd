/**
 * Ereignisgetriebener Portfolio-Backtester.
 *
 * Grundsatz: Der Backtest ENTSCHEIDET nicht — er ruft `decide()` aus
 * core/logic.ts, dieselbe Funktion wie die Live-Engine, und füllt nur die
 * zurückgegebenen Order-Intents. Alles, was der Backtest „besser weiß" als
 * die Engine, wäre ein Messfehler (Owner-Erkenntnis: der alte Backtest maß
 * eine Strategie, die live nie lief).
 *
 * Zeitmodell je Zeitpunkt t (Bucket-Beginn, Vereinigung aller Symbole):
 *   1. Tageswechsel: dayStartEquity, Short-Leihe, PDT-Fenster.
 *   2. Fills der Intents vom VORIGEN Zeitpunkt am OPEN dieser Bar
 *      (Stop nachziehen → Exit → Einstieg), danach Stop/Ziel intrabar —
 *      auch für die eben gefüllte Position.
 *   3. `advancePosition` für offene Positionen, Mark-to-Market.
 *   4. `decide()` mit Präfix-Sicht `series.prefix(i+1)` — eine Strategie
 *      kann physisch nicht in die Zukunft sehen.
 *
 * Fill-Konventionen (siehe costs.ts): Buchung zum Referenzkurs, Slippage
 * und Spread als Kostenposten. Stop-Fills sind Marktorders (mit Slippage),
 * Ziel-Fills Limits (nur Gebühren). Beides in einer Bar ⇒ Stop
 * (pessimistisch). Stop/Ziel gelten ab dem Fill, also schon im
 * Einstiegs-Bar: Live sind die Bracket-Beine sofort aktiv, und jedes Hoch/
 * Tief der Bar liegt zeitlich NACH dem Open — ein Stop-Fill im Einstiegs-
 * Bar ergibt einen Trade mit barsHeld 0.
 *
 * Kein Market-on-Close: Auch ein Exit, der an der letzten Bar des Tages
 * entschieden wird, füllt erst am Open der nächsten Bar desselben Symbols
 * — mit Übernacht-Gap. Live ist die 16:00-Bar erst um 16:00:04 geschlossen,
 * die Marktorder geht nach Börsenschluss raus und füllt am Folge-Open
 * (Red-Team-Befund). Ohne Folgebar (Datenende) gibt es keinen Fill, nur
 * eine Notiz.
 *
 * Bargeld: Das Sizing lief gegen das Bargeld zum Entscheidungs-Close; ein
 * Gap-Open darf das Konto nicht ins Minus hebeln — Long-Fills werden gegen
 * das Bargeld am Fill nachgesizet (0 Stück ⇒ kein Fill, Notiz).
 *
 * AUSWERTUNGSGRÖSSEN (MFE/MAE, `stopTrailed`): Der Simulator führt je
 * offener Position den besten und den schlechtesten Kurs der Haltezeit mit
 * (`updateExcursion`) und hält am Ausstieg fest, ob die Stop-Marke
 * nachgezogen war. Beides wandert AUSSCHLIESSLICH in den fertigen `Trade` —
 * nie in `PositionState`, nie in einen `SymbolSnapshot`, nie in `decide()`.
 * Eine Entscheidung kann sie physisch nicht sehen. Der Schalter
 * `SimInput.excursions` schaltet die Mitschrift ab; dann müssen Trades
 * (außer `mae`/`mfe`) und Equity-Kurve ZEICHENGLEICH bleiben — der Wächter
 * dafür ist test/backtest/anatomie.test.ts. Verändert die Messung das
 * Ergebnis, ist die Messung falsch.
 */
import type { CostConfig, RiskConfig, SessionConfig } from '../core/config.ts';
import { advancePosition, decide, openPosition, qtyStepFor, type LogicContext, type SymbolInput, type WiederaufbauZiel } from '../core/logic.ts';
import type { VolZielResult } from '../risk/volziel.ts';
import {
  DAY,
  MIN,
  bucketEnd,
  dayKeyFor,
  nextTradingDay,
  parseDay,
  prevTradingDayOrNull,
  sessionBounds,
  type Calendar,
  type SessionBounds,
} from '../core/time.ts';
import type {
  AssetClass,
  BarSeriesLike,
  EquityPoint,
  ExitReason,
  HaltState,
  IndicatorSet,
  Ms,
  OrderIntent,
  Params,
  PositionState,
  SessionInfo,
  SimResult,
  SizingSpec,
  Strategy,
  SymbolSnapshot,
  TimeframeMin,
  Trade,
} from '../core/types.ts';
import { borrowCost, fillCosts, regulatoryFees, type FillSide } from './costs.ts';
import { computeMetrics } from './metrics.ts';

export interface SimConfig {
  risk: RiskConfig;
  session: SessionConfig;
  costs: CostConfig;
  assetClass: AssetClass;
  timeframe: TimeframeMin;
}

export interface SimInput {
  /** Je Symbol Bars im Strategie-Zeitrahmen (bereits aggregiert, nur Sitzung). */
  bars: ReadonlyMap<string, BarSeriesLike>;
  benchmark?: BarSeriesLike | undefined;
  /** null ⇒ Symbol nicht handeln. `sizing` (Basis-Stufe: Allokation) geht unverändert in `decide()` — wie in der Engine. */
  strategyFor: (symbol: string) => { strategy: Strategy; params: Params; sizing?: SizingSpec | undefined; stufe?: string | undefined } | null;
  config: SimConfig;
  initialEquity: number;
  /** Entscheidungen/Fills nur für Bars mit t in [start, end); Bars davor sind Warmup, Bars danach werden ignoriert. */
  range?: { start: Ms; end: Ms } | undefined;
  calendar?: Calendar | undefined;
  /** Stressfaktor auf alle Kosten (1 = normal). */
  costMultiplier?: number | undefined;
  /**
   * Kursextreme je Trade mitschreiben (MFE/MAE) — Vorgabe an. Aus bleiben
   * `Trade.mae`/`Trade.mfe` null; alles andere MUSS identisch sein. Der
   * Schalter existiert nur, damit genau das prüfbar ist (siehe Kopf); im
   * Betrieb setzt ihn niemand.
   */
  excursions?: boolean | undefined;
}

type EnterIntent = Extract<OrderIntent, { kind: 'enter' }>;
type ExitIntent = Extract<OrderIntent, { kind: 'exit' }>;

const NO_HALT: HaltState = { halted: false, reason: null, since: null, until: null, note: null };
const ALL_TRADABLE = () => ({ tradable: true, shortable: true });
const MAX_NOTES = 400;

/** Laufzeitzustand je Symbol — bewusst ein flaches, wiederverwendetes Objekt (keine Allokation je Bar). */
interface SymState {
  symbol: string;
  series: BarSeriesLike;
  strategy: Strategy;
  params: Params;
  sizing: SizingSpec | undefined;
  /** Stufe der Wahl (`champion` · `basis` · `config`) — Latte der Notbremse (`risk.tiers`); wie in der Engine. */
  stufe: string | undefined;
  ind: IndicatorSet;
  /** Index der nächsten noch nicht verarbeiteten Bar. */
  cursor: number;
  pendingEnter: EnterIntent | null;
  pendingExit: ExitIntent | null;
  /** Nachgezogener Stop, wirksam ab der nächsten Bar. */
  pendingStop: number | null;
  pos: PositionState | null;
  /** Kosten des Einstiegs-Fills (Slippage + Gebühren). */
  entryCost: number;
  /** Aufgelaufene Short-Leihe der offenen Position. */
  borrow: number;
  /** Kursextreme während der Haltezeit (NaN, solange keine Bar gesehen). */
  mae: number;
  mfe: number;
  /** Inkrementelle Sitzungszählung (Handelstag der letzten Bar, Bars seit Open). */
  prevDay: string;
  barsSinceOpen: number;
  /** Letzter Schlusskurs (Mark-to-Market). */
  lastClose: number;
}

/**
 * Sitzungs-Sicht wie `buildSessionInfo(series.prefix(i+1), i, …)`, aber O(1):
 * `barsSinceOpen` wird inkrementell mitgezählt statt je Bar rückwärts über
 * den Tag zu laufen (bei 1-min-Bars 390 dayKey-Aufrufe je Entscheidung).
 * Die Parität zur Originalfunktion ist per Test festgenagelt
 * (test/backtest/sessionParity.test.ts) — semantisch bleibt es dieselbe
 * Sicht, die auch die Live-Engine hat.
 */
export function sessionInfoIncremental(args: {
  t: Ms;
  day: string;
  barsSinceOpen: number;
  tf: TimeframeMin;
  assetClass: AssetClass;
  bounds: SessionBounds | null;
}): SessionInfo {
  const { t, day, barsSinceOpen, tf, assetClass, bounds } = args;
  if (assetClass === 'crypto') {
    return { isRegularSession: true, minutesToClose: null, minutesSinceOpen: null, barsSinceOpen, isLastBarOfDay: false, day };
  }
  if (!bounds) {
    return { isRegularSession: false, minutesToClose: null, minutesSinceOpen: null, barsSinceOpen, isLastBarOfDay: false, day };
  }
  const inSession = t >= bounds.open && t < bounds.close;
  const end = inSession ? bucketEnd(t, tf, bounds) : t + tf * MIN;
  const minutesToClose = Math.max(0, Math.round((bounds.close - end) / MIN));
  const minutesSinceOpen = Math.max(0, Math.round((end - bounds.open) / MIN));
  // Mit Präfix-Sicht gibt es keine „nächste Bar" — genau wie live.
  const isLastBarOfDay = tf === 1440 || end >= bounds.close;
  return { isRegularSession: inSession, minutesToClose, minutesSinceOpen, barsSinceOpen, isLastBarOfDay, day };
}

/** Vereinigung aller Bar-Zeitpunkte, sortiert und ohne Duplikate. */
function mergedTimes(syms: readonly SymState[]): Float64Array {
  if (syms.length === 1) return syms[0]!.series.t;
  let total = 0;
  for (const s of syms) total += s.series.length;
  const all = new Float64Array(total);
  let k = 0;
  for (const s of syms) {
    all.set(s.series.t, k);
    k += s.series.length;
  }
  all.sort();
  const out = new Float64Array(total);
  let n = 0;
  for (let i = 0; i < total; i++) {
    if (i === 0 || all[i] !== all[i - 1]) out[n++] = all[i]!;
  }
  return out.subarray(0, n);
}

/**
 * Intrabar-Prüfung von Stop und Ziel. Gap durch den Stop ⇒ Fill am Open;
 * Gap durch das Ziel ⇒ Limit füllt am Open (erster Tick, keine Ambiguität);
 * sonst Stop vor Ziel, weil die Bar die Reihenfolge nicht verrät.
 */
function checkStopTarget(pos: PositionState, o: number, h: number, l: number): { price: number; reason: 'stop' | 'target' } | null {
  const stop = pos.stop;
  const target = pos.target;
  if (pos.side === 'long') {
    if (stop !== null && o <= stop) return { price: o, reason: 'stop' };
    if (target !== null && o >= target) return { price: o, reason: 'target' };
    if (stop !== null && l <= stop) return { price: stop, reason: 'stop' };
    if (target !== null && h >= target) return { price: target, reason: 'target' };
    return null;
  }
  if (stop !== null && o >= stop) return { price: o, reason: 'stop' };
  if (target !== null && o <= target) return { price: o, reason: 'target' };
  if (stop !== null && h >= stop) return { price: stop, reason: 'stop' };
  if (target !== null && l <= target) return { price: target, reason: 'target' };
  return null;
}

function calendarDaysBetween(a: string, b: string): number {
  const pa = parseDay(a);
  const pb = parseDay(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / DAY);
}

/** Blockier-Gründe auf ihren Kern kürzen („Schlussfenster (25 ≤ 30 min)" → „Schlussfenster"), damit die Zusammenfassung lesbar bleibt. */
function blockKey(text: string): string {
  const cut = text.indexOf(' (');
  const head = cut >= 0 ? text.slice(0, cut) : text;
  const colon = head.indexOf(': ');
  return colon >= 0 ? head.slice(0, colon) : head;
}

export function simulate(input: SimInput): SimResult {
  const { config, initialEquity, calendar, range } = input;
  const { assetClass, timeframe: tf, risk, session: sessionCfg, costs } = config;
  const mult = input.costMultiplier ?? 1;
  const trackExcursions = input.excursions ?? true;
  const notes: string[] = [];
  let haltNotes = 0;
  // Halt-Notizen sind gedeckelt (ein Halt je Tag über Jahre wäre Rauschen); die Bilanz am Ende nie.
  const haltNote = (s: string) => {
    if (haltNotes++ < MAX_NOTES) notes.push(s);
  };

  /* ── Symbole einrichten: Indikatoren einmal je Symbol ── */
  const syms: SymState[] = [];
  for (const [symbol, series] of input.bars) {
    if (series.length === 0) continue;
    const sp = input.strategyFor(symbol);
    if (!sp) continue;
    syms.push({
      symbol,
      series,
      strategy: sp.strategy,
      params: sp.params,
      sizing: sp.sizing,
      stufe: sp.stufe,
      ind: sp.strategy.precompute(series, sp.params),
      cursor: 0,
      pendingEnter: null,
      pendingExit: null,
      pendingStop: null,
      pos: null,
      entryCost: 0,
      borrow: 0,
      mae: Number.NaN,
      mfe: Number.NaN,
      prevDay: '',
      barsSinceOpen: 0,
      lastClose: Number.NaN,
    });
  }
  const bySymbol = new Map<string, SymState>();
  for (const s of syms) bySymbol.set(s.symbol, s);
  const times = mergedTimes(syms);
  const bench = input.benchmark ?? null;
  let benchIdx = -1;

  /* ── Konto ── */
  let cash = initialEquity;
  let equity = initialEquity;
  let peakEquity = initialEquity;
  let dayStartEquity = initialEquity;
  let halt: HaltState = NO_HALT;
  // Zustände, die `decide()` fortschreibt und die der Simulator genau wie die
  // Engine über die Zyklen trägt (Stufen-Bremsen, Wiederaufbau-Ziele).
  let stufenHalt: Record<string, HaltState> = {};
  let wiederaufbau: Record<string, WiederaufbauZiel> = {};
  let volFaktorMin = Number.POSITIVE_INFINITY;
  let volFaktorMax = Number.NEGATIVE_INFINITY;
  let volFaktorLetzt: VolZielResult | null = null;
  const positions = new Map<string, PositionState>();
  const pendingEntries = new Set<string>();
  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];
  const dailyReturns: number[] = [];
  const dayTrades = new Map<string, number>();
  let dayTradeCount = 0;
  let simDay = '';
  let lastDayEquity = initialEquity;
  let dayCloseEquity = initialEquity;
  let dayHadPoints = false;
  let inRangeCount = 0;
  let exposedCount = 0;
  let firstT = Number.NaN;
  let lastNow = Number.NaN;
  const blocked = new Map<string, number>();

  const boundsCache = new Map<string, SessionBounds | null>();
  const boundsOf = (day: string): SessionBounds | null => {
    let b = boundsCache.get(day);
    if (b === undefined) {
      b = sessionBounds(day, assetClass, calendar);
      boundsCache.set(day, b);
    }
    return b;
  };
  const nextDayCache = new Map<string, string>();
  const nextDayOf = (day: string): string => {
    let n = nextDayCache.get(day);
    if (n === undefined) {
      n = nextTradingDay(day, assetClass, calendar);
      nextDayCache.set(day, n);
    }
    return n;
  };

  // Brutto-Marktwert der offenen Positionen (Σ |Stück × letzter Schluss|) —
  // Zähler der Exposure je Bar; Long und Short zählen beide positiv.
  let grossValue = 0;
  const markEquity = (): void => {
    let mv = 0;
    let gross = 0;
    for (const s of syms) {
      const p = s.pos;
      if (!p) continue;
      const value = p.qty * s.lastClose;
      mv += p.side === 'long' ? value : -value;
      gross += Math.abs(value);
    }
    equity = cash + mv;
    grossValue = gross;
  };

  /**
   * Kursextreme der Haltezeit fortschreiben — NUR aus Bars, die der Simulator
   * an diesem Zeitpunkt schon gesehen hat. Schreibend, nie lesend: Kein
   * Zweig dieser Funktion beeinflusst eine Entscheidung, einen Fill oder die
   * Equity. Der Ausstiegs-Bar wird mit seinem Fill-Kurs übergeben (l = h =
   * Fill), weil die Haltezeit am Fill endet — Hoch und Tief danach gehören
   * nicht mehr zur Position.
   */
  const updateExcursion = (s: SymState, l: number, h: number): void => {
    if (!trackExcursions) return;
    const p = s.pos!;
    if (p.side === 'long') {
      s.mae = Number.isNaN(s.mae) ? l : Math.min(s.mae, l);
      s.mfe = Number.isNaN(s.mfe) ? h : Math.max(s.mfe, h);
    } else {
      s.mae = Number.isNaN(s.mae) ? h : Math.max(s.mae, h);
      s.mfe = Number.isNaN(s.mfe) ? l : Math.min(s.mfe, l);
    }
  };

  const cashReduced = new Map<string, number>();
  const cashRejected = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  const openFromIntent = (s: SymState, intent: EnterIntent, price: number, time: Ms): void => {
    const side: FillSide = intent.side === 'long' ? 'buy' : 'sell';
    let qty = intent.qty;
    if (intent.side === 'long') {
      // Stückzahl, die das Bargeld am Fill inkl. Kosten je Stück deckt — abgerundet auf die Stückelung.
      const unitOutlay = price + fillCosts({ side, qty: 1, price, assetClass, costs, multiplier: mult }).total;
      const step = qtyStepFor(assetClass);
      const affordable = Number((Math.floor(cash / unitOutlay / step) * step).toFixed(8));
      if (affordable < qty) {
        if (affordable <= 0) {
          bump(cashRejected, s.symbol);
          return;
        }
        bump(cashReduced, s.symbol);
        qty = affordable;
      }
    }
    const cost = fillCosts({ side, qty, price, assetClass, costs, multiplier: mult }).total;
    if (intent.side === 'long') cash -= qty * price + cost;
    else cash += qty * price - cost;
    s.pos = openPosition({
      symbol: s.symbol,
      side: intent.side,
      qty,
      fillPrice: price,
      fillTime: time,
      stop: intent.stop,
      target: intent.target,
      strategy: intent.strategy,
      entryDay: dayKeyFor(time, assetClass),
      stufe: s.stufe,
    });
    positions.set(s.symbol, s.pos);
    s.entryCost = cost;
    s.borrow = 0;
    s.mae = Number.NaN;
    s.mfe = Number.NaN;
  };

  /** Position schließen und Trade buchen. `market` = Marktorder (mit Slippage), sonst Limit (nur Gebühren). */
  const closeTrade = (s: SymState, exitPrice: number, exitTime: Ms, reason: ExitReason, market: boolean): void => {
    const p = s.pos!;
    const side: FillSide = p.side === 'long' ? 'sell' : 'buy';
    const args = { side, qty: p.qty, price: exitPrice, assetClass, costs, multiplier: mult };
    const cost = market ? fillCosts(args).total : regulatoryFees(args);
    if (p.side === 'long') cash += p.qty * exitPrice - cost;
    else cash -= p.qty * exitPrice + cost;
    const grossPnl = (p.side === 'long' ? exitPrice - p.entryPrice : p.entryPrice - exitPrice) * p.qty;
    const fees = s.entryCost + cost + s.borrow;
    const netPnl = grossPnl - fees;
    const riskUsd = p.initialStop === null ? 0 : Math.abs(p.entryPrice - p.initialStop) * p.qty;
    trades.push({
      symbol: p.symbol,
      side: p.side,
      qty: p.qty,
      entryTime: p.entryTime,
      entryPrice: p.entryPrice,
      exitTime,
      exitPrice,
      grossPnl,
      fees,
      netPnl,
      rMultiple: riskUsd > 0 ? netPnl / riskUsd : null,
      exitReason: reason,
      strategy: p.strategy,
      barsHeld: p.barsHeld,
      mae: Number.isNaN(s.mae) ? null : s.mae,
      mfe: Number.isNaN(s.mfe) ? null : s.mfe,
      // Lag am Ausstieg eine nachgezogene Marke? Nur Statistik (Trailing vs.
      // Katastrophen-Stop) — der Wert wird nirgends gelesen, der nicht Bericht ist.
      stopTrailed: p.initialStop !== null && p.stop !== null && p.stop !== p.initialStop,
    });
    // Daytrade = Round-Trip am selben Handelstag (so zählt Alpaca, so gilt PDT).
    const exitDay = dayKeyFor(exitTime, assetClass);
    if (exitDay === p.entryDay) {
      dayTrades.set(exitDay, (dayTrades.get(exitDay) ?? 0) + 1);
      dayTradeCount++;
    }
    s.pos = null;
    positions.delete(s.symbol);
    s.entryCost = 0;
    s.borrow = 0;
    s.mae = Number.NaN;
    s.mfe = Number.NaN;
  };

  /* ── Hauptschleife ── */
  const here: SymState[] = [];
  for (let ti = 0; ti < times.length; ti++) {
    const t = times[ti]!;
    if (range && t >= range.end) break;
    const active = !range || t >= range.start;

    here.length = 0;
    for (const s of syms) {
      if (s.cursor < s.series.length && s.series.t[s.cursor] === t) here.push(s);
    }
    const day = dayKeyFor(t, assetClass);
    const bounds = assetClass === 'crypto' ? null : boundsOf(day);
    // `now` ist das Bucket-Ende: Die Bar ist geschlossen, die Engine entscheidet danach.
    const now = bounds && t >= bounds.open && t < bounds.close ? bucketEnd(t, tf, bounds) : t + tf * MIN;

    /* 1. Tageswechsel */
    if (day !== simDay) {
      if (simDay !== '') {
        if (dayHadPoints) {
          dailyReturns.push(dayCloseEquity / lastDayEquity - 1);
          lastDayEquity = dayCloseEquity;
          dayHadPoints = false;
        }
        // Tagesstart-Equity = Schluss-Equity des Vortags (Alpaca `last_equity`), Leihe danach.
        dayStartEquity = equity;
        const elapsed = calendarDaysBetween(simDay, day);
        for (const s of syms) {
          const p = s.pos;
          if (!p || p.side !== 'short') continue;
          const b = borrowCost({ notional: p.qty * s.lastClose, days: elapsed, costs, multiplier: mult });
          cash -= b;
          s.borrow += b;
        }
        markEquity();
      } else {
        dayStartEquity = equity;
      }
      simDay = day;
      // PDT-Fenster: fünf Handelstage bis heute (inkl.), Älteres verfällt.
      // Am Anfang des Kalenders gibt es keine fünf: Dann reicht das Fenster
      // bis zum ersten Kalendertag — kürzer, nie länger. Genau wie live in
      // risk/pdt.ts (ein Pfad).
      let windowStart = day;
      for (let k = 0; k < 4; k++) {
        const prev = prevTradingDayOrNull(windowStart, assetClass, calendar);
        if (prev === null) break;
        windowStart = prev;
      }
      dayTradeCount = 0;
      for (const [d, n] of dayTrades) {
        if (d < windowStart) dayTrades.delete(d);
        else if (d <= day) dayTradeCount += n;
      }
    }

    /* 2. Fills am Open dieser Bar, 3. Stop/Ziel intrabar, advance */
    for (const s of here) {
      const i = s.cursor++;
      const o = s.series.o[i]!;
      const h = s.series.h[i]!;
      const l = s.series.l[i]!;
      const c = s.series.c[i]!;
      if (active) {
        if (s.pendingStop !== null) {
          if (s.pos) {
            s.pos = { ...s.pos, stop: s.pendingStop };
            positions.set(s.symbol, s.pos);
          }
          s.pendingStop = null;
        }
        if (s.pendingExit) {
          const ex = s.pendingExit;
          s.pendingExit = null;
          if (s.pos) {
            // Der Fill-Kurs gehört noch zur Haltezeit: Ein Gap-Open IST oft
            // der schlechteste Kurs der Position — ohne ihn unterschätzt der
            // MAE genau die Ausstiege, die weh tun. Hoch/Tief der Bar NACH
            // dem Open zählen nicht mehr, die Position ist dann schon zu.
            updateExcursion(s, o, o);
            closeTrade(s, o, t, ex.reason, true);
          }
        }
        if (s.pendingEnter) {
          const en = s.pendingEnter;
          s.pendingEnter = null;
          pendingEntries.delete(s.symbol);
          if (!s.pos) openFromIntent(s, en, o, t);
        }
        // Stop/Ziel intrabar — für Bestand UND die eben am Open gefüllte Position (Bracket-Beine sind sofort aktiv).
        // Bestand und offener Einstiegs-Intent schließen sich aus: decide() emittiert `enter` nur ohne Position.
        if (s.pos) {
          const hit = checkStopTarget(s.pos, o, h, l);
          if (hit) {
            updateExcursion(s, l, h);
            closeTrade(s, hit.price, t, hit.reason, hit.reason === 'stop');
          }
        }
        if (s.pos) {
          updateExcursion(s, l, h);
          s.pos = advancePosition(s.pos, c);
          positions.set(s.symbol, s.pos);
        }
      }
      s.lastClose = c;
      s.barsSinceOpen = day === s.prevDay ? s.barsSinceOpen + 1 : 1;
      s.prevDay = day;
    }
    if (bench) {
      while (benchIdx + 1 < bench.length && bench.t[benchIdx + 1]! <= t) benchIdx++;
    }
    markEquity();
    if (equity > peakEquity) peakEquity = equity;
    if (!active) continue;

    inRangeCount++;
    if (positions.size > 0) exposedCount++;
    if (Number.isNaN(firstT)) firstT = t;
    lastNow = now;

    /* 4. Entscheidung — EIN Aufruf mit allen Symbolen (Portfolio-Sicht) */
    const benchSnap = bench && benchIdx >= 0 ? { bars: bench.prefix(benchIdx + 1), i: benchIdx } : undefined;
    const inputs: SymbolInput[] = [];
    for (const s of here) {
      const i = s.cursor - 1;
      const session = sessionInfoIncremental({ t, day, barsSinceOpen: s.barsSinceOpen, tf, assetClass, bounds });
      const snap: SymbolSnapshot = { symbol: s.symbol, bars: s.series.prefix(i + 1), i, position: s.pos, session, benchmark: benchSnap };
      inputs.push({ snap, strategy: s.strategy, params: s.params, ind: s.ind, sizing: s.sizing, stufe: s.stufe });
    }
    const today = dayKeyFor(now, assetClass);
    const ctx: LogicContext = {
      now,
      today,
      nextTradingDay: nextDayOf(today),
      account: { equity, cash, dayStartEquity, peakEquity, dayTradeCount, patternDayTrader: false },
      positions,
      pendingEntries,
      halt,
      risk,
      session: sessionCfg,
      assetClass,
      timeframe: tf,
      dataFresh: true,
      localDayTrades: dayTradeCount,
      assetFacts: ALL_TRADABLE,
      // Vola-Ziel (risk/volziel.ts): dieselbe Reihe wie live — abgeschlossene
      // Tagesrenditen der eigenen Equity-Kurve, jüngste zuletzt. Der Faktor
      // entsteht in `decide()`, nicht hier; der Simulator rechnet ihn nie selbst.
      equityReturns: dailyReturns,
      stufenHalt,
      wiederaufbau,
    };
    const res = decide(ctx, inputs);
    halt = res.halt;
    if (res.stufenHalt) stufenHalt = res.stufenHalt;
    if (res.wiederaufbau) wiederaufbau = res.wiederaufbau;
    if (res.volZiel) {
      volFaktorMin = Math.min(volFaktorMin, res.volZiel.faktor);
      volFaktorMax = Math.max(volFaktorMax, res.volZiel.faktor);
      volFaktorLetzt = res.volZiel;
    }
    for (const n of res.notes) {
      if (n.kind === 'blocked') {
        const k = blockKey(n.text);
        blocked.set(k, (blocked.get(k) ?? 0) + 1);
      } else if (n.kind === 'halt') {
        haltNote(`${new Date(now).toISOString()} Halt: ${n.text}`);
      }
    }
    for (const it of res.intents) {
      const s = bySymbol.get(it.symbol);
      if (!s) continue;
      if (it.kind === 'enter') {
        s.pendingEnter = it;
        pendingEntries.add(s.symbol);
      } else if (it.kind === 'exit') {
        // Auch an der letzten Tagesbar: Fill erst am nächsten Open (kein Market-on-Close, siehe Kopf).
        s.pendingExit = it;
      } else {
        s.pendingStop = it.stop;
      }
    }
    // Exposure zum Schluss dieser Bar: was JETZT im Buch steht (Fills und
    // Exits dieser Bar eingerechnet, die eben entschiedenen Intents noch
    // nicht — sie füllen erst am nächsten Open). Bei Equity ≤ 0 ist das Konto
    // tot; 0 statt eines negativen oder unendlichen Anteils.
    equityCurve.push({ t, equity, exposure: equity > 0 ? grossValue / equity : 0 });
    dayCloseEquity = equity;
    dayHadPoints = true;
  }

  /* ── Abschluss ── */
  if (dayHadPoints) dailyReturns.push(dayCloseEquity / lastDayEquity - 1);
  for (const s of syms) {
    if (s.pendingEnter) notes.push(`Einstieg ${s.symbol} ohne Folgebar verworfen (Datenende)`);
    if (s.pendingExit) notes.push(`Exit ${s.symbol} (${s.pendingExit.reason}) ohne Folgebar — Position bleibt offen (Datenende)`);
    if (s.pos) {
      const p = s.pos;
      const unreal = (p.side === 'long' ? s.lastClose - p.entryPrice : p.entryPrice - s.lastClose) * p.qty;
      notes.push(`Offen am Ende: ${p.symbol} ${p.side} ${p.qty} @ ${p.entryPrice} (unrealisiert ${unreal.toFixed(2)}, ohne Exit-Kosten)`);
    }
  }
  for (const [sym, n] of cashRejected) notes.push(`Bargeld reicht am Fill nicht: ${sym} ×${n} (kein Fill)`);
  for (const [sym, n] of cashReduced) notes.push(`Stückzahl am Fill reduziert (Bargeld): ${sym} ×${n}`);
  if (blocked.size > 0) {
    const parts = [...blocked.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`);
    notes.push(`Blockierte Einstiege: ${parts.join(', ')}`);
  }
  if (haltNotes > MAX_NOTES) notes.push(`… ${haltNotes - MAX_NOTES} weitere Halt-Notizen unterdrückt`);
  if (halt.halted) notes.push(`Halt am Ende aktiv (${halt.reason}): ${halt.note ?? ''}`);
  for (const [stufe, h] of Object.entries(stufenHalt)) {
    if (h.halted) notes.push(`Halt der Stufe ${stufe} am Ende aktiv (${h.reason}): ${h.note ?? ''}`);
  }
  if (volFaktorLetzt) {
    notes.push(
      `Vola-Ziel: Faktor ${volFaktorMin.toFixed(2)}–${volFaktorMax.toFixed(2)} über den Lauf, zuletzt ${volFaktorLetzt.faktor.toFixed(2)} ` +
        `(realisiert ${volFaktorLetzt.realisiertVolPct.toFixed(2)} % p. a.)`,
    );
  }

  let days = 0;
  if (range) days = Math.max(1, Math.ceil((range.end - range.start) / DAY));
  else if (inRangeCount > 0) days = Math.max(1, Math.ceil((lastNow - firstT) / DAY));
  const exposurePct = inRangeCount > 0 ? (exposedCount / inRangeCount) * 100 : 0;
  const metrics = computeMetrics({
    trades,
    equity: equityCurve,
    dailyReturns,
    initialEquity,
    periodsPerYear: assetClass === 'crypto' ? 365 : 252,
    days,
    exposurePct,
  });
  return { trades, equity: equityCurve, dailyReturns, metrics, finalEquity: equity, notes };
}
