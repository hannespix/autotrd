/**
 * DER Entscheidungspfad. Backtest und Live-Engine rufen `decide()` mit
 * derselben Sicht auf und bekommen dieselben Order-Intents zurück. Alles,
 * was hier steht, gilt in beiden Welten — alles, was nur in einer Welt
 * gilt, ist ein Messfehler (Owner-Erkenntnis: der alte Backtest maß eine
 * Strategie, die live nie lief).
 *
 * Reihenfolge je Zyklus:
 *   1. Konto-Sperren prüfen (Tagesverlust, Drawdown) → ggf. alles glatt.
 *   2. Je Symbol: Strategie befragen — in rotierender Reihenfolge, damit
 *      niemand dauerhaft zuerst an die knappen Plätze kommt
 *      (`wettbewerbsOrdnung`).
 *      - Position offen: Exit / Stop nachziehen / EOD-Flatten. Exits werden
 *        NIE gesperrt (Owner-Regel).
 *      - Keine Position: Einstieg nur durch alle Tore (Halt, Datenfrische,
 *        Session, Short-Erlaubnis, Positionslimit, PDT, Stop-Plausibilität,
 *        Sizing).
 *
 * Die Basis-Stufe (Champion-Block `basis`, core/basisTier.ts) hat hier KEINE
 * Sonderrechte. Ein Basis-Symbol ist ein `SymbolInput` wie jedes andere:
 * Tages-Notbremse, Drawdown-Halt, Einstiegssperre von außen (`entryLock`),
 * Datenalter, Positionslimit, Exposure-Budget, PDT und Bargeld sperren ihre
 * Einstiege wie die des Alpha-Champions; Exits laufen wie überall nie
 * gesperrt. Was sie unterscheidet, ist allein die Sizing-Semantik der Wahl
 * (`sizing`, risk/sizing.ts) und die Rangbildung je Korb (`korbRaenge`).
 *
 * Benannt, nicht beschönigt (Prüfbefund M9, 09.09.2026): Der Simulator setzt
 * den Equity-Peak je Simulations-Range neu und kennt kein `resume`; live
 * steht der Peak über Wochen (`peakEquity` im State) und ein Drawdown-Halt
 * endet nur über `resume` (§0.5). Ein Drawdown, der sich über mehrere
 * Messfenster aufbaut, löst deshalb live aus, wo der Simulator schweigt —
 * das gilt heute für den Alpha-Champion und seit der Basis-Stufe für die
 * Basis genauso. Die durchgehende Basis-Simulation (ein Peak über die ganze
 * OOS-Kette, optimize/walkForward.ts) verkleinert die Lücke, sie schließt
 * sie nicht: `resume` gibt es dort nicht, live bleibt die Basis nach einem
 * Drawdown-Halt in Kasse, bis der Nutzer es aufhebt. Kein Auto-Resume —
 * das wäre ein Override, keine Ursache (§0.5).
 */
import type { RiskConfig, SessionConfig } from './config.ts';
import type {
  AccountView,
  AssetClass,
  HaltState,
  IndicatorSet,
  KorbRang,
  Ms,
  OrderIntent,
  Params,
  PositionState,
  SizingSpec,
  Strategy,
  SymbolSnapshot,
  TimeframeMin,
} from './types.ts';
import { checkHalt } from '../risk/limits.ts';
import { pdtCheck } from '../risk/pdt.ts';
import { sizePosition } from '../risk/sizing.ts';

export interface AssetFacts {
  tradable: boolean;
  shortable: boolean;
}

export interface LogicContext {
  now: Ms;
  today: string;
  nextTradingDay: string;
  account: AccountView;
  positions: ReadonlyMap<string, PositionState>;
  /** Symbole mit offener, noch ungefüllter Einstiegs-Order. */
  pendingEntries: ReadonlySet<string>;
  /** Nominalwert (qty × Referenzkurs) der offenen Einstiegs-Orders je Symbol — belegt Exposure-Budget. */
  pendingNotional?: ReadonlyMap<string, number> | undefined;
  halt: HaltState;
  risk: RiskConfig;
  session: SessionConfig;
  assetClass: AssetClass;
  timeframe: TimeframeMin;
  /** false ⇒ keine neuen Einstiege (Datenstrom alt/abgerissen). */
  dataFresh: boolean;
  /** Lokal gezählte Daytrades im 5-Tage-Fenster (Ergänzung zur Broker-Zahl). */
  localDayTrades: number;
  assetFacts: (symbol: string) => AssetFacts | undefined;
  /** Stop bei Einstieg mindestens diese Distanz (in %) vom Kurs — Schutz vor Null-Risiko-Stops. */
  minStopDistancePct?: number;
  /**
   * Einstiege von außen gesperrt (Text = Grund), ohne persistierten Halt: Der Functions-Takt setzt das,
   * wenn die Echtgeld-Kette (Freigabe, Kill-Switch, Nutzer-Schalter, Reife) nicht geschlossen ist.
   * Exits, Stop-Nachzüge und Glattstellungen laufen weiter — Exits werden nie gesperrt.
   */
  entryLock?: string | null | undefined;
}

export interface SymbolInput {
  snap: SymbolSnapshot;
  strategy: Strategy;
  params: Params;
  ind: IndicatorSet;
  /**
   * Sizing-Semantik der Strategie-Wahl (Basis-Stufe: Allokation). Fehlt sie,
   * gilt das Risiko-Budget je Trade. Sie kommt aus `strategyFor` — im
   * Simulator wie in der Engine derselbe Wert, sonst wären Messung und
   * Handel zwei Welten.
   */
  sizing?: SizingSpec | undefined;
}

export interface LogicNote {
  symbol: string;
  kind: 'blocked' | 'decision' | 'info' | 'halt';
  text: string;
}

export interface LogicResult {
  intents: OrderIntent[];
  notes: LogicNote[];
  halt: HaltState;
  /** true, wenn in diesem Zyklus eine Sperre neu ausgelöst wurde. */
  haltTriggered: boolean;
}

export const DEFAULT_MIN_STOP_DISTANCE_PCT = 0.05;

export function qtyStepFor(assetClass: AssetClass): number {
  return assetClass === 'crypto' ? 0.0001 : 1;
}

export function grossExposure(positions: ReadonlyMap<string, PositionState>, priceOf: (symbol: string) => number | undefined): number {
  let sum = 0;
  for (const p of positions.values()) {
    const px = priceOf(p.symbol) ?? p.entryPrice;
    sum += p.qty * px;
  }
  return sum;
}

/**
 * Reihenfolge, in der Symbole um die knappen Budgets konkurrieren
 * (`maxPositions`, Brutto-Exposure, PDT-Reserve, Bargeld am Fill).
 *
 * Warum es diese Funktion überhaupt gibt: Wer im Zyklus zuerst drankommt,
 * bekommt den letzten freien Platz. Ohne Regel entschied das die Reihenfolge,
 * in der der Aufrufer seine Liste gebaut hat — im Backtest wie live die
 * Reihenfolge aus `universe.symbols`. Bei 30 Symbolen auf 4 Plätzen ist das
 * keine Kleinigkeit: Die ersten vier Einträge der Config (bei uns die vier
 * Index-ETFs) hätten systematisch mehr Einstiege bekommen als der Rest, und
 * ein umsortiertes Universum hätte das Ergebnis verändert, ohne dass sich
 * eine Strategie geändert hat. Genau die Art stiller Freiheitsgrad, der
 * hinterher wie eine Kante aussieht.
 *
 * Die Regel: Jedes Symbol bekommt je Bar einen Schlüssel aus (Symbol, Bucket),
 * sortiert wird danach. Zwei Eigenschaften, die beide gebraucht werden und die
 * eine einfache Rotation `bucket mod n` NICHT hat (Red-Team, 08.09.):
 *
 *  1. **Keine Resonanz.** Ein Handelstag hat bei 5 min genau 288 Buckets. Mit
 *     `bucket mod n` rückt der Start an einer festen Tageszeit täglich um
 *     `288 mod n` vor — bei n = 30 gäbe es zu jeder Uhrzeit nur 5 verschiedene
 *     Startpunkte, 10 der 30 Symbole kämen um 10:00 ET NIE zuerst dran (unter
 *     ihnen SPY und QQQ, also genau die, die vorher bevorzugt waren). Bei
 *     n ∈ {12, 16, 18, 24} stünde die Reihenfolge zu einer festen Uhrzeit für
 *     immer still. Der Mischer hat keine gemeinsamen Teiler mit irgendetwas.
 *  2. **Unabhängig davon, WER im Zyklus dabei ist.** Der Schlüssel eines
 *     Symbols hängt nur an ihm selbst und an der Bar-Zeit, nicht an der Anzahl
 *     der Anwesenden. Sonst würde ein einziges fehlendes Symbol (live normal:
 *     keine IEX-Bar im Bucket) die ganze Prioritätsreihenfolge gegenüber der
 *     Messung permutieren — und zwar systematisch, weil die Ausfälle die
 *     dünneren Werte treffen.
 *
 * Über viele Bars ist die Priorität damit gleichverteilt; innerhalb einer Bar
 * ist sie allein aus den Daten reproduzierbar, im Backtest wie live.
 *
 * Exits berührt das nicht: Sie laufen für jedes Symbol dieses Zyklus,
 * unabhängig von der Reihenfolge, und werden nie gesperrt.
 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** splitmix32-Finalisierer: streut benachbarte Zahlen über den ganzen Bereich. */
function mische(x: number): number {
  let z = x | 0;
  z = (z ^ (z >>> 16)) >>> 0;
  z = Math.imul(z, 0x21f0aaad) >>> 0;
  z = (z ^ (z >>> 15)) >>> 0;
  z = Math.imul(z, 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

/**
 * Schlüssel des Korbs, in dem ein Symbol rangiert: Strategie, Parameter und
 * Sizing-Semantik der Wahl — alles Daten des `SymbolInput`, nichts, was ein
 * Aufrufer etikettieren könnte. Zwei Symbole rangieren nur dann gegeneinander,
 * wenn dieselbe Strategie mit denselben Parametern und derselben Semantik sie
 * führt: So bleibt der Korb der Basis-Stufe (Allokation, eigene Parameter) von
 * einem Alpha-Korb derselben Strategie getrennt, und ein gepoolter Alpha-Korb
 * (ein Parametersatz für alle) rangiert wie bisher als Ganzes.
 */
export function korbSchluessel(inp: Pick<SymbolInput, 'strategy' | 'params' | 'sizing'>): string {
  const params = Object.keys(inp.params)
    .sort()
    .map((k) => `${k}=${inp.params[k]}`)
    .join(',');
  const sizing = inp.sizing ? `${inp.sizing.mode}:${inp.sizing.positionPct}` : 'risk';
  return `${inp.strategy.id}|${params}|${sizing}`;
}

/**
 * Korb-Rang je Symbol für Querschnitts-Strategien.
 *
 * Warum das hier steht und nicht im Aufrufer: `decide()` ist der EINE
 * Entscheidungspfad. Würde der Backtest die Rangliste selbst bauen und die
 * Engine auch, hätten wir zwei Ranglisten, die auseinanderlaufen können —
 * und das wäre genau der Messfehler, gegen den der ganze Neubau gebaut ist.
 *
 * Zwei Regeln machen die Sache kausal und in beiden Welten gleich:
 *
 *  1. Es wird nur innerhalb eines KORBS rangiert (`korbSchluessel`: Strategie,
 *     Parameter, Sizing-Semantik). Symbole mit anderer Strategie haben eine
 *     andere Kennzahl; sie zu mischen wäre sinnlos. Und der Korb der
 *     Basis-Stufe (z. B. neun Anlageklassen-ETFs mit Allokations-Sizing)
 *     darf nie gegen einen Alpha-Korb derselben Strategie rangieren — gemessen
 *     wurde er allein, also rangiert er allein. In der Messung ist der Korb
 *     einer Einheit ohnehin ein Parametersatz; per Symbol gefittete
 *     Querschnitts-Champions rangierten in ihrer Messung nur gegen sich selbst
 *     (`of` 1, unter MIN_KORB) und konnten so nie Champion werden — der
 *     Schlüssel macht live nur, was die Messung schon tat.
 *  2. Es rangieren nur Symbole, deren Entscheidungs-Bar zur JÜNGSTEN Bar des
 *     Zyklus gehört. Live kann ein Symbol ohne Trade im Bucket eine ältere
 *     letzte Bar haben — seine Kennzahl stammt dann von einem anderen
 *     Zeitpunkt, und ein Vergleich damit wäre schlicht falsch. Solche Symbole
 *     bekommen keinen Rang; ihre EXITS laufen unberührt weiter (Regel 4).
 *
 * `crossScore` sieht nur `snap.bars.prefix(i + 1)` — geschlossene Bars bis
 * zur Entscheidungs-Bar. Zukunft kann hier also nicht hineingeraten.
 */
export function korbRaenge(inputs: readonly SymbolInput[]): Map<string, KorbRang> {
  const out = new Map<string, KorbRang>();
  let neueste = Number.NEGATIVE_INFINITY;
  for (const inp of inputs) {
    const t = inp.snap.bars.t[inp.snap.i];
    if (t !== undefined && t > neueste) neueste = t;
  }
  const proKorb = new Map<string, { symbol: string; score: number }[]>();
  for (const inp of inputs) {
    if (!inp.strategy.crossScore) continue;
    if (inp.snap.bars.t[inp.snap.i] !== neueste) continue;
    const score = inp.strategy.crossScore(inp.snap, inp.ind, inp.params);
    if (score === null || !Number.isFinite(score)) continue;
    const key = korbSchluessel(inp);
    const liste = proKorb.get(key) ?? [];
    liste.push({ symbol: inp.snap.symbol, score });
    proKorb.set(key, liste);
  }
  for (const liste of proKorb.values()) {
    // Absteigend nach Kennzahl; Gleichstand alphabetisch, damit der Lauf reproduzierbar bleibt.
    liste.sort((a, b) => b.score - a.score || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
    const of = liste.length;
    for (let k = 0; k < of; k++) {
      out.set(liste[k]!.symbol, { pct: of > 1 ? k / (of - 1) : 0, rank: k + 1, of });
    }
  }
  return out;
}

export function wettbewerbsOrdnung(inputs: readonly SymbolInput[], timeframe: TimeframeMin): SymbolInput[] {
  if (inputs.length < 2) return [...inputs];
  // Bucket-Nummer der jüngsten Entscheidungs-Bar. Beide Welten entscheiden auf
  // geschlossenen Bars desselben Rasters, also ergibt sich dieselbe Zahl.
  let neueste = 0;
  for (const inp of inputs) {
    const t = inp.snap.bars.t[inp.snap.i] ?? 0;
    if (t > neueste) neueste = t;
  }
  const bucket = mische(Math.floor(neueste / (timeframe * 60_000)));
  const schluessel = new Map<string, number>();
  for (const inp of inputs) schluessel.set(inp.snap.symbol, mische(fnv1a(inp.snap.symbol) ^ bucket));
  return [...inputs].sort((a, b) => {
    const d = schluessel.get(a.snap.symbol)! - schluessel.get(b.snap.symbol)!;
    // Gleichstand (Hash-Kollision) alphabetisch — der Lauf muss reproduzierbar bleiben.
    return d !== 0 ? d : a.snap.symbol < b.snap.symbol ? -1 : a.snap.symbol > b.snap.symbol ? 1 : 0;
  });
}

export function decide(ctx: LogicContext, inputs: readonly SymbolInput[]): LogicResult {
  const intents: OrderIntent[] = [];
  const notes: LogicNote[] = [];

  // 1. Konto-Sperren
  const hc = checkHalt({
    account: ctx.account,
    halt: ctx.halt,
    risk: ctx.risk,
    now: ctx.now,
    today: ctx.today,
    nextDay: ctx.nextTradingDay,
  });
  const halt = hc.halt;
  if (hc.lifted) notes.push({ symbol: '*', kind: 'halt', text: halt.note ?? 'Halt geendet' });
  if (hc.triggered) {
    notes.push({ symbol: '*', kind: 'halt', text: halt.note ?? 'Halt ausgelöst' });
    const reason = halt.reason === 'drawdown' ? 'drawdown' : 'kill_switch';
    for (const p of ctx.positions.values()) {
      intents.push({ kind: 'exit', symbol: p.symbol, reason, decidedAt: ctx.now });
    }
    return { intents, notes, halt, haltTriggered: true };
  }
  // Notbremse steht (Tagesverlust/Drawdown) und das Buch ist nicht leer: Der Glattstellungs-Exit wird in
  // JEDEM Zyklus erneut angefordert, bis alles zu ist — der Executor ist idempotent (positionsstabile
  // Kennung). Sonst bliebe eine Position nach einem im Auslöse-Zyklus gescheiterten Exit einfach offen
  // (Secreview 2, K2: im Functions-Takt gibt es keinen Wiederholversuch über den Takt hinaus).
  if (halt.halted && (halt.reason === 'daily_loss' || halt.reason === 'drawdown') && ctx.positions.size > 0) {
    const reason = halt.reason === 'drawdown' ? 'drawdown' : 'kill_switch';
    for (const p of ctx.positions.values()) {
      intents.push({ kind: 'exit', symbol: p.symbol, reason, decidedAt: ctx.now });
    }
    notes.push({ symbol: '*', kind: 'halt', text: `Notbremse aktiv (${halt.reason}) — offene Positionen werden glattgestellt` });
    return { intents, notes, halt, haltTriggered: false };
  }

  // Preise der Entscheidungs-Bars für Exposure
  const lastClose = new Map<string, number>();
  for (const inp of inputs) lastClose.set(inp.snap.symbol, inp.snap.bars.c[inp.snap.i]!);
  let gross = grossExposure(ctx.positions, (s) => lastClose.get(s));
  // Offene Einstiegs-Orders belegen Exposure-Budget, sobald sie füllen — mitzählen.
  if (ctx.pendingNotional) for (const n of ctx.pendingNotional.values()) gross += n;
  let openCount = ctx.positions.size + ctx.pendingEntries.size;
  // Unter der PDT-Schwelle zählt jeder geplante Einstieg gegen die Reserve — auch ein
  // Übernacht-Einstieg kann noch am selben Tag ausgestoppt werden (Red-Team-Befund).
  let plannedEntries = 0;

  // Querschnitts-Strategien brauchen den Korb-Rang. Nur bauen, wenn wirklich
  // eine Strategie im Zyklus danach fragt — sonst kostet es jede Bar Arbeit
  // und Speicher für nichts.
  const brauchtRang = inputs.some((inp) => inp.strategy.crossScore !== undefined);
  const raenge = brauchtRang ? korbRaenge(inputs) : null;

  // Um die knappen Plätze wird in rotierender Reihenfolge konkurriert, nicht in
  // Config-Reihenfolge (siehe wettbewerbsOrdnung) — mit einer Ausnahme: Wer
  // einen Korb-Rang hat, konkurriert nach RANG, der Stärkste zuerst. Sonst
  // entschiede der Hash, wer von sechs Kandidaten die vier Plätze bekommt
  // (Prüfbefund 09.09.: Rang 3–6 drin, 1 und 2 draußen). Stabil sortiert:
  // unter Gleichrangigen und ohne Rang bleibt die rotierende Ordnung.
  const rotierend = wettbewerbsOrdnung(inputs, ctx.timeframe);
  const geordnet = raenge
    ? [...rotierend].sort((a, b) => {
        const ra = raenge.get(a.snap.symbol)?.rank ?? Number.POSITIVE_INFINITY;
        const rb = raenge.get(b.snap.symbol)?.rank ?? Number.POSITIVE_INFINITY;
        return ra === rb ? 0 : ra - rb;
      })
    : rotierend;
  for (const roh of geordnet) {
    const rang = raenge?.get(roh.snap.symbol);
    const inp = rang === undefined ? roh : { ...roh, snap: { ...roh.snap, rank: rang } };
    const { snap, strategy, params, ind } = inp;
    const sym = snap.symbol;
    const pos = snap.position;
    const price = snap.bars.c[snap.i]!;

    if (snap.i + 1 < strategy.warmupBars(params)) {
      continue;
    }

    const decision = strategy.decide(snap, ind, params);

    if (pos) {
      // ── Position offen: Exits sind nie gesperrt ──
      // EOD-Flatten am LETZTEN Entscheidungspunkt vor der Frist: Würde die nächste
      // Bar erst nach (Schluss − flattenBeforeCloseMin) schließen, muss jetzt raus.
      // Der Fill liegt dann am Open der Folgebar — ein Kurs, den es live gibt
      // (Red-Team-Befund: ein Fill am Close der Entscheidungs-Bar existiert live nicht).
      const mustFlatten =
        !strategy.holdsOvernight &&
        snap.session.minutesToClose !== null &&
        snap.session.minutesToClose - ctx.timeframe < ctx.session.flattenBeforeCloseMin;
      if (mustFlatten) {
        intents.push({ kind: 'exit', symbol: sym, reason: 'eod', decidedAt: ctx.now });
        notes.push({ symbol: sym, kind: 'decision', text: 'EOD-Flatten' });
        continue;
      }
      if (decision.kind === 'exit') {
        intents.push({ kind: 'exit', symbol: sym, reason: 'signal', decidedAt: ctx.now });
        notes.push({ symbol: sym, kind: 'decision', text: `Exit: ${decision.reason}` });
        continue;
      }
      if (decision.kind === 'move_stop') {
        const tighter = pos.side === 'long' ? pos.stop === null || decision.stop > pos.stop : pos.stop === null || decision.stop < pos.stop;
        const onLossSide = pos.side === 'long' ? decision.stop < price : decision.stop > price;
        if (tighter && onLossSide && Number.isFinite(decision.stop) && decision.stop > 0) {
          intents.push({ kind: 'move_stop', symbol: sym, stop: decision.stop, reason: decision.reason, decidedAt: ctx.now });
          notes.push({ symbol: sym, kind: 'decision', text: `Stop → ${decision.stop} (${decision.reason})` });
        }
        continue;
      }
      if (decision.kind === 'enter' && decision.side !== pos.side) {
        notes.push({ symbol: sym, kind: 'info', text: 'Gegensignal bei offener Position — ignoriert (kein Reversal)' });
      }
      continue;
    }

    // ── Keine Position ──
    if (decision.kind !== 'enter') continue;

    const block = (text: string) => notes.push({ symbol: sym, kind: 'blocked', text });

    if (halt.halted) {
      block(`Halt aktiv (${halt.reason})`);
      continue;
    }
    if (ctx.entryLock) {
      block(`Einstiege gesperrt: ${ctx.entryLock}`);
      continue;
    }
    if (!ctx.dataFresh) {
      block('Daten nicht frisch');
      continue;
    }
    if (ctx.pendingEntries.has(sym)) {
      block('Einstiegs-Order bereits offen');
      continue;
    }
    const facts = ctx.assetFacts(sym);
    if (facts && !facts.tradable) {
      block('Asset nicht handelbar');
      continue;
    }
    if (decision.side === 'short') {
      if (!ctx.risk.allowShort) {
        block('Short nicht erlaubt (risk.allowShort=false)');
        continue;
      }
      if (ctx.assetClass === 'crypto') {
        block('Krypto: kein Short bei Alpaca');
        continue;
      }
      if (facts && !facts.shortable) {
        block('Asset nicht shortbar');
        continue;
      }
    }
    // Session-Tore (nur Intraday-Zeitrahmen bei Aktien)
    if (ctx.assetClass === 'us_equity' && ctx.timeframe !== 1440) {
      const so = snap.session.minutesSinceOpen;
      const tc = snap.session.minutesToClose;
      if (!snap.session.isRegularSession) {
        block('Außerhalb der regulären Sitzung');
        continue;
      }
      if (so !== null && so < ctx.session.noEntryFirstMin) {
        block(`Eröffnungsfenster (${so} < ${ctx.session.noEntryFirstMin} min)`);
        continue;
      }
      if (tc !== null && tc <= ctx.session.noEntryLastMin) {
        block(`Schlussfenster (${tc} ≤ ${ctx.session.noEntryLastMin} min)`);
        continue;
      }
      // Kein Einstieg, der am nächsten Entscheidungspunkt sofort wieder glattgestellt würde.
      if (!strategy.holdsOvernight && tc !== null && tc - ctx.timeframe < ctx.session.flattenBeforeCloseMin) {
        block('Flatten-Fenster');
        continue;
      }
    }
    if (openCount >= ctx.risk.maxPositions) {
      block(`Positionslimit ${ctx.risk.maxPositions} erreicht`);
      continue;
    }
    // Stop-Plausibilität
    const minDist = (ctx.minStopDistancePct ?? DEFAULT_MIN_STOP_DISTANCE_PCT) / 100;
    const stop = decision.stop;
    const stopOk =
      Number.isFinite(stop) &&
      stop > 0 &&
      (decision.side === 'long' ? stop < price * (1 - minDist) : stop > price * (1 + minDist));
    if (!stopOk) {
      block(`Stop unplausibel (${stop} bei Kurs ${price})`);
      continue;
    }
    let target: number | null = null;
    if (decision.target !== undefined && Number.isFinite(decision.target) && decision.target > 0) {
      const targetOk = decision.side === 'long' ? decision.target > price : decision.target < price;
      target = targetOk ? decision.target : null;
    }
    // PDT
    const pdt = pdtCheck({
      respect: ctx.risk.pdt.respect,
      minEquity: ctx.risk.pdt.minEquity,
      maxDayTrades: ctx.risk.pdt.maxDayTrades,
      equity: ctx.account.equity,
      brokerCount: ctx.account.dayTradeCount,
      localCount: ctx.localDayTrades,
      plannedIntradayEntries: plannedEntries,
      intraday: !strategy.holdsOvernight,
      assetClass: ctx.assetClass,
    });
    if (!pdt.allowed) {
      block(pdt.reason ?? 'PDT');
      continue;
    }
    // Sizing — Risiko-Budget, oder die Allokations-Semantik der Wahl
    // (Basis-Stufe); die Deckel des Nutzers gelten in beiden Fällen.
    const exposureBudget = (ctx.account.equity * ctx.risk.maxGrossExposurePct) / 100 - gross;
    const size = sizePosition({
      equity: ctx.account.equity,
      cash: ctx.account.cash,
      price,
      stop,
      side: decision.side,
      riskPct: ctx.risk.riskPerTradePct,
      maxPositionPct: ctx.risk.maxPositionPct,
      exposureBudget,
      qtyStep: qtyStepFor(ctx.assetClass),
      sizing: inp.sizing,
    });
    if (size.qty <= 0) {
      block(`Sizing: ${size.reason}`);
      continue;
    }

    intents.push({
      kind: 'enter',
      symbol: sym,
      side: decision.side,
      qty: size.qty,
      stop,
      target,
      refPrice: price,
      reason: decision.reason,
      strategy: strategy.id,
      decidedAt: ctx.now,
    });
    notes.push({
      symbol: sym,
      kind: 'decision',
      text: `Enter ${decision.side} ${size.qty} @~${price} stop ${stop}${target ? ` ziel ${target}` : ''}: ${decision.reason}`,
    });
    openCount++;
    gross += size.notional;
    plannedEntries++;
  }

  return { intents, notes, halt, haltTriggered: false };
}

/** Position nach einer geschlossenen Bar fortschreiben (Haltedauer, Hochwasser). Identisch in Backtest und Live. */
export function advancePosition(pos: PositionState, close: number): PositionState {
  const highWater = pos.side === 'long' ? Math.max(pos.highWater, close) : Math.min(pos.highWater, close);
  return { ...pos, barsHeld: pos.barsHeld + 1, highWater };
}

/** Neue Position aus einem Fill — Backtest und Live nutzen dieselbe Fabrik. */
export function openPosition(args: {
  symbol: string;
  side: PositionState['side'];
  qty: number;
  fillPrice: number;
  fillTime: Ms;
  stop: number;
  target: number | null;
  strategy: string;
  entryDay: string;
}): PositionState {
  return {
    symbol: args.symbol,
    side: args.side,
    qty: args.qty,
    entryPrice: args.fillPrice,
    entryTime: args.fillTime,
    stop: args.stop,
    target: args.target,
    initialStop: args.stop,
    highWater: args.fillPrice,
    strategy: args.strategy,
    barsHeld: 0,
    entryDay: args.entryDay,
  };
}
