/**
 * adoptBroker — das Buch an das reale Broker-Depot angleichen (05.08.).
 *
 * ── Der Vorfall, der das nötig machte ─────────────────────────────────────
 *
 * Am 05.08. um 15:30 kaufte die Engine über das Order-Routing real bei
 * Alpaca ein (16 Fills, ~119.500 $). Kurz darauf wurde das Buch per
 * „Neu anfangen" geleert — der Reset löscht Positionen, Trades und
 * Kennzahlen des BUCHES, aber kein Reset der Welt löscht ein Depot beim
 * Broker. Ergebnis: Alpaca hält acht Positionen, das Buch keine einzige;
 * der Abgleich meldet dauerhaft Fremdbestand, die Historie fehlt im
 * Steuerbericht.
 *
 * Owner-Frage dazu: „kann man das nicht im Nachhinein synchronisieren!?!"
 * — Ja. Genau das tut dieses Callable.
 *
 * ── Was übernommen wird ───────────────────────────────────────────────────
 *
 *   Positionen  aus `/v2/positions` — Menge, Seite, Einstand. Stops und
 *               Ziele werden aus der AKTUELLEN Strategie neu abgeleitet,
 *               damit riskPulse die übernommenen Positionen sofort schützt.
 *   Barbestand  aus `/v2/account` (`cash`, nicht `equity` — der Rest des
 *               Vermögens steckt in den Positionen, die gerade übernommen
 *               werden; equity zusätzlich zu setzen zählte ihn doppelt).
 *   Historie    aus `/v2/orders?status=closed` — aber NUR Orders mit
 *               unserer eigenen `client_order_id`. Was ein Mensch direkt
 *               in der Alpaca-Oberfläche gehandelt hat, gehört ihm, nicht
 *               unserem Buch; es erscheint als Bestand, nicht als Trade.
 *
 * ── Was NICHT passiert ────────────────────────────────────────────────────
 *
 * Keine einzige Order. Die Übernahme liest den Broker und schreibt das
 * Buch — sie kauft nichts, verkauft nichts, storniert nichts. Sie ist die
 * Umsetzung der Architekturentscheidung von M13 für den Konfliktfall:
 * Alpaca ist die Wahrheit über den BESTAND, also folgt ihr das Buch.
 *
 * Buch-Positionen, die der Broker nicht kennt, werden dabei GELÖSCHT —
 * das ist die harte Konsequenz derselben Entscheidung. Wer sie behalten
 * will, übernimmt nicht.
 */

import { getFirestore, Timestamp, type WriteBatch } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import {
  DEFAULT_STRATEGY,
  classify,
  currencyForSymbol,
  feePartsForClass,
  resolveRisk,
  type Position,
  type Strategy,
} from '../../../shared/src/index.js';
import {
  alpacaKonto,
  alpacaOrdersGeschlossen,
  alpacaOrdersOffen,
  alpacaPositionen,
  type AlpacaGeschlosseneOrder,
} from '../core/alpacaBroker.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';
import { consumeQuota } from '../core/broker.js';
import { fxFelder } from '../core/fx.js';
import { brokerVerbindungLesend } from '../core/orderRouting.js';

/** Übernahmen je Tag — großzügig, aber kein Dauerlauf. */
const DAILY_ADOPT_LIMIT = 10;

/** Wie weit die Order-Historie zurückgeholt wird. Länger als jede
 *  realistische Lücke zwischen Vorfall und Übernahme; ein Zuviel ist
 *  harmlos, weil bereits gebuchte brokerOrderIds übersprungen werden.
 *  Seit 07.08. 30 Tage (vorher 14): Die Handelsanalyse speist sich aus
 *  dieser Historie, und die Pagination trägt das Fenster jetzt. */
const HISTORIE_TAGE = 30;

/**
 * PnL je importierter Verkaufs-/Cover-Order — dieselbe Durchschnittskosten-
 * Rechnung wie der Live-Pfad (broker.ts: pnl = (Kurs − avgEntry) × Menge).
 *
 * Warum das existiert (Owner-Frage 07.08.: „die Handelsanalyse soll nach der
 * Broker-Synchronisation automatisch Daten beinhalten — auch nach Reset"):
 * Die GESAMTE Handelsanalyse (Winrate, Profitfaktor, Kanten-Messung,
 * Kennzahlen-Karte) zählt ausschließlich Trades MIT pnl-Feld (closedOnly).
 * Nachgebuchte Trades ohne pnl waren für sie unsichtbar — die Historie
 * stand in der Liste, aber die Analyse blieb leer.
 *
 * Konservativ, kein Raten: Ein Verkauf, dessen Einstand VOR dem
 * Import-Fenster liegt, bekommt KEIN pnl (unbekannte Basis) und wird auch
 * nicht als Short-Eröffnung unterstellt — nachfolgende Käufe eröffnen
 * frisch. PnL rechnet auf den echten Fill-Kursen; die Gebühren stehen
 * separat am Trade (Kosten-Analyse), wie beim Sync-Import üblich.
 */
export function importPnls(orders: AlpacaGeschlosseneOrder[]): Map<string, number> {
  const buch = new Map<string, { qty: number; avg: number }>();
  const pnls = new Map<string, number>();
  for (const o of orders) {
    const b = buch.get(o.symbol);
    if (o.side === 'buy') {
      if (b) {
        b.avg = (b.avg * b.qty + o.kurs * o.qty) / (b.qty + o.qty);
        b.qty += o.qty;
      } else {
        buch.set(o.symbol, { qty: o.qty, avg: o.kurs });
      }
    } else if (b) {
      const menge = Math.min(o.qty, b.qty);
      pnls.set(o.id, Math.round((o.kurs - b.avg) * menge * 100) / 100);
      b.qty -= menge;
      if (b.qty <= 1e-9) buch.delete(o.symbol);
    }
  }
  return pnls;
}

export interface AdoptErgebnis {
  ok: true;
  /** Übernommene Broker-Positionen. */
  positionen: number;
  /** Gelöschte Buch-Positionen ohne Gegenstück beim Broker. */
  geloescht: number;
  /** Nachgebuchte Trades aus der Order-Historie. */
  trades: number;
  /** Neuer Barbestand (vom Broker). */
  cash: number;
  meldung: string;
}

export const adoptBroker = onCall(CALLABLE_OPTS, async (request): Promise<AdoptErgebnis> => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Anmeldung erforderlich');
  if (!(await consumeQuota(uid, 'adoptBroker', DAILY_ADOPT_LIMIT))) {
    throw new HttpsError('resource-exhausted', `Höchstens ${DAILY_ADOPT_LIMIT} Übernahmen am Tag`);
  }

  const verbindung = await brokerVerbindungLesend(uid);
  if (!verbindung) {
    throw new HttpsError(
      'failed-precondition',
      'Kein Broker verbunden — es gibt kein Depot, das sich übernehmen ließe.',
    );
  }

  const [konto, brokerPositionen] = await Promise.all([
    alpacaKonto(verbindung.mode, verbindung.schluessel),
    alpacaPositionen(verbindung.mode, verbindung.schluessel),
  ]);

  /* Historie ist WÜNSCHENSWERT, aber nicht Bedingung: Wenn der Order-Abruf
   * scheitert, sollen Bestand und Cash trotzdem stimmen. Ein Depot ohne
   * Historie ist unvollständig; ein Buch, das dem Depot widerspricht, ist
   * falsch. */
  const uidSauber = uid.replace(/[^A-Za-z0-9-]/g, '_');
  let eigeneOrders: AlpacaGeschlosseneOrder[] = [];
  try {
    const seit = new Date(Date.now() - HISTORIE_TAGE * 86_400_000).toISOString();
    const alle = await alpacaOrdersGeschlossen(verbindung.mode, verbindung.schluessel, seit);
    // Nur UNSERE Orders: Die Kennung beginnt mit der (bereinigten) uid —
    // exakt so baut `clientOrderId()` sie. Fremde Orders (Mensch in der
    // Alpaca-Oberfläche) gehören nicht in unser Handelsjournal.
    eigeneOrders = alle.filter((o) => o.clientOrderId.startsWith(`${uidSauber}-`));
  } catch (err) {
    logger.warn(`adoptBroker ${uid}: Order-Historie nicht abrufbar`, err);
  }

  /* Offene Schutz-Stops WIEDERERKENNEN (Audit 06.08.): Seit Bracket Stufe 1
   * liegen beim Broker GTC-Stop-Orders, deren Kennung das Buch in
   * `position.schutz` trägt. Eine Übernahme, die Positionen OHNE dieses Feld
   * schreibt, macht den Stop zur Waise: Er reserviert die Stücke weiter,
   * blockiert damit jeden Exit (Storno-vor-Exit storniert nur die Order, die
   * das Buch kennt), und der nächste Scan versucht obendrein einen ZWEITEN
   * Stop anzulegen. Deshalb werden unsere offenen Stops hier gelesen und der
   * Position wieder zugeordnet — die Übernahme bleibt dabei reine Leserei:
   * Sie storniert nichts, sie merkt sich nur, was schon da ist. */
  const schutzJeSymbol = new Map<string, { orderId: string; stopPreis: number; qty: number }>();
  try {
    const offene = await alpacaOrdersOffen(verbindung.mode, verbindung.schluessel);
    for (const o of offene) {
      if (o.typ !== 'stop' || !o.clientOrderId.startsWith(`${uidSauber}-`)) continue;
      if (schutzJeSymbol.has(o.symbol)) {
        logger.warn(`adoptBroker ${uid}: mehrere offene Stops für ${o.symbol} — nehme den ersten`);
        continue;
      }
      schutzJeSymbol.set(o.symbol, { orderId: o.id, stopPreis: o.stopPreis, qty: o.qty });
    }
  } catch (err) {
    logger.warn(`adoptBroker ${uid}: offene Orders nicht abrufbar — schutz-Felder bleiben leer`, err);
  }

  const db = getFirestore();
  const userRef = db.collection('users').doc(uid);
  const [userSnap, posSnap, tradesSnap] = await Promise.all([
    userRef.get(),
    userRef.collection('positions').get(),
    // Bereits gebuchte Broker-Orders erkennen — die Übernahme muss
    // IDEMPOTENT sein: zweimal gedrückt darf nichts doppelt buchen.
    userRef.collection('trades').select('brokerOrderId').get(),
  ]);
  if (!userSnap.exists) throw new HttpsError('failed-precondition', 'Profil fehlt');
  const strategy = (userSnap.get('settings.strategy') as Strategy | undefined) ?? DEFAULT_STRATEGY;

  const bekannt = new Set<string>();
  for (const d of tradesSnap.docs) {
    const b = d.get('brokerOrderId');
    if (typeof b === 'string' && b.length > 0) bekannt.add(b);
  }

  /** Frühester eigener EINSTIEG je Symbol und Seite — bestmögliches
   *  `openedAt`. Longs eröffnen mit einem Kauf, Shorts mit einem VERKAUF
   *  (Audit 06.08.: vorher zählten nur Käufe, Shorts bekamen `now`). */
  const fruehesterKauf = new Map<string, string>();
  const fruehesterVerkauf = new Map<string, string>();
  for (const o of eigeneOrders) {
    const ziel = o.side === 'buy' ? fruehesterKauf : fruehesterVerkauf;
    const bisher = ziel.get(o.symbol);
    if (!bisher || o.filledAt < bisher) ziel.set(o.symbol, o.filledAt);
  }

  const now = new Date().toISOString();
  /* Schreib-Operationen SAMMELN statt direkt in einen Batch (Audit 06.08.):
   * Ein WriteBatch trägt höchstens 500 Operationen — eine Übernahme nach
   * 14 Handelstagen kann mehr Trades mitbringen, und dann scheiterte die
   * GESAMTE Übernahme mit einem Wurf. Stattdessen in 400er-Stücken
   * committen; die Reihenfolge stellt sicher, dass Wallet-Messlatte,
   * Equity-Snapshot und Abgleich-Vermerk im LETZTEN Stück liegen — bricht
   * ein früherer Chunk ab, fehlt keine halbe Messlatte, und ein erneuter
   * Aufruf heilt den Rest (Positionen per set idempotent, Trades per
   * brokerOrderId dedupliziert). */
  const ops: Array<(b: WriteBatch) => void> = [];

  // 1) Buch-Positionen ohne Gegenstück beim Broker löschen (Bestand folgt
  //    dem Broker — siehe Modulkopf).
  const brokerSymbole = new Set(brokerPositionen.map((p) => p.symbol));
  let geloescht = 0;
  for (const d of posSnap.docs) {
    if (!brokerSymbole.has(d.id)) {
      const ref = d.ref;
      ops.push((b) => b.delete(ref));
      geloescht += 1;
    }
  }

  // 2) Broker-Positionen ins Buch — mit frischen Stops aus der aktuellen
  //    Strategie, damit riskPulse sie ab dem nächsten Lauf schützt.
  for (const p of brokerPositionen) {
    if (!(p.qty > 0) || !(p.einstand > 0)) continue; // kein Raten bei kaputten Daten
    const cls = classify(p.symbol);
    const risk = resolveRisk(strategy.engine, cls);
    const short = p.seite === 'short';
    const avg = p.einstand;
    const schutz = schutzJeSymbol.get(p.symbol);
    const position: Position = {
      symbol: p.symbol,
      qty: p.qty,
      avgEntry: avg,
      // Level gespiegelt beim Short — dieselbe Regel wie beim Öffnen.
      stopLoss: risk.stopLossPct > 0 ? avg * (1 + (short ? 1 : -1) * (risk.stopLossPct / 100)) : null,
      takeProfit:
        risk.takeProfitPct > 0 ? avg * (1 - (short ? 1 : -1) * (risk.takeProfitPct / 100)) : null,
      openedAt: (short ? fruehesterVerkauf : fruehesterKauf).get(p.symbol) ?? now,
      ...(short ? { side: 'short' as const, lowWater: avg } : { highWater: avg }),
      broker: true,
      // Bereits liegender Schutz-Stop bleibt verknüpft (s. o.) — sonst wird
      // er zur Waise, die Stücke reserviert und Exits blockiert.
      ...(schutz ? { schutz } : {}),
    };
    ops.push((b) => b.set(userRef.collection('positions').doc(p.symbol), position));
  }

  // 3) Historie nachbuchen — chronologisch, mit dem ECHTEN Fill-Kurs und
  //    der Kommission der Klasse (Slippage steckt im Kurs, siehe
  //    effectivePriceFromFill). `at` trägt den Fill-Zeitpunkt, nicht den
  //    Import-Zeitpunkt, damit die Trade-Liste und FIFO richtig sortieren.
  let importiert = 0;
  // PnL über die VOLLE Abfolge rechnen (auch bereits gebuchte Orders zählen
  // als Deckung) — geschrieben wird weiterhin nur, was noch fehlt.
  const pnls = importPnls(eigeneOrders);
  for (const o of eigeneOrders) {
    if (bekannt.has(o.id)) continue;
    const pnl = pnls.get(o.id);
    const cls = classify(o.symbol);
    const teile = feePartsForClass(cls);
    const waehrung = currencyForSymbol(o.symbol);
    // EZB-Kurs zum FILL-Tag — je Tag gecacht, der Import bleibt billig.
    const fx = await fxFelder(o.filledAt, waehrung);
    const tradeRef = userRef.collection('trades').doc();
    ops.push((b) => b.set(tradeRef, {
      symbol: o.symbol,
      side: o.side,
      qty: o.qty,
      price: o.kurs,
      rawPrice: o.kurs,
      executedAt: o.filledAt,
      at: Timestamp.fromDate(new Date(o.filledAt)),
      source: 'engine',
      paper: verbindung.mode !== 'live',
      /** Kennzeichen der Übernahme — nachgebucht, nicht live gebucht. */
      sync: true,
      assetClass: cls,
      currency: waehrung,
      commissionRate: teile.commission,
      slippageRate: 0,
      feeRate: teile.commission,
      preisQuelle: 'broker',
      brokerOrderId: o.id,
      clientOrderId: o.clientOrderId,
      fee: Math.round(o.qty * o.kurs * teile.commission * 100) / 100,
      // Handelsanalyse-Anschluss (07.08.): nur bei bekannter Deckung — kein Raten.
      ...(pnl !== undefined ? { pnl } : {}),
      ...fx,
    }));
    importiert += 1;
  }

  /* 4) Barbestand UND Kapitalbasis vom Broker (Owner-Fund 05.08., 17:19).
   *
   * Nach der ersten Übernahme zeigte die Performance-Karte −100.330,67 $
   * Gesamt-P&L — obwohl kein Cent verloren war. Die Rechnung
   * (Equity − baseCapital) war richtig, die BEZUGSGRÖSSE falsch: Das Buch
   * war auf 200.000 $ zurückgesetzt worden, das Konto beim Broker hat aber
   * nie mehr als 100.000 $ gesehen. Eine Übernahme, die Cash und Positionen
   * holt, aber die Messlatte stehen lässt, erzeugt Phantom-Verluste in
   * exakt der Höhe der Differenz.
   *
   * Die Basis wird REKONSTRUIERT statt geraten:
   *
   *   Startkapital = Cash + Σ(±Menge × Einstand)
   *
   * Denn jeder Kauf hat den Cash genau um Menge × Einstand gesenkt (Shorts
   * umgekehrt) — die Summe stellt den Kontostand VOR allen offenen
   * Positionen wieder her, ohne die Einzahlungshistorie zu kennen. Beim
   * Vorfall: −19.521,50 + 119.521,50 = 100.000,00 — exakt die Einzahlung.
   * Bereits realisierte Gewinne/Verluste bleiben dabei ehrlich in der
   * Basis enthalten: Sie SIND passiert, bevor unsere Messung begann. */
  const cashRund = Math.round(konto.cash * 100) / 100;
  const einstandssumme = brokerPositionen.reduce(
    (s, p) => s + (p.seite === 'short' ? -1 : 1) * p.qty * p.einstand,
    0,
  );
  const basisKapital = Math.round((konto.cash + einstandssumme) * 100) / 100;
  ops.push((b) => b.update(userRef, {
    'wallet.paperBalance': cashRund,
    'wallet.baseCapital': basisKapital,
    'wallet.updatedAt': now,
    // Bezugsgröße der Tages-Notbremse mitziehen: Verglichen mit einem
    // Phantom-Vortag von 200.000 $ sähe die echte Equity wie ein
    // 50-%-Tagesverlust aus — die Bremse würde feuern und alles sperren,
    // obwohl nichts verloren ist. Nach einer Übernahme beginnt der Tag neu.
    'risk.vortagEquity': Math.round(konto.equity * 100) / 100,
  }));

  /* 4b) Heutigen Equity-Snapshot mit der ECHTEN Equity überschreiben.
   *
   * Hochwasser und Max-Drawdown rechnen über die Snapshot-Serie. Nach dem
   * Reset steht dort ein einzelner Punkt mit dem Phantom-Kontostand — er
   * bliebe als „Hochwasser 200.000 $" stehen und jede künftige Kurve sähe
   * wie ein 50-%-Drawdown aus. Der Snapshot von heute wird deshalb auf die
   * Broker-Equity gesetzt (Doc-ID = Datum, überschreibt idempotent). Ältere
   * Tage bleiben unangetastet: Vergangene Messungen umzuschreiben ist nicht
   * Aufgabe einer Übernahme. */
  const heute = now.slice(0, 10);
  ops.push((b) => b.set(userRef.collection('equity').doc(heute), {
    walletId: 'main',
    date: heute,
    equity: Math.round(konto.equity * 100) / 100,
    balance: cashRund,
    positionsValue: Math.round((konto.equity - konto.cash) * 100) / 100,
    positionsCount: brokerPositionen.length,
    updatedAt: now,
    uebernommen: true,
  }));

  // 5) Abgleich-Vermerk direkt mitschreiben: Nach der Übernahme IST der
  //    Stand sauber; die Karte soll das sofort sagen und nicht erst beim
  //    nächsten Scan.
  ops.push((b) =>
    b.set(
      userRef,
      {
        risk: {
          abgleich: {
            at: now,
            status: 'sauber',
            anzahl: 0,
            fehlbestand: 0,
            fremdbestand: 0,
            verglichen: brokerPositionen.length,
            brokerPositionen: brokerPositionen.length,
          },
        },
      },
      { merge: true },
    ),
  );

  // In 400er-Stücken committen (WriteBatch-Deckel 500) — Reihenfolge s. o.
  for (let i = 0; i < ops.length; i += 400) {
    const b = db.batch();
    for (const op of ops.slice(i, i + 400)) op(b);
    await b.commit();
  }
  logger.info(
    `adoptBroker ${uid}: ${brokerPositionen.length} Position(en) übernommen, ` +
      `${importiert} Trade(s) nachgebucht, ${geloescht} Buch-Position(en) entfernt`,
  );
  return {
    ok: true,
    positionen: brokerPositionen.length,
    geloescht,
    trades: importiert,
    cash: Math.round(konto.cash * 100) / 100,
    meldung:
      `${brokerPositionen.length} Position(en) und ${importiert} Trade(s) vom Broker übernommen; ` +
      `Barbestand jetzt ${konto.cash.toFixed(2)} $. Es wurde nichts gekauft oder verkauft. ` +
      'Stops und Ziele wurden aus deiner aktuellen Strategie neu gesetzt.',
  };
});
