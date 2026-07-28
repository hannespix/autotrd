/**
 * momentumRun — Cross-Sectional Momentum über das ganze Universum, als
 * Schattenkonto neben der laufenden Strategie (Owner-Go 28.07.).
 *
 * ── Was hier passiert ───────────────────────────────────────────────────────
 *
 *  1. Tages-Closes für ALLE Katalog-Symbole in einem Spark-Bündel holen
 *     (~9 Requests für 166 Symbole) — der erste Lauf bewertet sofort das
 *     ganze Universum. Fällt Yahoo aus, greift die gespeicherte Historie.
 *  2. Tiefe OHLCV-Historie für die CHARTS rotierend nachfüllen (Spark kennt
 *     nur Closes) — mit hartem Deckel.
 *  3. Ranking + Marktfilter rechnen, Ergebnis täglich nach `meta/momentum`
 *     schreiben (das ist die Datengrundlage der späteren Optimierung).
 *  4. Wöchentlich das Schattendepot auf das Zielportfolio bringen.
 *
 * ── Warum Schatten und nicht sofort echt ────────────────────────────────────
 *
 * Weil die Literatur auf UNSEREN Daten nichts beweist. Der Umstieg läuft
 * über dieselbe Evidenzschwelle wie jede Tuner-Beförderung: genug Trades,
 * echter Vorsprung, statistisch abgesichert. Bis dahin kostet die Strategie
 * nichts außer ein paar Firestore-Reads pro Tag.
 *
 * ── Warum der Lauf täglich rechnet, aber wöchentlich handelt ────────────────
 *
 * Das Ranking täglich zu kennen ist gratis und macht die Entwicklung des
 * Universums sichtbar. Täglich zu HANDELN wäre dagegen genau der Fehler,
 * der die Konfluenz-Strategie ruiniert hat: Jede Umschichtung ist ein
 * Roundtrip an Kosten. Gerechnet wird oft, angefasst wird selten.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  MOMENTUM_DEFAULTS,
  MOMENTUM_TOP_N,
  allSymbols,
  applyMomentumOrders,
  classify,
  emptyMomentumBook,
  feeRateForClass,
  istRebalanceFaellig,
  marketFilterPasses,
  momentumEquity,
  rankMomentum,
  rebalanceOrders,
  targetPortfolio,
  type MomentumBook,
  type RankedSymbol,
} from '../../../shared/src/index.js';
import { getDeepDailyBars, getSparkDailyCloses, chunkBarsByYear } from '../core/marketData.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';

/** Leitindex des Marktfilters — der breiteste verfügbare US-Index. */
const MARKET_INDEX = '^GSPC';
/** Startkapital des Schattendepots — gleich dem Paper-Default, damit die
 *  Ergebnisse mit den echten Konten vergleichbar bleiben. */
export const MOMENTUM_START_BALANCE = 25_000;
/**
 * Symbole je Lauf, für die tiefe OHLCV-Historie nachgeholt wird.
 *
 * Das betrifft seit dem Spark-Umbau nur noch die CHARTS, nicht mehr das
 * Ranking — der Deckel verzögert also keine Bewertung mehr, sondern nur, wie
 * schnell man in einem selten geöffneten Symbol weit zurückscrollen kann.
 * Vorher hing die Rangliste an genau dieser Zahl: 166 Symbole ÷ 20 pro Tag
 * ≈ neun Tage bis zum ersten vollständigen Lauf.
 */
const BACKFILL_PRO_LAUF = 20;

/** Zeitreihe eines Symbols aus den Jahres-Dokumenten zusammensetzen. */
function closesAusJahren(jahre: Array<Record<string, { close?: number }>>): number[] {
  const nachDatum = new Map<string, number>();
  for (const jahr of jahre) {
    for (const [datum, ohlc] of Object.entries(jahr)) {
      const c = ohlc?.close;
      if (typeof c === 'number' && Number.isFinite(c) && c > 0) nachDatum.set(datum, c);
    }
  }
  return [...nachDatum.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, c]) => c);
}

/** Tages-Closes eines Symbols laden (nur Reads, kein Netz). */
async function ladeCloses(symbol: string): Promise<number[]> {
  const db = getFirestore();
  const snap = await db.collection('market').doc(symbol).collection('ohlcDaily').get();
  if (snap.empty) return [];
  return closesAusJahren(snap.docs.map((d) => (d.get('days') ?? {}) as Record<string, { close?: number }>));
}

export interface MomentumRunResult {
  ranked: number;
  marktOffen: boolean;
  rebalanced: boolean;
  orders: number;
  equity: number;
  backfilled: number;
}

export async function runMomentum(now = new Date()): Promise<MomentumRunResult> {
  const db = getFirestore();
  const katalog = allSymbols();

  // ── 1. Historie für den GANZEN Katalog holen ──────────────────────────────
  // Ein Spark-Bündel (20 Symbole je Request, ~9 Requests für 166 Symbole)
  // statt 166 Firestore-Lesungen plus rotierendem Nachholen von 20 Symbolen
  // pro TAG. Der alte Weg hätte für den ersten vollständigen Ranglisten-Lauf
  // rund neun Tage gebraucht — solange rankte das System nur die Handvoll
  // Symbole, die zufällig schon Historie hatte, und „breit bewerten" war
  // bloß eine Absicht. Jetzt bewertet der erste Lauf sofort alles.
  const closesMap = new Map<string, number[]>();
  let fehlend: string[] = [];
  try {
    const batchCloses = await getSparkDailyCloses(katalog);
    for (const sym of katalog) {
      const closes = batchCloses.get(sym);
      if (closes && closes.length >= MOMENTUM_DEFAULTS.minBars) closesMap.set(sym, closes);
      else fehlend.push(sym);
    }
  } catch (err) {
    // Kein Ranking aus halben Daten: Fällt Yahoo aus, wird auf die
    // gespeicherte Historie zurückgefallen statt auf eine Rangliste aus
    // Zufallssymbolen. Eine Rangliste, die nur die Hälfte des Katalogs kennt,
    // sieht genauso aus wie eine richtige — und ist trotzdem falsch.
    logger.warn('Momentum: Spark-Bündel fehlgeschlagen — Rückfall auf ohlcDaily', err);
    fehlend = [];
    for (const sym of katalog) {
      const closes = await ladeCloses(sym);
      if (closes.length >= MOMENTUM_DEFAULTS.minBars) closesMap.set(sym, closes);
      else fehlend.push(sym);
    }
  }

  // ── 2. Tiefe Chart-Historie rotierend nachziehen ──────────────────────────
  // Das Ranking braucht diese Docs nicht mehr (s. o.), die CHARTS schon:
  // ohlcDaily hält ~5 Jahre OHLCV fürs nahtlose Rausscrollen, Spark liefert
  // nur Closes. Rotierend statt „immer die ersten N", damit Symbole, deren
  // Fetch dauerhaft scheitert, nicht für immer den Kopf der Schlange
  // blockieren (dieselbe Falle wie bei der Intraday-Bewertung am 27.07.).
  let backfilled = 0;
  if (fehlend.length > 0) {
    const stateRef = db.doc('meta/momentum');
    const cursor = ((await stateRef.get()).get('backfillCursor') as number | undefined) ?? 0;
    for (let n = 0; n < Math.min(BACKFILL_PRO_LAUF, fehlend.length); n++) {
      const sym = fehlend[(cursor + n) % fehlend.length]!;
      try {
        const deep = await getDeepDailyBars(sym);
        if (deep.length === 0) continue;
        const batch = db.batch();
        const ref = db.collection('market').doc(sym);
        for (const [jahr, tage] of chunkBarsByYear(deep)) {
          batch.set(ref.collection('ohlcDaily').doc(jahr), { days: tage, updatedAt: now.toISOString() }, { merge: true });
        }
        batch.set(ref, { deepBackfillV: 1, deepBackfilledAt: now.toISOString() }, { merge: true });
        await batch.commit();
        backfilled++;
        const closes = deep.map((b) => b.close).filter((c) => c > 0);
        if (closes.length >= MOMENTUM_DEFAULTS.minBars) closesMap.set(sym, closes);
      } catch (err) {
        logger.warn(`Momentum-Backfill ${sym} fehlgeschlagen`, err);
      }
    }
    await stateRef.set(
      { backfillCursor: (cursor + BACKFILL_PRO_LAUF) % Math.max(1, fehlend.length) },
      { merge: true },
    );
  }

  // ── 3. Ranking + Marktfilter ──────────────────────────────────────────────
  const ranked: RankedSymbol[] = rankMomentum(closesMap);
  const indexCloses = closesMap.get(MARKET_INDEX) ?? (await ladeCloses(MARKET_INDEX));
  const marktOffen = marketFilterPasses(indexCloses);
  const ziel = targetPortfolio(ranked, marktOffen, MOMENTUM_TOP_N);

  // ── 4. Schattendepot ──────────────────────────────────────────────────────
  const bookRef = db.doc('meta/momentumBook');
  const bookSnap = await bookRef.get();
  let book =
    (bookSnap.get('book') as MomentumBook | undefined) ??
    emptyMomentumBook(MOMENTUM_START_BALANCE, now);

  // Preise: letzter bekannter Close je Symbol — dieselbe Quelle wie das
  // Ranking, damit Bewertung und Entscheidung nicht auseinanderlaufen.
  const preise = new Map<string, number>();
  for (const [sym, closes] of closesMap) {
    const p = closes[closes.length - 1];
    if (p !== undefined && p > 0) preise.set(sym, p);
  }

  const faellig = istRebalanceFaellig(book.lastRebalance, now);
  let orders: ReturnType<typeof rebalanceOrders> = [];
  if (faellig) {
    const equity = momentumEquity(book, preise);
    orders = rebalanceOrders(new Set(Object.keys(book.holdings)), ziel, equity);
    // Ohne Kurs keine Order: Ein Kauf zum Einstand eines fremden Symbols
    // wäre erfunden, und erfundene Trades machen die ganze Auswertung wertlos.
    orders = orders.filter((o) => o.side === 'sell' || preise.has(o.symbol));
    if (orders.length > 0) {
      book = applyMomentumOrders({
        book,
        orders,
        preise,
        feeRate: (sym) => feeRateForClass(classify(sym)),
        fractional: (sym) => classify(sym) === 'crypto',
        now,
      });
    } else {
      book = { ...book, lastRebalance: now.toISOString() };
    }
    await bookRef.set({ book, updatedAt: now.toISOString() }, { merge: true });
  }

  const equity = momentumEquity(book, preise);

  // Tages-Protokoll: Ranking-Spitze, Filter-Zustand, Depotwert. Das ist die
  // Datengrundlage, aus der sich später beurteilen lässt, ob die Strategie
  // die laufende schlägt — und der einzige Weg, das ohne echtes Geld zu tun.
  await db.doc('meta/momentum').set(
    {
      at: now.toISOString(),
      date: now.toISOString().slice(0, 10),
      ranked: ranked.length,
      universum: katalog.length,
      marktOffen,
      top: ranked.slice(0, MOMENTUM_TOP_N).map((r) => ({ symbol: r.symbol, score: r.score })),
      ziel: ziel.map((z) => z.symbol),
      gehalten: Object.keys(book.holdings).sort(),
      equity,
      trades: book.pnls.length,
      rebalanced: faellig,
      backfilled,
      fehlendeHistorie: Math.max(0, katalog.length - closesMap.size),
    },
    { merge: true },
  );

  logger.info(
    `momentumRun: ${ranked.length}/${katalog.length} bewertbar, Filter ${marktOffen ? 'offen' : 'ZU'}, ` +
      `${faellig ? `${orders.length} Order(s)` : 'kein Rebalancing'}, Equity ${equity}`,
  );

  return { ranked: ranked.length, marktOffen, rebalanced: faellig, orders: orders.length, equity, backfilled };
}

/** Täglich 18:00 ET — nach snapshotEquity (17:15) und autoTune (17:45). */
export const momentumRun = onSchedule(
  {
    schedule: '0 18 * * *',
    timeZone: 'America/New_York',
    retryCount: 0,
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async () => {
    await runMomentum();
  },
);

/** Manueller Trigger — NUR im Emulator (Abnahme-Verifikation). */
export const momentumNow = onRequest(EMULATOR_TRIGGER_OPTS, async (_req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'momentumNow ist nur im Emulator verfügbar' });
    return;
  }
  res.status(200).json(await runMomentum());
});
