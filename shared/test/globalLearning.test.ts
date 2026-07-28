/**
 * Kollektives Lernen über alle Konten.
 *
 * Der gefährliche Fehler in diesem Modul wäre nicht ein Absturz, sondern
 * eine ÜBERSCHÄTZTE Evidenz: Ein Prior, der nach Kollektivwissen aussieht,
 * in Wahrheit aber aus einem einzigen Konto stammt, würde neue Konten mit
 * einer Einstellung starten lassen, für die es keinen Beleg gibt. Die Tests
 * halten deshalb vor allem die Schwellen und die Zählweise fest.
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_ACCOUNTS,
  MIN_JUDGED,
  buildPriors,
  mergeAxisStat,
  orderByPrior,
  recommendedStart,
  type GlobalAxisStats,
} from '../src/globalLearning.js';

describe('mergeAxisStat', () => {
  it('schreibt additiv fort — dieselbe Disziplin wie bei den Forecast-Kombis', () => {
    let s = mergeAxisStat(undefined, { promoted: true, edge: 2.5 }, true);
    s = mergeAxisStat(s, { promoted: false, edge: -1.5 }, true);
    expect(s).toEqual({ judged: 2, promoted: 1, edgeSum: 1, accounts: 2 });
  });

  it('zählt ein Konto nur EINMAL, auch bei täglicher Prüfung', () => {
    // Der scharfe Fall: Ein Konto, das dieselbe Variante zwanzig Tage prüft,
    // wäre sonst zwanzig „Konten" und täuschte eine Breite vor, die es nicht
    // gibt — genau die Überschätzung, die dieses Modul vermeiden soll.
    let s = mergeAxisStat(undefined, { promoted: false, edge: 1 }, true);
    for (let i = 0; i < 19; i++) s = mergeAxisStat(s, { promoted: false, edge: 1 }, false);
    expect(s.judged).toBe(20);
    expect(s.accounts).toBe(1);
  });

  it('behandelt NaN-Vorsprünge als 0 statt die Summe zu vergiften', () => {
    // Ein einziges NaN würde edgeSum dauerhaft auf NaN nageln — und der
    // Prior wäre für immer stumm, ohne dass irgendwo ein Fehler stünde.
    const s = mergeAxisStat(undefined, { promoted: false, edge: Number.NaN }, true);
    expect(s.edgeSum).toBe(0);
  });
});

const stat = (judged: number, promoted: number, edgeSum: number, accounts: number) => ({
  judged,
  promoted,
  edgeSum,
  accounts,
});

describe('buildPriors', () => {
  it('schweigt, solange zu wenige KONTEN beigetragen haben', () => {
    // Bei einem Konto ist der „globale" Wert dessen eigener. Ihn als
    // Kollektivwissen auszugeben wäre eine Selbsttäuschung.
    const stats: GlobalAxisStats = { 'minHoldMin=120': stat(50, 40, 200, 1) };
    expect(buildPriors(stats)).toEqual([]);
  });

  it('schweigt auch, solange zu wenige PRÜFUNGEN vorliegen', () => {
    // Viele Konten mit je zwei Trades sind Breite ohne Tiefe.
    const stats: GlobalAxisStats = { 'minHoldMin=120': stat(4, 4, 40, 8) };
    expect(buildPriors(stats)).toEqual([]);
  });

  it('spricht, sobald beide Schwellen erreicht sind', () => {
    const stats: GlobalAxisStats = {
      'minHoldMin=120': stat(MIN_JUDGED, 5, 20, MIN_ACCOUNTS),
    };
    const p = buildPriors(stats);
    expect(p.length).toBe(1);
    expect(p[0]!.meanEdge).toBe(2);
    expect(p[0]!.promoteRate).toBe(0.5);
  });

  it('Beförderungsquote schlägt einen großen Mittelwert', () => {
    // Eine Variante, die vielfach die lokale Signifikanzprüfung bestand,
    // ist verlässlicher als eine, deren Mittelwert ein Glückstreffer trägt.
    const stats: GlobalAxisStats = {
      'a=1': stat(20, 16, 20, 6), // Quote 0,80 · Ø 1,0
      'b=2': stat(20, 2, 400, 6), // Quote 0,10 · Ø 20,0
    };
    expect(buildPriors(stats).map((p) => p.variantId)).toEqual(['a=1', 'b=2']);
  });

  it('confidence steigt mit Konten UND Prüfungen, gedeckelt bei 1', () => {
    const wenig = buildPriors({ x: stat(MIN_JUDGED, 5, 10, MIN_ACCOUNTS) })[0]!;
    const viel = buildPriors({ x: stat(MIN_JUDGED * 5, 25, 50, MIN_ACCOUNTS * 4) })[0]!;
    expect(wenig.confidence).toBeLessThan(viel.confidence);
    expect(viel.confidence).toBeLessThanOrEqual(1);
  });
});

describe('orderByPrior', () => {
  const v = (id: string) => ({ id });

  it('zieht bewährte Varianten nach vorn', () => {
    const varianten = [v('a=1'), v('b=2'), v('c=3')];
    const priors = buildPriors({
      'c=3': stat(20, 18, 40, 6),
      'a=1': stat(20, 4, 10, 6),
    });
    expect(orderByPrior(varianten, priors).map((x) => x.id)).toEqual(['c=3', 'a=1', 'b=2']);
  });

  it('verwirft NIE eine unbekannte Variante', () => {
    // Sonst würde nie wieder etwas Neues geprüft, und das Kollektiv säße in
    // seinem eigenen lokalen Optimum fest.
    const varianten = [v('neu=9'), v('bekannt=1')];
    const priors = buildPriors({ 'bekannt=1': stat(20, 18, 40, 6) });
    const out = orderByPrior(varianten, priors);
    expect(out.length).toBe(2);
    expect(out.map((x) => x.id)).toContain('neu=9');
  });

  it('ohne Prior bleibt die Ursprungsreihenfolge', () => {
    const varianten = [v('a'), v('b'), v('c')];
    expect(orderByPrior(varianten, []).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('verändert die Eingabeliste nicht', () => {
    const varianten = [v('a=1'), v('b=2')];
    orderByPrior(varianten, buildPriors({ 'b=2': stat(20, 18, 40, 6) }));
    expect(varianten.map((x) => x.id)).toEqual(['a=1', 'b=2']);
  });
});

describe('recommendedStart', () => {
  it('empfiehlt höchstens EINE Änderung je Achse', () => {
    // Zwei Werte derselben Achse zu stapeln ergäbe eine Kombination, die so
    // nie geprüft wurde — und die letzte gewänne willkürlich.
    const priors = buildPriors({
      'minHoldMin=120': stat(20, 18, 40, 6),
      'minHoldMin=240': stat(20, 16, 30, 6),
      'cooldownMin=60': stat(20, 17, 35, 6),
    });
    const start = recommendedStart(priors);
    expect(start.filter((id) => id.startsWith('minHoldMin=')).length).toBe(1);
    expect(start).toContain('cooldownMin=60');
  });

  it('empfiehlt nichts, dessen Vorsprung ≤ 0 ist', () => {
    // Eine hohe Beförderungsquote bei negativem Mittel heißt: Es gab ein
    // paar signifikante Treffer und viele teure Fehlschläge.
    const priors = buildPriors({ 'x=1': stat(20, 18, -40, 6) });
    expect(recommendedStart(priors)).toEqual([]);
  });

  it('empfiehlt nichts unterhalb der Beförderungsquote', () => {
    const priors = buildPriors({ 'x=1': stat(20, 4, 40, 6) }); // Quote 0,2
    expect(recommendedStart(priors)).toEqual([]);
  });

  it('leeres Vorwissen ⇒ leere Empfehlung, kein Fehler', () => {
    expect(recommendedStart([])).toEqual([]);
  });
});
