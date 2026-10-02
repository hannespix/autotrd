/**
 * Ein Spiegel ohne Takt ist kein Stand.
 *
 * Befund vom 02.10.2026 aus zwei Nutzer-Screenshots: Konten hingen seit dem
 * Umstieg vom 07.09. fest. Der Status zeigte nebeneinander
 *
 *   Modus      Papierhandel
 *   Zustand    frei — Einstiege erlaubt        ← grün
 *   Equity     --
 *   Positionen –
 *   Letzter Takt –
 *   Letzter Fehler  Umstieg 2026-09-07: Engine ausgeschaltet — …   ← rot
 *
 * Das war KEIN Stand, sondern ein einziges Feld, das `scripts/umstieg.mjs`
 * nach `engine.lastError` geschrieben hatte. `leseEngine` macht aus jedem
 * Objekt einen vollständigen Spiegel; die fehlenden Felder lasen sich dann als
 * harmloser Normalzustand („Papierhandel", „frei"). Schlimmer: Weil damit ein
 * Spiegel EXISTIERTE, fiel der einzige Hinweis weg, der die Ursache nennt —
 * `ew.g.keinTakt` und `eng.keinTaktNoch` hängen beide an `!engine`.
 *
 * Unterscheidungsmerkmal ist `lastTickAt`: `engineFieldOf()`, `mirrorError()`
 * und `mirrorSkipped()` (functions/src/engine/mirror.ts) setzen es bei JEDEM
 * Schreiben. Fehlt es, war der Takt nie da.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { leseEngine, taktErreichteKonto } from '../src/data.js';

const lese = (...teile: string[]): string => readFileSync(join(import.meta.dirname, '..', '..', ...teile), 'utf8');
const dashboard = lese('frontend', 'src', 'dashboard.ts');
const i18n = lese('frontend', 'src', 'i18n.ts');

/** Wörtlich der Stand, den das Umstiegs-Skript hinterließ. */
const UMSTIEG = { lastError: 'Umstieg 2026-09-07: Engine ausgeschaltet — bitte Einstellungen prüfen und bewusst einschalten' };

describe('Der Stand aus den Screenshots wird als das erkannt, was er ist', () => {
  it('das Doc des Umstiegs ist KEIN Takt-Stand', () => {
    const e = leseEngine(UMSTIEG);
    expect(e).not.toBeNull();
    // Genau die irreführende Lesart von damals — sie entsteht weiterhin …
    expect(e!.mode).toBeNull();
    expect(e!.halt).toBeNull();
    expect(e!.equity).toBeNull();
    expect(e!.lastTickAt).toBeNull();
    // … darf aber nicht mehr als Stand durchgehen.
    expect(taktErreichteKonto(e)).toBe(false);
  });

  it('ein echter Spiegel wird weiterhin angenommen — auch der eines übersprungenen Kontos', () => {
    expect(taktErreichteKonto(leseEngine({ lastTickAt: '2026-10-02T14:00:00.000Z', mode: 'paper' }))).toBe(true);
    expect(taktErreichteKonto(leseEngine({ lastTickAt: '2026-10-02T14:00:00.000Z', skipped: 'kein_broker' }))).toBe(true);
    expect(taktErreichteKonto(null)).toBe(false);
  });

  it('der Übersprung-Grund wird gelesen', () => {
    expect(leseEngine({ skipped: 'kein_broker' })?.skipped).toBe('kein_broker');
    expect(leseEngine({})?.skipped).toBeNull();
  });
});

describe('Die Karte traut keinem Spiegel ohne Takt', () => {
  it('die Statuskarte prüft den Takt, nicht bloß die Existenz des Felds', () => {
    const fn = dashboard.slice(dashboard.indexOf('function renderEngineStatus'));
    const block = fn.slice(0, fn.indexOf('\n}'));
    expect(block).toContain('if (!taktErreichteKonto(e)) {');
    // Die alte Prüfung darf nicht zurückkommen.
    expect(block).not.toMatch(/if \(!e\) \{/);
  });

  it('„Warum handelt die Engine (nicht)?" nennt dann den Hinweis, der die Ursache benennt', () => {
    const fn = dashboard.slice(dashboard.indexOf('function renderEngineWhy'));
    const block = fn.slice(0, fn.indexOf('\n  if (gruende.length === 0)'));
    expect(block).toContain("if (running && !taktErreichteKonto(e)) {");
    expect(block).toContain("gruende.push(t('ew.g.keinTakt'));");
    // Der Block, der den Stand auswertet, hängt am selben Maßstab.
    expect(block).toContain('if (taktErreichteKonto(e)) {');
    expect(block).not.toMatch(/^\s*if \(e\) \{/m);
  });

  it('ein ausgelassenes Konto erfährt den Grund', () => {
    const fn = dashboard.slice(dashboard.indexOf('function renderEngineWhy'));
    expect(fn).toContain('if (e.skipped) {');
    expect(fn).toContain('SKIP_TEXT[e.skipped]');
  });
});

describe('Die Klartexte sind in beiden Sprachen da', () => {
  it('jeder neue Schlüssel steht in DE und EN', () => {
    for (const k of ['ew.ausgelassen', 'ew.g.ausgelassen', 'skip.keinBroker', 'skip.zugang', 'skip.resetLaeuft']) {
      const treffer = [...i18n.matchAll(new RegExp(`^\\s*'${k.replace('.', '\\.')}':`, 'gm'))];
      expect(treffer.length, `${k} steht ${treffer.length}× statt 2×`).toBe(2);
    }
  });

  it('der Grund „kein Broker" sagt, wo man ihn verbindet', () => {
    // Ein Grund ohne Abhilfe ist genau das, woran die Nutzer hingen.
    expect(i18n).toMatch(/'skip\.keinBroker': '[^']*Optionen → Broker[^']*'/);
    expect(i18n).toMatch(/'skip\.keinBroker': '[^']*Options → Broker[^']*'/);
  });
});

describe('die Wächter erkennen einen eingebauten Fehler', () => {
  it('die alte, zu gutgläubige Prüfung fällt auf', () => {
    const kaputt = 'const e = st.engine;\n  if (!e) {\n    box.innerHTML = hinweis;\n    return;\n  }';
    expect(kaputt).toMatch(/if \(!e\) \{/);
    expect(kaputt).not.toContain('if (!taktErreichteKonto(e)) {');
  });

  it('ein Spiegel ohne Zeitstempel würde ohne das Prädikat als Stand durchgehen', () => {
    // Das ist die Lesart von vorher — sie liefert einen Spiegel, und genau daran lag es.
    expect(leseEngine(UMSTIEG)).not.toBeNull();
  });
});
