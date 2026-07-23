/**
 * Firestore-Security-Rules-Tests (MILESTONES M4) — laufen gegen den
 * Firestore-Emulator via `npm run test:rules` (firebase emulators:exec).
 *
 * Kernaussagen (ARCHITECTURE §5, nicht verhandelbar):
 * - wallet / positions / trades sind auch für den OWNER read-only —
 *   Schreiben geht ausschließlich über Functions (Admin SDK).
 * - users/{uid}: create verboten (macht ensureProfile), update nur aufs
 *   settings-Feld, fremde User nie lesbar.
 * - market/** nur eingeloggt lesbar, nie client-schreibbar; meta öffentlich.
 */

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it } from 'vitest';

let env: RulesTestEnvironment;

const rulesPath = join(dirname(fileURLToPath(import.meta.url)), '../firestore.rules');

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-rules',
    firestore: { rules: readFileSync(rulesPath, 'utf8') },
  });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('users/alice').set({
      profile: { plan: 'free' },
      settings: { strategy: { broker: { mode: 'paper' } } },
      wallet: { paperBalance: 25_000, currency: 'USD' },
    });
    await db.doc('users/alice/positions/AAPL').set({ qty: 3, avgEntry: 100 });
    await db.doc('users/alice/trades/t1').set({ symbol: 'AAPL', side: 'buy' });
    await db.doc('market/QQQ').set({ quote: { price: 600 } });
    await db.doc('market/QQQ/ai/2026-07-23').set({ summary: 'x', degraded: true });
    await db.doc('market/QQQ/forecasts/2026-07-23_0.5_20').set({ evaluated: false });
    await db.doc('meta/universe').set({ classes: {} });
    await db.doc('meta/forecastStats').set({ tuning: { extraWeights: [0.5] } });
    await db.doc('admin/aiBudget').set({ dailyTokenBudget: 200000, used: 0 });
  });
});

afterAll(async () => {
  await env.cleanup();
});

const alice = () => env.authenticatedContext('alice').firestore();
const bob = () => env.authenticatedContext('bob').firestore();
const anon = () => env.unauthenticatedContext().firestore();

describe('users/{uid}', () => {
  it('Owner liest sein Profil, Fremde nicht', async () => {
    await assertSucceeds(alice().doc('users/alice').get());
    await assertFails(bob().doc('users/alice').get());
  });

  it('create ist auch für den Owner verboten (macht ensureProfile)', async () => {
    await assertFails(bob().doc('users/bob').set({ settings: {} }));
  });

  it('Owner darf NUR settings ändern', async () => {
    await assertSucceeds(
      alice().doc('users/alice').update({ settings: { strategy: { broker: { mode: 'paper' } } } }),
    );
  });

  it('wallet-Manipulation wird abgelehnt — auch für den Owner', async () => {
    await assertFails(alice().doc('users/alice').update({ wallet: { paperBalance: 9_999_999 } }));
    await assertFails(
      alice().doc('users/alice').update({
        settings: { strategy: {} },
        wallet: { paperBalance: 9_999_999 },
      }),
    );
  });

  it('positions/trades: Owner liest, schreibt aber NIE', async () => {
    await assertSucceeds(alice().doc('users/alice/positions/AAPL').get());
    await assertSucceeds(alice().doc('users/alice/trades/t1').get());
    await assertFails(alice().doc('users/alice/positions/AAPL').set({ qty: 999 }));
    await assertFails(alice().doc('users/alice/positions/AAPL').delete());
    await assertFails(alice().doc('users/alice/trades/t2').set({ symbol: 'X' }));
    await assertFails(bob().doc('users/alice/positions/AAPL').get());
  });

  it('alerts gehören dem User komplett', async () => {
    await assertSucceeds(alice().doc('users/alice/alerts/a1').set({ symbol: 'QQQ', above: 700 }));
    await assertFails(bob().doc('users/alice/alerts/a2').set({ symbol: 'QQQ' }));
  });

  it('workspaces (M9) gehören dem User komplett, Fremde bleiben draußen', async () => {
    await assertSucceeds(
      alice().doc('users/alice/workspaces/default').set({ preset: 'ueberblick', panels: {} }),
    );
    await assertSucceeds(alice().doc('users/alice/workspaces/default').get());
    await assertFails(bob().doc('users/alice/workspaces/default').get());
    await assertFails(bob().doc('users/alice/workspaces/w2').set({ preset: 'x' }));
  });

  // ── Adversarial (M7): was kann ein böswilliger EINGELOGGTER User? ──
  it('profile-Manipulation (plan-Upgrade) wird abgelehnt — einzeln und gemischt', async () => {
    await assertFails(alice().doc('users/alice').update({ profile: { plan: 'pro' } }));
    await assertFails(
      alice().doc('users/alice').update({
        settings: { strategy: {} },
        profile: { plan: 'pro' },
      }),
    );
  });

  it('User-Doc löschen ist verboten (auch fürs eigene)', async () => {
    await assertFails(alice().doc('users/alice').delete());
  });

  it('Fremde Settings sind weder les- noch schreibbar', async () => {
    await assertFails(bob().doc('users/alice').update({ settings: { strategy: {} } }));
    await assertFails(bob().doc('users/alice/alerts/a1').get());
  });
});

describe('market/** und meta/**', () => {
  it('market: eingeloggt lesbar, anonym nicht, nie schreibbar', async () => {
    await assertSucceeds(alice().doc('market/QQQ').get());
    await assertFails(anon().doc('market/QQQ').get());
    await assertFails(alice().doc('market/QQQ').set({ quote: { price: 1 } }));
  });

  it('meta: öffentlich lesbar, nie schreibbar', async () => {
    await assertSucceeds(anon().doc('meta/universe').get());
    await assertFails(alice().doc('meta/universe').set({ classes: {} }));
  });

  it('KI-Docs (market/{sym}/ai) folgen den market-Regeln', async () => {
    await assertSucceeds(alice().doc('market/QQQ/ai/2026-07-23').get());
    await assertFails(anon().doc('market/QQQ/ai/2026-07-23').get());
    await assertFails(
      alice().doc('market/QQQ/ai/2026-07-23').set({ summary: 'Pump!', degraded: false }),
    );
  });

  it('Forecast-Manipulation (evaluated/Score fälschen) wird abgelehnt', async () => {
    await assertFails(
      alice().doc('market/QQQ/forecasts/2026-07-23_0.5_20').update({ evaluated: true, dirHit: true }),
    );
  });

  it('Tuning-Gitter in meta/forecastStats ist nicht client-schreibbar', async () => {
    await assertFails(
      alice().doc('meta/forecastStats').update({ tuning: { extraWeights: [999] } }),
    );
  });
});

describe('admin/**', () => {
  it('rein serverseitig — kein Client-Zugriff', async () => {
    await assertFails(alice().doc('admin/quotas-alice').get());
    await assertFails(alice().doc('admin/quotas-alice').set({ trades_x: 1 }));
  });
});
