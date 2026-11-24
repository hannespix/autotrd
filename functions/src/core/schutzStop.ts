/**
 * Schutz-Stop beim Broker — Bracket Stufe 1 (Owner-Go 06.08.).
 *
 * ── Das Problem ───────────────────────────────────────────────────────────
 *
 * Die Engine prüft Stops im 5-MINUTEN-Takt. Zwischen zwei Scans (und erst
 * recht bei einem ausgefallenen Lauf) ist eine geroutete Position beim
 * Broker ungeschützt: Ein schneller Einbruch rauscht durch den Stop, und
 * gebucht wird erst, wenn der nächste Scan ihn bemerkt — zu einem
 * schlechteren Kurs.
 *
 * ── Die Lösung, und was sie bewusst NICHT ist ─────────────────────────────
 *
 * Nach jedem gerouteten Einstieg legt die Engine eine echte GTC-Stop-Order
 * beim Broker an, die die PROZENT-Stops der eigenen Risiko-Logik spiegelt
 * (Stop-Loss und Trailing — der engere von beiden gilt). Der Scan zieht
 * sie nach, wenn das Trailing das Niveau anhebt, und bucht einen beim
 * Broker ausgelösten Stop sauber ins eigene Buch.
 *
 * Das ist ein SICHERHEITSNETZ, keine neue Exit-Logik: Signal-Exits,
 * ATR-Stops, Take-Profit und Zeitgrenzen bleiben vollständig bei der
 * Engine. Die volle Bracket/OCO-Maschine je Signaltyp kommt erst, wenn die
 * laufende Exit-Stil-Messung sagt, WELCHE Exits je Signaltyp die richtigen
 * sind — heute Geratenes in Broker-Orders zu gießen wäre die falsche
 * Reihenfolge (MILESTONES, Entscheidung 06.08.).
 *
 * ── Die eine Regel, die nie brechen darf ──────────────────────────────────
 *
 * Alpaca RESERVIERT die Stücke für eine offene Verkaufs-Stop-Order. Ein
 * eigener Exit MUSS die Order vorher stornieren (`schutzAufheben`), sonst
 * wird er mit „insufficient qty" abgelehnt. Und umgekehrt: Meldet der
 * Storno „nicht stornierbar", ist der Stop meist schon AUSGEFÜHRT — dann
 * wird der Broker-Fill gebucht statt ein zweiter Verkauf versucht, der
 * einen ungewollten Short eröffnen würde.
 *
 * ── Ehrliche Grenzen (Stufe 1) ────────────────────────────────────────────
 *
 * - Forex/Rohstoffe bleiben Engine-only: Das sind historische
 *   yfinance-Klassen (`=X`, `=F`), die Alpaca gar nicht handelt.
 * - KRYPTO seit 19.08. dabei (Stufe 1b) — siehe unten.
 * - Nur GANZE Stücke: Alpaca akzeptiert keine Bruchstück-Stop-Orders. Bei
 *   10,4 Stück schützt der Broker 10; der Rest bleibt Engine-Sache.
 * - Nur Prozent-Stops: Ein ATR-Stop ist eine Funktion des Scan-Zeitpunkts
 *   und lässt sich nicht als statische Order abbilden. Konten mit reinen
 *   ATR-Stops (stopLossPct 0) bekommen keinen Broker-Stop.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { sockelRisk, umkehrBesitz, umkehrParameterFuer, umkehrRisk, usSessionClass, type Position, type RiskConfig } from '../../../shared/src/index.js';
import {
  type AlpacaOrderStand,
  alpacaOrderAbfragen,
  alpacaOrderErsetzen,
  alpacaOrderStornieren,
  alpacaStopOrder,
  clientOrderId,
} from './alpacaBroker.js';
import { ORDER_ENDZUSTAENDE, assetStand, type BrokerVerbindung } from './orderRouting.js';

// ── Pure Planung (testbar ohne Broker und ohne Firestore) ───────────────────

export interface SchutzLage {
  side: 'long' | 'short';
  qty: number;
  avgEntry: number;
  highWater?: number | null;
  lowWater?: number | null;
}

/**
 * Stop-Preis richtungsgerecht auf Alpaca-Raster runden: ≥ 1 $ zwei
 * Nachkommastellen, darunter vier. Gerundet wird VOM Kurs WEG (Long
 * abwärts, Short aufwärts) — die Rundung darf den Schutz nur weiter,
 * nie enger machen als geplant.
 */
export function rundeStopPreis(preis: number, side: 'long' | 'short'): number {
  const faktor = preis >= 1 ? 100 : 10_000;
  const roh = preis * faktor;
  return (side === 'long' ? Math.floor(roh) : Math.ceil(roh)) / faktor;
}

/**
 * Krypto-Raster: Alpaca gibt je Münze ein `price_increment` vor, und ein
 * Preis daneben wird ABGELEHNT. Bei BTC/USD ist es `1` — ganze Dollar. Die
 * Aktien-Regel (zwei Nachkommastellen) wäre dort jedes Mal eine tote Order.
 *
 * Gerundet wird wie oben VOM Kurs WEG: Long abwärts, Short aufwärts. Die
 * Rundung darf den Schutz nur weiter machen, nie enger.
 */
export function rundeAufSchritt(preis: number, schritt: number, side: 'long' | 'short'): number {
  if (!(schritt > 0) || !Number.isFinite(schritt)) return preis;
  const n = preis / schritt;
  const gerundet = side === 'long' ? Math.floor(n + 1e-9) : Math.ceil(n - 1e-9);
  // Nachkommastellen des Rasters übernehmen: 0.1 * 3 ist in Fließkomma
  // 0.30000000000000004, und Alpaca liest das als ungültigen Preis.
  const stellen = (String(schritt).split('.')[1] ?? '').length;
  return Number((gerundet * schritt).toFixed(Math.min(stellen, 10)));
}

/**
 * Abstand des Limits unter (Long) bzw. über (Short) dem Stop — Krypto.
 *
 * Alpaca kennt für Krypto KEINE einfache Stop-Order, nur `stop_limit`
 * (geprüft gegen die Alpaca-Doku, 19.08.). Ein Stop-Limit füllt aber
 * NICHT, wenn der Kurs durch das Limit hindurchspringt — und genau dieser
 * Sprung ist der Fall, den das Netz fangen soll.
 *
 * Deshalb liegt das Limit bewusst WEIT weg: Das Netz soll fangen, nicht den
 * besten Preis holen. Den besten Preis holt die Engine ohnehin im
 * 5-Minuten-Takt. Ein enges Limit machte das Netz zur Attrappe — es sähe im
 * Konto aus wie Schutz und finge im Ernstfall nichts.
 *
 * Füllt es trotzdem nicht, ist niemand schlechter dran als heute: Die
 * ungefüllte Order wird vor dem eigenen Exit storniert (`schutzAufheben`),
 * und der Exit läuft wie bisher über die Engine.
 */
export const KRYPTO_LIMIT_ABSTAND = 0.015;

/**
 * Das Stop-Niveau, das die Engine-Regeln JETZT ergeben — der engere von
 * Einstands-Stop und Trailing (beide in Prozent). `null`, wenn kein
 * Prozent-Stop konfiguriert ist.
 */
/** Welche der beiden Marken das Niveau gesetzt hat. */
export type SchutzMarke = 'einstand' | 'trailing';

/**
 * Wie `schutzStopPreis`, aber mit der Marke, die gewonnen hat.
 *
 * Die Marke wird beim SCHREIBEN festgehalten, nicht beim Lesen geraten
 * (Befund 23.08.). Ein erster Anlauf verglich später das gespeicherte
 * Order-Niveau mit einem frisch gerechneten Einstands-Stop — und lag in drei
 * realen Zuständen falsch:
 *
 *   - Wird `stopLossPct` VERBREITERT, ersetzt `sollSchutzErsetzen` die alte
 *     Order nie (beim Long ersetzt sie nur nach oben). Die alte, engere
 *     Einstands-Order steht weiter — und sähe gegen den neuen, weiteren
 *     Einstands-Stop wie eine Trailing-Marke aus.
 *   - `adoptBroker` übernimmt FREMDE Order-Niveaus ins Buch und ersetzt
 *     zugleich `avgEntry` durch den Broker-Einstand. Dieses Niveau hat
 *     `schutzStopPreis` nie berechnet; die Annahme „es gibt nur zwei
 *     Kandidaten" gilt dort nicht.
 *   - Ein `byClass`-Override `stopLossPct: 0` entfällt der Klemme in
 *     `clampStrategyRisk` (die fasst nur `engine.stopLossPct` an) — dann
 *     gäbe es scheinbar nur noch einen Kandidaten.
 *
 * Hier steht die Antwort dagegen an der Stelle, die sie WEISS: im
 * `Math.max`/`Math.min` selbst. Kein späterer Zustand kann sie verfälschen.
 */
export function schutzStopMarke(
  lage: SchutzLage,
  risk: RiskConfig,
): { preis: number; marke: SchutzMarke } | null {
  const sl = risk.stopLossPct > 0 ? risk.stopLossPct : null;
  const trail =
    typeof risk.trailingStopPct === 'number' && risk.trailingStopPct > 0
      ? risk.trailingStopPct
      : null;
  if (sl === null && trail === null) return null;
  if (lage.side === 'short') {
    /* Das Trailing zählt erst, wenn die Position IM PLUS war
     * (Audit-Befund 11.08.) — beim Short heißt das: der Kurs stand unter dem
     * Einstand. Die Begründung steht bei der Long-Seite unten; hier dieselbe
     * Regel gespiegelt, wie `riskExitReason` sie mit `trough < avgEntry`
     * führt. */
    const tief = lage.lowWater ?? lage.avgEntry;
    const imPlus = tief < lage.avgEntry;
    const kandidaten = [
      ...(sl !== null ? [lage.avgEntry * (1 + sl / 100)] : []),
      ...(trail !== null && imPlus ? [tief * (1 + trail / 100)] : []),
    ];
    if (kandidaten.length === 0) return null;
    const preis = Math.min(...kandidaten);
    return {
      preis: rundeStopPreis(preis, 'short'),
      marke:
        trail !== null && imPlus && preis < lage.avgEntry * (1 + (sl ?? 0) / 100) ? 'trailing' : 'einstand',
    };
  }
  /* Das Trailing zählt erst, wenn die Position IM PLUS war.
   *
   * ── Der Audit-Befund vom 11.08. ──────────────────────────────────────────
   *
   * Die Engine führt genau diese Regel mit einer zusätzlichen Bedingung:
   *
   *     if (peak > pos.avgEntry && atMost(price, peak * (1 - trailPct/100)))
   *
   * Das `peak > avgEntry` fehlte hier. Beim Einstieg ist `highWater` gleich
   * dem Einstand, der Trailing-Kandidat wurde also vom EINSTAND aus gerechnet
   * und gewann das `Math.max`, sobald `trailingStopPct < stopLossPct`.
   *
   * Der Broker-Stop lag damit enger als jede Engine-Regel — und er ist eine
   * echte GTC-Order, er verkauft wirklich. Konkret bei „fester Stop aus, nur
   * Trailing" (`stopLossPct: 0` ⇒ clampStrategyRisk setzt die 25-%-Notbremse,
   * `trailingStopPct: 3`): Einstieg AAPL 50 Stück zu 200,00.
   *
   *   Engine       Stop bei 150,00, Trailing inaktiv (peak = 200, nicht > 200)
   *   Schutz-Stop  max(150,00 ; 194,00) = 194,00
   *
   * Bei 193,80 löste die GTC-Order aus: 300 $ realisierter Verlust auf einer
   * Position, die nach den eigenen Regeln bis 150,00 laufen durfte —
   * 22 Prozentpunkte zwischen beabsichtigtem und tatsächlichem Stop. Gebucht
   * wurde der Fill danach als regulärer `stop_loss`, die Statistik sah also
   * nichts Ungewöhnliches.
   *
   * Mit den ausgelieferten Defaults (2 % Stop, 3 % Trailing) tritt es nicht
   * auf, weil dort der Einstands-Stop gewinnt. Es tritt bei jedem
   * `trailingStopPct < stopLossPct` auf — der klassischen Kombination
   * „weiter Einstands-Stop, enges Trailing". */
  const hoch = lage.highWater ?? lage.avgEntry;
  const imPlus = hoch > lage.avgEntry;
  const kandidaten = [
    ...(sl !== null ? [lage.avgEntry * (1 - sl / 100)] : []),
    ...(trail !== null && imPlus ? [hoch * (1 - trail / 100)] : []),
  ];
  // Nur Trailing konfiguriert und noch nie im Plus ⇒ es gibt kein Niveau,
  // das die Engine gerade führen würde. Keine Order ist richtig; eine vom
  // Einstand aus gerechnete wäre die des Befundes.
  if (kandidaten.length === 0) return null;
  const preis = Math.max(...kandidaten);
  return {
    preis: rundeStopPreis(preis, 'long'),
    // Gleichstand zählt als Einstands-Stop: Dann führt der feste Stop, das
    // Trailing hat nichts hinzugefügt.
    marke: trail !== null && imPlus && preis > lage.avgEntry * (1 - (sl ?? 0) / 100) ? 'trailing' : 'einstand',
  };
}

/** Nur das Niveau — die Fassung, die alle Aufrufer seit jeher benutzen. */
export function schutzStopPreis(lage: SchutzLage, risk: RiskConfig): number | null {
  return schutzStopMarke(lage, risk)?.preis ?? null;
}

export interface SchutzPlan {
  anlegen: boolean;
  qty: number;
  stopPreis: number;
  /** Welche Marke das Niveau gesetzt hat — wandert ins Positions-Doc. */
  marke?: SchutzMarke;
  /** Gesetzt ⇒ `stop_limit` statt `stop` (Krypto). */
  limitPreis?: number;
  /** Klartext, warum NICHT — für Log und Nachvollziehbarkeit. */
  grund?: string;
}

/** Was der Broker über das Papier weiß — für Krypto zwingend. */
export interface SchutzAsset {
  /** `price_increment` (nur Krypto). */
  preisSchritt?: number | undefined;
  /** `min_order_size` (nur Krypto). */
  mindestGroesse?: number | undefined;
}

const NEIN = (grund: string): SchutzPlan => ({ anlegen: false, qty: 0, stopPreis: 0, grund });

/** Ob (und mit welchen Werten) ein Broker-Stop angelegt wird. */
export function planeSchutzStop(
  lage: SchutzLage,
  risk: RiskConfig,
  klasse: string | null,
  asset: SchutzAsset | null = null,
): SchutzPlan {
  if (klasse === null) return NEIN('klasse_unbekannt');
  if (klasse === 'crypto') return planeKryptoSchutz(lage, risk, asset);
  if (!usSessionClass(klasse)) return NEIN('klasse_ohne_us_session');
  const qty = Math.floor(lage.qty + 1e-9);
  if (qty < 1) return NEIN('bruchstueck');
  const marke = schutzStopMarke(lage, risk);
  if (marke === null || !(marke.preis > 0)) return NEIN('kein_prozent_stop');
  return { anlegen: true, qty, stopPreis: marke.preis, marke: marke.marke };
}

/**
 * Krypto (Stufe 1b, 19.08.) — die Klasse, die das Netz am nötigsten hat.
 *
 * Sie läuft rund um die Uhr, auch nachts und am Wochenende, während der
 * Scan nur alle fünf Minuten schaut. Bis heute war der Scan dort der
 * EINZIGE Wächter: Ein Einbruch um 3 Uhr blieb bis 3:05 unbeantwortet, und
 * bei einem ausgefallenen Lauf beliebig viel länger.
 *
 * Vier Unterschiede zu Aktien, jeder davon ein möglicher Ablehnungsgrund
 * beim Broker — deshalb wird hier lieber NICHTS angelegt als geraten:
 *
 * 1. `stop_limit` statt `stop` (Alpaca kann für Krypto nichts anderes).
 * 2. Bruchstücke sind der Normalfall, nicht die Ausnahme — kein Abrunden
 *    auf ganze Stücke, dafür die Mindestgröße der Münze.
 * 3. Der Preis muss auf dem Raster der Münze liegen (`price_increment`).
 * 4. Alpaca handelt Krypto nur LONG. Eine Short-Lage kann es hier nicht
 *    geben; käme sie doch, wäre ein Kauf-Stop die falsche Antwort.
 */
function planeKryptoSchutz(
  lage: SchutzLage,
  risk: RiskConfig,
  asset: SchutzAsset | null,
): SchutzPlan {
  if (lage.side !== 'long') return NEIN('krypto_nur_long');
  const schritt = asset?.preisSchritt;
  if (typeof schritt !== 'number' || !(schritt > 0)) return NEIN('kein_preisraster');
  const mindest = asset?.mindestGroesse;
  if (typeof mindest === 'number' && mindest > 0 && lage.qty < mindest) {
    return NEIN('unter_mindestgroesse');
  }
  if (!(lage.qty > 0)) return NEIN('keine_menge');
  const roh = schutzStopMarke(lage, risk);
  if (roh === null || !(roh.preis > 0)) return NEIN('kein_prozent_stop');
  const stopPreis = rundeAufSchritt(roh.preis, schritt, 'long');
  if (!(stopPreis > 0)) return NEIN('stop_unter_raster');
  const limitPreis = rundeAufSchritt(stopPreis * (1 - KRYPTO_LIMIT_ABSTAND), schritt, 'long');
  // Rundet das Limit auf den Stop hoch (grobes Raster, kleiner Preis), wäre
  // es kein Limit mehr, sondern eine zweite Auslösemarke: Die Order füllte
  // dann nur bei EXAKT diesem Kurs. Ein Raster unter dem Stop muss übrig
  // bleiben, sonst gibt es kein Netz.
  if (!(limitPreis > 0) || limitPreis >= stopPreis) return NEIN('limit_unter_raster');
  // Die Marke überlebt das Münz-Raster: Gerundet wird das Niveau, nicht die
  // Frage, welcher Kandidat es gesetzt hat.
  return { anlegen: true, qty: lage.qty, stopPreis, limitPreis, marke: roh.marke };
}

/**
 * Erst ab 0,1 % Verbesserung wird ersetzt: Jedes Ersetzen ist ein
 * Broker-Call und eine neue Order-Kennung. Ein Trailing, das bei jedem
 * Mini-Hoch nachfasst, erzeugte Dauerrauschen für Zehntel-Cents.
 */
export const SCHUTZ_ERSETZ_SCHWELLE = 0.001;

export function sollSchutzErsetzen(
  alterPreis: number,
  neuerPreis: number,
  side: 'long' | 'short',
): boolean {
  if (!(alterPreis > 0) || !(neuerPreis > 0)) return false;
  return side === 'long'
    ? neuerPreis > alterPreis * (1 + SCHUTZ_ERSETZ_SCHWELLE)
    : neuerPreis < alterPreis * (1 - SCHUTZ_ERSETZ_SCHWELLE);
}

// ── Orchestrierung (Broker + Firestore) ─────────────────────────────────────

type FetchLike = typeof fetch;

function lageAusPosition(pos: Position): SchutzLage {
  return {
    side: pos.side === 'short' ? 'short' : 'long',
    qty: pos.qty,
    avgEntry: pos.avgEntry,
    highWater: pos.highWater ?? null,
    lowWater: pos.lowWater ?? null,
  };
}

function posRef(uid: string, symbol: string): FirebaseFirestore.DocumentReference {
  return getFirestore().doc(`users/${uid}/positions/${symbol}`);
}

/**
 * Broker-Wissen zum Papier — nur für Krypto nötig, nur dort geholt.
 *
 * Ein Fehlschlag ist kein Drama: Ohne Raster legt `planeKryptoSchutz`
 * nichts an, und die Position bleibt so geschützt wie vor dieser Änderung
 * (Engine im 5-Minuten-Takt). Ein geworfener Fehler dagegen würde den
 * gerade gebuchten Trade nachträglich zerschießen.
 */
async function schutzAsset(
  verbindung: BrokerVerbindung,
  symbol: string,
  klasse: string | null,
  fetchImpl: FetchLike,
): Promise<SchutzAsset | null> {
  if (klasse !== 'crypto') return null;
  try {
    const stand = await assetStand(verbindung, symbol, fetchImpl);
    if (stand.art !== 'bekannt') return null;
    return {
      preisSchritt: stand.asset.preisSchritt,
      mindestGroesse: stand.asset.mindestGroesse,
    };
  } catch {
    return null;
  }
}

/**
 * Schutz-Stop für die AKTUELLE Position anlegen (nach einem gerouteten
 * Einstieg oder als Ersatz für eine verschwundene Order).
 *
 * Liest die Position frisch: Bei einem Nachkauf gelten Gesamtmenge und
 * neuer Durchschnittseinstand, nicht die Werte des einzelnen Fills. Ein
 * bestehender Schutz wird vorher storniert — zwei Stop-Orders auf dieselbe
 * Position würden sich die Stücke streitig machen.
 *
 * Fehler werden geloggt, nie geworfen: Ein fehlgeschlagener Schutz-Stop
 * darf keinen gebuchten Trade rückwirkend scheitern lassen. Die Engine
 * bleibt als Stop-Instanz ja bestehen — es fehlt dann nur das Netz
 * zwischen den Scans, nicht der Stop selbst.
 */
export async function schutzAnlegen(
  verbindung: BrokerVerbindung,
  uid: string,
  symbol: string,
  risk: RiskConfig,
  klasse: string | null,
  laufId: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  try {
    const snap = await posRef(uid, symbol).get();
    if (!snap.exists) return; // Position schon wieder zu — nichts zu schützen.
    const pos = snap.data() as Position;
    if (pos.broker !== true) return;

    if (pos.schutz?.orderId) {
      const storno = await alpacaOrderStornieren(
        verbindung.mode,
        pos.schutz.orderId,
        verbindung.schluessel,
        fetchImpl,
      ).catch(() => 'weg' as const);
      // 422 heißt fast immer: Die alte Order ist schon GEFÜLLT, die Stücke
      // sind weg (Red-Team 16.10.). Eine neue Verkaufs-Stop-Order über die
      // volle Menge wäre dann ungedeckt — bei Alpaca ein GTC-Leerverkauf,
      // den niemand mehr storniert. Nichts anlegen; fillSync bucht den Fill.
      if (storno === 'nicht_stornierbar') {
        /* 422 heißt „gefüllt" ODER „längst storniert" (Red-Team 24.11.,
         * M1/M2). Bisher galt beides als gefüllt — eine Position, deren
         * Stop einmal storniert war (gescheiterter Exit, gescheiterter
         * Nachzug), bekam dadurch NIE wieder einen. Einmal nachsehen: Nur
         * ein Fill oder ein unklarer Stand verbietet die neue Order. */
        const alt = await alpacaOrderAbfragen(verbindung.mode, pos.schutz.orderId, verbindung.schluessel, fetchImpl)
          .catch(() => 'unbekannt' as const);
        const totOhneFill = alt === null || (alt !== 'unbekannt' && ORDER_ENDZUSTAENDE.has(alt.status) && !(alt.filledQty > 0));
        if (!totOhneFill) {
          logger.warn(`schutzAnlegen ${uid} ${symbol}: alte Schutz-Order nicht stornierbar (gefüllt oder unklar) — keine neue`);
          return;
        }
      }
      /* Angenommen ist nicht vollzogen (24.11., s. `schutzAufheben`): Solange
       * die alte Order die Stücke hält, wiese Alpaca die neue mit 403 ab —
       * und die Position stünde ohne Stop da. Erst den Endzustand abwarten.
       * Nur „weg" oder „tot ohne Fill" erlaubt die neue: Hat die alte
       * gefüllt, sind die Stücke weg; lebt sie noch, hält sie sie fest. */
      if (storno === 'storniert') {
        const ende = await warteAufStornoEnde(verbindung, uid, symbol, pos.schutz.orderId, fetchImpl, {});
        const frei = ende.art === 'weg' || (ende.art === 'ende' && !(ende.stand.filledQty > 0));
        if (!frei) {
          logger.warn(`schutzAnlegen ${uid} ${symbol}: alte Schutz-Order ${ende.art === 'offen' ? 'noch nicht storniert' : 'hat gefüllt'} — keine neue in diesem Lauf`);
          return;
        }
        // Das Warten kann Sekunden gedauert haben: Ist die Position inzwischen
        // geschlossen, gibt es nichts mehr zu schützen (Red-Team 24.11., M-5).
        if (!(await posRef(uid, symbol).get()).exists) return;
      }
    }

    // Sockel (Task 29, Owner 16.10.): Die Broker-Order spiegelt NUR die
    // Notbremse — egal, welche Hülle der Aufrufer reicht. Sonst stünde bei
    // Alpaca weiter ein −2-%-Stop, und ein Puls-Fix allein wäre wirkungslos.
    const wirksam = pos.core === true ? sockelRisk() : umkehrBesitz(pos) ? umkehrRisk(umkehrParameterFuer(klasse)) : risk;
    const plan = planeSchutzStop(lageAusPosition(pos), wirksam, klasse, await schutzAsset(verbindung, symbol, klasse, fetchImpl));
    if (!plan.anlegen) {
      if (pos.schutz) await posRef(uid, symbol).set({ schutz: null }, { merge: true });
      logger.debug(`schutzAnlegen ${uid} ${symbol}: kein Broker-Stop (${plan.grund})`);
      return;
    }
    const order = await alpacaStopOrder(
      verbindung.mode,
      {
        symbol,
        side: pos.side === 'short' ? 'buy' : 'sell',
        qty: plan.qty,
        stopPreis: plan.stopPreis,
        ...(plan.limitPreis !== undefined ? { limitPreis: plan.limitPreis } : {}),
        clientOrderId: clientOrderId(
          uid,
          symbol,
          pos.side === 'short' ? 'buy' : 'sell',
          plan.qty,
          `${laufId}-schutz`,
        ),
      },
      verbindung.schluessel,
      fetchImpl,
    );
    if (!order.id) {
      logger.warn(`schutzAnlegen ${uid} ${symbol}: keine Order-Kennung`);
      return;
    }
    await posRef(uid, symbol).set(
      {
        schutz: {
          orderId: order.id,
          stopPreis: plan.stopPreis,
          qty: plan.qty,
          ...(plan.limitPreis !== undefined ? { limitPreis: plan.limitPreis } : {}),
          ...(plan.marke ? { quelle: plan.marke } : {}),
        },
      },
      { merge: true },
    );
    logger.info(`Schutz-Stop ${uid} ${symbol}: ${plan.qty} @ ${plan.stopPreis}`);
  } catch (err) {
    logger.warn(`schutzAnlegen ${uid} ${symbol} fehlgeschlagen`, err);
  }
}

/* ── Fehlenden Schutz-Stop wiederherstellen (Task 45, 24.11.) ───────────────
 *
 * Ein Broker-Stop entstand bisher nur nach einem eröffnenden Fill. War er
 * einmal weg — der Exit hatte ihn storniert und scheiterte dann selbst, das
 * erste Anlegen schlug fehl —, kam er für Umkehr-Positionen nie zurück: Der
 * Scan führt sie nicht (`pflegeSchutz` sieht sie nie), der Puls legt Stops
 * nur für den Sockel an. Am 24.11. lagen so elf Positionen ohne Netz beim
 * Broker.
 *
 * `pflegeSchutz` taugt hier nicht als Abkürzung: Findet es einen gefüllten
 * Stop, löst es die Verknüpfung und erwartet, dass der Aufrufer den Fill
 * bucht. Diese Heilung bucht nichts — einen gefüllten Stop fasst sie nicht
 * an; den bucht der Exit-Weg über `schutzAufheben`.
 */

/** So lange muss eine Stop-Order tot sein, bevor sie ersetzt wird. */
export const SCHUTZ_HEIL_RUHE_MS = 5 * 60_000;

/** Zustände, in denen eine Stop-Order endgültig nichts mehr hält. */
const SCHUTZ_TOT = new Set(['canceled', 'expired', 'rejected']);

export type SchutzHeilBefund =
  /** Kein Stop da (kein Link, Order unbekannt, oder lange genug tot) → neu anlegen. */
  | 'anlegen'
  /** Die Order lebt (oder ist in einem Zustand, den wir nicht als tot kennen) → nichts tun. */
  | 'steht'
  /** Der Stop hat (teil)gefüllt → nicht anfassen; den Fill bucht der Exit-Weg. */
  | 'gefuellt'
  /** Eben erst gestorben → vielleicht läuft gerade ein Exit, der sie storniert hat. */
  | 'zu_frisch';

/**
 * Was ist mit dem Stop einer Position zu tun (pur)?
 *
 * Die Ruhezeit ist die Sicherung gegen das gefährlichste Rennen: Ein Exit
 * storniert den Stop und verkauft; sähe die Heilung in dieser Sekunde nur
 * „Stop tot", legte sie einen neuen an — der hielte die Stücke wieder fest
 * (Exit abgewiesen) oder stünde, wenn der Verkauf schon durch ist, als
 * Verkaufs-Stop ohne Bestand im Markt. Fehlt die Zeitangabe, gilt die
 * Order als frisch.
 */
export function schutzHeilBefund(stand: AlpacaOrderStand | null | 'kein_link', jetztMs: number): SchutzHeilBefund {
  if (stand === 'kein_link' || stand === null) return 'anlegen';
  if (stand.filledQty > 0) return 'gefuellt';
  if (!SCHUTZ_TOT.has(stand.status)) return 'steht';
  const seit = Date.parse(stand.geaendertAm ?? '');
  if (!Number.isFinite(seit)) return 'zu_frisch';
  return jetztMs - seit >= SCHUTZ_HEIL_RUHE_MS ? 'anlegen' : 'zu_frisch';
}

/**
 * Den Stop einer Broker-Position prüfen und, wenn er fehlt, neu anlegen.
 * Wirft nie und bucht nichts. `unklar`: Die Nachfrage ist gescheitert —
 * dann lieber nichts tun als auf Verdacht eine zweite Verkaufs-Order
 * senden.
 */
export async function heileSchutz(
  verbindung: BrokerVerbindung,
  uid: string,
  symbol: string,
  pos: Position,
  risk: RiskConfig,
  klasse: string | null,
  laufId: string,
  fetchImpl: FetchLike = fetch,
): Promise<SchutzHeilBefund | 'unklar' | 'kein_broker'> {
  if (pos.broker !== true) return 'kein_broker';
  try {
    const id = pos.schutz?.orderId;
    const stand = id
      ? await alpacaOrderAbfragen(verbindung.mode, id, verbindung.schluessel, fetchImpl)
      : ('kein_link' as const);
    const befund = schutzHeilBefund(stand, Date.now());
    if (befund !== 'anlegen') return befund;
    // `schutzAnlegen` liest die Position frisch, plant selbst (Umkehr und
    // Sockel bekommen ihre Notbremse, Bruchstücke nichts) und wirft nie.
    await schutzAnlegen(verbindung, uid, symbol, risk, klasse, laufId, fetchImpl);
    return 'anlegen';
  } catch (err) {
    logger.warn(`heileSchutz ${uid} ${symbol}: Stand der Schutz-Order nicht lesbar`, err);
    return 'unklar';
  }
}

export type SchutzAufhebung =
  | { stand: 'frei' }
  /**
   * Der Storno ist angenommen, aber im Wartefenster nicht vollzogen — die
   * Stop-Order hält die Stücke noch (24.11.). Der Aufrufer sendet seinen
   * Exit JETZT NICHT: Solange der Stop lebt, wiese Alpaca ihn ab; füllte
   * der Stop in dem Moment, träfe der Exit auf Bestand 0 und eröffnete
   * einen Leerverkauf. Der nächste Versuch (Puls: eine Minute, Scan: fünf,
   * Umkehr-Lauf: Nachholrunde) geht wieder hier durch.
   */
  | { stand: 'offen' }
  | {
      stand: 'gefuellt';
      fillPreis: number;
      fillQty: number;
      orderId: string;
      /**
       * Marke der aufgehobenen Order — dieselbe Zusage wie bei `pflegeSchutz`.
       *
       * Ohne dieses Feld wäre DIESELBE physische Order je nach Reihenfolge mal
       * als Trailing- und mal als Einstands-Ausstieg gebucht worden: Ein Fill
       * kann über `pflegeSchutz` ODER über diesen Weg entdeckt werden. Die
       * Mischung wäre nicht aufgelöst, nur verkleinert.
       */
      quelle: SchutzMarke;
      /**
       * Der Rest der Stop-Order ist VERIFIZIERT tot (Endzustand beim Broker)
       * — nur dann darf die Buchung die Position VERKLEINERN statt sie ganz
       * zu schließen (Drift-Paket 08.10.). Der Schutz-Stop deckt nur ganze
       * Stücke; bei 1,9 Stück verkauft er 1 und ließ bisher 0,9 Stück beim
       * Broker zurück, während das Buch über den Minuten-Puls auf 0 ging —
       * die häufigste Quelle für „Position nur beim Broker" unter 1 Stück.
       */
      restStorniert: boolean;
    };

/**
 * Schutz-Order vor einem EIGENEN Exit aus dem Weg räumen.
 *
 * `frei` heißt: Die Stücke sind nicht mehr reserviert, der eigene Verkauf
 * kann raus. `gefuellt` heißt: Der Broker war schneller — der Stop hat
 * bereits (ganz oder teilweise) verkauft, und der Aufrufer bucht DIESEN
 * Fill statt einen zweiten Verkauf zu senden.
 */
export async function schutzAufheben(
  verbindung: BrokerVerbindung,
  uid: string,
  symbol: string,
  schutz: { orderId: string; quelle?: SchutzMarke },
  fetchImpl: FetchLike = fetch,
  warte: { versuche?: number; pauseMs?: number } = {},
): Promise<SchutzAufhebung> {
  /* Scheitert der Storno SELBST (429, 5xx, Timeout), ist der Verbleib der
   * Stop-Order unklar (Red-Team 24.11., Runde 2, H-A). Bisher warf diese
   * Funktion dann, `executeTrade` las den Wurf als „frei" — und verkaufte
   * blind, ausgerechnet in den Minuten, in denen Stop-Fill und API-Fehler
   * zusammenfallen. Jetzt wird nachgesehen wie bei „nicht stornierbar";
   * lebt der Stop noch oder bleibt er unklar, wartet der Exit. */
  let stornoWarf = false;
  let befund: 'storniert' | 'weg' | 'nicht_stornierbar';
  try {
    befund = await alpacaOrderStornieren(verbindung.mode, schutz.orderId, verbindung.schluessel, fetchImpl);
  } catch (err) {
    logger.warn(`schutzAufheben ${uid} ${symbol}: Storno der Schutz-Order gescheitert — Verbleib wird nachgesehen`, err);
    stornoWarf = true;
    befund = 'nicht_stornierbar';
  }
  if (befund === 'weg') return { stand: 'frei' };

  const gefuelltIn = (x: AlpacaOrderStand | null): boolean => x !== null && x.filledQty > 0 && x.filledAvgPreis > 0;
  let stand: AlpacaOrderStand | null;
  if (befund === 'storniert') {
    /* „Storniert" heißt bei Alpaca: Storno ANGENOMMEN, nicht vollzogen
     * (24.11.). Bis die Order im Endzustand steht, hält sie die Stücke
     * weiter reserviert — der eigene Exit direkt danach wird mit 403
     * „insufficient qty available" abgewiesen. Genau das traf am 24.11.
     * elf Umkehr-Ausstiege in einem Morgenlauf, davor XLY (19.11.), XOM
     * (12.11.) und einen Notbremsen-Exit im Puls (05.11.): Der Stop war
     * weg, der Verkauf kam nicht, die Position blieb ungeschützt liegen.
     * Deshalb: nachfragen, bis die Order tot ist. */
    const ende = await warteAufStornoEnde(verbindung, uid, symbol, schutz.orderId, fetchImpl, warte);
    if (ende.art === 'weg') return { stand: 'frei' };
    // Tot und ohne Fill → frei.
    if (ende.art === 'ende' && !gefuelltIn(ende.stand)) return { stand: 'frei' };
    // Lebt noch und hat nichts gefüllt → der Exit wartet (s. Typ).
    if (ende.art === 'offen' && !gefuelltIn(ende.stand)) return { stand: 'offen' };
    // Mit Fill (tot oder teilgefüllt lebend) → der Stop war schneller:
    // weiter in denselben Zweig wie bei „nicht stornierbar".
    stand = ende.stand;
  } else {
    // `nicht_stornierbar`: nachsehen, ob (und wie viel) ausgeführt wurde.
    // 422 heißt sehr oft „schon gefüllt" — scheitert auch die Nachfrage,
    // wird NICHT blind verkauft (H-A), sondern vertagt.
    try {
      stand = await alpacaOrderAbfragen(verbindung.mode, schutz.orderId, verbindung.schluessel, fetchImpl);
    } catch (err) {
      logger.warn(`schutzAufheben ${uid} ${symbol}: Verbleib der Schutz-Order unklar — Exit wird vertagt`, err);
      return { stand: 'offen' };
    }
    // Der Storno kam nie an und die Order lebt ungefüllt: Sie hält die Stücke.
    if (stornoWarf && stand !== null && !gefuelltIn(stand) && !ORDER_ENDZUSTAENDE.has(stand.status)) {
      return { stand: 'offen' };
    }
    /* Steht sie in `pending_cancel` (Storno aus einem früheren Versuch läuft
     * noch), ohne gefüllt zu haben: ebenfalls den Endzustand abwarten.
     * Bisher ging der Exit hier sofort raus und lief in dieselbe
     * Reservierung. NUR dieser eine Zustand: Jeder andere, den Alpaca nicht
     * stornieren lässt (`replaced` nach einem Trailing-Ersatz, `stopped`,
     * `suspended` …), steht nicht in ORDER_ENDZUSTAENDE und käme dort nie
     * an — der Exit wäre auf Dauer vertagt. Für sie gilt wie bisher „frei". */
    if (stand !== null && !gefuelltIn(stand) && stand.status === 'pending_cancel') {
      const ende = await warteAufStornoEnde(verbindung, uid, symbol, schutz.orderId, fetchImpl, warte);
      if (ende.art === 'weg') return { stand: 'frei' };
      if (ende.art === 'ende' && !gefuelltIn(ende.stand)) return { stand: 'frei' };
      if (ende.art === 'offen' && !gefuelltIn(ende.stand)) return { stand: 'offen' };
      stand = ende.stand;
    }
  }
  if (stand && stand.filledQty > 0 && stand.filledAvgPreis > 0) {
    /* Teilgefüllt und noch aktiv (`partially_filled`, `pending_cancel`):
     * den Rest stornieren und EINMAL nachfragen — Alpaca storniert
     * asynchron, und ein Rest im Zustand pending_cancel kann noch füllen.
     * Nur ein Endzustand macht die Menge endgültig. */
    let endstand = stand;
    if (!ORDER_ENDZUSTAENDE.has(endstand.status)) {
      await alpacaOrderStornieren(verbindung.mode, schutz.orderId, verbindung.schluessel, fetchImpl)
        .catch(() => 'nicht_stornierbar' as const);
      /* Ein NETZFEHLER bei der Nachfrage ist kein Endzustand (Red-Team
       * 08.10., H2): `null` heißt bei `alpacaOrderAbfragen` ausdrücklich 404
       * — die Order ist weg. Wirft die Nachfrage, bleibt der Stand unbekannt
       * und die Zusicherung unterbleibt; es gilt der sichere volle Schluss. */
      let nach: AlpacaOrderStand | null | 'unbekannt';
      try {
        nach = await alpacaOrderAbfragen(verbindung.mode, schutz.orderId, verbindung.schluessel, fetchImpl);
      } catch {
        nach = 'unbekannt';
      }
      if (nach === null) endstand = { ...endstand, status: 'canceled' };
      else if (nach === 'unbekannt') { /* Stand bleibt: kein Endzustand */ }
      else if (nach.filledQty > 0 && nach.filledAvgPreis > 0) endstand = nach;
      else endstand = { ...endstand, status: nach.status };
    }
    return {
      stand: 'gefuellt',
      fillPreis: endstand.filledAvgPreis,
      fillQty: endstand.filledQty,
      orderId: schutz.orderId,
      // Fehlt sie (Altbestand, adoptierte Fremd-Order): bisheriges Etikett.
      quelle: schutz.quelle ?? 'einstand',
      restStorniert: ORDER_ENDZUSTAENDE.has(endstand.status),
    };
  }
  // Nicht stornierbar, nichts ausgeführt, und tot (oder Alpaca kennt sie
  // nicht mehr): Die Stücke sind frei — der eigene Exit darf raus.
  logger.info(`schutzAufheben ${uid} ${symbol}: Stop-Order schon tot, ohne Fill`);
  return { stand: 'frei' };
}

/** So oft wird nach einem angenommenen Storno höchstens nachgefragt … */
export const STORNO_WARTE_VERSUCHE = 12;
/** … mit dieser Pause dazwischen … */
export const STORNO_WARTE_PAUSE_MS = 300;
/**
 * … und nie länger als diese Frist insgesamt, auf der WANDUHR (Red-Team
 * 24.11., M3): Jede Nachfrage hat für sich 15 s Timeout — ohne Frist könnte
 * ein hängender Broker einen Exit zwei Minuten aufhalten und den
 * Minuten-Puls (55 s) sprengen.
 */
export const STORNO_WARTE_FRIST_MS = 4000;

export type StornoEnde =
  /** Alpaca kennt die Order nicht mehr (404). */
  | { art: 'weg' }
  /** Endzustand erreicht — am Stand erkennt der Aufrufer einen Fill, der dem Storno zuvorkam. */
  | { art: 'ende'; stand: AlpacaOrderStand }
  /** Frist um, Order lebt noch (oder jede Nachfrage scheiterte: `stand: null`). */
  | { art: 'offen'; stand: AlpacaOrderStand | null };

/**
 * Nach einem Storno warten, bis die Order im Endzustand steht — höchstens
 * `STORNO_WARTE_FRIST_MS`. Loggt die gemessene Dauer in BEIDEN Ausgängen:
 * Wie lange Alpaca für einen Storno braucht, wusste bis 24.11. niemand
 * (Red-Team H2), und an dieser Zahl hängt, ob das Fenster reicht.
 */
export async function warteAufStornoEnde(
  verbindung: BrokerVerbindung,
  uid: string,
  symbol: string,
  orderId: string,
  fetchImpl: FetchLike,
  warte: { versuche?: number; pauseMs?: number; fristMs?: number } = {},
): Promise<StornoEnde> {
  const versuche = warte.versuche ?? STORNO_WARTE_VERSUCHE;
  const pause = warte.pauseMs ?? STORNO_WARTE_PAUSE_MS;
  const frist = warte.fristMs ?? STORNO_WARTE_FRIST_MS;
  const start = Date.now();
  let letzter: AlpacaOrderStand | null = null;
  let fragen = 0;
  for (let i = 0; i < versuche; i += 1) {
    const rest = frist - (Date.now() - start);
    if (rest <= 0) break;
    fragen += 1;
    try {
      // Die einzelne Nachfrage darf die Frist nicht überziehen.
      const stand = await Promise.race([
        alpacaOrderAbfragen(verbindung.mode, orderId, verbindung.schluessel, fetchImpl),
        new Promise<'zeit'>((r) => setTimeout(() => r('zeit'), rest)),
      ]);
      if (stand === 'zeit') break;
      if (stand === null) {
        logger.info(`Storno ${uid} ${symbol}: Order nach ${Date.now() - start} ms weg (${fragen} Nachfrage(n))`);
        return { art: 'weg' };
      }
      letzter = stand;
      if (ORDER_ENDZUSTAENDE.has(stand.status)) {
        logger.info(`Storno ${uid} ${symbol}: ${stand.status} nach ${Date.now() - start} ms (${fragen} Nachfrage(n))`);
        return { art: 'ende', stand };
      }
    } catch {
      // Netzfehler ist kein Endzustand — weiter fragen.
    }
    if (i < versuche - 1 && pause > 0) await new Promise((r) => setTimeout(r, pause));
  }
  logger.warn(`Storno ${uid} ${symbol}: nach ${Date.now() - start} ms nicht vollzogen (${fragen} Nachfrage(n), Stand ${letzter?.status ?? 'unbekannt'})`);
  return { art: 'offen', stand: letzter };
}

export type SchutzBefund =
  | { stand: 'ok' }
  | {
      stand: 'gefuellt';
      fillPreis: number;
      fillQty: number;
      orderId: string;
      /** An welcher Marke die Order stand — steuert NUR das Statistik-Etikett. */
      quelle: 'einstand' | 'trailing';
    };

/**
 * Laufende Pflege im Scan — für jede Broker-Position mit Schutz-Order.
 *
 * Drei Fälle: (1) Der Stop hat AUSGELÖST → `gefuellt`, der Scan bucht den
 * Fill als Risk-Exit. (2) Die Order ist verschwunden (storniert, verfallen,
 * Konto-Reset beim Broker) → neu anlegen. (3) Sie steht — dann und nur
 * dann prüfen, ob das Trailing das Niveau angehoben hat, und ab 0,1 %
 * Verbesserung ersetzen.
 *
 * Teilausführung wird wie eine Ausführung behandelt: Der Rest der Order
 * wird storniert, der gefüllte Teil gebucht; die verbleibenden Stücke
 * sichert bis zum nächsten Einstieg wieder die Engine allein. Das ist die
 * ehrlich einfache Variante — eine kumulative Teilfill-Buchhaltung wäre
 * eine eigene Statusmaschine, und genau die kommt erst mit der
 * Bracket-Vollstufe.
 */
export async function pflegeSchutz(
  verbindung: BrokerVerbindung,
  uid: string,
  symbol: string,
  pos: Position,
  risk: RiskConfig,
  klasse: string | null,
  laufId: string,
  fetchImpl: FetchLike = fetch,
): Promise<SchutzBefund> {
  // Sockel: nur die Notbremse (Task 29) — dieselbe Weiche wie in schutzAnlegen.
  if (pos.core === true) risk = sockelRisk();
  else if (umkehrBesitz(pos)) risk = umkehrRisk(umkehrParameterFuer(klasse));
  const schutz = pos.schutz;
  if (!schutz?.orderId) {
    /* Kein Netz da — anlegen (19.08.).
     *
     * Bis heute entstand ein Schutz-Stop AUSSCHLIESSLICH nach einem
     * eröffnenden Fill. Damit verschwand er still und kam nie zurück:
     *
     * - Nach einem TEILausstieg storniert der Exit die Order (er muss, sonst
     *   sind die Stücke reserviert) — angelegt wurde danach nichts mehr. Der
     *   Rest der Position lag ungeschützt, bis zufällig nachgekauft wurde.
     * - Scheiterte das erste Anlegen (Netzwerk, kurzer Broker-Fehler), blieb
     *   die Position dauerhaft ohne Netz. Geloggt wurde eine Warnung, die
     *   niemand liest.
     * - Vom Broker übernommene und über den Momentum-Sockel gekaufte
     *   Positionen hatten nie eins.
     *
     * Der Plan wird aus der Position gerechnet, die der Aufrufer schon in der
     * Hand hat — KEIN zusätzlicher Firestore-Lesevorgang für Positionen, die
     * ohnehin keins bekommen (Konten ohne Prozent-Stops, Bruchstücke,
     * Krypto ohne bekanntes Raster). Erst wenn der Plan Ja sagt, liest
     * `schutzAnlegen` frisch nach und sendet. */
    const plan = planeSchutzStop(
      lageAusPosition(pos),
      risk,
      klasse,
      await schutzAsset(verbindung, symbol, klasse, fetchImpl),
    );
    if (plan.anlegen) {
      await schutzAnlegen(verbindung, uid, symbol, risk, klasse, laufId, fetchImpl);
    }
    return { stand: 'ok' };
  }
  try {
    const stand = await alpacaOrderAbfragen(
      verbindung.mode,
      schutz.orderId,
      verbindung.schluessel,
      fetchImpl,
    );

    const weg =
      !stand || ['canceled', 'expired', 'rejected', 'suspended', 'done_for_day'].includes(stand.status);
    if (weg && !(stand && stand.filledQty > 0)) {
      await posRef(uid, symbol).set({ schutz: null }, { merge: true });
      await schutzAnlegen(verbindung, uid, symbol, risk, klasse, laufId, fetchImpl);
      return { stand: 'ok' };
    }

    if (stand && stand.filledQty > 0 && stand.filledAvgPreis > 0) {
      if (stand.status === 'partially_filled') {
        await alpacaOrderStornieren(
          verbindung.mode,
          schutz.orderId,
          verbindung.schluessel,
          fetchImpl,
        ).catch(() => 'weg' as const);
      }
      await posRef(uid, symbol).set({ schutz: null }, { merge: true });
      return {
        stand: 'gefuellt',
        fillPreis: stand.filledAvgPreis,
        fillQty: stand.filledQty,
        orderId: schutz.orderId,
        /* Die beim Anlegen festgehaltene Marke. Fehlt sie (Altbestand,
         * adoptierte Fremd-Order), bleibt es beim bisherigen Etikett — nie
         * geraten. */
        quelle: schutz.quelle ?? 'einstand',
      };
    }

    /* Order steht — Trailing nachziehen?
     *
     * Bei einer stop_limit-Order (Krypto) wird BEIDES neu geplant, nicht nur
     * der Stop: Das Limit hängt am Stop, und ein stehen gebliebenes Limit
     * risse den geplanten Abstand mit jedem Nachziehen weiter auf. Der Plan
     * kommt deshalb aus derselben Funktion wie beim Anlegen — eine zweite
     * Rechenstelle wäre die nächste Quelle für Auseinanderlaufen. */
    const side = pos.side === 'short' ? 'short' : 'long';
    const plan = planeSchutzStop(
      lageAusPosition(pos),
      risk,
      klasse,
      await schutzAsset(verbindung, symbol, klasse, fetchImpl),
    );
    const neu = plan.anlegen ? plan.stopPreis : null;
    if (neu !== null && sollSchutzErsetzen(schutz.stopPreis, neu, side)) {
      const neueId = await alpacaOrderErsetzen(
        verbindung.mode,
        schutz.orderId,
        neu,
        verbindung.schluessel,
        fetchImpl,
        plan.limitPreis,
      );
      await posRef(uid, symbol).set(
        {
          schutz: {
            orderId: neueId,
            stopPreis: neu,
            qty: schutz.qty,
            ...(plan.limitPreis !== undefined ? { limitPreis: plan.limitPreis } : {}),
            // Auch die nachgezogene Order trägt ihre Marke — sonst verlöre
            // eine Position sie beim ersten Nachziehen wieder.
            ...(plan.marke ? { quelle: plan.marke } : {}),
          },
        },
        { merge: true },
      );
      logger.info(`Schutz-Stop nachgezogen ${uid} ${symbol}: ${schutz.stopPreis} → ${neu}`);
    }
    return { stand: 'ok' };
  } catch (err) {
    // Pflege-Fehler stoppen den Scan nicht: Die Order steht ja — nur das
    // Nachziehen/Prüfen fällt diesen Takt aus.
    logger.warn(`pflegeSchutz ${uid} ${symbol} fehlgeschlagen`, err);
    return { stand: 'ok' };
  }
}
