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
  const data = (request.data ?? {}) as { id?: unknown; symbols?: unknown };
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
    // Höchstens EINE Paper-Strategie je (User, Symbol) — sonst würden zwei
    // Bäume dasselbe Wallet gegeneinander handeln.
    for (const other of all.docs) {
      if (other.id === id) continue;
      const otherDoc = other.data() as StrategyDoc;
      const clash = symbols.filter((s) => (otherDoc.symbols ?? []).includes(s));
      if (clash.length > 0) {
        throw new HttpsError(
          'failed-precondition',
          `${clash.join(', ')} ist bereits „${otherDoc.name}" zugewiesen — erst dort entfernen`,
        );
      }
    }
    tx.set(target.ref, { symbols, updatedAt: new Date().toISOString() }, { merge: true });
  });
  return { ok: true, symbols };
});
