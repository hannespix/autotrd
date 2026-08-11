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
 * - Nur US-Session-Klassen: Krypto/Forex haben bei Alpaca eigene
 *   Order-Regeln und bleiben Engine-only.
 * - Nur GANZE Stücke: Alpaca akzeptiert keine Bruchstück-Stop-Orders. Bei
 *   10,4 Stück schützt der Broker 10; der Rest bleibt Engine-Sache.
 * - Nur Prozent-Stops: Ein ATR-Stop ist eine Funktion des Scan-Zeitpunkts
 *   und lässt sich nicht als statische Order abbilden. Konten mit reinen
 *   ATR-Stops (stopLossPct 0) bekommen keinen Broker-Stop.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { usSessionClass, type Position, type RiskConfig } from '../../../shared/src/index.js';
import {
  alpacaOrderAbfragen,
  alpacaOrderErsetzen,
  alpacaOrderStornieren,
  alpacaStopOrder,
  clientOrderId,
} from './alpacaBroker.js';
import type { BrokerVerbindung } from './orderRouting.js';

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
 * Das Stop-Niveau, das die Engine-Regeln JETZT ergeben — der engere von
 * Einstands-Stop und Trailing (beide in Prozent). `null`, wenn kein
 * Prozent-Stop konfiguriert ist.
 */
export function schutzStopPreis(lage: SchutzLage, risk: RiskConfig): number | null {
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
    return rundeStopPreis(Math.min(...kandidaten), 'short');
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
  return rundeStopPreis(Math.max(...kandidaten), 'long');
}

export interface SchutzPlan {
  anlegen: boolean;
  qty: number;
  stopPreis: number;
  /** Klartext, warum NICHT — für Log und Nachvollziehbarkeit. */
  grund?: string;
}

/** Ob (und mit welchen Werten) ein Broker-Stop angelegt wird. */
export function planeSchutzStop(
  lage: SchutzLage,
  risk: RiskConfig,
  klasse: string | null,
): SchutzPlan {
  if (klasse === null || !usSessionClass(klasse)) {
    return { anlegen: false, qty: 0, stopPreis: 0, grund: 'klasse_ohne_us_session' };
  }
  const qty = Math.floor(lage.qty + 1e-9);
  if (qty < 1) return { anlegen: false, qty: 0, stopPreis: 0, grund: 'bruchstueck' };
  const stopPreis = schutzStopPreis(lage, risk);
  if (stopPreis === null || !(stopPreis > 0)) {
    return { anlegen: false, qty: 0, stopPreis: 0, grund: 'kein_prozent_stop' };
  }
  return { anlegen: true, qty, stopPreis };
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
      await alpacaOrderStornieren(
        verbindung.mode,
        pos.schutz.orderId,
        verbindung.schluessel,
        fetchImpl,
      ).catch(() => 'weg' as const);
    }

    const plan = planeSchutzStop(lageAusPosition(pos), risk, klasse);
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
      { schutz: { orderId: order.id, stopPreis: plan.stopPreis, qty: plan.qty } },
      { merge: true },
    );
    logger.info(`Schutz-Stop ${uid} ${symbol}: ${plan.qty} @ ${plan.stopPreis}`);
  } catch (err) {
    logger.warn(`schutzAnlegen ${uid} ${symbol} fehlgeschlagen`, err);
  }
}

export type SchutzAufhebung =
  | { stand: 'frei' }
  | { stand: 'gefuellt'; fillPreis: number; fillQty: number; orderId: string };

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
  schutz: { orderId: string },
  fetchImpl: FetchLike = fetch,
): Promise<SchutzAufhebung> {
  const befund = await alpacaOrderStornieren(
    verbindung.mode,
    schutz.orderId,
    verbindung.schluessel,
    fetchImpl,
  );
  if (befund === 'storniert' || befund === 'weg') return { stand: 'frei' };

  // `nicht_stornierbar`: nachsehen, ob (und wie viel) ausgeführt wurde.
  const stand = await alpacaOrderAbfragen(
    verbindung.mode,
    schutz.orderId,
    verbindung.schluessel,
    fetchImpl,
  );
  if (stand && stand.filledQty > 0 && stand.filledAvgPreis > 0) {
    return {
      stand: 'gefuellt',
      fillPreis: stand.filledAvgPreis,
      fillQty: stand.filledQty,
      orderId: schutz.orderId,
    };
  }
  // Nicht stornierbar, aber auch nichts ausgeführt (z. B. pending_cancel):
  // den eigenen Exit trotzdem versuchen. Schlägt er an der Reservierung
  // fehl, bucht er NICHTS — der Abgleich bleibt das Sicherheitsnetz.
  logger.warn(`schutzAufheben ${uid} ${symbol}: nicht stornierbar, ohne Fill`);
  return { stand: 'frei' };
}

export type SchutzBefund =
  | { stand: 'ok' }
  | { stand: 'gefuellt'; fillPreis: number; fillQty: number; orderId: string };

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
  const schutz = pos.schutz;
  if (!schutz?.orderId) return { stand: 'ok' };
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
      };
    }

    // Order steht — Trailing nachziehen?
    const side = pos.side === 'short' ? 'short' : 'long';
    const neu = schutzStopPreis(lageAusPosition(pos), risk);
    if (neu !== null && sollSchutzErsetzen(schutz.stopPreis, neu, side)) {
      const neueId = await alpacaOrderErsetzen(
        verbindung.mode,
        schutz.orderId,
        neu,
        verbindung.schluessel,
        fetchImpl,
      );
      await posRef(uid, symbol).set(
        { schutz: { orderId: neueId, stopPreis: neu, qty: schutz.qty } },
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
