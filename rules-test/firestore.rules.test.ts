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
    await db.doc('users/alice/journal/t1').set({
      symbol: 'AAPL',
      side: 'buy',
      art: 'entry',
      qty: 3,
      price: 100,
      signalContext: { typ: 'konfluenz', konfluenz: 2 },
    });
    await db.doc('users/alice/strategies/s1/runs/r1').set({ totalReturnPct: 4.2 });
    await db.doc('users/alice/predictions/QQQ').set({ targetPrice: 620, confidence: 2 });
    await db.doc('users/alice/strategies/s1/shadowSignals/sig1').set({ direction: 'buy' });
    await db.doc('users/alice/strategies/s1').set({
      name: 'RSI-Dip',
      status: 'draft',
      symbols: [],
      draft: { buy: { type: 'compare', left: 'rsi', op: 'lt', right: 30 } },
    });
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

  /* Audit-Befund 11.08.: Die Regel prüfte nur, DASS ausschließlich `settings`
   * betroffen ist — nicht, WAS darin steht. `affectedKeys()` sieht die
   * Top-Level-Schlüssel; alles unterhalb war frei.
   *
   * Damit war `settings.strategy` direkt beschreibbar, und `saveStrategy`
   * wurde zur Empfehlung statt zur Pflicht. Das Callable ist die einzige
   * Stelle, die Schema, Watchlist-Länge, Katalog-Zugehörigkeit, `broker.mode`
   * und die E-Mail-Bestätigung prüft.
   *
   * Der ALTE Test an dieser Stelle hielt genau das falsche Verhalten fest —
   * er behauptete „Owner darf NUR settings ändern" und belegte mit
   * `settings.strategy` das Gegenteil dessen, was er meinte. Dieselbe Lehre
   * wie bei den Alpaca-Symbolen am 11.08.: Ein eigener Test kann eine falsche
   * Regel zementieren.
   *
   * Jeder Test stellt seinen Ausgangszustand selbst her — sonst hinge das
   * Ergebnis an der Reihenfolge, in der vitest die Fälle abarbeitet. */
  describe('settings: nur Präferenzen, Strategie nur über saveStrategy', () => {
    const grundzustand = async (): Promise<void> => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('users/alice').set({
          profile: { plan: 'free' },
          settings: {
            strategy: { broker: { mode: 'paper' }, watchlist: ['QQQ'] },
            ui: { theme: 'dark' },
          },
          wallet: { paperBalance: 25_000, currency: 'USD' },
        });
      });
    };

    it('UI-Präferenzen darf der Client selbst setzen', async () => {
      await grundzustand();
      await assertSucceeds(
        alice().doc('users/alice').update({ 'settings.ui': { theme: 'light' } }),
      );
    });

    it('den Auto-Tuner-Schalter auch', async () => {
      await grundzustand();
      await assertSucceeds(alice().doc('users/alice').update({ 'settings.autoTune': false }));
      await assertSucceeds(alice().doc('users/alice').update({ 'settings.hotkeys': { buy: 'b' } }));
    });

    it('mehrere Präferenzfelder in einem Schreibvorgang gehen auch', async () => {
      await grundzustand();
      await assertSucceeds(
        alice()
          .doc('users/alice')
          .update({ 'settings.ui': { theme: 'light' }, 'settings.autoTune': true }),
      );
    });

    it('die STRATEGIE nicht — sie muss durch saveStrategy', async () => {
      await grundzustand();
      await assertFails(
        alice().doc('users/alice').update({ 'settings.strategy': { broker: { mode: 'paper' } } }),
      );
    });

    it('auch nicht ein einzelnes Strategie-Feld', async () => {
      await grundzustand();
      // Die konkreten Umgehungen, die der Befund benannt hat:
      // Engine ohne bestätigte E-Mail starten …
      await assertFails(
        alice().doc('users/alice').update({ 'settings.strategy.engine.running': true }),
      );
      // … die Watchlist über MAX_WATCHLIST hinaus füllen (der Scan liest sie
      // roh und bedient sie VOR Ranking und Katalog) …
      await assertFails(
        alice()
          .doc('users/alice')
          .update({ 'settings.strategy.watchlist': Array.from({ length: 500 }, () => 'QQQ') }),
      );
      // … oder Echtgeld anfordern. (Das Doppelschloss aus ALPACA_ALLOW_LIVE
      // und Live-Reife hielte auch so — aber die Anforderung gehört gar nicht
      // erst ins Dokument.)
      await assertFails(
        alice().doc('users/alice').update({ 'settings.strategy.broker.mode': 'live' }),
      );
    });

    it('ein erlaubtes Feld deckt kein verbotenes mit ab', async () => {
      await grundzustand();
      // Der Versuch, die Strategie im Windschatten einer UI-Änderung
      // mitzuschreiben. `hasOnly` muss für ALLE geänderten Schlüssel gelten.
      await assertFails(
        alice()
          .doc('users/alice')
          .update({ 'settings.ui': { theme: 'light' }, 'settings.strategy.engine.running': true }),
      );
    });

    it('settings komplett ersetzen ist verboten — das löschte die Strategie', async () => {
      await grundzustand();
      // Ein Objekt-Update ersetzt das ganze Feld: `strategy` verschwände.
      // Für die Regel ist das eine Änderung an `strategy` wie jede andere.
      await assertFails(alice().doc('users/alice').update({ settings: { ui: { theme: 'x' } } }));
    });

    it('ein Profil ohne settings-Feld kann Präferenzen anlegen', async () => {
      // Randfall des Fixes: `resource.data.get('settings', {})` muss den
      // Erstschreibvorgang tragen, sonst könnte ein frisch angelegtes Profil
      // seine Oberfläche nie einstellen.
      await env.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('users/carol').set({ profile: { plan: 'free' } });
      });
      const carol = env.authenticatedContext('carol').firestore();
      await assertSucceeds(carol.doc('users/carol').update({ 'settings.ui': { theme: 'dark' } }));
    });
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

  it('strategies (M10): Owner liest, aber NIEMAND schreibt clientseitig', async () => {
    await assertSucceeds(alice().doc('users/alice/strategies/s1').get());
    await assertFails(bob().doc('users/alice/strategies/s1').get());
    // Auch der Owner darf nicht schreiben — nur die Studio-Callables.
    await assertFails(alice().doc('users/alice/strategies/s1').update({ name: 'hack' }));
    await assertFails(alice().doc('users/alice/strategies/s2').set({ name: 'neu', status: 'draft' }));
    await assertFails(alice().doc('users/alice/strategies/s1').delete());
    await assertFails(
      alice().doc('users/alice/strategies/s1').update({ symbols: ['QQQ', 'AAPL'] }),
    );
    // Backtest-Reports (M11): Owner liest, niemand schreibt clientseitig
    await assertSucceeds(alice().doc('users/alice/strategies/s1/runs/r1').get());
    await assertFails(bob().doc('users/alice/strategies/s1/runs/r1').get());
    await assertFails(alice().doc('users/alice/strategies/s1/runs/r2').set({ totalReturnPct: 99 }));
    // Shadow-Signale (M11): gleiche Disziplin
    await assertSucceeds(alice().doc('users/alice/strategies/s1/shadowSignals/sig1').get());
    await assertFails(bob().doc('users/alice/strategies/s1/shadowSignals/sig1').get());
    await assertFails(alice().doc('users/alice/strategies/s1/shadowSignals/sig2').set({ direction: 'buy' }));
    // User-Prognosen (Chart-Pfeile): read-only, Schreiben nur via savePrediction
    await assertSucceeds(alice().doc('users/alice/predictions/QQQ').get());
    await assertFails(bob().doc('users/alice/predictions/QQQ').get());
    await assertFails(alice().doc('users/alice/predictions/QQQ').set({ targetPrice: 9999, confidence: 3 }));
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

describe('Auto-Tuner (MT)', () => {
  it('Owner darf sein Journal und seine Schattenkonten lesen', async () => {
    await assertSucceeds(alice().doc('users/alice/tuneLog/2026-07-27T17_45_minHoldMin=120').get());
    await assertSucceeds(alice().doc('users/alice/tuning/fleet').get());
  });

  it('aber NICHT schreiben — sonst ließe sich eine Beförderung erfinden', async () => {
    // Ein Client, der sein eigenes Journal schreiben dürfte, könnte eine
    // Änderung samt Begründung frei erfinden; die Nachvollziehbarkeit wäre
    // damit wertlos. Und ein selbst gefülltes Schattenkonto würde den Tuner
    // zu einer Beförderung überreden, die keine Evidenz hat.
    await assertFails(
      alice().doc('users/alice/tuneLog/gefaelscht').set({ promoted: true, reason: 'weil ich es sage' }),
    );
    await assertFails(
      alice().doc('users/alice/tuning/fleet').set({ variants: { 'minHoldMin=120': { pnls: [999] } } }),
    );
  });

  it('Fremde Journale bleiben unsichtbar', async () => {
    await assertFails(alice().doc('users/bob/tuneLog/irgendwas').get());
    await assertFails(alice().doc('users/bob/tuning/fleet').get());
  });
});

describe('Trade-Journal (M12)', () => {
  it('Owner liest, Fremde nicht', async () => {
    await assertSucceeds(alice().doc('users/alice/journal/t1').get());
    await assertFails(bob().doc('users/alice/journal/t1').get());
  });

  it('Review-Felder darf der Owner ändern — und NUR die', async () => {
    await assertSucceeds(
      alice()
        .doc('users/alice/journal/t1')
        .update({ review: 'B', notes: 'Einstieg zu früh', tags: ['fomo'], mistakes: ['gegen_trend'] }),
    );
  });

  it('Fakten-Manipulation wird abgelehnt — auch gemischt mit erlaubten Feldern', async () => {
    // Ein Journal, dessen P&L oder Signal-Kontext der User editieren kann,
    // wäre als Lernwerkzeug wertlos: Die Review-Felder bewerten die Fakten,
    // sie ersetzen sie nicht.
    await assertFails(alice().doc('users/alice/journal/t1').update({ pnl: 9_999 }));
    await assertFails(
      alice().doc('users/alice/journal/t1').update({ review: 'A', price: 1 }),
    );
    await assertFails(
      alice().doc('users/alice/journal/t1').update({ signalContext: { typ: 'erfunden' } }),
    );
  });

  it('create/delete bleiben dem Server vorbehalten', async () => {
    await assertFails(
      alice().doc('users/alice/journal/erfunden').set({ symbol: 'X', art: 'entry' }),
    );
    await assertFails(alice().doc('users/alice/journal/t1').delete());
  });
});

describe('admin/**', () => {
  it('rein serverseitig — kein Client-Zugriff', async () => {
    await assertFails(alice().doc('admin/quotas-alice').get());
    await assertFails(alice().doc('admin/quotas-alice').set({ trades_x: 1 }));
  });
});
