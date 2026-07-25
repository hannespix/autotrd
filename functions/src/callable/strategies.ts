/**
 * Strategie-Studio-Callables (M10): users/{uid}/strategies/{id}.
 *
 * Client-Writes auf strategies/** sind per Rules verboten — ALLES läuft über
 * diese drei Callables, serverseitig validiert gegen shared/src/rules
 * (harte Guards: Tiefe ≤ 5, ≤ 25 Knoten, erreichbare Thresholds):
 *
 *   - saveStrategyDraft:      Entwurf anlegen/ändern (berührt `compiled` nie)
 *   - publishStrategyVersion: Entwurf einfrieren → compiled.version++
 *   - assignStrategy:         Paper-Zuordnung; je (User, Symbol) darf höchstens
 *                             EINE Strategie zugewiesen sein (transaktional)
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  allSymbols,
  validateStrategySpec,
  type StrategyDoc,
  type StrategySpec,
} from '../../../shared/src/index.js';
import { consumeQuota } from '../core/broker.js';
import { planPromotion } from '../core/rulesTrading.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';

const MAX_STRATEGIES = 10;
const MAX_NAME_LEN = 60;
const MAX_SYMBOLS = 12;
const DAILY_LIMIT = 300; // geteiltes Tageslimit für alle Studio-Aufrufe
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

async function requireUid(request: { auth?: { uid?: string } }): Promise<string> {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Anmeldung erforderlich');
  if (!(await consumeQuota(uid, 'strategyStudio', DAILY_LIMIT))) {
    throw new HttpsError('resource-exhausted', `Tageslimit von ${DAILY_LIMIT} Studio-Aufrufen erreicht`);
  }
  return uid;
}

function cleanName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.trim().length > MAX_NAME_LEN) {
    throw new HttpsError('invalid-argument', `name muss 1–${MAX_NAME_LEN} Zeichen haben`);
  }
  return raw.trim();
}

function cleanSpec(raw: unknown): StrategySpec {
  const problems = validateStrategySpec(raw);
  if (problems.length > 0) {
    throw new HttpsError('invalid-argument', problems.slice(0, 5).join(' · '));
  }
  return raw as StrategySpec;
}

function strategiesCol(uid: string) {
  return getFirestore().collection(`users/${uid}/strategies`);
}

export const saveStrategyDraft = onCall(CALLABLE_OPTS, async (request) => {
  const uid = await requireUid(request);
  const data = (request.data ?? {}) as { id?: unknown; name?: unknown; spec?: unknown };
  const name = cleanName(data.name);
  const spec = cleanSpec(data.spec);
  const now = new Date().toISOString();
  const col = strategiesCol(uid);

  if (data.id !== undefined) {
    if (typeof data.id !== 'string' || !ID_RE.test(data.id)) {
      throw new HttpsError('invalid-argument', 'Ungültige Strategie-ID');
    }
    const ref = col.doc(data.id);
    if (!(await ref.get()).exists) {
      throw new HttpsError('not-found', 'Strategie existiert nicht');
    }
    await ref.set({ name, draft: spec, updatedAt: now }, { merge: true });
    return { ok: true, id: data.id };
  }

  const count = (await col.count().get()).data().count;
  if (count >= MAX_STRATEGIES) {
    throw new HttpsError('resource-exhausted', `Maximal ${MAX_STRATEGIES} Strategien je Konto`);
  }
  const doc: StrategyDoc = {
    name,
    draft: spec,
    compiled: null,
    status: 'draft',
    symbols: [],
    createdAt: now,
    updatedAt: now,
  };
  const ref = await col.add(doc);
  return { ok: true, id: ref.id };
});

export const publishStrategyVersion = onCall(CALLABLE_OPTS, async (request) => {
  const uid = await requireUid(request);
  const { id } = (request.data ?? {}) as { id?: unknown };
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new HttpsError('invalid-argument', 'Ungültige Strategie-ID');
  }
  const ref = strategiesCol(uid).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Strategie existiert nicht');
  const doc = snap.data() as StrategyDoc;

  // Defense in depth: nie eine invalide Version einfrieren, egal was im
  // Entwurf steht (z. B. aus einer künftigen Migration).
  const spec = cleanSpec(doc.draft);
  const version = (doc.compiled?.version ?? 0) + 1;
  const now = new Date().toISOString();
  await ref.set(
    { compiled: { ...spec, version, publishedAt: now }, status: 'published', updatedAt: now },
    { merge: true },
  );
  return { ok: true, version };
});

export const assignStrategy = onCall(CALLABLE_OPTS, async (request) => {
  const uid = await requireUid(request);
  const data = (request.data ?? {}) as { id?: unknown; symbols?: unknown; mode?: unknown };
  // Modus (M11): paper handelt das echte Wallet, shadow ein virtuelles Konto.
  const mode: 'paper' | 'shadow' = data.mode === 'shadow' ? 'shadow' : 'paper';
  if (typeof data.id !== 'string' || !ID_RE.test(data.id)) {
    throw new HttpsError('invalid-argument', 'Ungültige Strategie-ID');
  }
  const id = data.id;
  if (
    !Array.isArray(data.symbols) ||
    data.symbols.length > MAX_SYMBOLS ||
    !data.symbols.every((s) => typeof s === 'string')
  ) {
    throw new HttpsError('invalid-argument', `symbols muss ein Array aus max. ${MAX_SYMBOLS} Symbolen sein`);
  }
  const symbols = [...new Set(data.symbols as string[])];
  const catalog = new Set(allSymbols());
  const unknown = symbols.filter((s) => !catalog.has(s));
  if (unknown.length > 0) {
    throw new HttpsError('invalid-argument', `Unbekannte Symbole: ${unknown.join(', ')}`);
  }

  const col = strategiesCol(uid);
  await getFirestore().runTransaction(async (tx) => {
    const all = await tx.get(col);
    const target = all.docs.find((d) => d.id === id);
    if (!target) throw new HttpsError('not-found', 'Strategie existiert nicht');
    const targetDoc = target.data() as StrategyDoc;
    if (symbols.length > 0 && !targetDoc.compiled) {
      throw new HttpsError('failed-precondition', 'Erst publizieren — nur publizierte Strategien handeln');
    }
    // Höchstens EINE PAPER-Strategie je (User, Symbol) — sonst würden zwei
    // Bäume dasselbe Wallet gegeneinander handeln. Shadow beobachtet nur und
    // darf parallel laufen (A/B: paper vs. shadow auf demselben Symbol).
    if (mode === 'paper') {
      for (const other of all.docs) {
        if (other.id === id) continue;
        const otherDoc = other.data() as StrategyDoc;
        if ((otherDoc.mode ?? 'paper') !== 'paper') continue;
        const clash = symbols.filter((s) => (otherDoc.symbols ?? []).includes(s));
        if (clash.length > 0) {
          throw new HttpsError(
            'failed-precondition',
            `${clash.join(', ')} ist bereits „${otherDoc.name}" zugewiesen — erst dort entfernen`,
          );
        }
      }
    }
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { symbols, mode, updatedAt: now };
    // Shadow-Konto beim Einschalten frisch anlegen (Startbalance wie Paper-
    // Default); beim Zurückschalten bleibt es als Historie stehen.
    if (mode === 'shadow' && !(targetDoc as StrategyDoc).shadow) {
      patch.shadow = {
        balance: 25_000,
        positions: {},
        equity: 25_000,
        startedAt: now,
        updatedAt: now,
      };
    }
    tx.set(target.ref, patch, { merge: true });
  });
  return { ok: true, symbols };
});

/**
 * Befördern (M11 A/B): transaktionaler Rollentausch — die Shadow-Strategie
 * wird paper (handelt ab dem nächsten Scan das echte Paper-Wallet), jede
 * überlappende Paper-Strategie wird shadow und beobachtet mit frischem
 * virtuellen Konto weiter. Das Wallet des Users wird dabei NICHT angefasst;
 * offene echte Positionen laufen unter der neuen Paper-Strategie weiter
 * (Stop-Loss/Take-Profit greifen unabhängig von der Strategie-Zuordnung).
 */
export const promoteStrategy = onCall(CALLABLE_OPTS, async (request) => {
  const uid = await requireUid(request);
  const data = (request.data ?? {}) as { id?: unknown };
  if (typeof data.id !== 'string' || !ID_RE.test(data.id)) {
    throw new HttpsError('invalid-argument', 'Ungültige Strategie-ID');
  }
  const id = data.id;
  const col = strategiesCol(uid);
  let demoted: string[] = [];
  await getFirestore().runTransaction(async (tx) => {
    const all = await tx.get(col);
    const candidates = all.docs.map((d) => {
      const doc = d.data() as StrategyDoc;
      return {
        id: d.id,
        status: doc.status ?? 'draft',
        mode: (doc.mode ?? 'paper') as 'paper' | 'shadow',
        symbols: doc.symbols ?? [],
      };
    });
    let plan: { demote: string[] };
    try {
      plan = planPromotion(candidates, id);
    } catch (e) {
      throw new HttpsError('failed-precondition', (e as Error).message);
    }
    demoted = plan.demote;
    const now = new Date().toISOString();
    const targetRef = col.doc(id);
    // Ziel wird paper: Shadow-Historie bleibt eingefroren stehen, lastDirs
    // startet leer (Paper-Pfad nutzt sie nicht).
    tx.set(targetRef, { mode: 'paper', promotedAt: now, updatedAt: now, lastDirs: {} }, { merge: true });
    for (const demoteId of plan.demote) {
      tx.set(
        col.doc(demoteId),
        {
          mode: 'shadow',
          demotedAt: now,
          updatedAt: now,
          lastDirs: {},
          shadow: { balance: 25_000, positions: {}, equity: 25_000, startedAt: now, updatedAt: now },
        },
        { merge: true },
      );
    }
  });
  return { ok: true, demoted };
});
