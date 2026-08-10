/**
 * Das Markup der Haltedauer-Karte.
 *
 * Geprüft wird hier nicht „sieht hübsch aus", sondern was eine falsche
 * Darstellung anrichten würde: Die Karte soll gelesen und danach eine
 * Einstellung geändert werden. Zwei Fehler wären teuer und beide lautlos —
 * ein Spitzenreiter aus dünnen Daten, der wie eine Empfehlung aussieht, und
 * eine fehlende Drift-Warnung, wenn nur die Kaufseite verdient.
 *
 * Das Layout (sechs Spalten auf 390 px) prüft der Bild-Prüfstand
 * `frontend/e2e/haltedauer-shot.mjs` — das kann kein Unit-Test.
 */
import { describe, expect, it } from 'vitest';
import { SCHATTEN_MIN_N, besteHaltedauer, haltedauerZeilen } from '@autotrd/shared';
import {
  haltedauerFazit,
  haltedauerMeta,
  haltedauerTabelle,
  pct3,
  quote1,
} from '../src/haltedauerCard.js';

function k(n: number, summePct: number) {
  return { n, summePct, treffer: Math.round(n * 0.52), summeRohPct: summePct, nRoh: n };
}

/** Die SPY-Messung vom 09.08. in der Größenordnung, plus eine dünne Zeile. */
const HORIZONTE = {
  1: { klasse: k(327, 31.3), buy: k(52, 34.0), sell: k(275, -25.9) },
  5: { klasse: k(327, 102.2), buy: k(52, 81.8), sell: k(275, -32.0) },
  10: { klasse: k(12, 1.4), buy: k(3, 2.8), sell: k(9, -2.3) },
};

describe('Zahlenformat', () => {
  it('schreibt Prozent mit deutschem Komma', () => {
    expect(pct3(0.3126)).toBe('0,313 %');
    expect(quote1(0.519)).toBe('51,9 %');
  });

  it('macht aus „nicht gemessen" einen Gedankenstrich, keine Null', () => {
    expect(pct3(null)).toBe('—');
    expect(quote1(null)).toBe('—');
  });
});

describe('haltedauerTabelle', () => {
  const zeilen = haltedauerZeilen(HORIZONTE);
  const beste = besteHaltedauer(zeilen);
  const html = haltedauerTabelle(zeilen, beste);

  it('markiert GENAU eine Zeile als beste', () => {
    expect(html.match(/hd-best/g)).toHaveLength(1);
  });

  it('markiert die dünne Zeile als blass — sie darf nicht mitzählen', () => {
    expect(html.match(/hd-dim/g)).toHaveLength(1);
    // Und die blasse ist NICHT die beste, obwohl sie die höchste Kante hat.
    expect(html).not.toMatch(/hd-dim hd-best|hd-best hd-dim/);
  });

  it('hat für jede Haltedauer eine Zeile plus Kopf', () => {
    expect(html.match(/class="hd-row/g)).toHaveLength(4);
  });

  it('schreibt Singular und Plural richtig', () => {
    expect(html).toContain('>1 Tag<');
    expect(html).toContain('>5 Tage<');
  });

  it('leere Zeilenliste ⇒ nur der Kopf, kein Absturz', () => {
    expect(haltedauerTabelle([], null)).toContain('hd-head');
  });
});

describe('haltedauerFazit', () => {
  it('ohne belastbare Zeile steht da „noch keine Aussage"', () => {
    const duenn = haltedauerZeilen({ 1: { klasse: k(3, 90) } });
    expect(haltedauerFazit(besteHaltedauer(duenn))).toMatch(/Noch keine Zeile/);
  });

  it('nennt Haltedauer, Kante und Stichprobe', () => {
    const beste = besteHaltedauer(haltedauerZeilen(HORIZONTE))!;
    const satz = haltedauerFazit(beste);
    expect(satz).toContain('5 Handelstage');
    expect(satz).toContain('0,313 %');
    expect(satz).toContain('n = 327');
  });

  it('warnt vor Drift, wenn nur die Kaufseite verdient', () => {
    // Der ehrlichste Teil der Karte. Ohne ihn läse man eine positive Zahl als
    // Signalkante, obwohl sie auch reine Aufwärtsbewegung sein kann.
    const beste = besteHaltedauer(haltedauerZeilen(HORIZONTE))!;
    expect(haltedauerFazit(beste)).toMatch(/Marktdrift/);
  });

  it('warnt NICHT, wenn beide Seiten tragen', () => {
    const beid = haltedauerZeilen({
      5: { klasse: k(SCHATTEN_MIN_N * 2, 100), buy: k(200, 60), sell: k(200, 40) },
    });
    expect(haltedauerFazit(besteHaltedauer(beid))).not.toMatch(/Marktdrift/);
  });
});

describe('haltedauerMeta', () => {
  it('nennt die Symbolzahl — ohne sie ist die Kante nicht lesbar', () => {
    expect(haltedauerMeta({ symbole: 164, fenster: 6000, version: 3 })).toBe(
      '164 Symbole · 6000 Basistage je Symbol · Rechnung v3',
    );
  });

  it('lässt weg, was fehlt, statt Platzhalter zu erfinden', () => {
    expect(haltedauerMeta({})).toBe('');
    expect(haltedauerMeta({ symbole: 12 })).toBe('12 Symbole');
  });
});
