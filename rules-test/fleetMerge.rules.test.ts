/**
 * Audit-Befund 11.08. (B3): Das Aufräumen der Schatten-Flotte wirkte nicht.
 *
 * ── Warum dieser Test am Emulator hängt und nicht in `functions/test/` ────
 *
 * Der Fix in `scanMarket.fleetSchreibfeld` beruht auf einer Annahme über
 * FIRESTORE, nicht über unseren Code:
 *
 *   1. `set({ variants: {…} }, { merge: true })` merged Maps FELDWEISE —
 *      ein Schlüssel, der im geschriebenen Objekt fehlt, bleibt stehen.
 *   2. Ein `FieldValue.delete()`-Sentinel INNERHALB der verschachtelten Map
 *      entfernt genau diesen einen Schlüssel.
 *
 * Beides ließe sich mit einer Firestore-Attrappe „belegen" — und der Beleg
 * wäre wertlos: Er prüfte dann meine Vorstellung von Firestore, nicht
 * Firestore. Genau die Fehlerfamilie, die diesen Befund erst erzeugt hat.
 * Also gegen den echten Emulator.
 *
 * Punkt 1 ist der Befund selbst: Ohne den Sentinel bleibt jede je gefahrene
 * Variante mit bis zu 400 `pnls` plus Buch im Dokument liegen, bis die
 * 1-MB-Grenze reißt. Der Schreibfehler wird im Scan als `logger.warn`
 * geschluckt — die Selbstoptimierung des Kontos stünde ab da still, ohne
 * dass eine Kennzahl es zeigt. Deshalb steht er hier als eigener Test:
 * Sollte Firestore diese Semantik je ändern, muss man es HIER merken und
 * nicht an einem vollen Dokument in Produktion.
 */
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteField, doc, getDoc, setDoc } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let env: RulesTestEnvironment;
const rulesPath = join(dirname(fileURLToPath(import.meta.url)), '../firestore.rules');

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-rules',
    firestore: { rules: readFileSync(rulesPath, 'utf8') },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

/** Zwei Varianten anlegen und den Pfad zurückgeben. */
const vorbereiten = async (
  name: string,
): Promise<{ pfad: string; lesen: () => Promise<Record<string, unknown>> }> => {
  const pfad = `users/fleet-${name}/tuning/fleet`;
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), pfad), {
      variants: {
        alt: { book: { cash: 1000 }, pnls: [1, 2] },
        neu: { book: { cash: 2000 }, pnls: [3] },
      },
      updatedAt: '2026-08-11T00:00:00Z',
    });
  });
  return {
    pfad,
    lesen: async () => {
      let daten: Record<string, unknown> = {};
      await env.withSecurityRulesDisabled(async (ctx) => {
        const snap = await getDoc(doc(ctx.firestore(), pfad));
        daten = (snap.data()?.['variants'] ?? {}) as Record<string, unknown>;
      });
      return daten;
    },
  };
};

describe('Firestore-Semantik, auf der fleetSchreibfeld beruht', () => {
  it('merge lässt einen weggelassenen Schlüssel STEHEN — das war der Befund', async () => {
    const { pfad, lesen } = await vorbereiten('ohne');
    await env.withSecurityRulesDisabled(async (ctx) => {
      // Genau das tat der alte Code: `state` enthält „alt" nicht mehr.
      await setDoc(
        doc(ctx.firestore(), pfad),
        { variants: { neu: { book: { cash: 2500 }, pnls: [3, 4] } } },
        { merge: true },
      );
    });
    const nachher = await lesen();
    expect(Object.keys(nachher).sort()).toEqual(['alt', 'neu']);
    // Und der Ballast ist vollständig da, nicht etwa geleert.
    expect((nachher['alt'] as { pnls: number[] }).pnls).toEqual([1, 2]);
  });

  it('ein delete-Sentinel IN der Map entfernt genau diesen Schlüssel', async () => {
    const { pfad, lesen } = await vorbereiten('mit');
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), pfad),
        { variants: { neu: { book: { cash: 2500 } }, alt: deleteField() } },
        { merge: true },
      );
    });
    const nachher = await lesen();
    expect(Object.keys(nachher)).toEqual(['neu']);
  });

  it('und lässt die übrigen Varianten unangetastet', async () => {
    // Wichtig, weil der Schreibvorgang beides in EINEM Aufruf tut. Ein
    // Sentinel, der die Nachbarn mitnähme, kostete Messdaten — die Flotte
    // braucht 30 Ergebnisse, bis eine Variante überhaupt beurteilt wird.
    const { pfad, lesen } = await vorbereiten('rest');
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), pfad),
        { variants: { alt: deleteField() } },
        { merge: true },
      );
    });
    const nachher = await lesen();
    expect((nachher['neu'] as { pnls: number[] }).pnls).toEqual([3]);
  });

  it('ein Sentinel auf einen nicht vorhandenen Schlüssel ist harmlos', async () => {
    // Kann vorkommen, wenn zwei Läufe dieselbe Variante gleichzeitig
    // ausräumen. Ein Fehler hier landete im `catch` der Flotte und stellte
    // die Selbstoptimierung still.
    const { pfad, lesen } = await vorbereiten('doppelt');
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), pfad),
        { variants: { gibtsNicht: deleteField() } },
        { merge: true },
      );
    });
    expect(Object.keys(await lesen()).sort()).toEqual(['alt', 'neu']);
  });
});
