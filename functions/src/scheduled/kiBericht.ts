/**
 * kiBericht — der tägliche KI-Lagebericht (Owner-Go 08.08.).
 *
 * Die Begründung, warum es GENAU EIN KI-Feature gibt und was es nie tun darf,
 * steht im Kopf von `shared/src/kiBericht.ts`. Hier ist der IO-Teil: Fakten
 * lesen, ein Modell fragen, das Ergebnis ablegen.
 *
 * ── Der Schlüssel ist gebunden — und was passiert, wenn er verschwindet ───
 *
 * `ANTHROPIC_API_KEY` liegt seit dem 23.07. im Secret Manager (angelegt für
 * die damalige KI-Staffel, seit deren Ausbau am 28.07. ungenutzt). Die
 * Deploy-Diagnose hat das am 08.08. bestätigt — „VORHANDEN mit 1 aktiven
 * Version" —, weshalb die Bindung unten steht.
 *
 * Diese Reihenfolge ist Absicht und bleibt sie: Eine Deklaration für ein
 * Secret, das NICHT existiert, bricht den GESAMTEN Deploy mit „Secret does
 * not exist". Wer hier ein weiteres Secret binden will, prüft es erst mit
 * `scripts-ci/check-secret.mjs` — der Schritt läuft bei jedem Deploy.
 *
 * Der Schlüssel-Guard im Code bleibt trotzdem bestehen: Wird das Secret
 * später gelöscht oder seine Version deaktiviert, ist
 * `process.env.ANTHROPIC_API_KEY` leer, der Lauf vermerkt
 * `stand: 'kein_schluessel'` und die Karte sagt genau das — statt dass eine
 * Ausnahme durch den Scheduler nach oben schlägt.
 *
 * ── Warum dieser Lauf niemals etwas kaputt machen kann ────────────────────
 *
 * Er liest `meta/**` und schreibt genau ein Dokument. Kein Konto, keine
 * Position, keine Einstellung wird angefasst. Fällt der Anbieter aus, wird das
 * vermerkt und der nächste Tag versucht es erneut.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  baueEingabe,
  entscheideLauf,
  KI_MAX_TOKENS,
  KI_SYSTEM,
  type ErkenntnisChronik,
  type KiBerichtDoc,
  type KiFakten,
} from '../../../shared/src/index.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';

/**
 * Das Modell.
 *
 * Kein Downgrade aus Kostengründen: Der Bericht ist ein Urteil über einen
 * Sachverhalt, und genau dafür wird hier überhaupt ein Modell benutzt. Der
 * Kostenhebel ist stattdessen die Aufrufzahl (einer pro Tag) und die
 * Denk-Tiefe (`effort: 'low'`) — bei dieser Eingabegröße liegt ein Lauf im
 * niedrigen Cent-Bereich.
 */
const MODELL = 'claude-opus-5';

export interface KiBerichtResult {
  stand: string;
  grund: string;
  laenge?: number;
}

/** Einen Lagebericht erzeugen — inklusive aller Guards. */
export async function schreibeBericht(now = new Date()): Promise<KiBerichtResult> {
  const db = getFirestore();
  const ref = db.doc('meta/aiBericht');
  const vorher = (await ref.get()).data() as KiBerichtDoc | undefined;

  const chronik = (await db.doc('meta/erkenntnisse').get()).data() as
    | ErkenntnisChronik
    | undefined;
  const schluessel = (process.env.ANTHROPIC_API_KEY ?? '').trim();

  const e = entscheideLauf(vorher, chronik !== undefined, schluessel.length > 0, now);
  if (!e.laufen) {
    logger.info(`kiBericht: übersprungen — ${e.grund}`);
    // Den Zustand „kein Schlüssel" sichtbar machen: Sonst steht in der Karte
    // dauerhaft „noch kein Bericht" und niemand weiß, dass nur ein Wert fehlt.
    if (e.grund === 'kein_schluessel' && vorher?.stand !== 'kein_schluessel') {
      await ref
        .set({ stand: 'kein_schluessel', at: now.toISOString(), date: now.toISOString().slice(0, 10) })
        .catch(() => undefined);
    }
    return { stand: 'uebersprungen', grund: e.grund };
  }

  const health = (await db.doc('meta/health').get()).data() ?? {};
  // Feld für Feld übernommen statt den ganzen Heartbeat weiterzureichen: Was
  // ins Modell geht, soll hier ablesbar sein und nicht davon abhängen, was der
  // Scan sonst noch in `meta/health` ablegt.
  const nimm = <K extends keyof KiFakten>(k: K): Pick<KiFakten, K> | undefined =>
    health[k] ? ({ [k]: health[k] as NonNullable<KiFakten[K]> } as Pick<KiFakten, K>) : undefined;
  const fakten: KiFakten = {
    ...nimm('trading'),
    ...nimm('signalSchatten'),
    ...nimm('konten'),
    ...nimm('regime'),
  };

  try {
    const client = new Anthropic({ apiKey: schluessel });
    const antwort = await client.messages.create({
      model: MODELL,
      // Harte Obergrenze für Denken UND Text zusammen — der eigentliche
      // Kostendeckel je Lauf. Weit genug, dass die Antwort nicht mitten im
      // Satz abbricht, eng genug, dass ein Ausreißer nichts reißt.
      max_tokens: KI_MAX_TOKENS,
      // Der Bericht verdichtet vorhandene Fakten; er löst kein hartes Problem.
      // Niedrige Denk-Tiefe ist hier nicht Sparen um jeden Preis, sondern die
      // passende Einstellung — und sie hält Laufzeit wie Kosten klein.
      output_config: { effort: 'low' },
      system: KI_SYSTEM,
      messages: [{ role: 'user', content: baueEingabe(chronik!, fakten) }],
    });

    // Eine Ablehnung ist eine gültige Antwort, kein Fehler — sie hat leeren
    // Inhalt, und ein blindes content[0] würde hier abstürzen.
    if (antwort.stop_reason === 'refusal') {
      await ref.set({
        stand: 'fehler',
        at: now.toISOString(),
        date: now.toISOString().slice(0, 10),
        fehler: 'Anfrage wurde abgelehnt',
        monat: e.monat,
        laeufeImMonat: e.laufNr,
      });
      logger.warn('kiBericht: Anfrage abgelehnt');
      return { stand: 'fehler', grund: 'refusal' };
    }

    const text = antwort.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text.length === 0) {
      logger.warn('kiBericht: leere Antwort');
      return { stand: 'fehler', grund: 'leer' };
    }

    const doc: KiBerichtDoc = {
      stand: 'bericht',
      at: now.toISOString(),
      date: now.toISOString().slice(0, 10),
      text,
      modell: MODELL,
      tokens: { ein: antwort.usage.input_tokens, aus: antwort.usage.output_tokens },
      monat: e.monat,
      laeufeImMonat: e.laufNr,
    };
    await ref.set(doc);
    logger.info(
      `kiBericht: geschrieben (${text.length} Zeichen, ${antwort.usage.input_tokens}+${antwort.usage.output_tokens} Token, Lauf ${e.laufNr}/Monat)`,
    );
    return { stand: 'bericht', grund: 'ok', laenge: text.length };
  } catch (err) {
    // Der Monatszähler wird AUCH bei einem Fehler fortgeschrieben: Ein Anbieter,
    // der jedes Mal scheitert, darf nicht beliebig oft angefragt werden.
    const text = err instanceof Error ? err.message : String(err);
    await ref
      .set({
        stand: 'fehler',
        at: now.toISOString(),
        date: now.toISOString().slice(0, 10),
        fehler: text.slice(0, 200),
        monat: e.monat,
        laeufeImMonat: e.laufNr,
      })
      .catch(() => undefined);
    logger.warn(`kiBericht: fehlgeschlagen — ${text.slice(0, 200)}`);
    return { stand: 'fehler', grund: 'ausnahme' };
  }
}

/**
 * Täglich 18:25 ET — nach Equity-Snapshot (17:15), Auto-Tuner (17:45) und
 * Struktursuche (18:10). Der Bericht kommentiert den fertigen Tagesstand;
 * liefe er davor, beschriebe er den von gestern.
 */
export const kiBericht = onSchedule(
  {
    schedule: '25 18 * * *',
    timeZone: 'America/New_York',
    retryCount: 0,
    // Ein Modell-Aufruf mit Denken kann länger als den 60-s-Default brauchen.
    timeoutSeconds: 300,
    // Erst nachdem die Deploy-Diagnose das Secret bestätigt hat (s. o.).
    secrets: ['ANTHROPIC_API_KEY'],
  },
  async () => {
    await schreibeBericht();
  },
);

/** Manueller Trigger — NUR im Emulator (Abnahme-Verifikation). */
export const kiBerichtNow = onRequest(EMULATOR_TRIGGER_OPTS, async (_req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'kiBerichtNow ist nur im Emulator verfügbar' });
    return;
  }
  res.status(200).json(await schreibeBericht());
});
