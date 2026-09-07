/**
 * ⓘ-Tips zweisprachig.
 *
 * Die Tips sind der größte Textbestand der App und bleiben deshalb in ihrem
 * eigenen Modul — zwei Records nebeneinander statt Dutzende Einträge im
 * allgemeinen Wörterbuch. Diese Tests pinnen die Eigenschaften, an denen
 * der Bestand scheitern könnte:
 *
 *   1. Jeder ⓘ-Knopf im Dashboard findet seinen Tip — ein unbekannter
 *      Schlüssel rendert STILL nichts (iBtn liefert '').
 *   2. Der Fallback ist FELDWEISE: eine übersetzte Überschrift ohne
 *      übersetzten Fließtext zeigt Englisch oben, Deutsch unten — nie leer.
 *   3. `INFO_EN` erfindet keine Schlüssel und lässt keinen aus.
 *   4. Die Tips beschreiben den Auto-Trader — nicht den alten Scan.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INFO, INFO_DE, INFO_EN, waehleTips, type Tip } from '../src/infotips';

const hier = dirname(fileURLToPath(import.meta.url));
const quelle = readFileSync(join(hier, '../src/infotips.ts'), 'utf8');
const dashboard = readFileSync(join(hier, '../src/dashboard.ts'), 'utf8');

describe('Fallback-Regel der Tips (pur)', () => {
  const de: Record<string, Tip> = {
    a: { t: 'Titel A', d: 'Text A' },
    b: { t: 'Titel B', d: 'Text B' },
  };

  it('im DE-Modus kommt der deutsche Record unverändert zurück', () => {
    expect(waehleTips(de, { a: { t: 'Title A' } }, 'de')).toBe(de);
  });

  it('FELDWEISER Fallback: übersetzte Überschrift, deutscher Fließtext', () => {
    const out = waehleTips(de, { a: { t: 'Title A' } }, 'en');
    expect(out['a']).toEqual({ t: 'Title A', d: 'Text A' });
  });

  it('fehlender EN-Eintrag fällt komplett auf Deutsch zurück — nie leer', () => {
    const out = waehleTips(de, { a: { t: 'Title A' } }, 'en');
    expect(out['b']).toEqual({ t: 'Titel B', d: 'Text B' });
  });

  it('leere EN-Strings zählen als „fehlt"', () => {
    const out = waehleTips(de, { a: { t: '', d: '' } }, 'en');
    expect(out['a']).toEqual({ t: 'Titel A', d: 'Text A' });
  });

  it('jede DE-ID überlebt die Übersetzung — kein Tip verschwindet', () => {
    const out = waehleTips(INFO_DE, INFO_EN, 'en');
    expect(Object.keys(out).sort()).toEqual(Object.keys(INFO_DE).sort());
    for (const [id, tip] of Object.entries(out)) {
      expect(tip.t.length, `Überschrift von „${id}" ist leer`).toBeGreaterThan(0);
      expect(tip.d.length, `Text von „${id}" ist leer`).toBeGreaterThan(0);
    }
  });
});

describe('Jeder ⓘ-Knopf findet seinen Tip', () => {
  const benutzt = [...new Set([...dashboard.matchAll(/iBtn\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]!))];

  it('das Dashboard trägt ⓘ-Knöpfe — der Test darf nicht leerlaufen', () => {
    expect(benutzt.length).toBeGreaterThan(15);
  });

  it('kein Knopf zeigt auf einen Schlüssel, den es nicht gibt (iBtn rendert dann STILL nichts)', () => {
    const fehlend = benutzt.filter((k) => !Object.hasOwn(INFO_DE, k));
    expect(fehlend, `iBtn ohne Tip: ${fehlend.join(', ')}`).toEqual([]);
  });

  it('kein Tip ohne Knopf — Karteileichen wandern sonst still ins Bundle', () => {
    const ungenutzt = Object.keys(INFO_DE).filter((k) => !benutzt.includes(k));
    expect(ungenutzt, `Tips ohne ⓘ: ${ungenutzt.join(', ')}`).toEqual([]);
  });
});

describe('Wörterbuch-Hygiene der Tips', () => {
  it('INFO_EN kennt keine Karteileichen — jede ID existiert in INFO_DE', () => {
    for (const id of Object.keys(INFO_EN)) {
      expect(Object.hasOwn(INFO_DE, id), `EN-Tip „${id}" fehlt in INFO_DE`).toBe(true);
    }
  });

  it('INFO_EN ist VOLLSTÄNDIG — jeder deutsche Tip hat eine englische Fassung', () => {
    /* Der Fallback ist das Laufzeit-Netz (nie ein leeres Popover), dieser
     * Test die Review-Pflicht (ein neuer Tip kommt zweisprachig). Ohne ihn
     * verfiele die englische Oberfläche schleichend — GERADE WEIL der
     * Fallback so leise ist. */
    const ohneEn = Object.keys(INFO_DE).filter((id) => {
      const u = INFO_EN[id];
      return !u || !u.t || u.t.length === 0 || !u.d || u.d.length === 0;
    });
    expect(ohneEn, `ohne englische Fassung: ${ohneEn.join(', ')}`).toEqual([]);
  });

  it('keine englische Fassung ist bloß der deutsche Text', () => {
    /* Der billigste Weg, den Vollständigkeits-Test zu bestehen, wäre, den
     * deutschen Text nach INFO_EN zu kopieren. Ausnahmen brauchen einen
     * Namen und einen Grund. */
    const gleichErlaubt = new Set([
      'engine', // Fachwort, in beiden Sprachen gleich
      'engineKommandos', // „Halt · Resume · Flatten" — die Kommandonamen sind der Vertrag zum Kern
    ]);
    for (const [id, tip] of Object.entries(INFO_DE)) {
      if (!gleichErlaubt.has(id)) {
        expect(INFO_EN[id]?.t, `Überschrift von „${id}" ist unübersetzt`).not.toBe(tip.t);
      }
      expect(INFO_EN[id]?.d, `Text von „${id}" ist unübersetzt`).not.toBe(tip.d);
    }
  });

  it('kein deutscher Tip ist leer — INFO_DE ist die Quelle der Wahrheit', () => {
    for (const [id, tip] of Object.entries(INFO_DE)) {
      expect(tip.t.length, `Überschrift von „${id}" ist leer`).toBeGreaterThan(0);
      expect(tip.d.length, `Text von „${id}" ist leer`).toBeGreaterThan(0);
    }
  });

  it('INFO ist im Testlauf (kein localStorage-Stub) die deutsche Fassung', () => {
    expect(INFO).toBe(INFO_DE);
  });
});

describe('Die Tips beschreiben den Auto-Trader, nicht den alten Scan', () => {
  it('kein Tip erwähnt Konfluenz, Prognose, Tuner oder Regime-Ampel', () => {
    for (const [id, tip] of Object.entries(INFO_DE)) {
      expect(tip.d, id).not.toMatch(/Konfluenz|Prognose|Auto-Tuner|Regime-Ampel|News-Veto/);
    }
  });

  it('die Kern-Regeln stehen drin: Exits nie gesperrt, Tages-Halt endet von selbst, Drawdown braucht Resume', () => {
    expect(INFO_DE['engineKommandos']?.d).toContain('Exits werden nie gesperrt');
    expect(INFO_DE['engineKommandos']?.d).toContain('endet von selbst am nächsten Handelstag');
    expect(INFO_DE['maxDrawdown']?.d).toContain('RESUME');
    expect(INFO_DE['dailyLossLimit']?.d).toContain('nicht per Knopf');
  });

  it('„kein Handel" ist ein zulässiges Ergebnis — der Tip sagt es (CLAUDE.md §0.9)', () => {
    expect(INFO_DE['symbolauswahl']?.d).toContain('zulässiges Ergebnis, kein Fehler');
    expect(INFO_EN['symbolauswahl']?.d).toContain('legitimate outcome, not an error');
  });

  it('die englischen Fassungen tragen die Broker-Fachbegriffe', () => {
    expect(INFO_EN['riskPerTrade']?.t).toBe('Risk per trade');
    expect(INFO_EN['maxDrawdown']?.t).toBe('Drawdown lock');
    expect(INFO_EN['dailyLossLimit']?.t).toBe('Daily loss brake');
    expect(INFO_EN['allowShort']?.d).toContain('theoretically unlimited');
    expect(INFO_EN['champion']?.d).toContain('walk-forward');
  });

  it('der ⓘ-Knopf zieht seine Attribut-Texte über t() (Anschluss-Wächter)', () => {
    expect(quelle).toContain("uebersetzt('tip.erklaerung')");
    expect(quelle).toContain("uebersetzt('tip.wasBedeutet')");
    expect(quelle).not.toContain('aria-label="Erklärung:');
    expect(quelle).not.toContain('title="Was bedeutet das?"');
    expect(quelle).toContain('waehleTips(INFO_DE, INFO_EN, sprachWahl())');
  });
});
