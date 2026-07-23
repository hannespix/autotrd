/**
 * KI-Staffel — Port der Idee aus reference/scripts/ai_analyst.py auf das
 * Anthropic TS-SDK (ARCHITECTURE §6): tokeneffizient, gestaffelt, zentral.
 *
 * Stufe 0 (kostenlos): Lexikon-Sentiment (shared/sentiment) — läuft immer.
 * Stufe 1 (Haiku):     Klassifikation der Tages-Schlagzeilen in Event-Tags.
 * Stufe 2 (Sonnet):    Tages-Erklärung „Warum bewegt sich X?“ in EINEM Satz.
 *
 * Cache-Disziplin: market/{sym}/ai/{date} — 1 API-Call-Paar für ALLE User;
 * jeder weitere Abruf ist ein reiner Firestore-Read (Abnahme M6).
 *
 * Kosten-Guard: admin/aiBudget hält ein Tages-Tokenbudget (Config-Feld
 * `dailyTokenBudget`). Bei Überschreitung — genau wie bei fehlendem Key oder
 * API-Fehler — degradiert die Pipeline SICHTBAR auf die regelbasierte
 * Zusammenfassung (logger.warn + `degraded: true` im Doc); Scan, Sentiment
 * und Prognose laufen davon unberührt weiter.
 */

import Anthropic from '@anthropic-ai/sdk';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import type { NewsItem } from './news.js';

/** Secret-Binding für Functions, die KI nutzen (Owner: SETUP.md §KI). */
export const anthropicApiKey: ReturnType<typeof defineSecret> = defineSecret('ANTHROPIC_API_KEY');

// Modell-Staffel laut ARCHITECTURE §6: Haiku für Routine, Sonnet on-demand.
export const HAIKU_MODEL = 'claude-haiku-4-5';
export const SONNET_MODEL = 'claude-sonnet-5';

export const DEFAULT_DAILY_TOKEN_BUDGET = 200_000;
/** Grobe Reservierung je Tages-Doc (Haiku- + Sonnet-Call). */
export const EST_TOKENS_PER_AI_DAY = 2_500;

export function aiAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

let _client: Anthropic | null = null;

/** SDK-Client lazy — liest ANTHROPIC_API_KEY erst beim ersten Call aus env. */
export function anthropicClient(): Anthropic {
  _client ??= new Anthropic();
  return _client;
}

// ── Kosten-Guard (admin/aiBudget) ────────────────────────────────────────────

/**
 * Tokens gegen das Tagesbudget reservieren. Transaktional; der Tageswechsel
 * setzt den Zähler zurück, das Budget selbst ist ein Config-Feld und bleibt.
 */
export async function reserveAiBudget(estTokens: number): Promise<boolean> {
  const ref = getFirestore().doc('admin/aiBudget');
  const today = new Date().toISOString().slice(0, 10);
  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const budget =
      (snap.get('dailyTokenBudget') as number | undefined) ?? DEFAULT_DAILY_TOKEN_BUDGET;
    const used = snap.get('date') === today ? ((snap.get('used') as number | undefined) ?? 0) : 0;
    if (used + estTokens > budget) {
      tx.set(
        ref,
        { date: today, used, dailyTokenBudget: budget, lastDeniedAt: new Date().toISOString() },
        { merge: true },
      );
      return false;
    }
    tx.set(ref, { date: today, used: used + estTokens, dailyTokenBudget: budget }, { merge: true });
    return true;
  });
}

/** Reservierung durch den tatsächlichen Verbrauch ersetzen (Delta-Update). */
export async function settleAiBudget(estTokens: number, actualTokens: number): Promise<void> {
  await getFirestore()
    .doc('admin/aiBudget')
    .set({ used: FieldValue.increment(actualTokens - estTokens) }, { merge: true });
}

/**
 * Kostenrelevante Token einer Antwort: Input + Output + Cache-Aufbau voll,
 * Cache-Reads mit 10 % (so bepreist sie die API).
 */
export function usageTokens(u?: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): number {
  if (!u) return 0;
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    Math.ceil((u.cache_read_input_tokens ?? 0) * 0.1)
  );
}

// ── Parsing & regelbasierter Fallback ────────────────────────────────────────

/** Erstes {...}-JSON aus einer Modell-Antwort ziehen (Port von _parse_json). */
export function extractJson(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const parsed: unknown = JSON.parse(m[0]);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Gewicht wie im Event-Ranking: |Sentiment| + Magnitude. */
function headlineWeight(item: NewsItem): number {
  return Math.abs(item.sent.sentiment) + item.sent.magnitude;
}

/**
 * Stufe-0-Fallback: auffälligste Schlagzeile nach Lexikon-Gewicht — genutzt,
 * wann immer die KI nicht verfügbar ist (kein Key, Budget, Fehler).
 */
export function ruleBasedDaySummary(items: NewsItem[]): { summary: string; headline: string | null } {
  if (items.length === 0) return { summary: 'Keine Schlagzeilen für diesen Tag.', headline: null };
  const top = [...items].sort((a, b) => headlineWeight(b) - headlineWeight(a))[0]!;
  const tone =
    top.sent.sentiment > 0.05 ? 'positiv' : top.sent.sentiment < -0.05 ? 'negativ' : 'neutral';
  return {
    summary: `Auffälligste Schlagzeile (${tone}): „${top.title}“ (${top.source}).`,
    headline: top.title,
  };
}

// ── Prompts ──────────────────────────────────────────────────────────────────
// Die System-Prompts sind bewusst STABIL formuliert und mit cache_control
// (ephemeral) markiert: Prompt-Caching greift, sobald der Prefix das
// Modell-Minimum (~1024–2048 Tokens) erreicht — der Marker ist bis dahin ein
// No-Op, kostet nichts und hält die Cache-Disziplin fest (ARCHITECTURE §6).

const CLASSIFY_SYSTEM =
  'Du bist ein präziser Finanznachrichten-Klassifikator für eine Trading-Plattform. ' +
  'Du ordnest Schlagzeilen eines Handelstags in Event-Typen ein: earnings, guidance, ' +
  'analyst, ma (Merger/Übernahme), regulatory, legal, macro, product, dividend, ' +
  'insider, other. Du antwortest AUSSCHLIESSLICH mit kompaktem JSON, ohne weitere Worte.';

const EXPLAIN_SYSTEM =
  'Du bist ein nüchterner Börsenanalyst für eine Trading-Plattform. Du erklärst die ' +
  'Tagesbewegung eines Symbols anhand der Schlagzeilen in EINEM sachlichen deutschen ' +
  'Satz (max. 25 Worte) und antwortest AUSSCHLIESSLICH mit kompaktem JSON, ohne weitere Worte.';

function cachedSystem(text: string): Array<{
  type: 'text';
  text: string;
  cache_control: { type: 'ephemeral' };
}> {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

async function messageText(params: {
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
}): Promise<{ text: string; tokens: number }> {
  const res = await anthropicClient().messages.create({
    model: params.model,
    max_tokens: params.maxTokens,
    system: cachedSystem(params.system),
    messages: [{ role: 'user', content: params.prompt }],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { text, tokens: usageTokens(res.usage) };
}

// ── Tages-Doc (market/{sym}/ai/{date}) ───────────────────────────────────────

export interface AiDayDoc {
  date: string;
  /** Ein deutscher Satz — KI (Sonnet) oder regelbasierter Fallback. */
  summary: string;
  cause: string | null;
  confidence: number | null;
  /** Haiku-Klassifikation der Tages-Schlagzeilen. */
  tags: Array<{ type: string; count: number }>;
  relevance: number | null;
  /** Genutzte Modelle; null = regelbasiert. */
  model: string | null;
  degraded: boolean;
  reason: 'no_api_key' | 'budget_exceeded' | 'ai_error' | null;
  usedTokens: number;
  at: string;
}

function degradedDoc(
  date: string,
  items: NewsItem[],
  reason: NonNullable<AiDayDoc['reason']>,
  usedTokens = 0,
): AiDayDoc {
  const rb = ruleBasedDaySummary(items);
  return {
    date,
    summary: rb.summary,
    cause: null,
    confidence: null,
    tags: [],
    relevance: null,
    model: null,
    degraded: true,
    reason,
    usedTokens,
    at: new Date().toISOString(),
  };
}

function parseTags(data: Record<string, unknown> | null): {
  tags: AiDayDoc['tags'];
  relevance: number | null;
} {
  const tags: AiDayDoc['tags'] = [];
  if (data && Array.isArray(data.tags)) {
    for (const t of data.tags as unknown[]) {
      if (typeof t !== 'object' || t === null) continue;
      const rec = t as Record<string, unknown>;
      if (typeof rec.type === 'string' && rec.type) {
        tags.push({
          type: rec.type.slice(0, 24),
          count: typeof rec.count === 'number' ? Math.max(1, Math.round(rec.count)) : 1,
        });
      }
    }
  }
  const relevance =
    data && typeof data.relevance === 'number'
      ? Math.min(1, Math.max(0, data.relevance))
      : null;
  return { tags: tags.slice(0, 8), relevance };
}

/**
 * KI-Tages-Doc holen oder EINMAL erzeugen. Cache-Hit = reiner Firestore-Read.
 * Wirft nie — jeder Fehlerpfad liefert ein sichtbar degradiertes Doc.
 */
export async function ensureAiDay(
  symbol: string,
  date: string,
  items: NewsItem[],
  movePct: number | null,
): Promise<{ doc: AiDayDoc; cached: boolean } | null> {
  if (items.length === 0) return null;
  const ref = getFirestore().collection('market').doc(symbol).collection('ai').doc(date);
  const existing = await ref.get();
  if (existing.exists) return { doc: existing.data() as AiDayDoc, cached: true };

  let doc: AiDayDoc;
  if (!aiAvailable()) {
    logger.warn(
      `KI degradiert (kein ANTHROPIC_API_KEY) — regelbasierte Zusammenfassung für ${symbol} ${date}`,
    );
    doc = degradedDoc(date, items, 'no_api_key');
  } else if (!(await reserveAiBudget(EST_TOKENS_PER_AI_DAY))) {
    logger.warn(
      `KI degradiert (Tages-Tokenbudget erschöpft, admin/aiBudget) — regelbasiert für ${symbol} ${date}`,
    );
    doc = degradedDoc(date, items, 'budget_exceeded');
  } else {
    let spent = 0;
    try {
      const ranked = [...items].sort((a, b) => headlineWeight(b) - headlineWeight(a));
      const lines = ranked
        .slice(0, 10)
        .map((i, idx) => `${idx}. [${i.source}] ${i.title}`)
        .join('\n');

      // Stufe 1 — Haiku: Event-Klassifikation
      const cls = await messageText({
        model: HAIKU_MODEL,
        system: CLASSIFY_SYSTEM,
        maxTokens: 300,
        prompt:
          `Schlagzeilen für ${symbol} am ${date}:\n\n${lines}\n\n` +
          'Klassifiziere den Tag. JSON-Format:\n' +
          '{"tags": [{"type": "<event-typ>", "count": <anzahl>}], "relevance": <0.0-1.0>}',
      });
      spent += cls.tokens;
      const { tags, relevance } = parseTags(extractJson(cls.text));

      // Stufe 2 — Sonnet: Tages-Erklärung (Port von _DAY_PROMPT)
      const moveCtx =
        typeof movePct === 'number' && Number.isFinite(movePct)
          ? `bewegte sich der Kurs um ${movePct >= 0 ? '+' : ''}${movePct.toFixed(1)} %`
          : 'lauteten die Schlagzeilen wie folgt';
      const tagCtx = tags.length
        ? ` Erkannte Event-Typen: ${tags.map((t) => t.type).join(', ')}.`
        : '';
      const exp = await messageText({
        model: SONNET_MODEL,
        system: EXPLAIN_SYSTEM,
        maxTokens: 200,
        prompt:
          `Für ${symbol} am ${date} ${moveCtx}.${tagCtx} Schlagzeilen:\n\n` +
          ranked.slice(0, 8).map((i) => `- ${i.title}`).join('\n') +
          '\n\nJSON-Format:\n' +
          '{"summary": "<ein Satz>", "cause": "<Ursache in 3-6 Worten>", "confidence": <0.0-1.0>}',
      });
      spent += exp.tokens;
      const data = extractJson(exp.text);
      const summary = typeof data?.summary === 'string' ? data.summary.slice(0, 220) : '';
      if (!summary) throw new Error('KI-Antwort ohne summary');

      doc = {
        date,
        summary,
        cause: typeof data?.cause === 'string' ? data.cause.slice(0, 80) : null,
        confidence:
          typeof data?.confidence === 'number'
            ? Math.min(1, Math.max(0, data.confidence))
            : null,
        tags,
        relevance,
        model: `${HAIKU_MODEL}+${SONNET_MODEL}`,
        degraded: false,
        reason: null,
        usedTokens: spent,
        at: new Date().toISOString(),
      };
    } catch (err) {
      logger.warn(`KI degradiert (API-Fehler) — regelbasiert für ${symbol} ${date}`, err);
      doc = degradedDoc(date, items, 'ai_error', spent);
    }
    await settleAiBudget(EST_TOKENS_PER_AI_DAY, spent);
  }

  await ref.set(doc);
  return { doc, cached: false };
}
