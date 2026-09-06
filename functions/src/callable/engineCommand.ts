/**
 * engineCommand — halt · resume · flatten für die Engine des Nutzers.
 *
 * Das Callable FÜHRT nichts aus; es hinterlegt das Kommando in
 * `users/{uid}/private/engineCommands` (Merge), und der nächste Engine-Takt
 * beansprucht und verarbeitet es (`engine/commands.ts`). Sperren löst man
 * über die Ursache (CLAUDE.md §0.5): `resume` hebt einen Tages-Halt nie auf,
 * einen Drawdown-Halt nur mit `ackDrawdown: true` — und das prüft der Takt,
 * nicht der Client.
 *
 * Zusätzlich stempelt es `engine.commandAt` ans User-Dokument, damit der Takt
 * bei geschlossenem Markt weiß, dass für diesen Nutzer etwas ansteht.
 */
import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { accessDeniedReason, accessLevelOfSnap, mayTradeSnap } from '../core/access.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';
import { commandPatch, commandsPath, parseCommandRequest, type CommandAction } from '../engine/commands.js';

export interface EngineCommandErgebnis {
  ok: true;
  action: CommandAction;
  /** Wann das Kommando hinterlegt wurde (ISO). Wirksam wird es im nächsten Takt. */
  at: string;
}

export const engineCommand = onCall(CALLABLE_OPTS, async (request): Promise<EngineCommandErgebnis> => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'srv.anmeldungErforderlich');

  const db = getFirestore();
  const userRef = db.doc(`users/${uid}`);
  const snap = await userRef.get();
  if (!mayTradeSnap(snap)) throw new HttpsError('permission-denied', accessDeniedReason(accessLevelOfSnap(snap)));

  let req;
  try {
    req = parseCommandRequest(request.data);
  } catch (e) {
    throw new HttpsError('invalid-argument', e instanceof Error ? e.message : 'Kommando ungültig');
  }

  const now = Date.now();
  const at = new Date(now).toISOString();
  await db.doc(commandsPath(uid)).set(commandPatch(req, now), { merge: true });
  await userRef.set({ engine: { commandAt: at } }, { merge: true });
  logger.info(`engineCommand ${uid}: ${req.action}${req.reason ? ` (${req.reason})` : ''}`);
  return { ok: true, action: req.action, at };
});
