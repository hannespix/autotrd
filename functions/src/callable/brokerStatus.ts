/**
 * brokerStatus — Zustand der Echtgeld-Anbindung, ohne etwas zu handeln.
 *
 * Owner-Auftrag 04.08. („fertige echtgeld trade Möglichkeit"). Das hier ist
 * der Knopf, den man VOR dem ersten echten Trade drückt: Er sagt, ob die
 * Verbindung steht, welches Konto dahinterliegt, ob die Schalter richtig
 * stehen — und ob das eigene Buch mit dem Depot beim Broker übereinstimmt.
 *
 * ── Warum das ein eigener Aufruf ist und nicht Teil des Handels ───────────
 *
 * Weil man den Zustand prüfen können muss, OHNE eine Order zu riskieren. Wer
 * die Anbindung erst beim ersten Trade testet, testet sie mit Geld. Dieses
 * Callable schreibt nichts, ordert nichts und ändert nichts — es liest.
 *
 * ── Was es NICHT tut ──────────────────────────────────────────────────────
 *
 * Es schaltet nichts frei. Der Doppel-Guard aus `resolveBrokerMode` bleibt
 * unangetastet: Echtgeld verlangt weiterhin `broker.mode === 'live'` in der
 * Strategie UND `ALPACA_ALLOW_LIVE=1` in der Umgebung. Dieses Callable macht
 * nur SICHTBAR, wie die Schalter stehen — es fasst sie nicht an. Ein
 * Statusknopf, der nebenbei scharf schaltet, wäre genau die Art Bequemlich-
 * keit, die man bei Geld nicht will.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { DEFAULT_STRATEGY, type Position, type Strategy } from '../../../shared/src/index.js';
import {
  abgleich,
  alpacaKonfiguriert,
  alpacaKonto,
  alpacaPositionen,
  type Abweichung,
  type AlpacaKonto,
} from '../core/alpacaBroker.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';
import { consumeQuota, resolveBrokerMode } from '../core/broker.js';

/** Der Aufruf geht nach außen und kostet Latenz — 60 am Tag sind reichlich. */
const DAILY_STATUS_LIMIT = 60;

export interface BrokerStatusResult {
  ok: true;
  /** Was tatsächlich gilt — Ergebnis des Doppel-Guards, nicht der Wunsch. */
  modus: 'paper' | 'live';
  /** Steht die Strategie auf Echtgeld? */
  wunschLive: boolean;
  /** Ist die Umgebungs-Freigabe gesetzt? */
  envFreigabe: boolean;
  /** Sind überhaupt Schlüssel hinterlegt? */
  schluesselVorhanden: boolean;
  /** Konto beim Broker — null, wenn nicht erreichbar. */
  konto: AlpacaKonto | null;
  /** Positionen, die im eigenen Buch und beim Broker auseinanderlaufen. */
  abweichungen: Abweichung[];
  /** Klartext-Diagnose für die Oberfläche. */
  meldung: string;
  /** Fehler beim Verbinden — ohne Schlüssel im Text. */
  fehler?: string;
}

export async function pruefeBrokerStatus(uid: string): Promise<BrokerStatusResult> {
  const db = getFirestore();
  const userDoc = await db.collection('users').doc(uid).get();
  const strategy = ((userDoc.get('settings') as Strategy | undefined) ??
    DEFAULT_STRATEGY) as Strategy;

  const modus = resolveBrokerMode(strategy);
  const wunschLive = strategy.broker?.mode === 'live';
  const envFreigabe = process.env.ALPACA_ALLOW_LIVE === '1';
  const schluesselVorhanden = alpacaKonfiguriert();

  const basis = {
    ok: true as const,
    modus,
    wunschLive,
    envFreigabe,
    schluesselVorhanden,
    konto: null,
    abweichungen: [] as Abweichung[],
  };

  if (!schluesselVorhanden) {
    return {
      ...basis,
      meldung:
        'Keine Alpaca-Schlüssel hinterlegt. Ohne sie läuft der Handel weiter im ' +
        'eigenen Buch — es geht keine Order nach außen.',
    };
  }

  try {
    // Immer am Endpunkt des EFFEKTIVEN Modus fragen: Damit prüft der Aufruf
    // nebenbei, ob das Schlüsselpaar dorthin gehört. Papier-Schlüssel
    // scheitern am Echtgeld-Endpunkt — und das soll hier auffallen, nicht
    // beim ersten Trade.
    const [konto, brokerPos] = await Promise.all([
      alpacaKonto(modus),
      alpacaPositionen(modus).catch(() => []),
    ]);

    const posSnap = await db.collection('users').doc(uid).collection('positions').get();
    const eigene = posSnap.docs.map((d) => {
      const p = d.data() as Position;
      return { symbol: p.symbol ?? d.id, qty: p.qty ?? 0, side: p.side };
    });
    const abweichungen = abgleich(eigene, brokerPos);

    const teile: string[] = [
      modus === 'live'
        ? `ECHTGELD-Konto verbunden (${konto.status}).`
        : `Papierkonto verbunden (${konto.status}).`,
    ];
    if (wunschLive && !envFreigabe) {
      teile.push(
        'Die Strategie steht auf Echtgeld, aber die Umgebungs-Freigabe ' +
          'ALPACA_ALLOW_LIVE fehlt — es wird weiter im Papiermodus gehandelt.',
      );
    }
    if (konto.tradingBlocked || konto.accountBlocked) {
      teile.push('Achtung: Der Broker hat das Konto gesperrt.');
    }
    if (konto.patternDayTrader) {
      teile.push('Hinweis: Das Konto ist als Muster-Daytrader eingestuft.');
    }
    teile.push(
      abweichungen.length === 0
        ? 'Eigenes Buch und Broker-Depot stimmen überein.'
        : `${abweichungen.length} Position${abweichungen.length === 1 ? '' : 'en'} laufen auseinander — vor dem Handeln klären.`,
    );

    logger.info(
      `brokerStatus ${uid}: modus=${modus} status=${konto.status} ` +
        `abweichungen=${abweichungen.length}`,
    );
    return { ...basis, konto, abweichungen, meldung: teile.join(' ') };
  } catch (e) {
    // `AlpacaFehler` putzt Schlüssel bereits aus der Nachricht; hier wird
    // nichts weiter angereichert, damit auch nichts hineinrutscht.
    const fehler = (e as Error).message;
    logger.warn(`brokerStatus ${uid} fehlgeschlagen: ${fehler}`);
    return {
      ...basis,
      meldung: 'Verbindung zum Broker fehlgeschlagen.',
      fehler,
    };
  }
}

export const brokerStatus = onCall(CALLABLE_OPTS, async (request): Promise<BrokerStatusResult> => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Anmeldung erforderlich');
  if (!(await consumeQuota(uid, 'brokerStatus', DAILY_STATUS_LIMIT))) {
    throw new HttpsError('resource-exhausted', `Höchstens ${DAILY_STATUS_LIMIT} Prüfungen am Tag`);
  }
  return pruefeBrokerStatus(uid);
});
