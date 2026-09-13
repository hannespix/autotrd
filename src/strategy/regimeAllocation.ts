/**
 * regime_allocation — Regime und relative Stärke, im Monatsrhythmus.
 *
 * ── Warum es diese Familie gibt ───────────────────────────────────────────
 *
 * Vier Fenster am 09.09.2026 (docs/ARCHITEKTUR.md §5a.12): Keine der vier
 * signalgetriebenen Vorlagen schlägt kaufen-und-halten, und im Bärenmarkt
 * 2022 verlieren alle. Sie fragen täglich, steigen mit engen ATR-Stops ein
 * und wieder aus und handeln dutzende Male im Quartal. Die Momentum- und
 * Trendfolge-Literatur sagt seit Jahrzehnten dasselbe: Die Kante — soweit es
 * sie gibt — liegt in der AUSFÜHRUNG: selten entscheiden, das Regime
 * beachten, Gewinner nicht mit Stops abschneiden.
 *
 * Diese Familie stellt deshalb drei Fragen, und nur in einem Fenster von
 * drei Handelstagen zu Monatsbeginn:
 *
 *   1. RELATIV — gehört das Symbol zu den stärksten des Korbs? `crossScore`
 *      ist das Momentum je Einheit Schwankung; den Rang baut `decide()` in
 *      core/logic.ts, einmal je Bar, für beide Welten (§0.2).
 *   2. REGIME — notiert es über seinem gleitenden Mittel?
 *   3. ABSOLUT — ist sein eigenes Momentum positiv? Dual Momentum: In
 *      Bärenmärkten ist „der relativ Stärkste" oft nur der, der am
 *      wenigsten fällt.
 *
 * Nur wenn alle drei ja sagen, kauft sie — mit einem WEITEN Katastrophen-
 * Stop beim Broker (§0.4), der nie nachgezogen wird, ohne Kursziel. Zwischen
 * zwei Fenstern entscheidet sie nichts; nur der Broker-Stop wacht.
 *
 * ── Was der Prüfer an der ersten Fassung widerlegt hat ────────────────────
 *
 * Die erste Fassung (Commit c71c9e9) war ein Allokator mit Zielvolatilität,
 * zehn Monaten Momentum und einem `weight`, das im Sizing das Risiko-Budget
 * ersetzte. Der Prüfer zeigte drei Dinge:
 *   (1) Warmup 233 Bars + 20 = Embargo 253 verschluckte das ganze IS-Fenster
 *       (~252 Bars) — der Walk-Forward warf vor dem ersten Fold.
 *   (2) `weight` umging riskPerTradePct: 4 % der Equity je ausgestopptem
 *       Trade statt der dem Nutzer versprochenen 0,5 %.
 *   (3) 80 % Exposure gegen die 2 %-Tagesnotbremse liquidiert an gewöhnlichen
 *       Tagen das ganze Buch — Kasse bis zum nächsten Monat.
 * Daraus wurde:
 *   - KEIN Gewicht. Die Stückzahl folgt wie bei jeder Vorlage dem
 *     Risiko-Budget über die Stop-Distanz (core/logic.ts, risk/sizing.ts).
 *     Ein weiter Stop heißt eine kleine Position — genau das Versprechen an
 *     den Nutzer; die Sharpe, an der `beats_market` misst, ist skalenfrei.
 *   - Horizonte von drei bis sechs Monaten: Warmup höchstens 149 Bars, das
 *     Embargo lässt vom IS-Fenster genug übrig.
 *   - Ein Rebalance-FENSTER von REBAL_TAGE Handelstagen je Monat statt eines
 *     Tages: Ein blockierter Tag (Order abgewiesen, Datenalter, eine Bar zu
 *     spät) kostet keinen Monat.
 *
 * ── Bekannte Grenzen, nicht wegdefiniert ─────────────────────────────────
 *
 *   - Ein am Rebalance-Tag frei werdender Platz ist erst am nächsten Tag des
 *     Fensters wieder besetzbar: core/logic.ts zählt Plätze je Zyklus und
 *     hält das Limit hart (§0.4).
 *   - Die IS-Suche verlangt `minIsTrades`; erreicht eine langsame Familie
 *     das nicht, nimmt der Rückfall die Variante mit den meisten Trades — ein
 *     Zug zum Umschlag, den diese Familie nicht will. Die Messung sagt, ob sie
 *     trotzdem ≥ 60 OOS-Trades erreicht; wenn nicht, ist das ein gemessenes
 *     Nein, kein Grund, Gates zu lockern (§0.9).
 *   - Auf der Plattform handelt ein Nutzer eine Teilmenge des Korbs; unter
 *     MIN_KORB Symbolen rangiert nichts, und die Familie hält still.
 *
 * Kein Short (§5a: widerlegt). Nur Tagesbars: Ein monatlicher Rhythmus auf
 * 5-Minuten-Bars wäre Unsinn.
 */
import { dayKey } from '../core/time.ts';
import type { BarSeriesLike, Decision, IndicatorSet, ParamSpec, Params, Strategy, SymbolSnapshot } from '../core/types.ts';
import { MIN_KORB } from './crossSectionalMomentum.ts';
import { fmtPx, hold, indAt, nanArray, sma, stddev } from './indicators.ts';
import { req, spec } from './params.ts';

/** Handelstage je Jahr — Annualisierung der realisierten Volatilität. */
const TAGE_JE_JAHR = 252;
/** Fenster der realisierten Volatilität in Bars — fest ein Quartal, keine Suchachse. */
export const VOL_LEN = 63;
/** Rebalance-Fenster: die ersten n Handelstage eines Monats — fest, keine Suchachse. */
export const REBAL_TAGE = 3;

const paramSpace: readonly ParamSpec[] = [
  spec('lookback', 63, 126, 21, 'int', 'Bars des Momentum-Fensters (drei bis sechs Monate)'),
  spec('skip', 0, 21, 21, 'int', 'Jüngste n Bars auslassen (der letzte Monat kehrt eher um)'),
  spec('regimeLen', 50, 150, 50, 'int', 'Länge des gleitenden Mittels, über dem das Regime „aufwärts" heißt'),
  spec('topPct', 0.1, 0.4, 0.1, 'float', 'Einstieg, solange das Symbol in den stärksten x % des Korbs liegt'),
  spec('exitPct', 0.4, 0.8, 0.2, 'float', 'Ausstieg im Fenster, sobald es schwächer als x % des Korbs ist'),
  spec('stopPct', 10, 25, 5, 'int', 'Katastrophen-Stop unter dem Einstand in % — beim Broker, nie nachgezogen; über ihn bemisst das Risiko-Budget die Stückzahl'),
];

const defaults: Params = {
  lookback: 105,
  skip: 21,
  regimeLen: 100,
  topPct: 0.2,
  exitPct: 0.6,
  stopPct: 20,
};

function warmupBars(p: Params): number {
  return Math.max(req(p, 'lookback') + req(p, 'skip'), req(p, 'regimeLen'), VOL_LEN + 1) + 2;
}

/** Rendite über `lookback` Bars, endend `skip` Bars vor der aktuellen. */
function momentum(close: BarSeriesLike['c'], lookback: number, skip: number): Float64Array {
  const out = nanArray(close.length);
  for (let i = lookback + skip; i < close.length; i++) {
    const jetzt = close[i - skip];
    const davor = close[i - skip - lookback];
    if (jetzt === undefined || davor === undefined || davor <= 0) continue;
    out[i] = jetzt / davor - 1;
  }
  return out;
}

/** Annualisierte Schwankung der Tagesrenditen über VOL_LEN Bars (Anteil, nicht Prozent). */
function realisierteVol(close: BarSeriesLike['c']): Float64Array {
  const r = nanArray(close.length);
  for (let i = 1; i < close.length; i++) {
    const a = close[i - 1];
    const b = close[i];
    if (a !== undefined && b !== undefined && a > 0 && b > 0) r[i] = b / a - 1;
  }
  const sd = stddev(r, VOL_LEN);
  const out = nanArray(close.length);
  for (let i = 0; i < sd.length; i++) {
    const x = sd[i]!;
    if (Number.isFinite(x)) out[i] = x * Math.sqrt(TAGE_JE_JAHR);
  }
  return out;
}

/**
 * 1 an den ersten REBAL_TAGE Bars eines Kalendermonats (ET), sonst 0. Kausal:
 * sieht nur t[i] und t[i−1]. Vor dem ersten beobachteten Monatswechsel
 * rebalanciert nichts — dort gibt es keine Geschichte für ein Urteil.
 *
 * Exportiert, weil `vigilant_allocation` denselben Monatsrhythmus hat: ZWEI
 * Implementierungen desselben Fensters wären zwei Stellen, an denen eine
 * Monatskante schiefgehen kann, und nur eine davon hätte einen Wächter.
 */
export function rebalanceFenster(t: BarSeriesLike['t']): Float64Array {
  const out = new Float64Array(t.length);
  let seit = Number.POSITIVE_INFINITY;
  for (let i = 1; i < t.length; i++) {
    if (dayKey(t[i]!).slice(0, 7) !== dayKey(t[i - 1]!).slice(0, 7)) seit = 0;
    else seit++;
    if (seit < REBAL_TAGE) out[i] = 1;
  }
  return out;
}

function precompute(bars: BarSeriesLike, p: Params): IndicatorSet {
  return {
    mom: momentum(bars.c, req(p, 'lookback'), req(p, 'skip')),
    sma: sma(bars.c, req(p, 'regimeLen')),
    rvol: realisierteVol(bars.c),
    rebal: rebalanceFenster(bars.t),
  };
}

/** Kennzahl für den Rangvergleich: Momentum je Einheit Schwankung. Den Rang baut core/logic.ts. */
function crossScore(snap: SymbolSnapshot, ind: IndicatorSet, _p: Params): number | null {
  const mom = indAt(ind, 'mom', snap.i);
  const rvol = indAt(ind, 'rvol', snap.i);
  if (!Number.isFinite(mom) || !Number.isFinite(rvol) || rvol <= 0) return null;
  return mom / rvol;
}

function decide(snap: SymbolSnapshot, ind: IndicatorSet, p: Params): Decision {
  const i = snap.i;
  const close = snap.bars.c[i];
  if (close === undefined || i < 0) return hold();
  // Außerhalb des Fensters entscheidet diese Familie NICHTS — weder Einstieg
  // noch Ausstieg. Der Katastrophen-Stop liegt beim Broker.
  if (indAt(ind, 'rebal', i) !== 1) return hold();

  const mom = indAt(ind, 'mom', i);
  const regime = indAt(ind, 'sma', i);
  const rang = snap.rank;
  const pos = snap.position;

  if (pos) {
    if (pos.side !== 'long') return hold();
    if (Number.isFinite(regime) && close < regime) return { kind: 'exit', reason: `Regime verloren: Close ${fmtPx(close)} unter Mittel ${fmtPx(regime)}` };
    if (Number.isFinite(mom) && mom < 0) return { kind: 'exit', reason: `absolutes Momentum negativ (${(mom * 100).toFixed(1)} %)` };
    // Ohne Rang (zu kleiner Korb, veraltete Bar) kein Urteil über relative Stärke.
    if (rang && rang.of >= MIN_KORB && rang.pct > req(p, 'exitPct')) {
      return { kind: 'exit', reason: `relative Stärke verloren: Rang ${rang.rank}/${rang.of}` };
    }
    return hold();
  }

  if (!rang || rang.of < MIN_KORB || rang.pct > req(p, 'topPct')) return hold();
  if (!Number.isFinite(regime) || !(close > regime)) return hold();
  if (!Number.isFinite(mom) || !(mom > 0)) return hold();

  const stop = close * (1 - req(p, 'stopPct') / 100);
  return { kind: 'enter', side: 'long', stop, reason: `Rang ${rang.rank}/${rang.of}, Regime auf, Momentum ${(mom * 100).toFixed(1)} %` };
}

export const strategy: Strategy = {
  id: 'regime_allocation',
  timeframes: [1440],
  paramSpace,
  defaults,
  holdsOvernight: true,
  warmupBars,
  precompute,
  decide,
  crossScore,
};
