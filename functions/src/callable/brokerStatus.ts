/**
 * brokerStatus — Zustand der Broker-Anbindung, ohne etwas zu handeln.
 *
 * Owner-Auftrag 04.08. („fertige echtgeld trade Möglichkeit"). Das hier ist
 * der Knopf, den man VOR dem ersten echten Trade drückt: Er sagt, ob die
 * Verbindung steht, welches Konto dahinterliegt und ob die Schalter richtig
 * stehen.
 *
 * ── Warum das ein eigener Aufruf ist und nicht Teil des Handels ───────────
 *
 * Weil man den Zustand prüfen können muss, OHNE eine Order zu riskieren. Wer
 * die Anbindung erst beim ersten Trade testet, testet sie mit Geld. Dieses
 * Callable schreibt nichts, ordert nichts und ändert nichts — es liest.
 *
 * ── Was es NICHT tut ──────────────────────────────────────────────────────
 *
 * Es schaltet nichts frei. Die Guard-Kette aus `brokerZugang.ts` bleibt
 * unangetastet: Echtgeld verlangt einen hinterlegten Live-Schlüssel,
 * `broker.mode === 'live'` in der Strategie, `ALPACA_ALLOW_LIVE=1` in der
 * Umgebung, einen ausgeschalteten Kill-Switch UND eine bestandene Live-Reife.
 * Dieses Callable macht nur SICHTBAR, wie die Kette steht — es fasst sie
 * nicht an. Ein Statusknopf, der nebenbei scharf schaltet, wäre genau die Art
 * Bequemlichkeit, die man bei Geld nicht will.
 *
 * Die Reife-Kennzahlen werden hier GELESEN und nicht neu gerechnet: Sie
 * stammen aus demselben `stats/main`-Dokument, das auch das Dashboard zeigt.
 * Zwei Rechenwege wären zwei Wahrheiten — bei der Frage, ob echtes Geld
 * fließen darf, ist das keine Option.
 *
 * ── Seit dem Rückbau der Handelsplattform ─────────────────────────────────
 *
 * Kontodaten kommen über den neuen Alpaca-Client (`src/alpaca/rest.ts`) und
 * die Verbindung aus `brokerVerbindungLesend()` — dieselbe Stelle, die auch
 * der Engine-Takt benutzt. Ein Betreiber-Schlüssel aus der Umgebung zählt
 * hier NICHT mehr als „verbunden": Ein Konto ohne eigene Schlüssel hat keinen
 * Broker, Punkt. Das eigene Buch, gegen das früher abgeglichen wurde, gibt es
 * nicht mehr — der Bestand beim Broker IST der Bestand; `abweichungen`
 * bleibt als leeres Feld erhalten, damit die Oberfläche unverändert lesen
 * kann.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import {
  DEFAULT_STRATEGY,
  kanteJeTrade,
  type KanteJeTrade,
  type ReifeBefund,
  type Strategy,
} from '../../../shared/src/index.js';
import { createAlpacaClient } from '../../../src/alpaca/rest.js';
import type { AlpacaAccount } from '../../../src/alpaca/types.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';
import { accessDeniedReason, accessLevelOfSnap, mayTradeSnap } from '../core/access.js';
import {
  brokerVerbindung,
  brokerVerbindungLesend,
  type BrokerVerbindung,
} from '../core/brokerZugang.js';
import { reifeFuerKonto, type BrokerMode } from '../core/liveGate.js';
import { consumeQuota } from '../core/quota.js';

/** Der Aufruf geht nach außen und kostet Latenz — 60 am Tag sind reichlich. */
const DAILY_STATUS_LIMIT = 60;

/**
 * Was die Oberfläche vom Konto sieht — bewusst ein Ausschnitt des
 * `AlpacaAccount`, damit der Vertrag zum Frontend stabil bleibt, auch wenn
 * der Client weitere Felder liefert.
 */
export type KontoAnzeige = Pick<
  AlpacaAccount,
  | 'id'
  | 'status'
  | 'currency'
  | 'cash'
  | 'equity'
  | 'buyingPower'
  | 'tradingBlocked'
  | 'accountBlocked'
  | 'patternDayTrader'
>;

/** Abweichung Buch/Broker — nur noch als leerer Vertrag für die Oberfläche. */
export interface Abweichung {
  symbol: string;
  eigeneMenge: number;
  brokerMenge: number;
  differenz: number;
}

export interface BrokerStatusResult {
  ok: true;
  /** Was tatsächlich gilt — Ergebnis der ganzen Guard-Kette, nicht der Wunsch. */
  modus: BrokerMode;
  /** Steht die Strategie auf Echtgeld? */
  wunschLive: boolean;
  /** Ist die Umgebungs-Freigabe gesetzt? */
  envFreigabe: boolean;
  /** Sind überhaupt Schlüssel hinterlegt? */
  schluesselVorhanden: boolean;
  /** Die dritte Bedingung: Geben die Zahlen echtes Geld frei? */
  reife: ReifeBefund;
  /** Was ein Trade im Mittel bringt gegen das, was er kostet. */
  kante: KanteJeTrade;
  /** Konto beim Broker — null, wenn nicht erreichbar. */
  konto: KontoAnzeige | null;
  /** Ohne eigenes Buch gibt es nichts abzugleichen — immer leer (s. Modulkopf). */
  abweichungen: Abweichung[];
  /** Klartext-Diagnose für die Oberfläche. */
  meldung: string;
  /** Fehler beim Verbinden — ohne Schlüssel im Text. */
  fehler?: string;
}

/**
 * Effektiver Modus — dieselbe Kette wie am Order-Pfad des Engine-Takts.
 *
 * `brokerVerbindung()` liefert eine Live-Verbindung nur, wenn ALLE Guards
 * stehen (Betreiber-Freigabe, Kill-Switch aus, Nutzer-Schalter, Reife).
 * Ohne Live-Schlüssel ist die Frage gar nicht zu stellen: Papier.
 */
async function effektiverModus(uid: string, verbindung: BrokerVerbindung | null): Promise<BrokerMode> {
  if (verbindung?.mode !== 'live') return 'paper';
  const scharf = await brokerVerbindung(uid);
  return scharf?.mode === 'live' ? 'live' : 'paper';
}

export async function pruefeBrokerStatus(uid: string): Promise<BrokerStatusResult> {
  const db = getFirestore();
  const userDoc = await db.collection('users').doc(uid).get();
  /* Freischaltung VOR dem Außen-Call (Audit 13.08., Härtung): Diese Karte
   * feuert 2–3 Alpaca-Aufrufe je Klick — ein nie freigeschaltetes Konto
   * zog damit bis zu 60× am Tag Fremd-API-Kosten. Das Doc ist ohnehin
   * gerade gelesen; das Gate kostet nichts. */
  if (!mayTradeSnap(userDoc)) {
    throw new HttpsError('permission-denied', accessDeniedReason(accessLevelOfSnap(userDoc)));
  }
  /* `settings.strategy`, nicht `settings` (Audit-Befund 11.08.): Unter
   * `settings` liegen mehrere Dinge nebeneinander; wer `settings` als
   * Strategie liest, bekommt eine Hülle ohne `broker`. */
  const strategy = ((userDoc.get('settings.strategy') as Strategy | undefined) ??
    DEFAULT_STRATEGY) as Strategy;

  // Reife über denselben Helfer wie der Engine-Takt — eine Quelle, eine Zahl.
  const reife = await reifeFuerKonto(uid);
  // Die Kante braucht zusätzlich den Roundtrip-Satz, deshalb hier noch einmal
  // das Kostenprofil. Fehlt der Satz, bleibt die Kante null statt auf einer
  // geratenen Zahl zu stehen — eine erfundene Kante wäre schlimmer als keine.
  const stats = await db.collection('users').doc(uid).collection('stats').doc('main').get();
  const kosten = stats.get('costs') as
    | { fees?: number; grossPnl?: number; roundTripPct?: number | null }
    | undefined;
  const kante = kanteJeTrade(
    (stats.get('trades') as number | undefined) ?? 0,
    kosten?.grossPnl ?? 0,
    kosten?.fees ?? 0,
    typeof kosten?.roundTripPct === 'number' ? kosten.roundTripPct / 100 : 0,
  );

  const wunschLive = strategy.broker?.mode === 'live';
  const envFreigabe = process.env.ALPACA_ALLOW_LIVE === '1';
  /* Nur das SELBST verbundene Schlüsselpaar zählt (Audit 13.08., H2): Die
   * Betreiber-Umgebung zählte hier früher mit — der Nutzer sah dann Cash und
   * Depot des BETREIBER-Kontos. Ein Konto ohne eigene Schlüssel hat keinen
   * Broker. `brokerVerbindungLesend` entschlüsselt das Geheimnis über den
   * keyVault; ein Chiffrat geht nie roh als Passwort an Alpaca. */
  const verbindung = await brokerVerbindungLesend(uid);
  const schluesselVorhanden = verbindung !== null;
  const modus = await effektiverModus(uid, verbindung);

  const basis = {
    ok: true as const,
    modus,
    wunschLive,
    envFreigabe,
    schluesselVorhanden,
    reife,
    kante,
    konto: null,
    abweichungen: [] as Abweichung[],
  };

  if (!verbindung) {
    return {
      ...basis,
      meldung:
        'Kein Broker verbunden — die Engine kann für dieses Konto nicht handeln. ' +
        'Zum Verbinden ein Alpaca-PAPIERKONTO anlegen (gratis) und dessen ' +
        'Schlüssel oben eintragen.',
    };
  }

  try {
    /* Am Endpunkt der SCHLÜSSELART fragen (PK… ⇒ Papier, AK… ⇒ Echtgeld):
     * Damit prüft der Aufruf nebenbei, ob das Schlüsselpaar dorthin gehört.
     * Das ist ein LESENDER Aufruf — über ORDERS entscheidet die Guard-Kette
     * in `brokerZugang.ts`, nicht diese Karte. */
    const client = createAlpacaClient({
      mode: verbindung.mode,
      keyId: verbindung.schluessel.keyId,
      secret: verbindung.schluessel.secret,
      feed: 'iex',
      assetClass: 'us_equity',
    });
    /* „Depot nicht abrufbar" ist kein leeres Depot (Audit-Befund 11.08.):
     * Ein gescheiterter Abruf wird ehrlich gemeldet, nicht als „0
     * Positionen" verkauft. */
    const [konto, depot] = await Promise.all([
      client.getAccount(),
      client.listPositions().then(
        (p) => ({ lesbar: true as const, anzahl: p.length }),
        () => ({ lesbar: false as const, anzahl: 0 }),
      ),
    ]);

    const teile: string[] = [
      verbindung.mode === 'live'
        ? `ECHTGELD-Konto verbunden (${konto.status}).`
        : `Papierkonto verbunden (${konto.status}).`,
    ];
    if (wunschLive && verbindung.mode !== 'live') {
      teile.push(
        'Die Strategie steht auf Echtgeld, verbunden ist aber ein Papierkonto — ' +
          'gehandelt wird auf Papier.',
      );
    }
    if (wunschLive && !envFreigabe) {
      teile.push(
        'Die Strategie steht auf Echtgeld, aber die Umgebungs-Freigabe ' +
          'ALPACA_ALLOW_LIVE fehlt — es wird weiter im Papiermodus gehandelt.',
      );
    }
    if (wunschLive && envFreigabe && !reife.bereit) {
      // Der wichtigste Satz der ganzen Karte: Beide Schalter stehen, und
      // trotzdem fließt kein echtes Geld. Ohne diese Erklärung sähe es nach
      // einem Fehler aus statt nach der Sicherung, die es ist.
      teile.push(`Beide Freigaben stehen — aber ${reife.fazit}`);
    }
    if (verbindung.mode === 'live' && wunschLive && envFreigabe && reife.bereit && modus !== 'live') {
      // Alles andere steht — dann hält nur noch der Not-Aus des Betreibers.
      teile.push('Der Kill-Switch des Betreibers ist aktiv — es geht keine Echtgeld-Order raus.');
    }
    if (konto.tradingBlocked || konto.accountBlocked) {
      teile.push('Achtung: Der Broker hat das Konto gesperrt.');
    }
    if (konto.patternDayTrader) {
      teile.push('Hinweis: Das Konto ist als Muster-Daytrader eingestuft.');
    }
    teile.push(
      depot.lesbar
        ? `Depot beim Broker: ${depot.anzahl} Position${depot.anzahl === 1 ? '' : 'en'}.`
        : 'Das Depot war gerade nicht abrufbar — bitte gleich noch einmal prüfen.',
    );

    logger.info(
      `brokerStatus ${uid}: modus=${modus} status=${konto.status} ` +
        `positionen=${depot.lesbar ? depot.anzahl : 'unbekannt'}`,
    );
    const anzeige: KontoAnzeige = {
      id: konto.id,
      status: konto.status,
      currency: konto.currency,
      cash: konto.cash,
      equity: konto.equity,
      buyingPower: konto.buyingPower,
      tradingBlocked: konto.tradingBlocked,
      accountBlocked: konto.accountBlocked,
      patternDayTrader: konto.patternDayTrader,
    };
    return { ...basis, konto: anzeige, meldung: teile.join(' ') };
  } catch (e) {
    // Der Client schwärzt Schlüssel bereits aus jeder Fehlermeldung
    // (`redact`); hier wird nichts weiter angereichert, damit auch nichts
    // hineinrutscht.
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
  if (!uid) throw new HttpsError('unauthenticated', 'srv.anmeldungErforderlich');
  if (!(await consumeQuota(uid, 'brokerStatus', DAILY_STATUS_LIMIT))) {
    throw new HttpsError('resource-exhausted', `srv.hoechstensPruefungen|${DAILY_STATUS_LIMIT}`);
  }
  return pruefeBrokerStatus(uid);
});
