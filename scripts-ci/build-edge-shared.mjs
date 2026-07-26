#!/usr/bin/env node
/**
 * Leitet `supabase/functions/_shared/` aus dem bestehenden Quellcode ab.
 *
 * Warum überhaupt ein Schritt dazwischen? Node und Deno lösen Importpfade
 * unterschiedlich auf: Unser Code schreibt `from './x.js'` (ESM-Konvention
 * für Node), Deno erwartet `from './x.ts'`. Statt den Quellcode für beide
 * Welten zu verbiegen oder unstabile Deno-Flags zu benutzen, entsteht hier
 * eine abgeleitete Kopie mit umgeschriebenen Endungen.
 *
 * ENTSCHEIDEND: Das Ergebnis ist NICHT eingecheckt (.gitignore). Es gibt
 * weiterhin genau EINE Quelle für Indikatoren, Regelbaum und Konfluenz —
 * ein Duplikat im Repo würde früher oder später auseinanderlaufen, und
 * genau davon lebt die Migration: Der Wertkern wandert unverändert mit,
 * inklusive seiner Golden-Tests.
 *
 * Aufruf: node scripts-ci/build-edge-shared.mjs
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'supabase', 'functions', '_shared');

/** Alle .ts-Dateien unterhalb von dir (rekursiv). */
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** './x.js' → './x.ts' — nur relative Pfade, Paketnamen bleiben unberührt. */
function rewriteImports(code) {
  return code.replace(/(from\s+['"])(\.[^'"]*?)\.js(['"])/g, '$1$2.ts$3');
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// 1. shared/src → _shared/
for (const file of await walk(join(ROOT, 'shared', 'src'))) {
  const rel = relative(join(ROOT, 'shared', 'src'), file);
  const target = join(OUT, rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, rewriteImports(await readFile(file, 'utf8')));
}

// 2. Die Engine-Logik liegt (historisch) unter functions/src/core, ist aber
//    ebenso frei von Node-Bibliotheken. Sie kommt als engine.ts dazu; der
//    Import auf shared wird auf die flache Ablage hier umgebogen.
const engine = rewriteImports(
  await readFile(join(ROOT, 'functions', 'src', 'core', 'engine.ts'), 'utf8'),
).replaceAll('../../../shared/src/index.ts', './index.ts');
await writeFile(join(OUT, 'engine.ts'), engine);

// 3. Sammel-Export, damit die Funktionen nur EINEN Pfad importieren.
await writeFile(
  join(OUT, 'mod.ts'),
  [
    '// Abgeleitet von scripts-ci/build-edge-shared.mjs — NICHT von Hand ändern.',
    "export * from './index.ts';",
    "export * from './engine.ts';",
    '',
  ].join('\n'),
);

const files = await walk(OUT);
console.log(`_shared aufgebaut: ${files.length} Dateien`);
