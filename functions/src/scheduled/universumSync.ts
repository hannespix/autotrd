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

/**
 * Welche Block-Dokumente nach dem Schreiben übrig bleiben und weg müssen.
 *
 * ── Audit-Befund 11.08. ───────────────────────────────────────────────────
 *
 * Der Lauf schrieb die Blöcke `0 … n-1` und ließ alles darüber stehen.
 * Schrumpft das Universum — ein Delisting-Schwung, ein geänderter Filter,
 * eine unvollständige Antwort von Alpaca —, bleibt der letzte Block mit
 * seinen bis zu 2.000 Symbolen als Leiche liegen.
 *
 * Der Kommentar an der Schreibstelle behauptete das Gegenteil: „Volles `set`
 * statt `merge`: Ein geschrumpftes Universum muss die Blöcke am Ende
 * wirklich leeren." Das galt nur für das Zähl-Dokument, nicht für die
 * Blöcke. Ein Kommentar, der eine Garantie verspricht, die der Code nicht
 * gibt, ist schlimmer als gar keiner — der nächste Leser prüft sie nicht
 * mehr nach.
 *
 * ── Warum es (noch) nichts kaputt macht und trotzdem dringend ist ─────────
 *
 * Einen Leser gibt es heute noch nicht; die Rangliste zieht das Universum
 * erst im nächsten Schritt. Die naheliegende Bauweise dafür ist aber
 * `collection('bloecke').get()` — und die liest die Leichen mit. Delistete
 * Papiere ständen dann wieder in der Rangliste, ohne dass jemand den
 * Zusammenhang zum Sync-Lauf herstellt.
 *
 * Deshalb jetzt, solange der Zusammenhang noch sichtbar ist.
 */
export function verwaisteBloecke(vorhanden: readonly string[], neueAnzahl: number): string[] {
  return vorhanden.filter((id) => {
    const n = Number(id);
    // Eine Kennung, die keine Blocknummer ist, gehört nicht zu diesem
    // Schema — Finger weg. Löschen ist unumkehrbar, und was hier liegt,
    // haben wir nicht angelegt.
    if (!Number.isInteger(n) || n < 0 || String(n) !== id) return false;
    return n >= neueAnzahl;
  });
}

/**
 * Ergebnis des Sync-Laufs MIT Grund.
 *
 * Der Grund existiert für die Diagnose ohne GCP-Konsole (Befund 13.08.:
 * `meta/alpacaUniversum` wurde seit #246 NIE geschrieben, und warum, stand
 * nur in Cloud Logging). `universumSyncNow` reicht ihn in die HTTP-Antwort
 * durch — die Deploy-Aufwärm-Kette druckt sie ins Actions-Log.
 */
export interface UniversumErgebnis {
  stand: UniversumStand | null;
  /** null bei Erfolg; sonst maschinenlesbarer Kurzgrund. */
  grund: string | null;
}

export async function runUniversumSync(now = new Date()): Promise<UniversumErgebnis> {
  if (!alpacaKonfiguriert()) {
    logger.info('Universum: keine Alpaca-Schlüssel in der Umgebung — übersprungen');
    return { stand: null, grund: 'keine_schluessel' };
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
    return {
      stand: null,
      grund: `abruf_fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
    };
  }

  if (eintraege.length === 0) {
    logger.warn('Universum: leere Antwort — alter Stand bleibt');
    return { stand: null, grund: 'leere_antwort' };
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
  /* Blöcke, die es nach dem Schrumpfen nicht mehr gibt, im SELBEN Batch
   * löschen (siehe `verwaisteBloecke`). Ein volles `set` erreicht sie nicht:
   * Es überschreibt nur die Dokumente, die es anfasst — die dahinter bleiben
   * unberührt liegen.
   *
   * `listDocuments` statt einer Abfrage: Es holt nur die Kennungen, nicht die
   * bis zu 2.000 Symbole je Block. Bei einer Handvoll Blöcken ist der
   * Unterschied klein, aber es gibt keinen Grund, Daten zu lesen, die
   * gleich gelöscht werden. */
  let entfernt = 0;
  try {
    const vorhanden = await db.collection('meta/alpacaUniversum/bloecke').listDocuments();
    for (const id of verwaisteBloecke(vorhanden.map((r) => r.id), bloecke)) {
      batch.delete(db.doc(`meta/alpacaUniversum/bloecke/${id}`));
      entfernt += 1;
    }
  } catch (err) {
    // Ein misslungenes Aufräumen darf den Sync nicht kippen — der neue Stand
    // ist wichtiger als die Leichen von gestern, und der nächste Lauf
    // versucht es erneut.
    logger.warn('Universum: alte Blöcke nicht auflistbar', err);
  }

  // Volles `set` statt `merge` — hier reicht es, weil das Zähl-Dokument
  // vollständig neu geschrieben wird.
  batch.set(db.doc('meta/alpacaUniversum'), { ...stand, bloecke });

  await batch.commit();
  logger.info(
    `Universum: ${stand.gesamt} Symbole (${stand.aktien} Aktien, ${stand.krypto} Krypto) in ${bloecke} Blöcken`
      + (entfernt > 0 ? `, ${entfernt} alte Blöcke entfernt` : ''),
  );
  return { stand, grund: null };
}

/** Täglich 17:30 ET — nach Börsenschluss, vor dem Momentum-Lauf (18:00). */
export const universumSync = onSchedule(
  {
    schedule: '30 17 * * *',
    timeZone: 'America/New_York',
    retryCount: 0,
    timeoutSeconds: 540,
    memory: '512MiB',
    /* Erst nachdem die Deploy-Diagnose beide Secrets bestätigt hat
     * (15.08. 15:00 UTC: „VORHANDEN … Bereit zum Binden") — ein gebundenes
     * Secret, das nicht existiert, bricht den GESAMTEN Functions-Deploy
     * (gleiche Regel wie beim ANTHROPIC_API_KEY, kiBericht). Der eine
     * Plattform-Schlüssel dient NUR der Asset-Liste; Konto-Schlüssel der
     * Nutzer bleiben verschlüsselt in Firestore und sind hiervon getrennt. */
    secrets: ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY'],
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
  // Dieselbe Bindung wie der Zeitplan drüber — sonst antwortet der
  // Hand-Auslöser weiter `keine_schluessel`, während der Nachtlauf läuft.
  { timeoutSeconds: 540, memory: '512MiB', secrets: ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY'] },
  async (_req, res) => {
    // Der Grund steht in der Antwort, nicht nur im Cloud-Log: Die
    // Deploy-Aufwärm-Kette druckt sie ins Actions-Log, und „warum ist das
    // Universum leer?" ist damit ohne GCP-Konsole beantwortbar.
    const r = await runUniversumSync();
    res.json(r.stand ?? { ok: false, grund: r.grund ?? 'kein_stand' });
  },
);
