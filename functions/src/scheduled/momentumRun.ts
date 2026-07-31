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
  isStrategy,
  isTradable,
  istRebalanceFaellig,
  marketFilterPasses,
  momentumEquity,
  rankMomentum,
  rebalanceOrders,
  targetPortfolio,
  type MomentumBook,
  type Position,
  type RankedSymbol,
  type Strategy,
  type TargetPosition,
  bucketKey,
} from '../../../shared/src/index.js';
import { executePaperTrade, resolveBrokerMode } from '../core/broker.js';
import { mayTrade } from '../core/access.js';
import { clampStrategyRisk } from '../core/rulesTrading.js';
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
  /** Echte Paper-Wallets im Momentum-Modus, die rebalanciert wurden. */
  echteKonten: number;
  /** Dort tatsächlich ausgeführte Orders. */
  echteOrders: number;
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
  // Bewertet wird der GANZE Katalog, gekauft nur, was es zu kaufen gibt
  // (Befund 28.07.): Ohne diesen Filter landeten ^N225 und ^GSPC im
  // Zielportfolio — Zahlen, die kein Broker verkauft. Das Ranking selbst
  // bleibt vollständig, weil es als Marktbild wertvoll ist.
  const rankedAlle: RankedSymbol[] = rankMomentum(closesMap);
  const ranked = rankedAlle.filter((r) => isTradable(r.symbol));
  const indexCloses = closesMap.get(MARKET_INDEX) ?? (await ladeCloses(MARKET_INDEX));
  // Der Marktfilter läuft bewusst über den nicht handelbaren ^GSPC: Als
  // SIGNAL ist er das breiteste verfügbare US-Bild, gekauft wird er nie.
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

  // ── 5. Echte Wallets im Momentum-Modus ────────────────────────────────────
  const echte = await rebalanceMomentumUsers(ziel, preise, now);

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
      // Echte Konten im Momentum-Modus — getrennt vom Schattendepot, damit
      // sichtbar bleibt, ob überhaupt jemand die Strategie scharf hat.
      echteKonten: echte.konten,
      echteOrders: echte.orders,
    },
    { merge: true },
  );

  logger.info(
    `momentumRun: ${ranked.length}/${katalog.length} bewertbar, Filter ${marktOffen ? 'offen' : 'ZU'}, ` +
      `${faellig ? `${orders.length} Order(s)` : 'kein Rebalancing'}, Equity ${equity}`,
  );

  return {
    ranked: ranked.length,
    marktOffen,
    rebalanced: faellig,
    orders: orders.length,
    equity,
    backfilled,
    echteKonten: echte.konten,
    echteOrders: echte.orders,
  };
}

/**
 * Wöchentliches Rebalancing der ECHTEN Paper-Wallets im Momentum-Modus.
 *
 * ── Warum das die ruhige Schicht ist ──────────────────────────────────────
 *
 * Die Konfluenz-Engine hat über 297 Live-Trades 1 774 $ Gebühren erzeugt —
 * das 2,7-Fache ihres Brutto-Ergebnisses. Diese Strategie handelt EINMAL DIE
 * WOCHE und rührt bestehende Zielpositionen nicht an: typisch 0 bis 3 Orders
 * je Konto und Woche statt Dutzender am Tag. Die Reibung fällt damit von der
 * dominierenden Größe auf eine Randnotiz.
 *
 * ── Was hier bewusst FEHLT: Stop-Loss ─────────────────────────────────────
 *
 * Momentum-Positionen bekommen keine Stops, und das ist keine Nachlässigkeit.
 * Die Strategie lebt davon, Gewinner laufen zu lassen und Verlierer beim
 * nächsten Rebalancing aus der Rangliste fallen zu sehen. Ein enger Stop
 * würde sie systematisch an genau den Rücksetzern ausstoppen, über die
 * hinweg sie ihre Rendite verdient — er machte aus der Strategie eine
 * andere, schlechtere.
 *
 * Was bleibt: der SMA200-Marktfilter (in einem Abwärtsmarkt ist das
 * Zielportfolio leer, das Konto geht in Cash) und der Margin-Call im
 * 1-Minuten-Puls. Der ist kein Strategie-Stop, sondern eine Solvenzgrenze.
 *
 * ── Warum die Kaufreihenfolge zählt ───────────────────────────────────────
 *
 * `rebalanceOrders` liefert Verkäufe zuerst, und die Schleife hält diese
 * Reihenfolge ein: Erst das Cash freimachen, dann kaufen. Andersherum
 * scheiterten die Käufe an `zu_wenig_cash`, obwohl das Geld eine Zeile
 * später da gewesen wäre — ein Fehler, der nur bei vollem Depot auftritt
 * und deshalb im Test leicht durchrutscht.
 */
async function rebalanceMomentumUsers(
  ziel: TargetPosition[],
  preise: ReadonlyMap<string, number>,
  now: Date,
): Promise<{ konten: number; orders: number }> {
  const db = getFirestore();
  const users = await db
    .collection('users')
    .where('settings.strategy.engine.mode', '==', 'momentum')
    .get();

  let konten = 0;
  let orderSumme = 0;

  for (const userDoc of users.docs) {
    try {
      const roh = userDoc.get('settings.strategy') as Strategy | undefined;
      if (!roh || !isStrategy(roh)) continue;
      if (roh.engine.running !== true) continue;
      // Dieselben Tore wie im Scan: Echtgeld bleibt verriegelt, nicht
      // freigeschaltete Konten handeln nicht.
      if (resolveBrokerMode(roh) !== 'paper') continue;
      if (!mayTrade(userDoc.data())) continue;
      const clamped = clampStrategyRisk(structuredClone(roh));

      const stateRef = userDoc.ref.collection('meta').doc('momentum');
      const lastRebalance = (await stateRef.get()).get('lastRebalance') as string | undefined;
      if (!istRebalanceFaellig(lastRebalance ?? null, now)) continue;

      const posSnap = await userDoc.ref.collection('positions').get();
      const gehalten = new Map<string, Position>(
        posSnap.docs.map((d) => [d.id, d.data() as Position]),
      );
      const cash = (userDoc.get('wallet.paperBalance') as number | undefined) ?? 0;
      let equity = cash;
      for (const [sym, pos] of gehalten) {
        equity += pos.qty * (preise.get(sym) ?? pos.avgEntry);
      }
      if (!(equity > 0)) continue;

      const orders = rebalanceOrders(new Set(gehalten.keys()), ziel, equity)
        // Ohne Kurs kein Kauf — ein erfundener Einstand macht die ganze
        // Auswertung wertlos. Verkäufe brauchen keinen: Sie schließen zum
        // Kurs, den der Broker ohnehin bekommt.
        .filter((o) => o.side === 'sell' || preise.has(o.symbol));

      let ausgefuehrt = 0;
      for (const o of orders) {
        const preis = preise.get(o.symbol) ?? gehalten.get(o.symbol)?.avgEntry;
        if (!preis || !(preis > 0)) continue;
        const cls = classify(o.symbol);
        if (o.side === 'sell') {
          const r = await executePaperTrade(
            { uid: userDoc.id, symbol: o.symbol, side: 'sell', price: preis, source: 'engine', riskExit: 'momentum_rebalance', assetClass: cls },
            clamped,
          );
          if (r.executed) ausgefuehrt += 1;
          continue;
        }
        const fractional = cls === 'crypto';
        const roheMenge = (o.notional ?? 0) / preis;
        const qty = fractional ? Math.floor(roheMenge * 1e6) / 1e6 : Math.floor(roheMenge);
        if (qty < (fractional ? 1e-6 : 1)) continue;
        const r = await executePaperTrade(
          {
            uid: userDoc.id,
            symbol: o.symbol,
            side: 'buy',
            price: preis,
            qty,
            source: 'engine',
            assetClass: cls,
            // Steckbrief fürs Meta-Labeling: Momentum-Käufe lernen getrennt
            bucket: bucketKey({ assetClass: cls, timeframe: 'daily', signature: 'momentum', side: 'long' }),
          },
          clamped,
        );
        if (r.executed) ausgefuehrt += 1;
      }

      // Der Zeitstempel wird IMMER gesetzt, auch wenn nichts zu tun war.
      // Sonst gälte das Rebalancing als überfällig und liefe täglich neu —
      // bei einem leeren Zielportfolio (Marktfilter zu) wäre das eine
      // Endlosschleife aus Nichts.
      await stateRef.set(
        { lastRebalance: now.toISOString(), orders: orders.length, executed: ausgefuehrt },
        { merge: true },
      );
      konten += 1;
      orderSumme += ausgefuehrt;
      if (ausgefuehrt > 0) {
        logger.info(`Momentum-Rebalancing ${userDoc.id}: ${ausgefuehrt}/${orders.length} Order(s)`);
      }
    } catch (err) {
      logger.warn(`Momentum-Rebalancing: User ${userDoc.id} übersprungen`, err);
    }
  }
  return { konten, orders: orderSumme };
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
