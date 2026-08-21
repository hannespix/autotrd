/**
 * Wächter der Text-Diät (Owner 21.08.: „auf den ersten Blick viel zu
 * textlastig — verbessern, ohne Informationen zu verlieren").
 *
 * Stufe 1: Die fünf größten Erklärabsätze der Analyse-Karten standen
 * WORTGLEICH bereits hinter dem ⓘ derselben Karte (Kritiker-
 * Bestandsaufnahme) — der sichtbare Doppel-Einbau ist raus, die Erklärung
 * lebt vollständig im Infotip weiter. Dieser Wächter hält beide Hälften
 * des Versprechens fest: Dublette bleibt draußen UND der ⓘ-Zugang bleibt
 * drin. Fällt der ⓘ, wäre die Information wirklich weg — dann ist dieser
 * Test zu Recht rot.
 *
 * Die i18n-Schlüssel (lay.strukturHinweis …) bleiben bewusst als Archiv im
 * Wörterbuch — die EN-Qualitäts-Pins in i18n.test.ts prüfen sie weiter,
 * und eine Rückkehr des Absatzes wäre ein Einzeiler.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lese = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const dashboard = lese('../src/dashboard.ts');
const infotips = lese('../src/infotips.ts');

const STUFE_1 = [
  { schluessel: 'lay.momentumHinweis', tip: 'momentum' },
  { schluessel: 'lay.strukturHinweis', tip: 'struktursuche' },
  { schluessel: 'dc.hinweis', tip: 'depotVerlauf' },
  { schluessel: 'hd.hinweis', tip: 'haltedauer' },
  { schluessel: 'er.hinweis', tip: 'erkenntnisse' },
] as const;

describe('Text-Diät Stufe 1 — Dubletten raus, ⓘ-Zugang bleibt', () => {
  for (const { schluessel, tip } of STUFE_1) {
    it(`${schluessel}: kein Dauer-Absatz mehr, Erklärung über iBtn('${tip}')`, () => {
      expect(dashboard).not.toContain(`t('${schluessel}')`);
      expect(dashboard).toContain(`iBtn('${tip}')`);
      expect(infotips).toContain(`${tip}:`);
    });
  }
});
