/**
 * Sprachumschalter Phase 0 (Task #139) — die Fallback-Regel ist das Fundament.
 *
 * Deutsch ist die Quelle der Wahrheit; Englisch darf lücken, aber nie
 * erfinden. Der Golden-Wächter pinnt zusätzlich die bisherigen deutschen
 * Login-Texte: Im DE-Modus rendert die App nachweislich EXAKT dieselben
 * Texte wie vor dem Umbau — damit ist „kaputtmachen" strukturell
 * ausgeschlossen (Owner: „ich mag auf keinen Fall irgendwas kaputt machen").
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DE, EN, sprachWahl, uebersetze, type TextSchluessel } from '../src/i18n.js';

const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
const auth = readFileSync(join(import.meta.dirname, '..', 'src', 'auth.ts'), 'utf8');
const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

describe('die Fallback-Regel — fehlendes Englisch zeigt Deutsch, nie Lücken', () => {
  it('fehlender EN-Eintrag fällt auf den deutschen Text zurück', () => {
    expect(uebersetze('login.anmelden', 'en', {})).toBe(DE['login.anmelden']);
    // Auch ein leerer String zählt als „fehlt" — niemals nichts anzeigen.
    expect(uebersetze('login.anmelden', 'en', { 'login.anmelden': '' })).toBe(
      DE['login.anmelden'],
    );
  });

  it('vorhandener EN-Eintrag gewinnt im EN-Modus', () => {
    expect(uebersetze('login.anmelden', 'en')).toBe('Sign in');
  });

  it('im DE-Modus zählt IMMER das deutsche Wörterbuch', () => {
    for (const k of Object.keys(DE) as TextSchluessel[]) {
      expect(uebersetze(k, 'de')).toBe(DE[k]);
    }
  });
});

describe('Wörterbuch-Hygiene', () => {
  it('EN kennt keine Karteileichen — jeder Schlüssel existiert in DE', () => {
    for (const k of Object.keys(EN)) {
      expect(Object.hasOwn(DE, k), `EN-Schlüssel „${k}" fehlt in DE`).toBe(true);
    }
  });

  it('kein deutscher Text ist leer — DE ist die Quelle der Wahrheit', () => {
    for (const [k, v] of Object.entries(DE)) {
      expect(v.length, `DE-Schlüssel „${k}" ist leer`).toBeGreaterThan(0);
    }
  });
});

describe('Sprachwahl', () => {
  it("Standard ist 'de' — auch ohne localStorage oder mit Unsinn darin", () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
    });
    expect(sprachWahl()).toBe('de');
    vi.stubGlobal('localStorage', {
      getItem: () => 'quatsch',
    });
    expect(sprachWahl()).toBe('de');
    vi.stubGlobal('localStorage', {
      getItem: () => 'en',
    });
    expect(sprachWahl()).toBe('en');
    vi.unstubAllGlobals();
  });
});

describe('Golden-Wächter — im DE-Modus exakt die bisherigen Texte', () => {
  it('die deutschen Login-Texte sind byte-gleich zum Stand vor dem Umbau', () => {
    expect(DE['login.email']).toBe('E-Mail');
    expect(DE['login.passwort']).toBe('Passwort');
    expect(DE['login.anmelden']).toBe('Anmelden');
    expect(DE['login.registrieren']).toBe('Registrieren');
    expect(DE['login.passwortVergessen']).toBe('Passwort vergessen?');
    expect(DE['login.oder']).toBe('oder');
    expect(DE['login.mitGoogle']).toBe('Mit Google anmelden');
    expect(DE['login.emailFehlt']).toBe('Bitte oben die E-Mail-Adresse eintragen.');
    expect(DE['auth.falscheDaten']).toBe('E-Mail oder Passwort ist falsch.');
    expect(DE['auth.fehlgeschlagen']).toBe('Anmeldung fehlgeschlagen. Bitte erneut versuchen.');
  });

  it('Tranche 2: die deutschen Optionen-Anzeige-Texte sind byte-gleich zum Bestand', () => {
    // Mehrzeilige Template-Literale wurden auf EINE Zeile normalisiert —
    // HTML kollabiert Whitespace, gerendert ist das identisch.
    expect(DE['opt.titel']).toBe('Optionen');
    expect(DE['opt.tabAnzeige']).toBe('Anzeige');
    expect(DE['opt.tabBroker']).toBe('Broker &amp; Echtgeld');
    expect(DE['opt.tabKonto']).toBe('Konto &amp; Steuer');
    expect(DE['opt.darstellung']).toBe('Darstellung');
    expect(DE['opt.hellDunkel']).toBe(
      '<b>Hell/Dunkel</b> — „System" folgt automatisch deiner Geräte-Einstellung; Hell/Dunkel stellt fest um.',
    );
    expect(DE['opt.themeSystem']).toBe('System');
    expect(DE['opt.themeHell']).toBe('Hell');
    expect(DE['opt.themeDunkel']).toBe('Dunkel');
    expect(DE['opt.optionaleElemente']).toBe('Optionale Elemente');
    expect(DE['opt.prognosePfeil']).toBe(
      '<b>Prognose-Pfeil</b> — eigene Kurs-Erwartung im Chart einzeichnen; zählt als gewichtete Stimme im Auto-Trading. <i>Beta, standardmäßig aus.</i>',
    );
    expect(DE['opt.vergleichsOverlay']).toBe(
      '<b>Vergleichs-Overlay</b> — zweites Symbol als %-Linie im Haupt-Chart.',
    );
    expect(DE['opt.multiChartRaster']).toBe(
      '<b>Multi-Chart-Raster</b> — 1/2/4 Charts parallel mit Lock-Sync.',
    );
    expect(DE['opt.module']).toBe('Module');
    expect(DE['opt.marktgruppen']).toBe('Marktgruppen');
    expect(DE['opt.moduleHint']).toContain('Abgewählte Module verschwinden komplett');
    expect(DE['opt.marktgruppenHint']).toContain('nur Anzeige — die Daten aller Gruppen');
  });

  it('Tranche 1: die deutschen Kopfleisten-Texte sind byte-gleich zum Bestand', () => {
    expect(DE['nav.engineAus']).toBe('Engine aus');
    expect(DE['nav.engineAn']).toBe('Engine an');
    expect(DE['nav.panelLinks']).toBe('Linkes Panel');
    expect(DE['nav.panelRechts']).toBe('Rechtes Panel');
    expect(DE['nav.optionenTitle']).toBe('Optionen: Elemente, Module & Paper-Wallet');
    expect(DE['nav.tourTitle']).toBe('Tour: die wichtigsten Bereiche in einer Minute');
    expect(DE['nav.spalteLinks']).toBe('Linke Spalte ein-/ausblenden');
    expect(DE['nav.spalteRechts']).toBe('Rechte Spalte ein-/ausblenden');
  });
});

describe('Anschluss-Wächter — die Funktion ist verdrahtet, nicht nur vorhanden', () => {
  it('renderLogin zieht seine Texte über t()', () => {
    for (const k of [
      "t('login.sub')",
      "t('login.anmelden')",
      "t('login.mitGoogle')",
      "t('login.emailFehlt')",
    ]) {
      expect(main).toContain(k);
    }
    // Kein hartkodierter Rest der übersetzten Texte im Template.
    expect(main).not.toContain('>Anmelden<');
    expect(main).not.toContain('>Mit Google anmelden<');
  });

  it('authErrorMessage übersetzt über t()', () => {
    expect(auth).toContain("t('auth.falscheDaten')");
    expect(auth).toContain("t('auth.fehlgeschlagen')");
  });

  it('die Kopfleiste zieht ihre Texte über t() — Badge inklusive Umschalter', () => {
    for (const k of [
      "t('nav.panelLinks')",
      "t('nav.panelRechts')",
      "t('nav.engineAus')",
      "t('nav.optionenTitle')",
      "t('nav.tourTitle')",
      "t('nav.spalteLinks')",
      "t('nav.spalteRechts')",
    ]) {
      expect(dashboard).toContain(k);
    }
    // Der dynamische Badge-Umschalter (renderEngineBadge) übersetzt BEIDE
    // Zustände — sonst spränge das Badge beim Engine-Start zurück auf Deutsch.
    expect(dashboard).toContain("running ? t('nav.engineAn') : t('nav.engineAus')");
    // Keine hartkodierten Reste in der Kopfleiste.
    expect(dashboard).not.toContain('>Engine aus</div>');
    expect(dashboard).not.toContain('aria-label="Linkes Panel"');
  });

  it('der Optionen-Tab „Anzeige" zieht seine Texte über t()', () => {
    for (const k of [
      "t('opt.titel')",
      "t('opt.tabAnzeige')",
      "t('opt.tabBroker')",
      "t('opt.darstellung')",
      "t('opt.hellDunkel')",
      "t('opt.themeSystem')",
      "t('opt.sprache')",
      "t('opt.optionaleElemente')",
      "t('opt.prognosePfeil')",
      "t('opt.indikatorExtras')",
      "t('opt.module')",
      "t('opt.moduleHint')",
      "t('opt.marktgruppen')",
      "t('opt.marktgruppenHint')",
    ]) {
      expect(dashboard).toContain(k);
    }
    // Keine hartkodierten Reste der übersetzten Region im Template.
    expect(dashboard).not.toContain('<h3>Optionen</h3>');
    expect(dashboard).not.toContain('data-otab="anzeige">Anzeige<');
    expect(dashboard).not.toContain('<b>Prognose-Pfeil</b> — eigene Kurs-Erwartung im Chart einzeichnen;\n');
    // Sprachnamen bleiben unübersetzt — jede Sprache in ihrem eigenen Namen.
    expect(dashboard).toContain('<option value="de">Deutsch</option>');
    expect(dashboard).toContain('<option value="en">English</option>');
  });

  it('die Sprachwahl sitzt in Optionen → Anzeige und wird angewandt', () => {
    const anzeige = dashboard.indexOf('data-opane="anzeige"');
    const select = dashboard.indexOf('id="ouLang"');
    expect(select, '#ouLang fehlt').toBeGreaterThan(anzeige);
    expect(dashboard.slice(select, select + 300)).toContain('value="de"');
    expect(dashboard.slice(select, select + 300)).toContain('value="en"');
    expect(dashboard).toContain("setzeSprache(ouLang.value === 'en' ? 'en' : 'de');");
  });
});
