/**
 * Ereigniskanal für Ausführungen (Drift-Paket 2, 08.10.).
 *
 * ── Warum ────────────────────────────────────────────────────────────────
 *
 * Bis zum Drift-Paket 1 erfuhr das Buch von einem Fill nur, wenn es im
 * Moment der Order selbst nachfragte. Paket 1 hat die bekannten Nebenwege
 * geschlossen (Stop-Rest, offene Orders, doppelte Exits). Dieser Lauf dreht
 * die Beweislast um: Er liest die KONTO-AKTIVITÄT des Brokers — jede
 * Ausführung, egal auf welchem Weg sie zustande kam — und bucht, was im
 * Buch fehlt. Der Abgleich wird damit zur Kontrolle, nicht zur einzigen
 * Wahrheit.
 *
 * ── Regeln ───────────────────────────────────────────────────────────────
 *
 *   - Nur UNSERE Orders (Client-Kennung beginnt mit der Nutzer-Kennung).
 *     Hand-Orders in der Alpaca-Oberfläche werden gezählt, nie gebucht —
 *     dieselbe Linie wie bei der Depot-Übernahme.
 *   - Gebucht wird je Order die DIFFERENZ zwischen Σ Ausführungen und dem,
 *     was das Buch schon trägt (Σ qty je brokerOrderId). Nie zweimal.
 *   - Orders mit einem Vermerk in `offeneOrders` gehören dem Nachlauf
 *     (Paket 1) und werden hier übersprungen.
 *   - Karenz: Ausführungen jünger als FILL_KARENZ_MIN bleiben liegen —
 *     der eigene Buchungspfad des Scans hat Vorrang.
 *   - Maßgeblich ist die KUMULIERTE Menge der Order laut Broker, nicht die
 *     Summe der Ausführungen im Fenster (Red-Team 08.10., H2): Ein später
 *     Rest-Fill einer offenen Order wird so auch dann gebucht, wenn der
 *     erste Teil schon im Buch steht. Eine eröffnende Order, die noch
 *     arbeitet, bekommt einen Nachlauf-Vermerk (Paket 1 storniert den Rest).
 *   - Scheitert eine Buchung, fällt der Cursor auf den Stand VOR der ersten
 *     Ausführung dieser Order zurück (H1) — auch wenn andere Orders danach
 *     schon gebucht wurden; die liest der nächste Lauf harmlos noch einmal.
 *     Nach FILL_FEHLER_MAX Fehlschlägen in Folge wird laut aufgegeben und der
 *     Cursor rückt vor (Fall für die Übernahme). Nichts verschwindet still.
 *   - Ein VERKAUF ohne Buch-Position eröffnet nur dann einen Buch-Short, wenn
 *     es eine eigene Market-Order mit Lauf-Kennung ist (H3). Ein Stop oder
 *     ein Exit auf eine Position, die das Buch nicht (mehr) kennt — etwa
 *     nach einem Reset —, ist ein Fall für die Übernahme, kein Phantom-Short.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { classify, isStrategy, resetLaeuft, type Strategy } from '../../../shared/src/index.js';
import {
  alpacaOrderAbfragen,
  holeFillAktivitaeten,
  type AlpacaFill,
  type AlpacaOrderStand,
} from '../core/alpacaBroker.js';
import { executePaperTrade, gebuchteMengeJeOrder, merkeOffeneOrder, merkeUnbookedFill } from '../core/broker.js';
import { ORDER_ENDZUSTAENDE, brokerVerbindungLesend } from '../core/orderRouting.js';
import { mayTrade } from '../core/access.js';
import { clampStrategyRisk } from '../core/rulesTrading.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';

/** Ausführungen jünger als das bleiben dem Buchungspfad des Scans. */
export const FILL_KARENZ_MIN = 3;
/** Beim ersten Lauf höchstens so weit zurück (die Übernahme deckt Älteres). */
export const FILL_ERSTLAUF_STUNDEN = 24;
/** Nach so vielen Fehlschlägen in Folge je Order wird laut aufgegeben. */
export const FILL_FEHLER_MAX = 10;

export interface FillSyncKonto {
  geprueft: number;
  gebucht: number;
  fremd: number;
  uebersprungen: number;
  fehler: number;
  /** Verkäufe ohne Buch-Position, nicht gebucht (Fall für die Übernahme). */
  ohnePosition: number;
  /** Cursor fiel zurück (Fehlschlag) — der nächste Lauf wiederholt. */
  wartet: boolean;
}

/** Je Order zusammengefasst: Menge, mengengewichteter Preis, Zeit, Seite. */
export interface OrderFills {
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  menge: number;
  preis: number;
  /** Zeit der letzten Ausführung dieser Order. */
  zuletzt: string;
  /** Zeit der ersten Ausführung (Cursor-Rückfall bei Fehlschlag). */
  zuerst: string;
}

/**
 * Ausführungen je Order bündeln — pur. Nur Ausführungen vor `bisIso`
 * (Karenz); die Reihenfolge folgt der ersten Ausführung je Order.
 */
export function buendleFills(fills: readonly AlpacaFill[], bisIso: string): OrderFills[] {
  const map = new Map<string, OrderFills & { wert: number }>();
  for (const f of fills) {
    if (!f.orderId || !(f.qty > 0) || !(f.price > 0) || !f.transactionTime) continue;
    if (f.transactionTime >= bisIso) continue;
    const e = map.get(f.orderId);
    if (!e) {
      map.set(f.orderId, { orderId: f.orderId, symbol: f.symbol, side: f.side, menge: f.qty, preis: f.price, wert: f.qty * f.price, zuletzt: f.transactionTime, zuerst: f.transactionTime });
    } else {
      e.menge += f.qty;
      e.wert += f.qty * f.price;
      e.preis = Math.round((e.wert / e.menge) * 10_000) / 10_000;
      if (f.transactionTime > e.zuletzt) e.zuletzt = f.transactionTime;
      if (f.transactionTime < e.zuerst) e.zuerst = f.transactionTime;
    }
  }
  return [...map.values()]
    .map(({ wert: _w, ...rest }) => rest)
    .sort((a, b) => (a.zuerst < b.zuerst ? -1 : a.zuerst > b.zuerst ? 1 : 0));
}

/** Gehört die Order zu uns? Dieselbe Regel wie bei der Depot-Übernahme. */
export function eigeneOrder(uid: string, clientOrderId: string | undefined): boolean {
  if (!clientOrderId) return false;
  return clientOrderId.startsWith(`${uid.replace(/[^A-Za-z0-9-]/g, '_')}-`);
}

/** Zeitpunkt minus Minuten als ISO. */
const minusMin = (iso: string, min: number): string => new Date(Date.parse(iso) - min * 60_000).toISOString();

/**
 * Cursor-Stand VOR einer Order (Red-Team 08.10., H1): die späteste
 * Ausführung, die strikt vor der ersten Ausführung dieser Order liegt —
 * sonst der alte Cursor. `after` ist beim Broker exklusiv; alles ab der
 * Order wird im nächsten Lauf erneut gelesen.
 */
export function cursorVor(fills: readonly AlpacaFill[], zuerstIso: string, fallback: string): string {
  let best = fallback;
  for (const f of fills) {
    if (f.transactionTime < zuerstIso && f.transactionTime > best) best = f.transactionTime;
  }
  return best;
}

/**
 * Darf ein VERKAUF ohne Buch-Position einen Buch-Short eröffnen? Nur eine
 * eigene Market-Order mit Lauf-Kennung (so eröffnet die Engine Shorts).
 * Stop-Orders und Exits (`exit-` in der Kennung) gehören zu einer Position,
 * die das Buch nicht mehr kennt — Fall für die Übernahme (H3).
 */
export function darfShortEroeffnen(order: { typ?: string | undefined; clientOrderId?: string | undefined }): boolean {
  if (order.typ !== 'market') return false;
  return !/-exit-/.test(order.clientOrderId ?? '');
}

/**
 * Ein Konto: Aktivität lesen, fehlende Ausführungen buchen, Cursor vorrücken.
 */
export async function fillSyncKonto(
  uid: string,
  strategy: Strategy,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<FillSyncKonto> {
  const leer: FillSyncKonto = { geprueft: 0, gebucht: 0, fremd: 0, uebersprungen: 0, fehler: 0, ohnePosition: 0, wartet: false };
  const verbindung = await brokerVerbindungLesend(uid, now.getTime());
  if (!verbindung) return leer;
  const db = getFirestore();
  const brokerRef = db.doc(`users/${uid}/private/broker`);
  const brokerDoc = await brokerRef.get();
  const stand = (brokerDoc.get('fillSync') as { cursor?: string; fehlerFolge?: number; accountId?: string } | undefined) ?? {};
  const accountId = String(brokerDoc.get('accountId') ?? '');
  // Cursor: letzter verarbeiteter Zeitpunkt; beim ersten Lauf (oder nach
  // Kontowechsel) höchstens FILL_ERSTLAUF_STUNDEN zurück und nie vor dem
  // Verbinden — Älteres gehört der Depot-Übernahme.
  const connectedAt = String(brokerDoc.get('connectedAt') ?? '');
  const erstlauf = minusMin(now.toISOString(), FILL_ERSTLAUF_STUNDEN * 60);
  const cursorAlt = stand.cursor && stand.accountId === accountId ? stand.cursor : [erstlauf, connectedAt].filter(Boolean).sort().pop()!;
  const nowIso = now.toISOString();
  const karenz = minusMin(nowIso, FILL_KARENZ_MIN);

  const { fills, abgeschnitten } = await holeFillAktivitaeten(verbindung.mode, verbindung.schluessel, cursorAlt, fetchImpl);
  if (abgeschnitten) logger.warn(`fillSync ${uid}: Seitendeckel erreicht — Rest im nächsten Lauf`);
  const orders = buendleFills(fills, karenz);

  let gebucht = 0;
  let fremd = 0;
  let uebersprungen = 0;
  let fehler = 0;
  let ohnePosition = 0;
  let cursorNeu = cursorAlt;
  let fehlerFolge = typeof stand.fehlerFolge === 'number' ? stand.fehlerFolge : 0;
  let wartet = false;
  for (const o of orders) {
    let order: AlpacaOrderStand | null;
    try {
      order = await alpacaOrderAbfragen(verbindung.mode, o.orderId, verbindung.schluessel, fetchImpl);
    } catch (err) {
      logger.warn(`fillSync ${uid} ${o.symbol}: Order ${o.orderId} nicht lesbar — nächster Lauf`, err);
      cursorNeu = cursorVor(fills, o.zuerst, cursorAlt);
      wartet = true;
      break;
    }
    if (!order || !eigeneOrder(uid, order.clientOrderId)) {
      fremd += 1;
      cursorNeu = o.zuletzt > cursorNeu ? o.zuletzt : cursorNeu;
      continue;
    }
    // Dem Nachlauf (Paket 1) gehört, was dort vermerkt ist.
    const vermerkId = (order.clientOrderId ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
    const vermerk = vermerkId ? await db.doc(`users/${uid}/offeneOrders/${vermerkId}`).get().catch(() => null) : null;
    if (vermerk?.exists) {
      uebersprungen += 1;
      cursorNeu = o.zuletzt > cursorNeu ? o.zuletzt : cursorNeu;
      continue;
    }
    const schon = await gebuchteMengeJeOrder(uid, o.orderId);
    // KUMULIERT laut Order (H2), nicht nur das Fenster: Ein Rest-Fill einer
    // offenen Order ist sonst „schon gebucht", weil Fenster-Summe = Buch.
    const gesamt = order.filledQty > 0 ? order.filledQty : o.menge;
    const fehlt = Math.round((gesamt - schon) * 1e6) / 1e6;
    // Preis: der des Fensters, wenn es genau den fehlenden Teil enthält —
    // sonst der Durchschnitt der Order (ehrlicher als ein geratener).
    const preis = Math.abs(o.menge - fehlt) < 1e-9 || !(order.filledAvgPreis > 0) ? o.preis : order.filledAvgPreis;
    if (fehlt <= 1e-9) {
      cursorNeu = o.zuletzt > cursorNeu ? o.zuletzt : cursorNeu;
      continue;
    }
    // Eröffnend oder schließend? Entscheidet das Buch: Ein Kauf auf einen
    // Short deckt ein, ein Verkauf auf einen Long schließt — alles andere
    // eröffnet (oder stockt auf).
    const posSnap = await db.doc(`users/${uid}/positions/${o.symbol}`).get();
    const posSide = posSnap.exists ? (posSnap.get('side') as string | undefined) : undefined;
    const schliesst = posSnap.exists && ((o.side === 'buy' && posSide === 'short') || (o.side === 'sell' && posSide !== 'short'));
    const endzustand = ORDER_ENDZUSTAENDE.has(order.status);
    /* Verkauf ohne Buch-Position (H3): kein Phantom-Short aus einem Stop
     * oder Exit auf eine Position, die das Buch nicht mehr kennt (Reset).
     * Laut melden, Cursor vorrücken — der Abgleich zeigt den Zustand, die
     * Übernahme löst ihn. */
    if (o.side === 'sell' && !posSnap.exists && !darfShortEroeffnen(order)) {
      ohnePosition += 1;
      logger.error(`fillSync ${uid} ${o.symbol}: Verkauf ${fehlt} Stück (${order.typ ?? '?'}) ohne Buch-Position — Fall für die Übernahme, nicht gebucht`);
      cursorNeu = o.zuletzt > cursorNeu ? o.zuletzt : cursorNeu;
      continue;
    }
    const r = await executePaperTrade(
      {
        uid,
        symbol: o.symbol,
        side: o.side,
        price: preis,
        qty: fehlt,
        fillPreis: preis,
        brokerOrderId: o.orderId,
        source: 'engine',
        assetClass: classify(o.symbol),
        ausgefuehrtAt: o.zuletzt,
        ...(schliesst
          ? { restStorniert: endzustand, riskExit: 'fill_sync' }
          : { aufstockung: true, ...(o.side === 'sell' ? { openShort: true } : {}) }),
      },
      strategy,
    ).catch((err: unknown) => ({
      executed: false as const,
      reason: `buchung_exception: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
    }));
    if (r.executed) {
      gebucht += 1;
      fehlerFolge = 0;
      cursorNeu = o.zuletzt > cursorNeu ? o.zuletzt : cursorNeu;
      logger.warn(`FILL-SYNC ${uid} ${o.symbol}: ${o.side} ${fehlt} @ ${preis} nachgebucht (Order ${o.orderId})`);
      // Eine eröffnende Order, die noch ARBEITET, darf nicht unbeaufsichtigt
      // weiterfüllen (H2): Vermerk für den Nachlauf, der den Rest storniert.
      if (!schliesst && !endzustand && order.clientOrderId) {
        await merkeOffeneOrder(uid, o.symbol, o.side, { art: 'einstieg_rest', orderId: o.orderId, clientOrderId: order.clientOrderId }, {
          gebucht: schon + fehlt,
          soll: gesamt,
          lauf: 'fill-sync',
        });
      }
      continue;
    }
    if (r.reason === 'fill_schon_gebucht') {
      // Rennen mit einem anderen Pfad — schon erledigt, weiter.
      cursorNeu = o.zuletzt > cursorNeu ? o.zuletzt : cursorNeu;
      continue;
    }
    fehler += 1;
    fehlerFolge += 1;
    if (fehlerFolge >= FILL_FEHLER_MAX) {
      logger.error(`fillSync ${uid} ${o.symbol}: ${fehlt} Stück nach ${FILL_FEHLER_MAX} Fehlschlägen nicht buchbar (${r.reason ?? '?'}) — aufgegeben, Fall für die Übernahme`);
      await merkeUnbookedFill(uid, o.symbol, o.side, fehlt, o.preis, o.orderId, 'fill-sync', r.reason ?? 'unbekannt', schliesst ? endzustand : undefined);
      fehlerFolge = 0;
      cursorNeu = o.zuletzt > cursorNeu ? o.zuletzt : cursorNeu;
      continue;
    }
    logger.error(`fillSync ${uid} ${o.symbol}: ${fehlt} Stück NICHT gebucht — ${r.reason ?? '?'} (Versuch ${fehlerFolge}, Cursor fällt zurück)`);
    cursorNeu = cursorVor(fills, o.zuerst, cursorAlt);
    wartet = true;
    break;
  }

  await brokerRef
    .set({ fillSync: { cursor: cursorNeu, accountId, at: nowIso, fehlerFolge, gebucht, fremd, ohnePosition } }, { merge: true })
    .catch((err: unknown) => logger.warn(`fillSync ${uid}: Cursor nicht geschrieben`, err));
  return { geprueft: orders.length, gebucht, fremd, uebersprungen, fehler, ohnePosition, wartet };
}

export interface FillSyncLauf {
  konten: number;
  gebucht: number;
  fremd: number;
  fehler: number;
  uebersprungen: number;
  ohnePosition: number;
}

export async function runFillSync(now: Date = new Date()): Promise<FillSyncLauf> {
  const db = getFirestore();
  const users = await db
    .collection('users')
    .where('settings.strategy.engine.running', '==', true)
    .get();
  const summe: FillSyncLauf = { konten: 0, gebucht: 0, fremd: 0, fehler: 0, uebersprungen: 0, ohnePosition: 0 };
  for (const userDoc of users.docs) {
    try {
      const roh = userDoc.get('settings.strategy') as Strategy | undefined;
      if (!roh || !isStrategy(roh)) continue;
      if (!mayTrade(userDoc.data())) continue;
      // Während Reset/Übernahme bucht niemand — der Schnitt nähme es nicht mit.
      if (resetLaeuft(userDoc.get('risk.resetLaeuftSeit'), now)) continue;
      const r = await fillSyncKonto(userDoc.id, clampStrategyRisk(structuredClone(roh)), now);
      if (r.geprueft === 0 && !r.wartet && r.gebucht === 0) continue;
      summe.konten += 1;
      summe.gebucht += r.gebucht;
      summe.fremd += r.fremd;
      summe.fehler += r.fehler;
      summe.uebersprungen += r.uebersprungen;
      summe.ohnePosition += r.ohnePosition;
    } catch (err) {
      summe.fehler += 1;
      logger.warn(`fillSync: Konto übersprungen`, err);
    }
  }
  await db
    .doc('meta/health')
    .set({ fillSync: { at: now.toISOString(), ...summe } }, { merge: true })
    .catch(() => undefined);
  return summe;
}

/**
 * Alle fünf Minuten, zwei Minuten nach dem Scan (:00/:05 …): Dessen eigener
 * Buchungspfad hat dann gebucht, was er buchen konnte; die Karenz deckt den
 * Rest. 256 MiB genügen — keine Bars, keine Indikatoren.
 */
export const fillSync = onSchedule(
  {
    schedule: '2-59/5 * * * *',
    timeZone: 'America/New_York',
    memory: '256MiB',
    timeoutSeconds: 240,
    retryCount: 0,
    secrets: ['BROKER_MASTER_KEY'],
  },
  async () => {
    const r = await runFillSync();
    logger.info(`fillSync: ${r.konten} Konto/Konten, ${r.gebucht} nachgebucht, ${r.fremd} fremd, ${r.fehler} Fehler`);
  },
);

/** Manueller Anstoß — nur im Emulator, wie die übrigen *Now-Endpunkte. */
export const fillSyncNow = onRequest(EMULATOR_TRIGGER_OPTS, async (_req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'fillSyncNow ist nur im Emulator verfügbar' });
    return;
  }
  res.status(200).json(await runFillSync());
});
