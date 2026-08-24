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
  istNoOpUebernahme,
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
import { accessDeniedReason, accessLevelOf, mayTrade } from '../core/access.js';
import { consumeQuota } from '../core/broker.js';
import { fxFelder } from '../core/fx.js';
import { brokerVerbindungLesend } from '../core/orderRouting.js';

/** Übernahmen je Tag — großzügig, aber kein Dauerlauf. */
const DAILY_ADOPT_LIMIT = 10;

/** RÜCKFALL-Fenster der Order-Historie, wenn Alpaca kein `created_at`
 *  liefert. Der Normalfall ist seit dem 13.08. die KONTO-ERÖFFNUNG als
 *  Anker (`historieAnker`, Owner-Wunsch: Historie ohne 30-Tage-Deckel) —
 *  ein Zuviel ist harmlos, weil bereits gebuchte brokerOrderIds
 *  übersprungen werden. 14 → 30 Tage (07.08.) → Konto-Eröffnung (13.08.). */
const HISTORIE_TAGE = 30;

/**
 * Ab wann die Order-Historie geholt wird: die Konto-Eröffnung — vor ihr kann
 * es keine Orders geben, und jeder spätere Anker verliert Historie (der
 * 30-Tage-Deckel war genau die Lücke, die der Owner am 13.08. gemeldet hat:
 * Steuer-FIFO und Handelsanalyse sahen nur den letzten Monat).
 *
 * Pur und defensiv: Ein fehlender, unlesbarer oder in der Zukunft liegender
 * Stempel fällt auf das bisherige 30-Tage-Fenster zurück — ein kaputtes
 * `created_at` darf die Übernahme nicht auf die Ur-Zeit aufblasen und nicht
 * in die Zukunft ankern (dann käme gar nichts zurück).
 */
export function historieAnker(createdAt: string, jetztMs: number): string {
  const t = Date.parse(createdAt);
  if (Number.isFinite(t) && t > 0 && t < jetztMs) return new Date(t).toISOString();
  return new Date(jetztMs - HISTORIE_TAGE * 86_400_000).toISOString();
}

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
 * nicht als Short-Eröffnung unterstellt. PnL rechnet auf den echten
 * Fill-Kursen; die Gebühren stehen separat am Trade (Kosten-Analyse).
 *
 * `shortsMoeglich` (Short-Audit 07.08.): Auf einem Konto, das leerverkaufen
 * DARF, kann ein ungedeckter Verkauf zwei Dinge sein — Alt-Long-Exit oder
 * Short-Eröffnung. Ein nachfolgender Kauf ist dann entweder frischer Long
 * oder das Eindecken; beides ist aus der Order-Historie allein nicht
 * unterscheidbar. Vorher eröffnete der Kauf IMMER ein Buch-Long — für einen
 * echten Short-Roundtrip ein Phantom, gegen das der NÄCHSTE Verkauf ein
 * erfundenes PnL gebucht hätte. Jetzt neutralisieren Käufe zuerst die
 * ungedeckte Menge (ohne PnL — die Basis ist strittig), nur der Überschuss
 * eröffnet frisch. Long-only-Konten behalten das alte, für sie korrekte
 * Verhalten.
 */
export function importPnls(
  orders: AlpacaGeschlosseneOrder[],
  opts: { shortsMoeglich?: boolean } = {},
): Map<string, number> {
  const buch = new Map<string, { qty: number; avg: number }>();
  /** Ungedeckte Verkaufsmengen je Symbol — nur relevant mit shortsMoeglich. */
  const ungedeckt = new Map<string, number>();
  const pnls = new Map<string, number>();
  for (const o of orders) {
    const b = buch.get(o.symbol);
    if (o.side === 'buy') {
      let rest = o.qty;
      if (opts.shortsMoeglich === true) {
        const u = ungedeckt.get(o.symbol) ?? 0;
        const gegen = Math.min(u, rest);
        if (gegen > 0) {
          ungedeckt.set(o.symbol, u - gegen);
          rest -= gegen;
        }
      }
      if (rest > 0) {
        if (b) {
          b.avg = (b.avg * b.qty + o.kurs * rest) / (b.qty + rest);
          b.qty += rest;
        } else {
          buch.set(o.symbol, { qty: rest, avg: o.kurs });
        }
      }
    } else {
      const menge = b ? Math.min(o.qty, b.qty) : 0;
      if (b && menge > 0) {
        pnls.set(o.id, Math.round((o.kurs - b.avg) * menge * 100) / 100);
        b.qty -= menge;
        if (b.qty <= 1e-9) buch.delete(o.symbol);
      }
      const rest = o.qty - menge;
      if (rest > 0) ungedeckt.set(o.symbol, (ungedeckt.get(o.symbol) ?? 0) + rest);
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
  /**
   * Hat diese Übernahme eine MESSZÄSUR gesetzt? (Owner-Befund 16.08.)
   *
   * `false` heißt: Sie hat nichts bewegt, `resetAt` blieb ungestempelt und
   * die Equity-Serie — die Messstrecke der Live-Reife — steht unverändert.
   * Die Oberfläche sagt das dem Nutzer, statt ihn raten zu lassen.
   */
  schnitt: boolean;
  meldung: string;
}

export const adoptBroker = onCall(CALLABLE_OPTS, async (request): Promise<AdoptErgebnis> => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'srv.anmeldungErforderlich');
  /* Freischaltung VOR allem anderen (Audit 13.08., Härtung): Die Übernahme
   * ruft Konto, Positionen und Order-Historie beim Broker ab und
   * ÜBERSCHREIBT das eigene Buch — beides hat ein nie freigeschaltetes
   * Konto nicht zu tun. */
  const zugang = (await getFirestore().collection('users').doc(uid).get()).data();
  if (!mayTrade(zugang)) {
    throw new HttpsError('permission-denied', accessDeniedReason(accessLevelOf(zugang)));
  }
  if (!(await consumeQuota(uid, 'adoptBroker', DAILY_ADOPT_LIMIT))) {
    throw new HttpsError('resource-exhausted', `srv.hoechstensUebernahmen|${DAILY_ADOPT_LIMIT}`);
  }

  /* Lauf-Marker gegen den parallelen Scan (Audit 13.08., K-5c) — dieselbe
   * Mechanik wie beim Reset (`resetLaeuft`, verfällt nach 10 min): Ein
   * 5-Minuten-Scan, der MITTEN in die Übernahme handelt, wird von deren
   * abschließendem Cash-/Positions-Überschreiben ausgelöscht — Geld
   * erschaffen oder vernichtet, beim Broker aber real gehandelt. Der Reset
   * hatte diesen Schutz seit dem 11.08.; die Übernahme, die dieselben
   * Felder überschreibt, hatte ihn nicht. Aufgeräumt wird der Marker im
   * letzten Batch; stirbt die Function vorher, verfällt er von selbst. */
  await getFirestore()
    .collection('users')
    .doc(uid)
    .set({ risk: { resetLaeuftSeit: new Date().toISOString() } }, { merge: true })
    .catch(() => undefined);

  const verbindung = await brokerVerbindungLesend(uid);
  if (!verbindung) {
    throw new HttpsError(
      'failed-precondition',
      'srv.keinBrokerFuerDepot',
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
    const seit = historieAnker(konto.createdAt, Date.now());
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
  const schutzJeSymbol = new Map<
    string,
    { orderId: string; stopPreis: number; qty: number; limitPreis?: number }
  >();
  try {
    const offene = await alpacaOrdersOffen(verbindung.mode, verbindung.schluessel);
    for (const o of offene) {
      // `stop` UND `stop_limit`: Krypto-Schutz-Stops gehen als `stop_limit`
      // raus (`alpacaStopOrder`) — der frühere Filter auf nur `stop` machte
      // genau sie bei jedem Adopt zu Waisen (Befund 24.08.). Das Limit wird
      // fürs Buch mitgenommen (vollständiger Steckbrief der Order); das
      // Nachziehen selbst rechnet Stop UND Limit ohnehin frisch über
      // `planeSchutzStop` und liest das gespeicherte Feld nicht.
      if ((o.typ !== 'stop' && o.typ !== 'stop_limit') || !o.clientOrderId.startsWith(`${uidSauber}-`)) continue;
      if (schutzJeSymbol.has(o.symbol)) {
        logger.warn(`adoptBroker ${uid}: mehrere offene Stops für ${o.symbol} — nehme den ersten`);
        continue;
      }
      schutzJeSymbol.set(o.symbol, {
        orderId: o.id,
        stopPreis: o.stopPreis,
        qty: o.qty,
        ...(o.limitPreis > 0 ? { limitPreis: o.limitPreis } : {}),
      });
    }
  } catch (err) {
    logger.warn(`adoptBroker ${uid}: offene Orders nicht abrufbar — schutz-Felder bleiben leer`, err);
  }

  const db = getFirestore();
  const userRef = db.collection('users').doc(uid);
  const [userSnap, posSnap, tradesSnap, archivSnap] = await Promise.all([
    userRef.get(),
    userRef.collection('positions').get(),
    // Bereits gebuchte Broker-Orders erkennen — die Übernahme muss
    // IDEMPOTENT sein: zweimal gedrückt darf nichts doppelt buchen.
    userRef.collection('trades').select('brokerOrderId').get(),
    /* AUCH das Archiv (Audit 13.08., K-5a): `resetWallet` verschiebt die
     * Historie nach `tradesArchive` — die Dedupe-Lesung kannte nur die
     * Live-Sammlung. Der von reset.ts selbst empfohlene Ablauf „Reset →
     * Depot übernehmen" importierte dieselben Orders deshalb ERNEUT, und
     * der Steuerbericht (liest beide Sammlungen) wies jede Veräußerung
     * doppelt aus. */
    userRef.collection('tradesArchive').select('brokerOrderId').get(),
  ]);
  if (!userSnap.exists) throw new HttpsError('failed-precondition', 'srv.profilFehlt');
  const strategy = (userSnap.get('settings.strategy') as Strategy | undefined) ?? DEFAULT_STRATEGY;

  const bekannt = new Set<string>();
  for (const d of [...tradesSnap.docs, ...archivSnap.docs]) {
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
  // Positionen, die das Buch noch nicht kennt — Teil der Wirkungs-Messung
  // (s. istNoOpUebernahme): Eine neue Position ist immer eine Zäsur.
  const buchSymbole = new Set(posSnap.docs.map((d) => d.id));
  /* Die LERN-Identität der Position überlebt die Übernahme (23.08.).
   *
   * Der Bestand folgt dem Broker — Menge, Einstand und Stops kommen von
   * dort. Der Steckbrief und der aufgelaufene Teil-P&L sind aber keine
   * Bestandsdaten, sondern die Zugehörigkeit zu einer Messreihe. Sie hier
   * fallen zu lassen hieße: Eine Position, die bereits teilweise geschlossen
   * wurde, meldet ihr Ergebnis NIE an die Steckbrief-Statistik.
   *
   * Das wiegt einseitig: Ein Teilfill entsteht per Konstruktion an einem
   * SCHUTZ-STOP, also auf der Verlustseite. Verlorene Verluste lassen den
   * Eimer besser aussehen, als er ist — und derselbe Eimer öffnet über
   * `leverageGate` das Hebel-Tor. */
  const bisherige = new Map(posSnap.docs.map((d) => [d.id, d.data() as Position]));
  let neuePositionen = 0;
  for (const p of brokerPositionen) {
    if (!(p.qty > 0) || !(p.einstand > 0)) continue; // kein Raten bei kaputten Daten
    if (!buchSymbole.has(p.symbol)) neuePositionen += 1;
    const cls = classify(p.symbol);
    const risk = resolveRisk(strategy.engine, cls);
    const short = p.seite === 'short';
    const avg = p.einstand;
    const schutz = schutzJeSymbol.get(p.symbol);
    const alt = bisherige.get(p.symbol);
    const position: Position = {
      symbol: p.symbol,
      qty: p.qty,
      avgEntry: avg,
      // Lern-Identität, nicht Bestand — s. Kommentar oben.
      ...(alt?.bucket ? { bucket: alt.bucket } : {}),
      ...(typeof alt?.teilPnl === 'number' && Number.isFinite(alt.teilPnl)
        ? { teilPnl: alt.teilPnl }
        : {}),
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
  const pnls = importPnls(eigeneOrders, {
    shortsMoeglich: strategy.signals.allowShort === true,
  });
  for (const o of eigeneOrders) {
    if (bekannt.has(o.id)) continue;
    const pnl = pnls.get(o.id);
    const cls = classify(o.symbol);
    const teile = feePartsForClass(cls);
    const waehrung = currencyForSymbol(o.symbol);
    // EZB-Kurs zum FILL-Tag — je Tag gecacht, der Import bleibt billig.
    const fx = await fxFelder(o.filledAt, waehrung);
    /* Deterministische Doc-ID (Audit 13.08., K-5a): `alpaca_<orderId>`
     * statt Zufalls-ID. Zwei PARALLELE Übernahmen (Doppelklick — die
     * Dedupe-Lesung oben liegt vor den Batch-Commits) schreiben damit
     * dieselben Dokumente statt Duplikate; `set` ist idempotent. */
    const tradeRef = userRef.collection('trades').doc(`alpaca_${o.id}`);
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
  /* Buch-Konvention für Shorts (Short-Audit 07.08.): Alpaca schreibt den
   * Leerverkaufs-Erlös dem Cash GUT, unser Buch führt Shorts als
   * 100-%-Margin (Cash sinkt um Menge × Einstand — broker.ts). Wer den
   * Alpaca-Cash unverändert übernimmt, hat je Short 2 × Margin zu viel im
   * Buch: Die Equity springt am nächsten Snapshot nach oben, und das
   * spätere Eindecken schreibt Margin + P&L auf einen Cash, der den Erlös
   * schon enthält. Deshalb hier die Umrechnung; Equity und Kapitalbasis
   * rechnen weiter auf den ECHTEN Broker-Zahlen. */
  const shortMargin = brokerPositionen.reduce(
    (s, p) => s + (p.seite === 'short' ? p.qty * p.einstand : 0),
    0,
  );
  const cashRund = Math.round((konto.cash - 2 * shortMargin) * 100) / 100;
  const einstandssumme = brokerPositionen.reduce(
    (s, p) => s + (p.seite === 'short' ? -1 : 1) * p.qty * p.einstand,
    0,
  );
  const basisKapital = Math.round((konto.cash + einstandssumme) * 100) / 100;

  /* Bewegt diese Übernahme überhaupt etwas? (Owner-Befund 16.08.)
   *
   * Der Schnitt unten kostet die Live-Reife ihre 14-Tage-Messstrecke — zu
   * Recht, wenn sich die Kapitalbasis verschiebt. Ein Klick OHNE Wirkung
   * kostete sie bisher genauso, und weil der Scan bei Drift die Einstiege
   * sperrt, standen sich zwei Sicherungen gegenseitig im Weg (Begründung
   * ausführlich in shared/src/uebernahmeSchnitt.ts). Die Anti-Wasch-Garantie
   * bleibt: Sobald etwas bewegt wird, stempelt es wie bisher. */
  const alteBasis = userSnap.get('wallet.baseCapital') as number | undefined;
  const wirkung = {
    geloescht,
    importiert,
    neuePositionen,
    basisVorher: typeof alteBasis === 'number' ? alteBasis : null,
    basisNachher: basisKapital,
  };
  const ohneWirkung = istNoOpUebernahme(wirkung);

  ops.push((b) => b.update(userRef, {
    'wallet.paperBalance': cashRund,
    'wallet.baseCapital': basisKapital,
    'wallet.updatedAt': now,
    /* Übernahme = MARKIERTER Schnitt (Audit 13.08., K-5c/B-3). Sie stempelt
     * die Kapitalbasis neu — das ist dieselbe Messzäsur wie ein Reset, nur
     * hieß sie bisher nirgends so: kein resetAt, keine Spur, und ein Minus
     * ließ sich per Knopfdruck aus der Anzeige waschen, ohne dass später
     * jemand sagen konnte, wann die Messlatte verschoben wurde. Jetzt
     * tragen beide Marken das Datum; `uebernahmeAt` unterscheidet die
     * Übernahme vom echten Reset, `resetAt` schneidet die „seit
     * hier"-Kennzahlen wie überall sonst.
     *
     * NUR wenn die Übernahme etwas bewegt (s. `ohneWirkung`): Ein Abruf, der
     * dasselbe Depot bestätigt, ist keine Zäsur — er ist ein Abgleich. */
    ...(ohneWirkung ? {} : { 'wallet.resetAt': now, 'wallet.uebernahmeAt': now }),
    // Bezugsgröße der Tages-Notbremse mitziehen: Verglichen mit einem
    // Phantom-Vortag von 200.000 $ sähe die echte Equity wie ein
    // 50-%-Tagesverlust aus — die Bremse würde feuern und alles sperren,
    // obwohl nichts verloren ist. Nach einer Übernahme beginnt der Tag neu.
    // Ohne Wirkung bleibt der Vortagswert stehen: Die Notbremse soll den
    // laufenden Tag messen, nicht bei jedem Abgleich neu anfangen.
    ...(ohneWirkung ? {} : { 'risk.vortagEquity': Math.round(konto.equity * 100) / 100 }),
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
    // Gegenstück zum Buch-Cash: balance + positionsValue = equity muss auch
    // mit der Margin-Konvention aufgehen (positionValue rechnet Shorts als
    // Margin + unrealisierter P&L — shared/src/portfolio.ts).
    positionsValue: Math.round((konto.equity - cashRund) * 100) / 100,
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

  /* 6) Equity-Serie VOR heute schneiden (Audit 13.08., B-3): Die Übernahme
   * setzt die Kapitalbasis neu — eine Serie, die über diesen Schnitt
   * hinweg läuft, misst zwei verschiedene Konten in einer Kurve. Ein Konto,
   * das mit Buch-Basis 200.000 lief und mit Broker-Equity 100.000
   * übernommen wird, trüge sonst bis zu 120 Tage ein Phantom-Hochwasser
   * und einen Phantom-Max-Drawdown von ~50 % in stats/main. Der Reset
   * löscht die Serie aus demselben Grund komplett.
   *
   * NUR wenn die Übernahme etwas bewegt (Owner-Befund 16.08.): Diese Serie
   * IST die Messstrecke der Live-Reife. Ein Abruf, der dasselbe Depot
   * bestätigt, verschiebt keine Kapitalbasis — und darf deshalb auch keine
   * 14 Tage kosten. */
  let geschnitteneTage = 0;
  if (!ohneWirkung) {
    const alteSerie = await userRef
      .collection('equity')
      .where('date', '<', heute)
      .select()
      .get()
      .catch(() => null);
    if (alteSerie) {
      for (const d of alteSerie.docs) ops.push((b) => b.delete(d.ref));
      geschnitteneTage = alteSerie.size;
    }
  }

  /* 7) Diagnose-Protokoll je Übernahme (Audit 13.08., K-5c): Der Owner
   * stand am 12.08. vor einem Buch-Cash von −167.720 $ und niemand konnte
   * sagen, wie die Zahl entstand. Jede Übernahme schreibt jetzt ihre
   * komplette Rechnung mit — die Frage „wie kam dieser Kontostand
   * zustande?" hat damit dauerhaft eine nachlesbare Antwort. */
  ops.push((b) => b.set(userRef.collection('adoptLog').doc(now.replace(/[:.]/g, '-')), {
    at: now,
    brokerCash: Math.round(konto.cash * 100) / 100,
    brokerEquity: Math.round(konto.equity * 100) / 100,
    shortMargin: Math.round(shortMargin * 100) / 100,
    buchCash: cashRund,
    baseCapital: basisKapital,
    positionen: brokerPositionen.length,
    tradesImportiert: importiert,
    equityTageGeschnitten: geschnitteneTage,
    /* Ob gestempelt wurde und warum nicht — die Diagnose muss auch den
     * NICHT-Schnitt erklären können (Owner-Befund 16.08.). */
    schnitt: !ohneWirkung,
    wirkung,
    rechnung:
      'buchCash = brokerCash − 2×Σ(Short-Menge×Einstand) [Buch führt Shorts als '
      + '100-%-Margin, Alpaca schreibt den Erlös gut]; '
      + 'baseCapital = brokerCash + Σ(±Menge×Einstand) [rekonstruierte Einzahlung '
      + 'inkl. bereits realisierter Ergebnisse]',
  }));

  /* 8) Lauf-Marker aufräumen — die Übernahme ist fertig, der Scan darf
   * wieder. Zusammen damit fällt die Übernahme-Vormerkung eines Admins
   * (22.08.): Sie war die Bitte, genau das hier zu tun, und eine Bitte,
   * die nach Erfüllung stehen bleibt, ist eine Mahnung ohne Anlass. */
  ops.push((b) => b.set(
    userRef,
    { risk: { resetLaeuftSeit: null, uebernahmeVorgemerkt: null } },
    { merge: true },
  ));

  // In 400er-Stücken committen (WriteBatch-Deckel 500) — Reihenfolge s. o.
  for (let i = 0; i < ops.length; i += 400) {
    const b = db.batch();
    for (const op of ops.slice(i, i + 400)) op(b);
    await b.commit();
  }
  logger.info(
    `adoptBroker ${uid}: ${brokerPositionen.length} Position(en) übernommen, ` +
      `${importiert} Trade(s) nachgebucht, ${geloescht} Buch-Position(en) entfernt` +
      (ohneWirkung ? ' — ohne Wirkung, Messstrecke bleibt' : ''),
  );
  return {
    ok: true,
    positionen: brokerPositionen.length,
    geloescht,
    trades: importiert,
    cash: Math.round(konto.cash * 100) / 100,
    /* Der Nutzer muss WISSEN, ob dieser Klick seine Messstrecke gekostet
     * hat — die Zahl steht sonst nirgends, bis er die Live-Reife öffnet. */
    schnitt: !ohneWirkung,
    meldung:
      `${brokerPositionen.length} Position(en) und ${importiert} Trade(s) vom Broker übernommen; ` +
      `Barbestand jetzt ${konto.cash.toFixed(2)} $. Es wurde nichts gekauft oder verkauft. ` +
      'Stops und Ziele wurden aus deiner aktuellen Strategie neu gesetzt.' +
      (ohneWirkung
        ? ' Es hat sich nichts geändert — die Messstrecke der Live-Reife läuft weiter.'
        : ' Buch und Depot sind wieder gleich; die Messstrecke der Live-Reife beginnt neu.'),
  };
});
