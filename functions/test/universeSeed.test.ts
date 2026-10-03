/**
 * Der Katalog-Seed nach `meta/universe`.
 *
 * ── Der Fehler, der hier verhindert wird ──────────────────────────────────
 *
 * Der Seed war „einmal und nie wieder":
 *
 *   if ((await ref.get()).exists) return;
 *
 * Das Dokument in Produktion stammte damit aus der ersten Woche. Mit der
 * Alpaca-Ausrichtung (10.08.) hätte die ENGINE den neuen Katalog benutzt — er
 * steht im Code — die OBERFLÄCHE aber weiter den alten: Picker und
 * Markt-Übersicht lesen `meta/universe`. Der Nutzer hätte Devisen, Futures und
 * SAP.DE gesehen, alle mit eingefrorenen Kursen, weil der Scan sie nicht mehr
 * versorgt.
 *
 * Kein Fehler wäre irgendwo aufgetaucht. Die Oberfläche hätte einfach eine
 * andere Welt gezeigt als die Engine handelt.
 */
import { describe, expect, it } from 'vitest';
import { UNIVERSE_V } from '../src/scheduled/scanMarket.js';
import { CATALOG, CLASS_LABELS, allSymbols } from '../../shared/src/index.js';

/** Der Seed baut genau diese Struktur — hier nachgebildet, um sie zu prüfen. */
function baueKlassen(): Record<string, { label: string; groups: Record<string, unknown[]> }> {
  const classes: Record<string, { label: string; groups: Record<string, unknown[]> }> = {};
  for (const [cls, groups] of Object.entries(CATALOG)) {
    classes[cls] = {
      label: CLASS_LABELS[cls] ?? cls,
      groups: Object.fromEntries(
        Object.entries(groups).map(([g, entries]) => [
          g,
          entries.map(([symbol, name]) => ({ symbol, name })),
        ]),
      ),
    };
  }
  return classes;
}

describe('meta/universe', () => {
  it('trägt eine Version — sonst bliebe der erste Seed für immer stehen', () => {
    expect(UNIVERSE_V).toBeGreaterThanOrEqual(2);
  });

  it('enthält jede Klasse des Katalogs mit deutschem Label', () => {
    const k = baueKlassen();
    expect(Object.keys(k).sort()).toEqual(Object.keys(CATALOG).sort());
    for (const [cls, eintrag] of Object.entries(k)) {
      expect(eintrag.label, cls).toBe(CLASS_LABELS[cls]);
      expect(eintrag.label, cls).not.toBe(cls); // kein roher Schlüssel
    }
  });

  it('enthält kein Symbol mehr, das die Engine nicht mehr kennt', () => {
    // Der eigentliche Punkt: Oberfläche und Engine müssen dieselbe Welt
    // sehen. Ein angebotenes Symbol ohne Kursversorgung ist schlimmer als
    // ein fehlendes — es sieht handelbar aus und ist eingefroren.
    const imSeed = new Set(
      Object.values(baueKlassen()).flatMap((c) =>
        Object.values(c.groups).flatMap((g) => (g as Array<{ symbol: string }>).map((e) => e.symbol)),
      ),
    );
    expect([...imSeed].sort()).toEqual([...allSymbols()].sort());
    for (const tot of ['EURUSD=X', 'GC=F', 'SAP.DE', '^N225']) {
      expect(imSeed.has(tot), tot).toBe(false);
    }
  });

  it('führt keine leere Klasse — ein leerer Reiter ist ein Fehler mit Rahmen', () => {
    for (const [cls, eintrag] of Object.entries(baueKlassen())) {
      const n = Object.values(eintrag.groups).reduce((s, g) => s + (g as unknown[]).length, 0);
      expect(n, cls).toBeGreaterThan(0);
    }
  });
});
