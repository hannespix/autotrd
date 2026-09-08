#!/usr/bin/env node
/**
 * Nächtlicher Wächter über die laufende Plattform.
 *
 *   node scripts/wachhund.mjs --config config/platform.yaml
 *
 * Er SCHAUT und BERICHTET — er ändert nichts. Prüft: schlägt der Takt, ist
 * der Champion frisch, handelt die Engine dasselbe Universum, das der
 * Optimierer gemessen hat, wie viele Konten sind an, wie viele im Echtgeld.
 *
 * Das Urteil über einen toten Takt kommt aus `shared/src/wachhund.ts` —
 * dieselbe Funktion, die auch das Frontend nutzt. Zwei Meinungen darüber,
 * wann ein Takt tot ist, wären eine zu viel.
 *
 * Zugang über GOOGLE_APPLICATION_CREDENTIALS (Service-Account-JSON).
 * Exit 1, wenn etwas kaputt ist — sonst 0.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../src/core/config.ts';
import { bewerteHerzschlag } from '../shared/src/wachhund.ts';
import { alsMarkdown, beurteile } from './module/wachhund.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const cfg = parseConfig(parseYaml(readFileSync(resolve(opt('--config', 'config/platform.yaml')), 'utf8')));

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_CONFIG) {
  console.error('GOOGLE_APPLICATION_CREDENTIALS fehlt — ohne Service-Account kein Blick auf Firestore.');
  process.exit(1);
}

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
initializeApp();
const db = getFirestore();

const holen = async (pfad) => {
  const s = await db.doc(pfad).get();
  return s.exists ? s.data() : null;
};

const [health, champion, engineConfig] = await Promise.all([holen('meta/health'), holen('meta/champion'), holen('meta/engineConfig')]);

const users = await db.collection('users').get();
const nutzer = users.docs.map((d) => {
  const v = d.data() ?? {};
  return {
    uid: d.id,
    engineAn: v?.settings?.strategy?.engine?.running === true,
    live: v?.broker?.mode === 'live' || v?.settings?.broker?.mode === 'live',
  };
});

const jetztMs = Date.now();
const urteil = beurteile({
  jetztMs,
  health,
  champion,
  engineConfig,
  repoSymbols: [...cfg.universe.symbols],
  repoTimeframe: cfg.timeframe,
  nutzer,
  herzschlagUrteil: bewerteHerzschlag({ lastRunAt: typeof health?.lastRunAt === 'string' ? health.lastRunAt : null, jetztMs }),
});

const text = alsMarkdown(urteil);
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
}
process.exit(urteil.ok ? 0 : 1);
