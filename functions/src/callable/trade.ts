/**
 * trade — manueller Paper-Trade (auth-geprüft, validiert, rate-limitiert).
 * Der Preis kommt IMMER aus den zentralen Scan-Daten (market/{sym}.quote),
 * nie vom Client — Clients können Ausführungspreise nicht wählen.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  bucketKey,
  classify,
  kursZuAlt,
  tradableSymbols,
  type Quote,
  type Strategy,
} from '../../../shared/src/index.js';
import { consumeQuota, executeTrade, resolveBrokerMode } from '../core/broker.js';
import { ladeUniversumSymbole } from '../core/universumLeser.js';
import { kontoTore } from '../core/kontoTore.js';
import { clampStrategyRisk, maxOpenPositions } from '../core/rulesTrading.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';
import { accessDeniedReason, accessLevelOfSnap, mayTradeSnap } from '../core/access.js';

const DAILY_TRADE_LIMIT = 50;
const MAX_QTY = 10_000;

export const trade = onCall(CALLABLE_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'srv.anmeldungErforderlich');

  const { symbol, side, qty } = (request.data ?? {}) as {
    symbol?: unknown;
    side?: unknown;
    qty?: unknown;
  };
  /* HANDELBARE Symbole, nicht bloß bekannte (04.08.).
   *
   * Vorher prüfte die Handeingabe gegen `allSymbols()` — den ganzen Katalog
   * inklusive der Dinge, die `isTradable` längst ausschließt: Indizes (`^GSPC`
   * ist eine Zahl, kein Instrument) und Auslandsbörsen. Letztere sind der
   * ernstere Fall, denn sie notieren gar nicht in Dollar: `BMW.DE` in Euro,
   * `7203.T` in Yen, `AZN.L` sogar in Pence. Der Kontostand ist hart in USD
   * geführt — ein solcher Kauf hätte den Saldo lautlos verfälscht.
   *
   * Seit Stufe 3 (Task 121) gilt zusätzlich das ALPACA-UNIVERSUM: jedes
   * Papier, das der Broker laut täglichem Sync wirklich handelt (nur
   * US-Börsen + Krypto, OTC ausgefiltert, USD-notiert — dieselben Sorgen wie
   * oben, nur broker-verifiziert statt handverlesen). Der Katalog bleibt der
   * schnelle Normalfall; das Universum ist der Fallback für freie Eingaben.
   * Kein Guard wird dadurch weicher: Kurs-Pflicht, Kurs-Zeitdeckel,
   * Konto-Tore und Quota laufen für beide Wege identisch weiter. */
  if (typeof symbol !== 'string') {
    throw new HttpsError('invalid-argument', 'srv.symbolNichtHandelbar');
  }
  if (
    !new Set(tradableSymbols()).has(symbol)
    && !(await ladeUniversumSymbole()).has(symbol)
  ) {
    throw new HttpsError(
      'invalid-argument',
      'srv.symbolNichtHandelbarKatalog',
    );
  }
  if (side !== 'buy' && side !== 'sell') {
    throw new HttpsError('invalid-argument', 'srv.sideUngueltig');
  }
  let qtyNum: number | undefined;
  if (qty !== undefined && qty !== null) {
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      throw new HttpsError('invalid-argument', `srv.qtyGanzeZahl|${MAX_QTY}`);
    }
    qtyNum = qty;
  }

  if (!(await consumeQuota(uid, 'trades', DAILY_TRADE_LIMIT))) {
    throw new HttpsError('resource-exhausted', `srv.tageslimitTrades|${DAILY_TRADE_LIMIT}`);
  }

  const db = getFirestore();
  const userSnap = await db.doc(`users/${uid}`).get();
  // Zugangsstufe (Owner 26.07.): Ohne Freischaltung keine Order — auch nicht
  // manuell. Die Prüfung steht VOR jeder Preisermittlung, damit ein gesperrtes
  // Konto nicht einmal Marktdaten-Aufrufe auslöst.
  //
  // *Snap statt .data() (Naht-Befund 24.08., vierte Fundstelle desselben
  // Musters): `.data()` liefert `undefined` auch für ein NICHT MEHR
  // EXISTIERENDES Dokument, und `mayTrade(undefined)` gilt als
  // Bestandskonto-Regel `true` — ein bereits endgültig gelöschtes Konto
  // wäre mit einem noch gültigen Token sonst wieder handelsfähig gewesen.
  if (!mayTradeSnap(userSnap)) {
    throw new HttpsError('permission-denied', accessDeniedReason(accessLevelOfSnap(userSnap)));
  }
  const strategy = userSnap.get('settings.strategy') as Strategy | undefined;
  if (!strategy) throw new HttpsError('failed-precondition', 'srv.profilFehltEnsure');

  // M4: Paper only — der Doppel-Guard entscheidet zentral (M13/M14 erweitern das).
  if (resolveBrokerMode(strategy) !== 'paper') {
    throw new HttpsError('failed-precondition', 'srv.liveNichtFreigeschaltet');
  }

  /* Risiko-Hülle auch für die Handeingabe (Audit 13.08., H3).
   *
   * Bis dahin ging die UNGEKLAMMERTE Strategie an den Broker: Wer sich
   * maxPositionPct 100 ins Profil schrieb, kaufte von Hand mit vollem
   * Einsatz, während der Scan längst auf 25 % geklemmt hätte. Die Hülle gilt
   * für jeden Trade dieses Users — egal, welcher Pfad ihn auslöst.
   */
  const clamped = clampStrategyRisk(strategy);

  /* Konto-Tore (M12, zentralisiert 13.08.): Reset sperrt JEDEN Handel
   * (Buchführung), Notbremse und Abgleich-Drift sperren EINSTIEGE — eine
   * Bremse, die man mit einem Klick umgehen kann, ist keine. Ein Verkauf
   * einer bestehenden Position bleibt immer möglich; ein Leerverkauf ist
   * ein Einstieg und fällt unter die Tore. */
  const tore = kontoTore(userSnap, clamped, new Date());
  if (tore.handel) {
    /* CODE statt tore.grund (#145-Grenzfall, 20.08.): `grund` ist deutsche
     * Prosa für Server-Logs — im Fehler wäre sie für EN-Nutzer unlesbar.
     * Die Tore tragen längst Maschinen-Codes; die Grenze übersetzt sie in
     * srv.*-Schlüssel, und das Wörterbuch spricht die Sprache des Nutzers. */
    throw new HttpsError(
      'failed-precondition',
      tore.handel === 'reset_laeuft' ? 'srv.resetLaeuft' : 'srv.kontoVoruebergehendGesperrt',
    );
  }

  /* Positionsbestand EINMAL lesen: Er entscheidet, ob dieser Trade ein
   * Einstieg ist (neue Position) — und ob das Positionslimit greift. */
  const posSnap = await db.collection(`users/${uid}/positions`).get();
  const hatPosition = posSnap.docs.some((d) => d.id === symbol);
  // Sockel-Positionen (core) zählen nicht — dieselbe Besitzgrenze wie im
  // Scan: Sie gehören dem Momentum-Lauf und blockieren nicht das Limit
  // der aktiv geführten Trades.
  const offenAktiv = posSnap.docs.filter((d) => (d.data() as { core?: boolean }).core !== true).length;

  const istEinstieg =
    (side === 'buy' && !hatPosition)
    || (side === 'sell' && strategy.signals.allowShort === true && !hatPosition);
  if (istEinstieg) {
    if (tore.einstieg) {
      // Wie oben: Code statt Prosa — Breaker und Abgleich-Drift haben
      // eigene, im Wörterbuch übersetzte Erklärungen.
      throw new HttpsError(
        'failed-precondition',
        tore.einstieg === 'breaker_aktiv'
          ? 'srv.breakerAktiv'
          : tore.einstieg === 'abgleich_drift'
            ? 'srv.abgleichDrift'
            : 'srv.einstiegeGesperrt',
      );
    }
    /* Positionslimit auch von Hand (Audit 13.08., H3): 50 Käufe am Tag mit
     * je 25 % wären sonst regelkonform gewesen, während der Scan beim
     * Limit längst aufhört. Nur NEUE Positionen — ein Verkauf und die
     * Bedienung bestehender Positionen bleiben frei. */
    const limit = maxOpenPositions(clamped);
    if (offenAktiv >= limit) {
      throw new HttpsError(
        'failed-precondition',
        `srv.positionslimitErreicht|${offenAktiv}/${limit}`,
      );
    }
  }

  const quote = (await db.doc(`market/${symbol}`).get()).get('quote') as Quote | undefined;
  if (!quote || !(quote.price > 0)) {
    throw new HttpsError(
      'failed-precondition',
      'srv.keinZentralerKurs',
    );
  }
  /* Kurs-Zeitdeckel (Audit 13.08., B-2): `updatedAt` wurde geschrieben und
   * von keinem Leser geprüft — ein Symbol, das aus der Beobachtung fällt,
   * behielt seine eingefrorene Quote, und die Handeingabe führte zum
   * Wochen-alten Kurs aus. Gilt für BEIDE Seiten wie die Prüfung darüber:
   * Ein Verkauf zu einem erfundenen Kurs ist keine Hilfe, sondern eine
   * falsche P&L-Buchung. Das ist keine Risiko-Sperre (die lassen Exits
   * durch), sondern dieselbe Frage wie „kein zentraler Kurs" — nur in der
   * Zeit statt im Raum. */
  const kursAlter = kursZuAlt(quote.updatedAt, classify(symbol), new Date());
  if (kursAlter.zuAlt) {
    /* Code + Zahl statt kursAlter.grund (#145-Grenzfall, 20.08.): Der
     * Befund liefert jetzt einen Maschinen-Code und das Alter — die
     * Prosa in `grund` bleibt den Logs vorbehalten. Der Parameter ist eine
     * ZAHL, kein Text: serverText setzt sie sprachneutral in {0} ein. */
    throw new HttpsError(
      'failed-precondition',
      kursAlter.code === 'tage_alt'
        ? `srv.kursTageAlt|${Math.round((kursAlter.alterMin ?? 0) / 1440)}`
        : kursAlter.code === 'min_alt'
          ? `srv.kursMinAlt|${kursAlter.alterMin ?? 0}`
          : 'srv.kursOhneZeitstempel',
    );
  }

  const result = await executeTrade(
    {
      uid,
      symbol,
      side,
      price: quote.price,
      // Kauf ohne qty: Positionsgröße aus maxPositionPct (wie die Engine);
      // Verkauf schließt immer die ganze Position.
      ...(side === 'buy' && qtyNum !== undefined ? { qty: qtyNum } : {}),
      source: 'manual',
      // Klassen-aufgelöste Stop/Take-Level (MA3-Fund 26.07.): Ohne die
      // Klasse schrieb der Broker jedem Kauf die GLOBALEN Prozente als
      // Level fest — Krypto-Profile griffen nie (Level haben Vorrang).
      assetClass: classify(symbol),
      // Manueller Verkauf ohne Position wird zum SHORT, wenn der User
      // Leerverkäufe erlaubt hat (Opt-in) — sonst wie bisher 'keine_position'.
      ...(side === 'sell' && strategy.signals.allowShort === true ? { openShort: true } : {}),
      // Steckbrief fürs Meta-Labeling: Hand-Trades lernen als eigene Sorte.
      // Bei Öffnungen relevant; bei Schließungen ignoriert ihn der Broker.
      bucket: bucketKey({
        assetClass: classify(symbol),
        timeframe: 'daily',
        signature: 'manuell',
        side: side === 'sell' ? 'short' : 'long',
      }),
    },
    clamped,
    /* Lauf-Kennung des Handeingabe-Trades (M13).
     *
     * Minutengenau — und das ist hier die GEWOLLTE Semantik, nicht ein
     * Kompromiss: Ein Doppelklick auf „Kaufen" soll nicht zwei Positionen
     * eröffnen. Alpaca weist die zweite Order mit derselben Kennung ab.
     * Die Kehrseite ist bekannt: Wer denselben Trade absichtlich zweimal
     * will, muss die Minutengrenze abwarten. Für eine Handeingabe ist das
     * die sichere Richtung. */
    `man-${new Date().toISOString().slice(0, 16)}Z`,
  );
  if (!result.executed) {
    throw new HttpsError('failed-precondition', `srv.nichtAusgefuehrt|${result.reason}`);
  }
  return { ok: true, trade: result.trade };
});
