/**
 * Einstieg für den Chart-Prüfstand (`chart-shot.mjs`).
 *
 * Existiert nur, damit esbuild EIN Bündel aus dem echten Chart-Modul und der
 * Lightweight-Charts-Bibliothek bauen kann — nicht nachgebaut, sondern
 * dieselbe Datei, die die App lädt.
 */
export { buildPriceChart } from '../src/chart.js';
