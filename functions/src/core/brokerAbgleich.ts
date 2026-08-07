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
import { brokerVerbindungLesend } from './orderRouting.js';

/**
 * Ausgang eines Abgleichs — vier unterscheidbare Fälle.
 *
 * Die Unterscheidung zwischen `kein_broker` und `fehler` ist der Grund für
 * dieses Feld: Beide bedeuten „nicht verglichen", aber nur einer ist ein
 * Problem. Ohne sie sähe ein Konto, dessen Broker seit Stunden nicht
 * antwortet, im Heartbeat exakt so aus wie eines ganz ohne Broker.
 */
export type AbgleichZustand = 'kein_broker' | 'sauber' | 'drift' | 'fehler';

export interface AbgleichBefund {
  /** Lief der Abgleich überhaupt? `false` = kein Broker verbunden. */
  geprueft: boolean;
  /** Ausgang in einem Wort — Grundlage der Heartbeat-Telemetrie. */
  zustand: AbgleichZustand;
  /** Gefundene Abweichungen (leer = sauber). */
  abweichungen: Abweichung[];
  /** Sollen Einstiege gesperrt werden? */
  sperre: boolean;
  /** Klartext für Log und Anzeige. */
  grund?: string;
}

/** Kein Broker, keine Prüfung — der Normalfall für reine Buch-Konten. */
const OHNE: AbgleichBefund = {
  geprueft: false,
  zustand: 'kein_broker',
  abweichungen: [],
  sperre: false,
};

/**
 * Ein Eintrag im Broker-Verlaufsprotokoll (Owner-Meldung 05.08.: „ca. 1
 * Stunde keine Verbindung" — und niemand konnte hinterher sagen, WAS in
 * dieser Stunde war, weil nur der LETZTE Zustand gespeichert wurde).
 */
export interface VerlaufEintrag {
  at: string;
  von: AbgleichZustand | null;
  nach: AbgleichZustand;
  fehlbestand?: number;
  fremdbestand?: number;
  fehler?: string;
}

/** Höchstens so viele Einträge — ein Protokoll, kein zweites Log-System. */
export const VERLAUF_MAX = 12;

/**
 * Verlauf fortschreiben — aber NUR bei einem Zustandswechsel.
 *
 * `null` heißt „kein Wechsel, nichts schreiben": Der Abgleich läuft alle
 * fünf Minuten, und 288 „weiterhin sauber"-Einträge am Tag würden genau
 * die Stunde zuschütten, die man sucht. Pur gehalten und exportiert, weil
 * die Grenzfälle (erster Eintrag, Deckel, gleicher Zustand) testbar sein
 * müssen, ohne Firestore zu heucheln.
 */
export function ergaenzeVerlauf(
  bisher: readonly VerlaufEintrag[] | undefined,
  vorherStatus: string | undefined,
  eintrag: Omit<VerlaufEintrag, 'von'>,
  max: number = VERLAUF_MAX,
): VerlaufEintrag[] | null {
  if (vorherStatus === eintrag.nach) return null;
  const von = (
    vorherStatus === 'sauber' || vorherStatus === 'drift'
    || vorherStatus === 'fehler' || vorherStatus === 'kein_broker'
      ? vorherStatus
      : null
  ) as AbgleichZustand | null;
  return [...(bisher ?? []), { ...eintrag, von }].slice(-max);
}

/**
 * Ist diese Abweichung die GEFÄHRLICHE Richtung — hält das Buch mehr, als
 * der Broker in derselben Richtung hat?
 *
 * Vorher entschied das rohe Vorzeichen der Differenz (`differenz > 0`), und
 * das ist für Shorts exakt gedreht (Short-Audit 07.08.): Ein Buch-Short,
 * den der Broker nicht kennt (Cover kauft ins Leere, Equity falsch —
 * GEFÄHRLICH), ergibt eine NEGATIVE Differenz und galt als harmloser
 * Fremdbestand; ein manuell beim Broker eröffneter Short (harmlos, trägt
 * kein broker:true) ergab eine positive und sperrte das Konto dauerhaft.
 * Maßgeblich ist die Richtung des BUCHES: Gefährlich ist, wenn das Buch
 * in seiner eigenen Richtung über den Broker hinausgeht — long wie short.
 */
export function istGefaehrlicheAbweichung(a: Abweichung): boolean {
  return (a.eigeneMenge > 0 && a.differenz > 0) || (a.eigeneMenge < 0 && a.differenz < 0);
}

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
  /** Bisheriger Vermerk (`risk.abgleich` des schon geladenen User-Docs) —
   *  Grundlage des Verlaufsprotokolls, ohne einen zweiten Read je Konto. */
  vorher?: { status?: string; verlauf?: VerlaufEintrag[] },
): Promise<AbgleichBefund> {
  /* LESENDE Verbindung — auch bei hinterlegtem Echtgeld-Schlüssel.
   *
   * `brokerVerbindung()` würde für Echtgeld `null` liefern, solange der
   * Handel verriegelt ist. Für den Abgleich ist das zu streng: Er ruft
   * ausschließlich `/v2/positions` ab und ist damit genau das, was ein
   * hinterlegter Live-Schlüssel VOR der Freischaltung bringen soll — das
   * echte Depot sehen, ohne hineinzuhandeln. */
  const verbindung = await brokerVerbindungLesend(uid);
  if (!verbindung) return OHNE;

  let brokerPositionen;
  try {
    brokerPositionen = await alpacaPositionen(verbindung.mode, verbindung.schluessel);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    logger.warn(`Abgleich ${uid}: Broker nicht erreichbar — ${text.slice(0, 200)}`);
    const verlaufF = ergaenzeVerlauf(vorher?.verlauf, vorher?.status, {
      at: jetzt.toISOString(),
      nach: 'fehler',
      fehler: text.slice(0, 120),
    });
    await vermerke(uid, {
      at: jetzt.toISOString(),
      status: 'fehler',
      fehler: text.slice(0, 200),
      ...(verlaufF ? { verlauf: verlaufF } : {}),
    });
    return {
      geprueft: false,
      zustand: 'fehler',
      abweichungen: [],
      sperre: false,
      grund: 'broker_nicht_erreichbar',
    };
  }

  const relevante = eigene
    .filter((p) => p.broker === true)
    .map((p) => ({ symbol: p.symbol, qty: p.qty, side: p.side }));
  const abweichungen = abgleich(relevante, brokerPositionen);

  /* ── Nicht jede Abweichung ist gleich gefährlich (Live-Fund 05.08.) ────
   *
   * Der erste Entwurf sperrte bei JEDER Drift. Der erste Betriebstag hat
   * gezeigt, warum das zu grob ist: Ein Konto mit leerem Buch und Beständen
   * beim Broker wurde dauerhaft gesperrt — obwohl die Engine mit diesen
   * Beständen nichts zu tun hat und sie nie anfassen wird.
   *
   * Die zwei Richtungen sind nicht symmetrisch:
   *
   *   Buch > Broker (differenz > 0) — GEFÄHRLICH. Die Engine hält eine
   *   Position, die es nicht gibt: Ihr Stop-Loss verkauft ins Leere, ihr
   *   Positionslimit ist blockiert, ihre Equity-Rechnung ist falsch. Jede
   *   Größenrechnung für einen Einstieg steht auf Sand. Das MUSS sperren.
   *
   *   Broker > Buch (differenz < 0) — FREMDBESTAND. Wer sein Konto
   *   verbindet, darf dort weiter selbst handeln; solche Positionen tragen
   *   kein `broker: true` und werden nie geroutet. Sie binden Kaufkraft, ja
   *   — aber eine Order, der die Deckung fehlt, scheitert SAUBER beim
   *   Broker. Das ist ein ehrlicher Fehlschlag, kein stiller Fehler, und
   *   rechtfertigt keine Dauersperre des ganzen Kontos.
   *
   * Gemeldet werden weiterhin beide. Nur das Sperren ist einseitig — nach
   * derselben Regel wie überall hier: die gefährliche Richtung hart, die
   * harmlose sichtbar. */
  const fehlbestand = abweichungen.filter(istGefaehrlicheAbweichung);
  const fremdbestand = abweichungen.filter((a) => !istGefaehrlicheAbweichung(a));

  const status = abweichungen.length === 0 ? 'sauber' : 'drift';
  const verlauf = ergaenzeVerlauf(vorher?.verlauf, vorher?.status, {
    at: jetzt.toISOString(),
    nach: status,
    fehlbestand: fehlbestand.length,
    fremdbestand: fremdbestand.length,
  });
  await vermerke(uid, {
    at: jetzt.toISOString(),
    status,
    anzahl: abweichungen.length,
    // Getrennt gezählt: Die Oberfläche soll „dir fehlen Stücke" von „da
    // liegt fremdes Zeug" unterscheiden können, ohne selbst zu rechnen.
    fehlbestand: fehlbestand.length,
    fremdbestand: fremdbestand.length,
    // Bewusst gedeckelt: Der Vermerk ist eine Meldung, kein zweites Depot.
    // Bei 50 Abweichungen sagt die Zahl alles, was zählt.
    abweichungen: abweichungen.slice(0, 10),
    verglichen: relevante.length,
    brokerPositionen: brokerPositionen.length,
    ...(verlauf ? { verlauf } : {}),
  });

  if (abweichungen.length === 0) {
    return { geprueft: true, zustand: 'sauber', abweichungen: [], sperre: false };
  }
  const beschreibe = (liste: Abweichung[]): string =>
    liste
      .slice(0, 5)
      .map((a) => `${a.symbol} Buch ${a.eigeneMenge} / Broker ${a.brokerMenge}`)
      .join(', ');

  if (fehlbestand.length === 0) {
    // Nur Fremdbestand: melden, weiterhandeln lassen.
    logger.info(
      `Abgleich ${uid}: ${fremdbestand.length} Position(en) nur beim Broker — ${beschreibe(fremdbestand)}`,
    );
    return {
      geprueft: true,
      zustand: 'drift',
      abweichungen,
      sperre: false,
      grund: `Nur beim Broker (${fremdbestand.length}): ${beschreibe(fremdbestand)}`,
    };
  }

  logger.warn(
    `Abgleich ${uid}: ${fehlbestand.length} Fehlbestand — ${beschreibe(fehlbestand)}`,
  );
  return {
    geprueft: true,
    zustand: 'drift',
    abweichungen,
    sperre: true,
    grund:
      `Im Buch stehen ${fehlbestand.length} Position(en), die der Broker nicht hat: `
      + `${beschreibe(fehlbestand)}`,
  };
}

async function vermerke(uid: string, daten: Record<string, unknown>): Promise<void> {
  await getFirestore()
    .doc(`users/${uid}`)
    .set({ risk: { abgleich: daten } }, { merge: true })
    .catch((err: unknown) => logger.warn(`Abgleich-Vermerk ${uid}`, err));
}
