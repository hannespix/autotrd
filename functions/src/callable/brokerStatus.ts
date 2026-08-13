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
 * Es schaltet nichts frei. Die drei Guards aus `resolveBrokerMode` bleiben
 * unangetastet: Echtgeld verlangt `broker.mode === 'live'` in der Strategie,
 * `ALPACA_ALLOW_LIVE=1` in der Umgebung UND eine bestandene Live-Reife.
 * Dieses Callable macht nur SICHTBAR, wie die drei stehen — es fasst sie
 * nicht an. Ein Statusknopf, der nebenbei scharf schaltet, wäre genau die Art
 * Bequemlichkeit, die man bei Geld nicht will.
 *
 * Die Reife-Kennzahlen werden hier GELESEN und nicht neu gerechnet: Sie
 * stammen aus demselben `stats/main`-Dokument, das auch das Dashboard zeigt.
 * Zwei Rechenwege wären zwei Wahrheiten — bei der Frage, ob echtes Geld
 * fließen darf, ist das keine Option.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import {
  DEFAULT_STRATEGY,
  kanteJeTrade,
  type KanteJeTrade,
  type Position,
  type ReifeBefund,
  type Strategy,
} from '../../../shared/src/index.js';
import {
  bestandsAbgleich,
  alpacaKonfiguriert,
  alpacaKonto,
  alpacaPositionen,
  type Abweichung,
  type AlpacaKonto,
  type AlpacaSchluessel,
} from '../core/alpacaBroker.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';
import { consumeQuota, resolveBrokerMode } from '../core/broker.js';
import { entschluessle } from '../core/keyVault.js';
import { reifeFuerKonto } from '../core/liveGate.js';

/** Der Aufruf geht nach außen und kostet Latenz — 60 am Tag sind reichlich. */
const DAILY_STATUS_LIMIT = 60;

export interface BrokerStatusResult {
  ok: true;
  /** Was tatsächlich gilt — Ergebnis aller drei Guards, nicht der Wunsch. */
  modus: 'paper' | 'live';
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
  konto: AlpacaKonto | null;
  /** Positionen, die im eigenen Buch und beim Broker auseinanderlaufen. */
  abweichungen: Abweichung[];
  /** Klartext-Diagnose für die Oberfläche. */
  meldung: string;
  /** Fehler beim Verbinden — ohne Schlüssel im Text. */
  fehler?: string;
}

/**
 * Selbst verbundenes Papierkonto-Schlüsselpaar; null, wenn keins hinterlegt.
 *
 * Liegt in `users/{uid}/private/broker` — für Clients per Rules gesperrt.
 * Lesefehler werden zu `null`: Ohne Schlüssel läuft der Handel im eigenen
 * Buch weiter, mit einem halb gelesenen Schlüssel liefe er ins Leere.
 */
async function nutzerSchluessel(uid: string): Promise<AlpacaSchluessel | null> {
  try {
    const d = await getFirestore()
      .collection('users')
      .doc(uid)
      .collection('private')
      .doc('broker')
      .get();
    const keyId = d.get('keyId') as string | undefined;
    const gespeichert = d.get('secretKey') as string | undefined;
    /* Entschlüsseln wie in `brokerVerbindung` (Audit 13.08., H2): Seit dem
     * keyVault liegt das Geheimnis als AES-256-GCM-Chiffrat im Dokument.
     * Diese Funktion las es ROH — das Chiffrat ging als Passwort an Alpaca,
     * und die Karte meldete für jedes neu verbundene Konto fälschlich
     * „Verbindung fehlgeschlagen". `entschluessle` gibt Klartext-Altbestand
     * unverändert zurück und `null` bei kaputtem Chiffrat — beides darf
     * nicht raten. */
    const secret = gespeichert ? entschluessle(gespeichert) : null;
    if (gespeichert && !secret) {
      logger.warn(`brokerStatus ${uid}: Geheimnis nicht entschlüsselbar`);
    }
    return keyId && secret ? { keyId, secret } : null;
  } catch {
    return null;
  }
}

export async function pruefeBrokerStatus(uid: string): Promise<BrokerStatusResult> {
  const db = getFirestore();
  const userDoc = await db.collection('users').doc(uid).get();
  /* `settings.strategy`, nicht `settings` (Audit-Befund 11.08.).
   *
   * Unter `settings` liegen drei Dinge nebeneinander: `strategy`, `ui` und
   * `autoTune`. Wer `settings` als Strategie liest, bekommt eine Hülle ohne
   * `broker` und ohne `engine` — und `resolveBrokerMode` greift zwei Zeilen
   * später ungeschützt auf `strategy.broker.mode` zu. Diese Karte warf
   * dadurch für JEDES Konto mit Profil; funktioniert hat nur der Fallback
   * für Konten ganz ohne `settings`.
   *
   * Es war die einzige Stelle in `functions/src`, die das Feld `settings`
   * selbst als Strategie las — alle anderen lesen `settings.strategy`. */
  const strategy = ((userDoc.get('settings.strategy') as Strategy | undefined) ??
    DEFAULT_STRATEGY) as Strategy;

  // Reife über denselben Helfer wie der Scan — eine Quelle, eine Zahl.
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

  const modus = resolveBrokerMode(strategy, reife);
  const wunschLive = strategy.broker?.mode === 'live';
  const envFreigabe = process.env.ALPACA_ALLOW_LIVE === '1';
  // Einmal laden, zweimal gebraucht: für die Ampel und für den Probe-Call.
  //
  // Im PAPIER-Modus zählt ausschließlich das SELBST verbundene Schlüsselpaar
  // (Audit 13.08., H2): Die Betreiber-Umgebung zählte hier bisher mit —
  // `keys = null` fiel dann in `alpacaFetch` auf die env-Schlüssel zurück,
  // und der Nutzer sah Cash und Depot des BETREIBER-Kontos, gegen das auch
  // noch sein eigenes Buch „abgeglichen" wurde. Ein Konto ohne eigene
  // Schlüssel hat keinen Broker — Punkt. Nur für ECHTGELD ist die Umgebung
  // der einzige legitime Weg (ein Nutzer-Schlüssel darf nie an den
  // Echtgeld-Endpunkt), und dorthin führt ohnehin erst die volle
  // Drei-Guard-Kette.
  const eigeneKeys = await nutzerSchluessel(uid);
  const schluesselVorhanden = modus === 'live' ? alpacaKonfiguriert() : eigeneKeys !== null;

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

  if (!schluesselVorhanden) {
    return {
      ...basis,
      meldung:
        'Kein Broker verbunden. Der Handel läuft im eigenen Buch — es geht ' +
        'keine Order nach außen. Zum Verbinden ein Alpaca-PAPIERKONTO ' +
        'anlegen (gratis) und dessen Schlüssel oben eintragen.',
    };
  }

  try {
    // Immer am Endpunkt des EFFEKTIVEN Modus fragen: Damit prüft der Aufruf
    // nebenbei, ob das Schlüsselpaar dorthin gehört. Papier-Schlüssel
    // scheitern am Echtgeld-Endpunkt — und das soll hier auffallen, nicht
    // beim ersten Trade.
    // Beim Papierkonto zählt das SELBST VERBUNDENE Schlüsselpaar des
    // Nutzers; für Echtgeld ausschließlich das der Umgebung (`null` ⇒
    // envSchluessel). Ein Nutzer-Schlüssel darf nie an den Echtgeld-Endpunkt.
    const keys = modus === 'paper' ? eigeneKeys : null;
    /* „Depot nicht abrufbar" ist kein leeres Depot (Audit-Befund 11.08.).
     *
     * Der `catch` machte aus einem gescheiterten Abruf eine leere Liste, und
     * der Abgleich weiter unten fand dann erwartungsgemäß keine Abweichung —
     * die Karte meldete „Eigenes Buch und Broker-Depot stimmen überein."
     *
     * Das ist genau das Muster, das `brokerAbgleich.ts` an seiner Stelle
     * ausdrücklich aufgelöst hat: „Ohne sie sähe ein Konto, dessen Broker
     * seit Stunden nicht antwortet, exakt so aus wie eines ganz ohne
     * Broker." Im Callable stand es noch.
     *
     * Der Fall ist nicht konstruiert. Nach einem Reset ist das Buch leer,
     * beim Broker liegen Positionen — der Vorfall vom 05.08., der
     * `adoptBroker` überhaupt nötig machte. Antwortet `/v2/account`, aber
     * `/v2/positions` läuft in einen Timeout, sah der Nutzer eine
     * Unbedenklichkeitsbescheinigung und keinen Anlass, „Depot übernehmen"
     * zu drücken. */
    const [konto, depot] = await Promise.all([
      alpacaKonto(modus, keys),
      alpacaPositionen(modus, keys).then(
        (p) => ({ lesbar: true as const, positionen: p }),
        () => ({ lesbar: false as const, positionen: [] }),
      ),
    ]);
    const brokerPos = depot.positionen;

    const posSnap = await db.collection('users').doc(uid).collection('positions').get();
    const eigene = posSnap.docs.map((d) => {
      const p = d.data() as Position;
      return { symbol: p.symbol ?? d.id, qty: p.qty ?? 0, side: p.side, broker: p.broker };
    });
    /* Dieselbe Funktion wie im geplanten Abgleich (`brokerAbgleich.ts`).
     *
     * Vorher lief hier der ungefilterte Bestand in ein eigenes `abgleich()`.
     * Jede Papier-Position (aus der Zeit vor dem Verbinden, oder aus einem
     * der legitimen Papier-Pfade in `broker.ts`) erschien damit als
     * Fehlbestand: Dasselbe Konto war für die Engine „sauber" und für den
     * Nutzer „Abweichung". */
    const abweichungen = bestandsAbgleich(eigene, brokerPos);

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
    if (wunschLive && envFreigabe && !reife.bereit) {
      // Der wichtigste Satz der ganzen Karte: Beide Schalter stehen, und
      // trotzdem fließt kein echtes Geld. Ohne diese Erklärung sähe es nach
      // einem Fehler aus statt nach der Sicherung, die es ist.
      teile.push(`Beide Freigaben stehen — aber ${reife.fazit}`);
    }
    if (konto.tradingBlocked || konto.accountBlocked) {
      teile.push('Achtung: Der Broker hat das Konto gesperrt.');
    }
    if (konto.patternDayTrader) {
      teile.push('Hinweis: Das Konto ist als Muster-Daytrader eingestuft.');
    }
    teile.push(
      !depot.lesbar
        ? 'Das Depot war gerade nicht abrufbar — ob Buch und Broker übereinstimmen, ist damit UNBEKANNT. Bitte gleich noch einmal prüfen.'
        : abweichungen.length === 0
          ? 'Eigenes Buch und Broker-Depot stimmen überein.'
          : `${abweichungen.length} Position${abweichungen.length === 1 ? '' : 'en'} laufen auseinander — vor dem Handeln klären.`,
    );

    logger.info(
      `brokerStatus ${uid}: modus=${modus} status=${konto.status} ` +
        // „0 Abweichungen" und „nicht nachgesehen" dürfen auch im Log nicht
        // gleich aussehen — sonst wäre der Befund von der Meldung in die
        // Diagnose gewandert statt behoben.
        `abweichungen=${depot.lesbar ? abweichungen.length : 'unbekannt'}`,
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
