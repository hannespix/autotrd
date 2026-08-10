/**
 * Einstieg für den Layout-Prüfstand des Depot-Verlaufs (`depot-shot.mjs`).
 *
 * Existiert nur, damit esbuild EIN Bündel aus Zeichnung und Zerlegung bauen
 * kann — beides aus den echten Quellen, nicht nachgebaut.
 */
export { depotChart, depotTooltip } from '../src/depotChart.js';
export { zerlegeDepot } from '@autotrd/shared';
