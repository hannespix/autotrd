#!/usr/bin/env node
/**
 * Schlüssel des Bars-Caches einer Config — für die Workflows.
 *
 *   node scripts/bars-cache-key.mjs config/basis-1440-v4.yaml
 *   → us_equity-iex-all
 *
 * Die REGEL steht in `src/data/store.ts` neben `barStoreRoot`, dessen
 * Trennung sie nachbildet; hier liegt nur das Kommando drumherum. Warum es
 * das überhaupt gibt, steht dort im Kopf der Funktion — kurz: Vorher hashten
 * `probe.yml` und `optimize.yml` die ganze Config-Datei, also bekamen zwei
 * Configs, die sich nur in einer Risiko-Zahl unterscheiden, getrennte
 * Bars-Caches und damit verschiedene Daten.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../src/core/config.ts';
import { barsCacheKey } from '../src/data/store.ts';

const path = process.argv[2];
if (!path) {
  console.error('Aufruf: node scripts/bars-cache-key.mjs <config.yaml>');
  process.exit(2);
}
process.stdout.write(`${barsCacheKey(parseConfig(parseYaml(readFileSync(resolve(path), 'utf8'))))}\n`);
