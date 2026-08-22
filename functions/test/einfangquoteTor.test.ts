/**
 * Hebel 1a — die gemessene Einfangquote erreicht das Kosten-Tor (22.08.).
 *
 * ── Die Lücke, die das schließt ───────────────────────────────────────────
 *
 * Die Einfangquote ist die einzige klassen-scharfe Stellschraube der
 * Kostenhürde. Sie war eine Konstante aus EINER Messwoche, und ihr eigener
 * Quelltext sagt seit dem 04.08., sie „gehört aus der laufenden Attribution
 * nachgeführt statt hier gepflegt". `captureLearning.ts` rechnet diese
 * Nachführung seit dem 11.08. auch aus — und der Herzschlag BERICHTET sie.
 *
 * Nur: Im Tor kam sie nie an. `scanMarket` rechnet die scharfe Fassung mit
 * `captureForClass(klasse)`, also mit der Konstante. Zwischen Bericht und
 * Wirkung lag eine Lücke, die man dem Bericht nicht ansieht.
 *
 * ── Warum zuerst nur gezählt wird ─────────────────────────────────────────
 *
 * Weil von hier aus niemand sehen kann, wie viele Signale je Klasse schon
 * vorliegen und welche Quote sie ergäben. Ein Tor scharf zu schalten, dessen
 * Wirkung man nicht beziffern kann, ist genau die Sorte Änderung, gegen die
 * das Red-Team in CLAUDE.md §11 antritt. Der Zähler beziffert sie erst.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  captureForClass,
  costGate,
  wirksameEinfangquote,
  QUOTE_MIN_N,
  QUOTE_UNTERGRENZE,
} from '../../shared/src/index.js';

const hier = dirname(fileURLToPath(import.meta.url));
const scan = readFileSync(join(hier, '../src/scheduled/scanMarket.ts'), 'utf8');

/** Ein Halte-Schatten-Stand mit gegebener Einfangquote. */
const stand = (n: number, erwartet: number, quote: number) => ({
  nErwartet: n,
  erwartetPct: erwartet,
  rohBeiErwartetPct: erwartet * quote,
});

/** Dieselben Eingaben wie im Tor, nur die Quote wechselt. */
const basis = {
  atrPct: 1.2,
  minHoldMin: 2880,
  timeframe: 'daily' as const,
  atrSessionMin: 1440,
  feeRate: 0.0025,
};

describe('gemessene Quote kann die Hürde nur ANZIEHEN', () => {
  it('eine schlechtere Messung senkt die Quote unter die Annahme', () => {
    const b = wirksameEinfangquote('crypto', stand(QUOTE_MIN_N, 2, 0.03));
    expect(b.herkunft).toBe('gemessen');
    expect(b.quote).toBeLessThan(captureForClass('crypto'));
  });

  it('eine BESSERE Messung hebt die Quote nicht an', () => {
    const b = wirksameEinfangquote('crypto', stand(QUOTE_MIN_N, 2, 0.9));
    expect(b.quote).toBe(captureForClass('crypto'));
    // Die Messung bleibt trotzdem sichtbar — sonst sähe der Bericht aus,
    // als hätte niemand gemessen.
    expect(b.gemessen).toBeGreaterThan(captureForClass('crypto'));
  });

  it('zu wenige Signale ⇒ Konstante, nicht Messung', () => {
    const b = wirksameEinfangquote('crypto', stand(QUOTE_MIN_N - 1, 2, 0.001));
    expect(b.quote).toBe(captureForClass('crypto'));
    expect(b.herkunft).toBe('annahme_zu_wenig_daten');
  });

  it('über ALLE Klassen gilt: Messfassung ist nie durchlässiger', () => {
    for (const kl of ['crypto', 'stocks_us', 'etf_thematic', 'commodities', 'gibtsnicht']) {
      const gemessen = wirksameEinfangquote(kl, stand(QUOTE_MIN_N, 2, 0.02)).quote;
      const scharf = costGate({ ...basis, capture: captureForClass(kl) });
      const mess = costGate({ ...basis, capture: gemessen });
      // Gleiche Kosten, gleiche Bewegung — nur die eingefangene Kante sinkt.
      expect(mess.needPct).toBe(scharf.needPct);
      expect(mess.edgePct).toBeLessThanOrEqual(scharf.edgePct);
      if (!scharf.ok) expect(mess.ok).toBe(false);
    }
  });

  it('die Untergrenze hält die Tür einen Spalt offen', () => {
    // Quote 0 würde eine Klasse unbefristet und in JEDEM Marktzustand
    // sperren — die Signalquelle bekäme nie wieder eine Gelegenheit.
    const b = wirksameEinfangquote('crypto', stand(QUOTE_MIN_N, 2, 0));
    expect(b.quote).toBe(QUOTE_UNTERGRENZE);
    expect(b.quote).toBeGreaterThan(0);
  });
});

describe('Quelltext-Wächter: gezählt, nicht entschieden', () => {
  it('die scharfe Fassung rechnet weiter mit der Konstante', () => {
    const treffer = scan.match(/const mitKante = costGate\(\{ \.\.\.kostenBasis, capture: captureForClass\(klasse\) \}\);/g) ?? [];
    expect(treffer, 'scharfe Fassung fehlt oder ist dupliziert').toHaveLength(1);
  });

  it('die Messfassung fließt NUR in den Zähler, nie in die Entscheidung', () => {
    // Das ist die eigentliche Sicherheitsaussage dieses Wächters. Wer
    // `mitMessung` scharf schaltet, muss diesen Test bewusst anfassen —
    // und damit die Owner-Entscheidung treffen, statt sie zu verrutschen.
    const vorkommen = scan.match(/mitMessung/g) ?? [];
    expect(vorkommen.length, 'mitMessung verschwunden').toBeGreaterThanOrEqual(2);
    expect(scan).toContain('if (kosten.ok && !mitMessung.ok) gate.quote_wuerde_blocken += 1;');
    // Keine Rückgabe und keine Zuweisung an `kosten`/`kostenShort`.
    expect(scan).not.toMatch(/return[^;]*mitMessung/);
    expect(scan).not.toMatch(/const kosten\s*=\s*[^;]*mitMessung/);
    expect(scan).not.toMatch(/const kostenShort\s*=\s*[^;]*mitMessung/);
  });

  it('der Zähler zählt nur, was die scharfe Fassung DURCHLÄSST', () => {
    // Ohne `kosten.ok &&` stünde derselbe Einstieg in zwei Zählern und
    // läse sich wie doppelte Wirkung.
    expect(scan).toContain('if (kosten.ok && !mitMessung.ok)');
  });

  it('das Tor liest die HALTE-Reihe, nicht die Fünf-Minuten-Reihe', () => {
    // Fünf Minuten gegen eine Mindesthalte von 2 880 Minuten wäre derselbe
    // Kategorienfehler, den der Halte-Schatten am 17.08. behoben hat.
    const block = scan.slice(scan.indexOf('let quotenStand'), scan.indexOf('await migrateTimeframeDaily'));
    expect(block).toContain("vor.get('klassenHalte')");
    expect(block).not.toContain("vor.get('klassen')");
  });

  it('ein Lesefehler blockiert den Handel nicht', () => {
    const block = scan.slice(scan.indexOf('let quotenStand'), scan.indexOf('await migrateTimeframeDaily'));
    expect(block).toContain('catch');
    expect(block).toContain('logger.warn');
    // Startwert leer ⇒ wirksameEinfangquote fällt auf die Konstante zurück.
    expect(scan).toContain('let quotenStand: Record<string, SchattenAuswertung> = {};');
  });
});
