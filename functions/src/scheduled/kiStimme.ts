/**
 * kiStimme — die tägliche KI-Stimme (Slice 1, Owner-Go 25.08.).
 *
 * Die Begründung — warum das keine zweite „KI-Staffel" ist, warum sie
 * (noch) NICHTS am Handel ändert und wie die eingebaute Gegenstimme
 * gedacht ist — steht im Kopf von `shared/src/kiStimme.ts`. Hier ist der
 * IO-Teil: die Momentum-Rangliste lesen, ein Modell fragen, das Ergebnis
 * ablegen. Strukturell fast identisch zu `kiBericht.ts` — bewusst, damit
 * es nur EIN bewährtes Muster für „Claude-API aus einer Scheduled Function
 * aufrufen" im Repo gibt, nicht zwei leicht verschiedene.
 *
 * ── Der Schlüssel ist derselbe wie beim Lagebericht ────────────────────────
 *
 * `ANTHROPIC_API_KEY` liegt bereits im Secret Manager (s. `kiBericht.ts`).
 * Keine neue Bindung nötig, kein neues Ausfallrisiko für den Deploy.
 *
 * ── Warum dieser Lauf niemals etwas kaputt machen kann ────────────────────
 *
 * Er liest `meta/momentum` und `meta/health` (beide bereits vom eigenen
 * Scan/Momentum-Lauf geschrieben) und schreibt genau EIN Dokument
 * (`meta/aiVoteShadow`). Kein Konto, keine Position, keine Order — nichts
 * davon liest dieses Dokument. Fällt der Anbieter aus, wird das vermerkt
 * und der nächste Tag versucht es erneut.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  baueKiStimmeEingabe,
  entscheideKiStimmeLauf,
  parseKiStimmeAntwort,
  KI_STIMME_MAX_TOKENS,
  KI_STIMME_SYSTEM,
  type KiStimmeDoc,
  type KiStimmeFakten,
} from '../../../shared/src/index.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';

/** Dasselbe Modell wie der Lagebericht — kein Downgrade aus Kostengründen,
 *  Kostenhebel sind Aufrufzahl (einer pro Tag) und Denk-Tiefe. */
const MODELL = 'claude-opus-5';

/** Nicht-Läufe, die als Stand im Dokument landen — dieselbe Unterscheidung
 *  wie bei `kiBericht.ts` (nur die, bei denen ein Baustein FEHLT). */
const SICHTBARE_LEERGRUENDE = new Set(['kein_schluessel', 'keine_daten']);

export interface KiStimmeResult {
  stand: string;
  grund: string;
  anzahl?: number;
}

/** Eine tägliche Runde KI-Stimmen erheben — inklusive aller Guards. */
export async function erhebeKiStimme(now = new Date()): Promise<KiStimmeResult> {
  const db = getFirestore();
  const ref = db.doc('meta/aiVoteShadow');
  const vorher = (await ref.get()).data() as KiStimmeDoc | undefined;

  const momentum = (await db.doc('meta/momentum').get()).data() as
    | { top?: Array<{ symbol: string; score: number }> }
    | undefined;
  const health = (await db.doc('meta/health').get()).data() ?? {};
  const top = momentum?.top ?? [];
  const schluessel = (process.env.ANTHROPIC_API_KEY ?? '').trim();

  const e = entscheideKiStimmeLauf(vorher, top.length > 0, schluessel.length > 0, now);
  if (!e.laufen) {
    logger.info(`kiStimme: übersprungen — ${e.grund}`);
    // Wie beim Lagebericht: `schon_gelaufen`/`monatsdeckel` überschreiben NIE
    // den letzten guten Stand — nur ein fehlender Baustein wird sichtbar.
    if (SICHTBARE_LEERGRUENDE.has(e.grund) && vorher?.stand !== e.grund) {
      await ref
        .set({ stand: e.grund, at: now.toISOString(), date: now.toISOString().slice(0, 10) })
        .catch(() => undefined);
    }
    return { stand: 'uebersprungen', grund: e.grund };
  }

  const fakten: KiStimmeFakten = {
    top,
    ...(health['regime']
      ? { regime: health['regime'] as NonNullable<KiStimmeFakten['regime']> }
      : {}),
  };
  const symbole = top.map((t) => t.symbol);

  try {
    const client = new Anthropic({ apiKey: schluessel });
    const antwort = await client.messages.create({
      model: MODELL,
      max_tokens: KI_STIMME_MAX_TOKENS,
      output_config: { effort: 'low' },
      system: KI_STIMME_SYSTEM,
      messages: [{ role: 'user', content: baueKiStimmeEingabe(fakten) }],
    });

    if (antwort.stop_reason === 'refusal') {
      await ref.set({
        stand: 'fehler',
        at: now.toISOString(),
        date: now.toISOString().slice(0, 10),
        fehler: 'Anfrage wurde abgelehnt',
        monat: e.monat,
        laeufeImMonat: e.laufNr,
      });
      logger.warn('kiStimme: Anfrage abgelehnt');
      return { stand: 'fehler', grund: 'refusal' };
    }

    const text = antwort.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const votes = parseKiStimmeAntwort(text, symbole);
    if (!votes) {
      await ref.set({
        stand: 'fehler',
        at: now.toISOString(),
        date: now.toISOString().slice(0, 10),
        fehler: 'Antwort nicht auswertbar',
        monat: e.monat,
        laeufeImMonat: e.laufNr,
      });
      logger.warn('kiStimme: Antwort nicht auswertbar (kein gültiges JSON-Array)');
      return { stand: 'fehler', grund: 'unlesbar' };
    }

    const doc: KiStimmeDoc = {
      stand: 'stimmen',
      at: now.toISOString(),
      date: now.toISOString().slice(0, 10),
      votes,
      modell: MODELL,
      tokens: { ein: antwort.usage.input_tokens, aus: antwort.usage.output_tokens },
      monat: e.monat,
      laeufeImMonat: e.laufNr,
    };
    await ref.set(doc);
    logger.info(
      `kiStimme: ${votes.length} Stimme(n) geschrieben (${antwort.usage.input_tokens}+${antwort.usage.output_tokens} Token, Lauf ${e.laufNr}/Monat)`,
    );
    return { stand: 'stimmen', grund: 'ok', anzahl: votes.length };
  } catch (err) {
    // Der Monatszähler wird AUCH bei einem Fehler fortgeschrieben — dieselbe
    // Begründung wie beim Lagebericht: ein dauerhaft scheiternder Anbieter
    // darf nicht beliebig oft angefragt werden.
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
    logger.warn(`kiStimme: fehlgeschlagen — ${text.slice(0, 200)}`);
    return { stand: 'fehler', grund: 'ausnahme' };
  }
}

/**
 * Täglich 18:35 ET — nach `momentumRun` (18:00), der `meta/momentum.top`
 * erst befüllt, und nach `kiBericht` (18:25)/`tagRueckblick` (18:30), damit
 * kein zweiter Claude-Aufruf im selben Minutenfenster steht.
 */
export const kiStimme = onSchedule(
  {
    schedule: '35 18 * * *',
    timeZone: 'America/New_York',
    retryCount: 0,
    // Ein Modell-Aufruf mit Denken kann länger als den 60-s-Default brauchen.
    timeoutSeconds: 300,
    secrets: ['ANTHROPIC_API_KEY'],
  },
  async () => {
    await erhebeKiStimme();
  },
);

/** Manueller Trigger — NUR im Emulator (Abnahme-Verifikation). */
export const kiStimmeNow = onRequest(EMULATOR_TRIGGER_OPTS, async (_req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'kiStimmeNow ist nur im Emulator verfügbar' });
    return;
  }
  res.status(200).json(await erhebeKiStimme());
});
