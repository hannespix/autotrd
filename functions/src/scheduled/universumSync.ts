/**
 * universumSync — das Handels-Universum täglich beim Broker abholen.
 *
 * Owner-Frage 11.08.: „Können wir nicht einfach alle verfügbaren Alpaca-
 * Symbole in die Beobachtung nehmen?" Dieser Lauf ist die Antwort auf der
 * billigen Ebene: Einmal am Tag fragen, welche Papiere Alpaca überhaupt
 * handelt, und das Ergebnis ablegen. Ein Aufruf je Anlageklasse, ein
 * Firestore-Dokument.
 *
 * ── Warum das ERST nur ein Dokument schreibt ──────────────────────────────
 *
 * Weil niemand weiß, wie groß die Antwort ist, bevor man sie einmal gesehen
 * hat. Die Rangliste und die Kursversorgung darauf umzustellen, ohne die
 * Zahl zu kennen, hieße die Fünf-Minuten-Ebene ins Blaue zu skalieren — und
 * genau dort sitzen die Kosten (rund 78 Firestore-Writes je Symbol und
 * Handelstag, dazu die Yahoo-Anfragen). Dieser Lauf ändert deshalb NICHTS am
 * Handel: Er misst.
 *
 * ── Warum täglich und nicht bei jedem Scan ────────────────────────────────
 *
 * Die Antwort ist mehrere Megabyte groß und ändert sich in Tagen, nicht in
 * Minuten: Neuemissionen, Delistings, Umbenennungen. Ein Abruf je Scan wäre
 * 288-mal am Tag dieselbe Liste.
 *
 * ── Verlaufen statt verlieren ─────────────────────────────────────────────
 *
 * Schlägt der Abruf fehl, bleibt der letzte Stand stehen. Ein Universum, dem
 * still die halbe Aktienseite fehlt, sieht aus wie ein richtiges — und
 * führte zu einer Rangliste, die nur noch Krypto kennt.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { alpacaKonfiguriert, envSchluessel } from '../core/alpacaBroker.js';
import { alpacaUniversum, type UniversumEintrag } from '../core/alpacaUniversum.js';

/** Fassung des Filters — bei Regeländerungen erhöhen (s. `zaehlung`). */
export const UNIVERSUM_SYNC_V = 1;

export interface UniversumStand {
  v: number;
  at: string;
  gesamt: number;
  aktien: number;
  krypto: number;
  /** Wie viele davon Bruchstücke erlauben — Grundlage kleiner Positionen. */
  fractionable: number;
  shortable: number;
}

/**
 * Zählung für den Betriebsblick.
 *
 * Rein gehalten, damit die Kennzahlen prüfbar sind: Sie sind die einzige
 * Stelle, an der später auffällt, dass ein Filterfehler das Universum
 * halbiert hat. „Es sieht plausibel aus" ist bei 10.000 Zeilen keine
 * Prüfung.
 */
export function zaehlung(eintraege: readonly UniversumEintrag[], at: string): UniversumStand {
  return {
    v: UNIVERSUM_SYNC_V,
    at,
    gesamt: eintraege.length,
    aktien: eintraege.filter((e) => e.klasse === 'us_equity').length,
    krypto: eintraege.filter((e) => e.klasse === 'crypto').length,
    fractionable: eintraege.filter((e) => e.fractionable).length,
    shortable: eintraege.filter((e) => e.shortable).length,
  };
}

/**
 * Wie viele Symbole je Firestore-Dokument.
 *
 * Ein Dokument fasst 1 MB. Zehntausend Einträge mit Namen sprengen das
 * sicher, deshalb wird die Liste in nummerierte Blöcke geteilt. 2.000 je
 * Block liegt mit reichlich Abstand darunter (ein Eintrag ist selten über
 * 100 Byte) und hält die Zahl der Dokumente einstellig.
 */
export const BLOCK = 2_000;

export async function runUniversumSync(now = new Date()): Promise<UniversumStand | null> {
  if (!alpacaKonfiguriert()) {
    logger.info('Universum: keine Alpaca-Schlüssel in der Umgebung — übersprungen');
    return null;
  }

  let eintraege: UniversumEintrag[];
  try {
    // Immer über das PAPIER-Konto: Die Assetliste ist an beiden Endpunkten
    // dieselbe, und für eine reine Leseabfrage die Echtgeld-Schlüssel zu
    // benutzen, wäre unnötiges Risiko.
    eintraege = await alpacaUniversum('paper', envSchluessel());
  } catch (err) {
    // Letzter Stand bleibt stehen — s. Modulkopf.
    logger.warn('Universum: Abruf fehlgeschlagen, alter Stand bleibt', err);
    return null;
  }

  if (eintraege.length === 0) {
    logger.warn('Universum: leere Antwort — alter Stand bleibt');
    return null;
  }

  const db = getFirestore();
  const stand = zaehlung(eintraege, now.toISOString());
  const batch = db.batch();

  const bloecke = Math.ceil(eintraege.length / BLOCK);
  for (let i = 0; i < bloecke; i++) {
    batch.set(db.doc(`meta/alpacaUniversum/bloecke/${i}`), {
      symbole: eintraege.slice(i * BLOCK, (i + 1) * BLOCK),
    });
  }
  // Volles `set` statt `merge`: Ein geschrumpftes Universum muss die Blöcke
  // am Ende wirklich leeren, sonst ranken delistete Papiere weiter mit.
  batch.set(db.doc('meta/alpacaUniversum'), { ...stand, bloecke });

  await batch.commit();
  logger.info(
    `Universum: ${stand.gesamt} Symbole (${stand.aktien} Aktien, ${stand.krypto} Krypto) in ${bloecke} Blöcken`,
  );
  return stand;
}

/** Täglich 17:30 ET — nach Börsenschluss, vor dem Momentum-Lauf (18:00). */
export const universumSync = onSchedule(
  {
    schedule: '30 17 * * *',
    timeZone: 'America/New_York',
    retryCount: 0,
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async () => {
    await runUniversumSync();
  },
);

/**
 * Von Hand auslösbar — ohne diesen Weg müsste man auf 17:30 ET warten, um
 * überhaupt die erste Zahl zu sehen.
 */
export const universumSyncNow = onRequest(
  { timeoutSeconds: 540, memory: '512MiB' },
  async (_req, res) => {
    const stand = await runUniversumSync();
    res.json(stand ?? { ok: false, grund: 'kein_stand' });
  },
);
