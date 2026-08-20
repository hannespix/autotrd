/** Bundle-Eingang für trade-shot.mjs — exportiert die Maschinen-Video-Maler
 *  als globales IIFE (`__m`), damit der Prüfstand auf file:// ohne
 *  Modul-CORS Standbilder malen und die echte Aufnahme starten kann. */
export { aktBei, aktPlan } from '../src/tradeStory.js';
export { baueTradeStoryVideo, maleAkt, vermesseLage } from '../src/tradeStoryVideo.js';
