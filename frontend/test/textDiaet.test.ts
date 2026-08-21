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

/**
 * Stufe 1b: Dieselbe Regel wie Stufe 1 für die nächsten vier großen
 * Erklärabsätze — Auto-Tuner, Trade-Journal, Klassen-Regler und Loadouts.
 * Die ⓘ-Texte (infotips) sind jeweils AUSFÜHRLICHER als die entfernten
 * Absätze; verlagert wird also nur die Dublette, keine Information.
 */
const STUFE_1B = [
  { schluessel: 'lay.tunerHinweis', tip: 'autotuner' },
  { schluessel: 'lay.journalHinweis', tip: 'tradejournal' },
  { schluessel: 'opt.klassenHint', tip: 'classWeights' },
  { schluessel: 'opt.loadoutsHint', tip: 'loadouts' },
] as const;

describe('Text-Diät Stufe 1b — Tuner/Journal/Klassen/Loadouts hinter ihre ⓘ', () => {
  for (const { schluessel, tip } of STUFE_1B) {
    it(`${schluessel}: kein Dauer-Absatz mehr, Erklärung über iBtn('${tip}')`, () => {
      expect(dashboard).not.toContain(`t('${schluessel}')`);
      expect(dashboard).toContain(`iBtn('${tip}')`);
      expect(infotips).toContain(`${tip}: {`);
    });
  }
});

/**
 * Stufe 2: Die Performance-Karte stapelte bei einem frischen Konto vier
 * „Noch keine …"-Absätze übereinander (Exits, Kosten, Fill-Reibung,
 * Kapitaleinsatz). Jetzt sind Sektionen ohne Daten KOMPLETT zu (Wrapper
 * hidden) und EIN Sammelsatz (#pfLeer) erklärt, was noch kommt. Die
 * Sichtbarkeit ist rein datengetrieben — kein gemerkter Zustand, kein
 * Springen beim Zeitfenster-Wechsel (die Sektionen hängen an Server-
 * Zahlen, nicht am pfZeit-Chip).
 */
const STUFE_2_LEERSAETZE = [
  "t('pf.keineGeschlossenen')",
  "t('px.keineGeschlossenen')",
  "t('pf.reibungKeineFills')",
  "t('pf.kapitalKeineDaten')",
  "t('pc.reibungAbErstem')",
] as const;

describe('Text-Diät Stufe 2 — Performance-Sektionen zu statt Leersatz-Stapel', () => {
  it('kein einzelner „Noch keine …"-Absatz mehr in der Performance-Karte', () => {
    for (const aufruf of STUFE_2_LEERSAETZE) expect(dashboard).not.toContain(aufruf);
  });

  it('die vier Sektions-Wrapper starten zu, der Sammelsatz existiert genau einmal', () => {
    for (const id of ['pfSekExits', 'pfSekKosten', 'pfSekReibung', 'pfSekKapital']) {
      expect(dashboard).toContain(`<div id="${id}" hidden>`);
    }
    expect(dashboard).toContain('<div class="hint" id="pfLeer" hidden>');
    expect(dashboard.split("t('pf.sektionenFolgen')").length).toBe(2);
  });

  it('jeder Sektions-Renderer meldet seinen Daten-Stand an den Wrapper', () => {
    expect(dashboard).toContain("zeigePfSektion('pfSekExits', total > 0);");
    expect(dashboard).toContain("zeigePfSektion('pfSekKosten', !!c && c.n > 0);");
    expect(dashboard).toContain("zeigePfSektion('pfSekReibung', klassen.length > 0);");
    expect(dashboard).toContain("zeigePfSektion('pfSekKapital', !!k);");
  });

  it('ohne Stats-Doc schließen die Sektionen ebenfalls — sonst stünde nach einem Reset der alte Stand', () => {
    // Der Early-Return in renderStats (equityDays === 0) erreicht die
    // Sektions-Renderer nie — er muss selbst aufräumen.
    expect(dashboard).toContain('for (const id of PF_SEKTIONEN) zeigePfSektion(id, false);');
    // Und der Voll-Zweig schaltet den Sammelsatz nach den vier Renderern.
    expect(dashboard).toMatch(/renderKapital\(s\);\n {2}aktualisierePfLeer\(\);/);
  });
});
