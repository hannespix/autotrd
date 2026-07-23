/**
 * tunerReview — täglicher KI-Review der Prognose-Genauigkeit (MILESTONES M6,
 * Port von reference/scripts/ai_tuner.py) über die Anthropic **Batch API**
 * (50 % Kosten, ARCHITECTURE §6) im Zwei-Phasen-Muster:
 *
 *   Phase A (Collect): liegt ein pendingBatchId vor, wird das Ergebnis des
 *   Vortags abgeholt, geparst und das Shadow-Suchgitter — hart geclampt —
 *   in meta/forecastStats.tuning erweitert.
 *   Phase B (Submit): genug realisierte Scores vorhanden → neuen Review-Batch
 *   einreichen (custom_id `tuner-review`), ID in meta/tuner merken.
 *
 * SICHERHEIT: ändert NIE Live-Parameter (bestParams bleibt rein empirisch);
 * ohne Key/Budget degradiert der Review sichtbar, das empirische Tuning
 * läuft unverändert weiter.
 */

import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { LOOKBACK_GRID, WEIGHT_GRID, type ComboStat } from '../../../shared/src/index.js';
import {
  SONNET_MODEL,
  aiAvailable,
  anthropicClient,
  anthropicApiKey,
  reserveAiBudget,
  usageTokens,
} from '../core/ai.js';
import {
  buildTunerPrompt,
  clampGridProposals,
  mergeGrids,
  parseTunerResponse,
  type TunerStatsSummary,
} from '../core/tuner.js';

const MIN_SCORED = 20; // wie die Referenz: erst reviewen, wenn Daten da sind
const EST_TUNER_TOKENS = 1_500;
const BATCH_CUSTOM_ID = 'tuner-review';

export interface TunerRunResult {
  status:
    | 'ok'
    | 'batch_submitted'
    | 'batch_pending'
    | 'waiting_for_data'
    | 'ai_unavailable'
    | 'budget_exceeded'
    | 'ai_error';
  detail?: string;
}

function summarizeStats(
  scored: number,
  dirAccuracy: number | null,
  best: { w: number; lookback: number },
  combos: Record<string, ComboStat>,
): TunerStatsSummary {
  const topCombos = Object.entries(combos)
    .filter(([, d]) => d.n >= 3)
    .map(([combo, d]) => ({
      combo,
      n: d.n,
      hitRate: Math.round((d.hits / d.n) * 1000) / 10,
    }))
    .sort((a, b) => b.hitRate - a.hitRate)
    .slice(0, 5);
  return { scored, dirAccuracy, best, topCombos };
}

async function recordReview(fields: Record<string, unknown>): Promise<void> {
  await getFirestore()
    .doc('meta/tuner')
    .set({ ...fields, ts: new Date().toISOString() }, { merge: true });
}

/** Phase A: Batch-Ergebnis des Vortags abholen und Gitter sicher erweitern. */
async function collectPendingBatch(pendingBatchId: string): Promise<TunerRunResult> {
  const db = getFirestore();
  const statsRef = db.doc('meta/forecastStats');
  const batch = await anthropicClient().messages.batches.retrieve(pendingBatchId);
  if (batch.processing_status !== 'ended') {
    logger.info(`Tuner-Batch ${pendingBatchId} läuft noch (${batch.processing_status})`);
    return { status: 'batch_pending', detail: pendingBatchId };
  }

  let outcome: TunerRunResult = { status: 'ai_error', detail: 'kein Ergebnis im Batch' };
  for await (const entry of await anthropicClient().messages.batches.results(pendingBatchId)) {
    if (entry.custom_id !== BATCH_CUSTOM_ID) continue;
    if (entry.result.type !== 'succeeded') {
      outcome = { status: 'ai_error', detail: `Batch-Ergebnis: ${entry.result.type}` };
      break;
    }
    const msg = entry.result.message;
    const text = msg.content
      .filter((b): b is Extract<(typeof msg.content)[number], { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const proposal = parseTunerResponse(text);
    if (!proposal) {
      outcome = { status: 'ai_error', detail: 'KI-Antwort nicht auswertbar' };
      break;
    }

    const statsSnap = await statsRef.get();
    const tuning = statsSnap.get('tuning') as
      | { extraLookbacks?: number[]; extraWeights?: number[] }
      | undefined;
    const { weightGrid, lookbackGrid } = mergeGrids(WEIGHT_GRID, LOOKBACK_GRID, tuning);
    const exp = clampGridProposals(proposal, lookbackGrid, weightGrid);
    if (exp.extraLookbacks.length > 0 || exp.extraWeights.length > 0) {
      const merged = mergeGrids(tuning?.extraWeights ?? [], tuning?.extraLookbacks ?? [], {
        extraWeights: exp.extraWeights,
        extraLookbacks: exp.extraLookbacks,
      });
      await statsRef.set(
        {
          tuning: {
            extraWeights: merged.weightGrid,
            extraLookbacks: merged.lookbackGrid,
            updatedAt: new Date().toISOString(),
          },
        },
        { merge: true },
      );
    }
    await recordReview({
      status: 'ok',
      diagnosis: proposal.diagnosis,
      suggestions: proposal.suggestions,
      applied: exp.applied,
      usedTokens: usageTokens(msg.usage),
      pendingBatchId: FieldValue.delete(),
    });
    logger.info(
      `Tuner-Review ok — ${exp.applied.length} Gitter-Erweiterung(en): ${exp.applied.join(', ') || 'keine'}`,
    );
    return { status: 'ok', detail: exp.applied.join(', ') };
  }

  await recordReview({ status: outcome.status, detail: outcome.detail, pendingBatchId: FieldValue.delete() });
  logger.warn(`Tuner-Review fehlgeschlagen: ${outcome.detail}`);
  return outcome;
}

/** Phase B: neuen Review-Batch einreichen (Budget-Guard inklusive). */
async function submitReviewBatch(): Promise<TunerRunResult> {
  const db = getFirestore();
  const statsSnap = await db.doc('meta/forecastStats').get();
  const scored = (statsSnap.get('scored') as number | undefined) ?? 0;
  if (scored < MIN_SCORED) {
    await recordReview({ status: 'waiting_for_data', scored });
    return { status: 'waiting_for_data', detail: `${scored}/${MIN_SCORED} Scores` };
  }
  if (!(await reserveAiBudget(EST_TUNER_TOKENS))) {
    logger.warn('Tuner-Review degradiert: Tages-Tokenbudget erschöpft (admin/aiBudget)');
    await recordReview({ status: 'budget_exceeded' });
    return { status: 'budget_exceeded' };
  }

  const combos = (statsSnap.get('combos') as Record<string, ComboStat> | undefined) ?? {};
  const dirAccuracy = (statsSnap.get('dirAccuracy') as number | null | undefined) ?? null;
  const best =
    (statsSnap.get('best') as { w: number; lookback: number } | undefined) ??
    { w: 0.5, lookback: 20 };
  const tuning = statsSnap.get('tuning') as
    | { extraLookbacks?: number[]; extraWeights?: number[] }
    | undefined;
  const { weightGrid, lookbackGrid } = mergeGrids(WEIGHT_GRID, LOOKBACK_GRID, tuning);

  const batch = await anthropicClient().messages.batches.create({
    requests: [
      {
        custom_id: BATCH_CUSTOM_ID,
        params: {
          model: SONNET_MODEL,
          max_tokens: 600,
          messages: [
            {
              role: 'user',
              content: buildTunerPrompt(
                summarizeStats(scored, dirAccuracy, best, combos),
                weightGrid,
                lookbackGrid,
              ),
            },
          ],
        },
      },
    ],
  });
  await recordReview({ status: 'batch_submitted', pendingBatchId: batch.id, scored });
  logger.info(`Tuner-Review-Batch eingereicht (${batch.id}, Batch API = 50 % Kosten)`);
  return { status: 'batch_submitted', detail: batch.id };
}

/** Ein Review-Zyklus: erst Vortags-Batch abholen, sonst neuen einreichen. */
export async function runTunerReview(): Promise<TunerRunResult> {
  if (!aiAvailable()) {
    logger.warn(
      'Tuner-Review degradiert: kein ANTHROPIC_API_KEY — empirisches Tuning läuft unverändert weiter.',
    );
    await recordReview({ status: 'ai_unavailable' });
    return { status: 'ai_unavailable' };
  }
  try {
    const tunerSnap = await getFirestore().doc('meta/tuner').get();
    const pending = tunerSnap.get('pendingBatchId') as string | undefined;
    if (pending) return await collectPendingBatch(pending);
    return await submitReviewBatch();
  } catch (err) {
    // API-Fehler (Auth, Netz, Rate-Limit) → sichtbar degradieren; das
    // empirische Tuning läuft unverändert weiter.
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`Tuner-Review degradiert (API-Fehler): ${detail}`);
    await recordReview({ status: 'ai_error', detail: detail.slice(0, 300) });
    return { status: 'ai_error', detail };
  }
}

/** Täglich 17:30 ET (nach evalForecasts 16:30), Mo–Fr. */
export const tunerReview = onSchedule(
  {
    schedule: '30 17 * * 1-5',
    timeZone: 'America/New_York',
    retryCount: 0,
    secrets: [anthropicApiKey],
  },
  async () => {
    await runTunerReview();
  },
);

/** Manueller Trigger — NUR im Emulator (Abnahme-Verifikation). */
export const tunerNow = onRequest(async (_req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'tunerNow ist nur im Emulator verfügbar' });
    return;
  }
  res.status(200).json(await runTunerReview());
});
