/**
 * Laufender Abgleich zwischen eigenem Buch und Broker-Depot (M13).
 *
 * ── Warum das bei JEDEM Scan läuft und nicht auf Knopfdruck ───────────────
 *
 * Die Architekturentscheidung vom 05.08. teilt die Wahrheit auf: Der Broker
 * weiß, was im Depot LIEGT; das eigene Buch weiß, WARUM es dort liegt. Diese
 * Teilung trägt nur, solange beide Seiten dasselbe Depot beschreiben. Läuft
 * sie auseinander, ist keine der beiden Seiten mehr verlässlich — die Engine
 * rechnet mit Stücken, die es nicht gibt, oder trägt ein Risiko, von dem sie
 * nichts weiß.
 *
 * Ein Abgleich, den jemand auslösen muss, findet genau dann nicht statt, wenn
 * er gebraucht wird. Deshalb läuft er automatisch, und deshalb SPERRT eine
 * Abweichung die Einstiege — dieselbe Mechanik wie die Tages-Notbremse.
 *
 * ── Warum Einstiege, aber nicht Ausstiege ────────────────────────────────
 *
 * Eine Sperre, die auch Exits blockiert, wäre gefährlicher als die Drift, die
 * sie meldet: Ein Stop-Loss, der wegen einer Buchungsdifferenz nicht auslöst,
 * lässt einen Verlust unbegrenzt laufen. Der Grundsatz aus der Risiko-Hülle
 * gilt hier genauso — Exits sind nie gesperrt.
 *
 * ── Was NICHT verglichen wird ────────────────────────────────────────────
 *
 * Nur Positionen mit `Position.broker === true` gehen in den Vergleich.
 * Alles, was vor dem Verbinden im eigenen Buch entstand, kennt der Broker
 * nicht und wird es nie kennen; verglichen führte es zu einer Dauermeldung,
 * und eine Meldung, die immer ansteht, liest niemand mehr.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import type { Position } from '../../../shared/src/index.js';
import { abgleich, alpacaPositionen, type Abweichung } from './alpacaBroker.js';
import { brokerVerbindung } from './orderRouting.js';

export interface AbgleichBefund {
  /** Lief der Abgleich überhaupt? `false` = kein Broker verbunden. */
  geprueft: boolean;
  /** Gefundene Abweichungen (leer = sauber). */
  abweichungen: Abweichung[];
  /** Sollen Einstiege gesperrt werden? */
  sperre: boolean;
  /** Klartext für Log und Anzeige. */
  grund?: string;
}

/** Kein Broker, keine Prüfung — der Normalfall für reine Buch-Konten. */
const OHNE: AbgleichBefund = { geprueft: false, abweichungen: [], sperre: false };

/**
 * Ein Konto abgleichen und das Ergebnis am User-Dokument vermerken.
 *
 * Der Vermerk ist Teil der Aufgabe, nicht Beiwerk: Eine Sperre ohne
 * nachlesbaren Grund ist im Nachhinein nicht von einem Ausfall zu
 * unterscheiden — dieselbe Begründung wie beim Breaker-Vermerk.
 *
 * Ein FEHLER beim Broker sperrt NICHT. Ein Netzwerkfehler ist kein Beweis
 * für Drift, und ein Anbieter mit fünf Minuten Störung dürfte nicht das
 * Handeln für fünf Minuten einstellen. Er wird vermerkt und gemeldet.
 */
export async function abgleichFuerKonto(
  uid: string,
  eigene: readonly Position[],
  jetzt: Date = new Date(),
): Promise<AbgleichBefund> {
  const verbindung = await brokerVerbindung(uid);
  if (!verbindung) return OHNE;

  let brokerPositionen;
  try {
    brokerPositionen = await alpacaPositionen(verbindung.mode, verbindung.schluessel);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    logger.warn(`Abgleich ${uid}: Broker nicht erreichbar — ${text.slice(0, 200)}`);
    await vermerke(uid, {
      at: jetzt.toISOString(),
      status: 'fehler',
      fehler: text.slice(0, 200),
    });
    return { geprueft: false, abweichungen: [], sperre: false, grund: 'broker_nicht_erreichbar' };
  }

  const relevante = eigene
    .filter((p) => p.broker === true)
    .map((p) => ({ symbol: p.symbol, qty: p.qty, side: p.side }));
  const abweichungen = abgleich(relevante, brokerPositionen);

  await vermerke(uid, {
    at: jetzt.toISOString(),
    status: abweichungen.length === 0 ? 'sauber' : 'drift',
    anzahl: abweichungen.length,
    // Bewusst gedeckelt: Der Vermerk ist eine Meldung, kein zweites Depot.
    // Bei 50 Abweichungen sagt die Zahl alles, was zählt.
    abweichungen: abweichungen.slice(0, 10),
    verglichen: relevante.length,
    brokerPositionen: brokerPositionen.length,
  });

  if (abweichungen.length === 0) return { geprueft: true, abweichungen: [], sperre: false };
  const liste = abweichungen
    .slice(0, 5)
    .map((a) => `${a.symbol} Buch ${a.eigeneMenge} / Broker ${a.brokerMenge}`)
    .join(', ');
  logger.warn(`Abgleich ${uid}: ${abweichungen.length} Abweichung(en) — ${liste}`);
  return {
    geprueft: true,
    abweichungen,
    sperre: true,
    grund: `Buch und Depot weichen ab (${abweichungen.length}): ${liste}`,
  };
}

async function vermerke(uid: string, daten: Record<string, unknown>): Promise<void> {
  await getFirestore()
    .doc(`users/${uid}`)
    .set({ risk: { abgleich: daten } }, { merge: true })
    .catch((err: unknown) => logger.warn(`Abgleich-Vermerk ${uid}`, err));
}
