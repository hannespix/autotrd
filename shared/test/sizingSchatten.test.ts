/**
 * Wächter der Sizing-Schattenmessung (Kapital-Panel 21.08., Hebel 2).
 *
 * Die Zahlen aus dieser Datei entscheiden später, ob die Positionsgröße von
 * Cash- auf Equity-Basis umgestellt wird. Sie müssen deshalb genau das
 * messen, was der Broker real täte — inklusive seiner Klemmen.
 */
import { describe, expect, it } from 'vitest';
import { fasseSizingSchatten, sizingSchatten } from '../src/sizingSchatten.js';

const basis = {
  effPreis: 100,
  deckung: 4_000,
  equity: 10_000,
  maxPositionPct: 10,
  sizeFactor: 1,
  fractional: false,
};

describe('Was wäre gewesen — Equity-Tranche neben der gebuchten', () => {
  it('der Kern des Owner-Befunds: investierter Sockel schrumpft die nächste Tranche', () => {
    /* 10 000 Equity, davon 6 000 investiert ⇒ 4 000 Cash. Die „10-%-Position"
     * ist real 400 $ (4 % der Equity) statt 1 000 $. */
    const s = sizingSchatten({ ...basis, istQty: 4 });
    expect(s.istWert).toBe(400);
    expect(s.sollWert).toBe(1_000);
    expect(s.mehrPct).toBe(150);
  });

  it('meldet Kollision, wenn der Cash die Soll-Position NICHT deckt', () => {
    // Genau die zu_wenig_cash-Falle, an der die fixe Tranche scheiterte.
    expect(sizingSchatten({ ...basis, istQty: 4, deckung: 800 }).kollision).toBe(true);
    expect(sizingSchatten({ ...basis, istQty: 4, deckung: 4_000 }).kollision).toBe(false);
  });

  it('bei vollem Cash ist kein Unterschied — die Messung erfindet keinen Effekt', () => {
    const s = sizingSchatten({ ...basis, istQty: 10, deckung: 10_000, equity: 10_000 });
    expect(s.sollWert).toBe(s.istWert);
    expect(s.mehrPct).toBe(0);
    expect(s.kollision).toBe(false);
  });

  it('rechnet mit denselben Klemmen wie der Broker: Faktor 0,25–1,5 und Deckel 25 %', () => {
    // sizeFactor 9 ⇒ auf 1,5 geklemmt; 10 % × 1,5 = 15 %.
    expect(sizingSchatten({ ...basis, istQty: 1, sizeFactor: 9 }).sollWert).toBe(1_500);
    // 30 % × 1,5 = 45 % ⇒ Deckel 25 %.
    expect(sizingSchatten({ ...basis, istQty: 1, maxPositionPct: 30, sizeFactor: 9 }).sollWert).toBe(2_500);
    // Unsinniger Faktor ⇒ neutral 1, nicht 0.
    expect(sizingSchatten({ ...basis, istQty: 1, sizeFactor: Number.NaN }).sollWert).toBe(1_000);
  });

  it('stückelt wie der Broker: ganze Stücke, Krypto in µ-Einheiten', () => {
    // 1 000 $ / 300 $ = 3,33 ⇒ 3 Stück.
    expect(sizingSchatten({ ...basis, istQty: 1, effPreis: 300 }).sollQty).toBe(3);
    // Krypto: 1 000 $ / 64 000 $ ⇒ 0,015625 (ohne Bruchteile wäre es 0).
    const krypto = sizingSchatten({ ...basis, istQty: 0.006, effPreis: 64_000, fractional: true });
    expect(krypto.sollQty).toBeCloseTo(0.015625, 6);
    expect(sizingSchatten({ ...basis, istQty: 0.006, effPreis: 64_000 }).sollQty).toBe(0);
  });

  it('bleibt ehrlich bei Rand-Eingaben — kein Faktor auf einer Null', () => {
    expect(sizingSchatten({ ...basis, istQty: 0 }).mehrPct).toBeNull();
    expect(sizingSchatten({ ...basis, istQty: 4, effPreis: 0 }).sollQty).toBe(0);
    expect(sizingSchatten({ ...basis, istQty: 4, equity: -500 }).sollQty).toBe(0);
  });
});

describe('Aggregat — die Grundlage der Freigabe-Entscheidung', () => {
  it('summiert Werte und Kollisionsquote über viele Einstiege', () => {
    const zeilen = [
      sizingSchatten({ ...basis, istQty: 4 }),
      sizingSchatten({ ...basis, istQty: 4, deckung: 500 }),
      sizingSchatten({ ...basis, istQty: 10, deckung: 10_000, equity: 10_000 }),
    ];
    const summe = fasseSizingSchatten(zeilen);
    expect(summe.n).toBe(3);
    expect(summe.istWert).toBe(1_800);
    expect(summe.sollWert).toBe(3_000);
    expect(summe.kollisionen).toBe(1);
    expect(summe.kollisionsQuotePct).toBeCloseTo(33.33, 1);
    expect(summe.mehrPct).toBeCloseTo(66.67, 1);
  });

  it('leeres Aggregat behauptet nichts', () => {
    const leer = fasseSizingSchatten([]);
    expect(leer.n).toBe(0);
    expect(leer.mehrPct).toBeNull();
    expect(leer.kollisionsQuotePct).toBeNull();
  });
});
