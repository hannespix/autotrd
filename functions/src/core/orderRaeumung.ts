/**
 * orderRaeumung — eigene offene Broker-Orders abräumen, bevor niemand mehr kann.
 *
 * ── Wozu (Befund 24.08., Task „GTC-Waisen") ───────────────────────────────
 *
 * `trenneBroker` löschte das Schlüsselpaar und ließ alle offenen Orders beim
 * Broker stehen. Schutz-Stops sind GTC: Sie arbeiten danach unbeaufsichtigt
 * weiter, reservieren die Stücke („insufficient qty" bei jedem manuellen
 * Verkauf in der Alpaca-Oberfläche) und blockieren über die freigegebene
 * Depot-Bindung sogar die Exits eines NACHFOLGE-Kontos. Und weil die
 * Schlüssel weg sind, kann kein Code sie je wieder erreichen.
 *
 * ── Was dieser Sweep tut — und was ausdrücklich nicht ─────────────────────
 *
 * Er storniert ausschließlich EIGENE Orders: solche, deren Kennung mit der
 * bereinigten uid beginnt (so baut `clientOrderId()` sie), plus die
 * `schutz.orderId`s aus dem eigenen Buch — Letzteres fängt Kennungen, deren
 * uid-Teil bei Überlänge gekappt wurde (`clientOrderId()` kappt den Nutzer,
 * nie den Schwanz). Was ein Mensch direkt in der Alpaca-Oberfläche gestellt
 * hat, bleibt unangetastet — dieselbe Grenze wie in `adoptBroker`.
 *
 * Er läuft NUR beim Trennen. Beim Sperren/Archivieren eines Kontos wird
 * bewusst NICHT storniert: Dort überspringen alle Läufe das Konto, der
 * GTC-Stop beim Broker ist der letzte verbliebene Exit — ihn zu stornieren
 * hieße, eine Position ungeschützt zurückzulassen. Die Unterscheidung ist
 * nicht „Einstieg vs. Exit", sondern: Gibt der Nutzer die Depot-Verwaltung
 * ab (trennen ⇒ aufräumen) oder pausiert sie nur (sperren ⇒ Netz stehen
 * lassen)?
 *
 * ── Nur Papier — Echtgeld bleibt unberührt (Red-Team 24.08.) ──────────────
 *
 * Der Sweep läuft über die LESENDE Verbindung, also ohne die vier
 * Echtgeld-Guards (`ALPACA_ALLOW_LIVE`, Kill-Switch, Nutzer-Schalter,
 * Live-Reife). Für ein Live-Depot wäre er damit der einzige gate-freie
 * Schreibpfad — ausgelöst von einem einzigen unbestätigten Klick oder einer
 * übernommenen Sitzung, und er stornierte ausgerechnet die Schutz-Stops:
 * Der Storno eines Schutz-Stops NIMMT kein Risiko, er GIBT welches. Deshalb
 * ist die Sperre hart HIER im Modul verankert, nicht nur beim Aufrufer:
 * Bei `mode !== 'paper'` wird nichts gelistet und nichts storniert; der
 * Kontoinhaber räumt sein Echtgeld-Depot selbst im Alpaca-Dashboard auf —
 * dort hat er jede Order jederzeit im Zugriff.
 *
 * ── Ehrlichkeit statt Zusicherung ─────────────────────────────────────────
 *
 * `nicht_stornierbar` (422) heißt fast immer: Die Order hat sich schon
 * gefüllt. Beim Trennen wird dieser Fill NICHT mehr ins Buch gebucht — der
 * Nutzer verlässt die Verwaltung, das Buch bleibt als letzter Stand stehen,
 * und ein späteres `adoptBroker` gleicht es wieder an. Der Befund zählt
 * solche Fälle getrennt, damit die Antwort ans Frontend nicht „alles
 * storniert" behauptet, wenn es nicht stimmt.
 */
import { logger } from 'firebase-functions/v2';
import {
  alpacaOrdersOffen,
  alpacaOrderStornieren,
  type AlpacaSchluessel,
  type FetchLike,
} from './alpacaBroker.js';
import type { BrokerMode } from './broker.js';

/** Ergebnis des Sweeps — Zahlen für Log und Frontend, IDs fürs Buch-Putzen. */
export interface RaeumBefund {
  /** Eigene offene Orders, die der Sweep gesehen hat. */
  gefunden: number;
  /** Erfolgreich storniert — schließt `weg` (404, war schon fort) ein. */
  storniert: number;
  /** `nicht_stornierbar` (422) — fast immer: schon gefüllt, Stücke sind weg. */
  gefuellt: number;
  /** Storno-Aufruf gescheitert (Netz/5xx) — die Order arbeitet womöglich weiter. */
  fehler: number;
  /** Die Liste selbst war nicht abrufbar — alle Zahlen oben sind dann 0. */
  listeFehlgeschlagen: boolean;
  /** Die Liste kam exakt am 500er-Limit zurück — dahinter kann mehr liegen,
   *  das der Sweep nie gesehen hat. Ohne dieses Feld behauptete der Befund
   *  eine Vollständigkeit, die er nicht geprüft hat. */
  moeglicherweiseUnvollstaendig: boolean;
  /** Echtgeld-Depot: bewusst NICHTS storniert (s. Modulkopf). */
  liveUebersprungen: boolean;
  /** Orders, die sicher nicht mehr offen sind (storniert/weg/gefüllt) —
   *  deren `schutz`-Verweis im Buch darf fallen. */
  erledigteOrderIds: string[];
}

/** Mehr als so viele Storni laufen gleichzeitig nicht — Alpaca nicht fluten. */
const BUENDEL = 5;
/** Frist für den Gesamt-Sweep: Das Callable hat ein endliches Zeitbudget;
 *  ein einziger zäher Alpaca-Call blockiert 15 s. Was die Frist reißt, wird
 *  als `fehler` gezählt statt die Function sterben zu lassen. */
const FRIST_MS = 90_000;

/**
 * Alle EIGENEN offenen Orders stornieren. Wirft nie — der Aufrufer (das
 * Trennen) muss auch dann durchlaufen, wenn Alpaca nicht antwortet; der
 * Befund sagt ehrlich, was liegen blieb.
 */
export async function raeumeEigeneOrders(
  mode: BrokerMode,
  schluessel: AlpacaSchluessel,
  uid: string,
  bekannteOrderIds: ReadonlySet<string>,
  fetchImpl: FetchLike = fetch,
  fristMs: number = FRIST_MS,
  jetztMs: () => number = Date.now,
): Promise<RaeumBefund> {
  const befund: RaeumBefund = {
    gefunden: 0,
    storniert: 0,
    gefuellt: 0,
    fehler: 0,
    listeFehlgeschlagen: false,
    moeglicherweiseUnvollstaendig: false,
    liveUebersprungen: false,
    erledigteOrderIds: [],
  };
  // Die Echtgeld-Sperre aus dem Modulkopf — hart HIER, damit kein künftiger
  // Aufrufer sie vergessen kann: kein Listen, kein Storno, kein Call.
  if (mode !== 'paper') {
    befund.liveUebersprungen = true;
    return befund;
  }
  // Dieselbe Bereinigung wie in `clientOrderId()`/`adoptBroker` — die
  // Kennung beginnt exakt so.
  const praefix = `${uid.replace(/[^A-Za-z0-9-]/g, '_')}-`;
  let offene;
  try {
    offene = await alpacaOrdersOffen(mode, schluessel, fetchImpl);
  } catch (err) {
    logger.warn(`orderRaeumung ${uid}: offene Orders nicht abrufbar — nichts storniert`, err);
    befund.listeFehlgeschlagen = true;
    return befund;
  }
  // Exakt am Abfrage-Limit heißt: Dahinter kann mehr liegen, das dieser
  // Sweep nie gesehen hat — der Befund darf keine Vollständigkeit behaupten.
  if (offene.length >= 500) befund.moeglicherweiseUnvollstaendig = true;
  // KEIN Typ-Filter: Beim Abräumen zählt „gehört uns", nicht „ist ein Stop".
  // Ein Typ-Filter auf 'stop' hat in `adoptBroker` bereits einmal alle
  // Krypto-Schutz-Stops (`stop_limit`) übersehen.
  const eigene = offene.filter(
    (o) => o.clientOrderId.startsWith(praefix) || bekannteOrderIds.has(o.id),
  );
  befund.gefunden = eigene.length;
  const start = jetztMs();
  for (let i = 0; i < eigene.length; i += BUENDEL) {
    if (jetztMs() - start >= fristMs) {
      // Die Frist reißt NACH dem Schlüssel-Löschen im Aufrufer — sterben
      // lassen hieße: keine Antwort, kein Aufräumen im Buch. Ehrlich zählen
      // ist das einzig Richtige, was hier noch geht.
      befund.fehler += eigene.length - i;
      logger.warn(
        `orderRaeumung ${uid}: Frist erreicht — ${eigene.length - i} Order(s) nicht mehr versucht`,
      );
      break;
    }
    const buendel = eigene.slice(i, i + BUENDEL);
    await Promise.all(
      buendel.map(async (o) => {
        try {
          const stand = await alpacaOrderStornieren(mode, o.id, schluessel, fetchImpl);
          if (stand === 'nicht_stornierbar') befund.gefuellt += 1;
          else befund.storniert += 1;
          befund.erledigteOrderIds.push(o.id);
        } catch (err) {
          befund.fehler += 1;
          logger.warn(`orderRaeumung ${uid}: Storno ${o.id} (${o.symbol}) fehlgeschlagen`, err);
        }
      }),
    );
  }
  return befund;
}
