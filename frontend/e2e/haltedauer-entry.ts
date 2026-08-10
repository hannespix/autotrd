/**
 * Einstieg für den Layout-Prüfstand (`haltedauer-shot.mjs`).
 *
 * Existiert nur, damit esbuild EIN Bündel aus Karten-Markup und Auswertung
 * bauen kann — beides aus den echten Quellen, nicht nachgebaut.
 */
export { haltedauerTabelle, haltedauerFazit, haltedauerMeta } from '../src/haltedauerCard.js';
export { haltedauerZeilen, besteHaltedauer } from '@autotrd/shared';
