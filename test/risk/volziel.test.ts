/**
 * Volatilitätsziel (src/risk/volziel.ts) — der Faktor, der jede Positionsgröße
 * skaliert.
 *
 * Wächter, die Geld kosten, wenn sie fehlen:
 *  (a) KAUSAL: Der Faktor eines Tages ändert sich nicht rückwirkend, wenn
 *      später Tage dazukommen (Präfix-Konsistenz). Wäre er es, hätte die
 *      Messung Zukunftswissen in der Positionsgröße — Lookahead in der Größe
 *      statt im Signal, und niemand würde es im Bericht sehen.
 *  (b) AUFWÄRMPHASE: Unter `minBeobachtungen` gilt 1,0. Geraten wird nicht —
 *      eine Schätzung aus fünf Tagen kann den Faktor sonst auf `maxFaktor`
 *      ziehen, und das erste Quartal liefe mit doppelter Größe.
 *  (c) DECKEL: Flache Kurve (Vola 0) ⇒ `maxFaktor`, nie unendlich. Ohne den
 *      Deckel wäre die erste Position nach einer Kassenphase unbegrenzt.
 *  (d) Die Reihe ist die der EIGENEN Equity, und `tagesRenditen` bildet sie
 *      genau wie der Simulator (Schluss zu Schluss).
 */
import { describe, expect, it } from 'vitest';
import { tagesRenditen, volSkalierung, type VolZielInput } from '../../src/risk/volziel.ts';

const basis: Omit<VolZielInput, 'renditen'> = {
  zielVolPct: 10,
  halbwertszeitTage: 20,
  minFaktor: 0.25,
  maxFaktor: 2,
  minBeobachtungen: 60,
};

/** Deterministische Renditen mit vorgegebener Streuung (kein Zufall im Test). */
function reihe(n: number, amplitude: number): number[] {
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? amplitude : -amplitude));
}

describe('volSkalierung', () => {
  it('skaliert mit Ziel / realisierter Vola', () => {
    // ±0,5 % im Wechsel ⇒ Standardabweichung (unzentriert) 0,005 ⇒ 0,005 × √252 ≈ 7,94 % p. a.
    const r = volSkalierung({ ...basis, renditen: reihe(200, 0.005) });
    expect(r.realisiertVolPct).toBeCloseTo(0.005 * Math.sqrt(252) * 100, 6);
    expect(r.faktor).toBeCloseTo(10 / r.realisiertVolPct, 6);
    expect(r.faktor).toBeGreaterThan(1); // ruhiges Depot ⇒ größere Positionen
    expect(r.grund).toMatch(/Vola-Ziel/);
  });

  it('unruhiges Depot ⇒ Faktor unter 1', () => {
    const r = volSkalierung({ ...basis, renditen: reihe(200, 0.02) });
    expect(r.realisiertVolPct).toBeGreaterThan(10);
    expect(r.faktor).toBeLessThan(1);
  });

  it('WÄCHTER (a): Präfix-Konsistenz — spätere Tage ändern den Faktor von damals nicht', () => {
    const lang = [...reihe(120, 0.004), ...reihe(80, 0.03)];
    // So, wie es live entstünde: Tag für Tag, jeweils mit der Reihe bis heute.
    const wachsend: number[] = [];
    const damals: number[] = [];
    for (const r of lang) {
      wachsend.push(r);
      damals.push(volSkalierung({ ...basis, renditen: [...wachsend] }).faktor);
    }
    // Und noch einmal, nachdem die volle Reihe bekannt ist: kein Wert von damals darf sich bewegt haben.
    for (let i = 0; i < lang.length; i++) {
      expect(volSkalierung({ ...basis, renditen: lang.slice(0, i + 1) }).faktor).toBe(damals[i]);
    }
    // Der Faktor von HEUTE darf sich sehr wohl ändern, wenn neue Tage kommen — sonst misst er nichts.
    expect(damals[199]).not.toBe(damals[120]);
  });

  it('WÄCHTER (b): Aufwärmphase ⇒ Faktor 1,0 mit Grund', () => {
    const r = volSkalierung({ ...basis, renditen: reihe(59, 0.0001) });
    expect(r.faktor).toBe(1);
    expect(r.beobachtungen).toBe(59);
    expect(r.grund).toMatch(/Aufwärmphase/);
    // Eine Beobachtung mehr, und die (winzige) Vola würde den Faktor an den Deckel ziehen.
    expect(volSkalierung({ ...basis, renditen: reihe(60, 0.0001) }).faktor).toBe(2);
  });

  it('WÄCHTER (c): flache Kurve (Vola 0) ⇒ maxFaktor, nicht unendlich', () => {
    const r = volSkalierung({ ...basis, renditen: new Array(100).fill(0) });
    expect(r.faktor).toBe(2);
    expect(Number.isFinite(r.faktor)).toBe(true);
    expect(r.realisiertVolPct).toBe(0);
    expect(r.grund).toMatch(/flache Equity-Kurve/);
  });

  it('klemmt nach unten und oben und sagt es im Grund', () => {
    const hoch = volSkalierung({ ...basis, renditen: reihe(200, 0.05) });
    expect(hoch.faktor).toBe(0.25);
    expect(hoch.grund).toMatch(/geklemmt/);
    const tief = volSkalierung({ ...basis, renditen: reihe(200, 0.0005) });
    expect(tief.faktor).toBe(2);
  });

  it('unbrauchbare Vorgaben ⇒ 1,0 (fail-neutral), nie ein geratener Faktor', () => {
    const r = reihe(200, 0.01);
    expect(volSkalierung({ ...basis, renditen: r, zielVolPct: 0 }).faktor).toBe(1);
    expect(volSkalierung({ ...basis, renditen: r, zielVolPct: Number.NaN }).faktor).toBe(1);
    expect(volSkalierung({ ...basis, renditen: r, halbwertszeitTage: 0 }).faktor).toBe(1);
    expect(volSkalierung({ ...basis, renditen: r, minFaktor: 2, maxFaktor: 1 }).faktor).toBe(1);
    expect(volSkalierung({ ...basis, renditen: r, tageJeJahr: 0 }).faktor).toBe(1);
  });

  it('überspringt nicht-finite Renditen und zählt sie nicht als Beobachtung', () => {
    const mit = [...reihe(30, 0.01), Number.NaN, Number.POSITIVE_INFINITY, ...reihe(30, 0.01)];
    const r = volSkalierung({ ...basis, renditen: mit, minBeobachtungen: 60 });
    expect(r.beobachtungen).toBe(60);
    expect(Number.isFinite(r.realisiertVolPct)).toBe(true);
  });

  it('gewichtet das Jüngste stärker: dieselben Tage, andere Reihenfolge ⇒ andere Schätzung', () => {
    const ruhigDannWild = [...reihe(150, 0.002), ...reihe(50, 0.03)];
    const wildDannRuhig = [...reihe(50, 0.03), ...reihe(150, 0.002)];
    const a = volSkalierung({ ...basis, renditen: ruhigDannWild });
    const b = volSkalierung({ ...basis, renditen: wildDannRuhig });
    expect(a.realisiertVolPct).toBeGreaterThan(b.realisiertVolPct * 1.5);
    // Und die Folge fürs Sizing: frischer Sturm ⇒ kleinere Positionen.
    expect(a.faktor).toBeLessThan(b.faktor);
  });

  it('Krypto rechnet mit 365 Tagen', () => {
    const r = reihe(200, 0.01);
    const aktien = volSkalierung({ ...basis, renditen: r });
    const krypto = volSkalierung({ ...basis, renditen: r, tageJeJahr: 365 });
    expect(krypto.realisiertVolPct / aktien.realisiertVolPct).toBeCloseTo(Math.sqrt(365 / 252), 10);
  });
});

describe('tagesRenditen', () => {
  it('WÄCHTER (d): Schluss zu Schluss — dieselbe Definition wie im Simulator', () => {
    const r = tagesRenditen([100, 110, 99]);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(0.1, 12);
    expect(r[1]).toBeCloseTo(99 / 110 - 1, 12);
    expect(tagesRenditen([100])).toEqual([]);
    expect(tagesRenditen([])).toEqual([]);
  });

  it('überspringt kaputte Marken statt durch 0 zu teilen', () => {
    const r = tagesRenditen([0, 100, 110]);
    expect(r).toHaveLength(1);
    expect(r[0]).toBeCloseTo(0.1, 12);
    expect(tagesRenditen([100, Number.NaN, 110])).toEqual([]);
  });
});
