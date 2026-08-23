/**
 * Teilausführung beim SCHLIESSEN — Befund 23.08.
 *
 * `executeTrade` reicht die tatsächlich ausgeführte Menge als `req.qty` an die
 * Buchung weiter, mit einem Kommentar, der die Absicht wörtlich benennt: „Die
 * AUSGEFÜHRTE Menge gilt, nicht die geplante". Die beiden schließenden Zweige
 * lasen `req.qty` bis heute nicht — sie rechneten mit `pos.qty` und löschten
 * die Position.
 *
 * Der Schutz-Stop macht daraus einen sicheren Schaden statt eines zufälligen:
 * Er STORNIERT bei einer Teilausführung den Rest der Stop-Order
 * (`schutzStop.ts`) und übergibt `fillQty` — der Rest füllt also garantiert
 * nie nach. Gebucht wurde trotzdem die ganze Position.
 *
 * Der teurere Teil ist nicht das Geld, sondern die verlorene Aufsicht: Was
 * beim Broker liegt, aber in keinem Buch steht, hat weder Stop noch Trailing
 * noch Signal-Exit — und der Positionsabgleich stuft es als „Fremdbestand"
 * ein, also HARMLOS und ohne Sperre. Beim Short bleibt so ein offener
 * Leerverkauf ohne Absicherung zurück.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schlussMenge } from '../src/core/broker.js';

describe('schlussMenge — was eine schließende Buchung wirklich bewegt', () => {
  describe('Vollausführung: alles bleibt wie bisher', () => {
    it('schließt ganz, wenn die Wunschmenge der Position entspricht', () => {
      expect(schlussMenge(10, 10)).toEqual({ menge: 10, rest: 0, ganz: true });
    });

    it('schließt ganz, wenn keine Menge angegeben ist', () => {
      // Der Normalfall aller Aufrufer: `callable/trade.ts` setzt beim Verkauf
      // bewusst kein `qty`. Eine fehlende Angabe darf nie einen Rest erzeugen,
      // den niemand angefordert hat.
      expect(schlussMenge(7, undefined)).toEqual({ menge: 7, rest: 0, ganz: true });
    });

    it('bucht NIE mehr als die offene Menge', () => {
      // Ein Fill über die Position hinaus wäre ein Leerverkauf aus Versehen.
      expect(schlussMenge(5, 8)).toEqual({ menge: 5, rest: 0, ganz: true });
    });

    it('behandelt unbrauchbare Angaben wie „keine Angabe"', () => {
      expect(schlussMenge(4, 0).ganz).toBe(true);
      expect(schlussMenge(4, -3).ganz).toBe(true);
      expect(schlussMenge(4, Number.NaN).ganz).toBe(true);
      expect(schlussMenge(4, Number.POSITIVE_INFINITY).ganz).toBe(true);
    });
  });

  describe('Teilausführung: der eigentliche Befund', () => {
    it('bucht nur den gefüllten Teil und lässt den Rest stehen', () => {
      expect(schlussMenge(40, 12)).toEqual({ menge: 12, rest: 28, ganz: false });
    });

    it('kann auch Bruchstücke (Krypto)', () => {
      const r = schlussMenge(0.5, 0.2);
      expect(r.ganz).toBe(false);
      expect(r.menge).toBeCloseTo(0.2, 12);
      expect(r.rest).toBeCloseTo(0.3, 12);
    });

    it('Menge plus Rest ergibt immer die Position', () => {
      for (const [pos, fill] of [
        [40, 12],
        [3, 1],
        [0.5, 0.2],
        [100, 99],
      ] as const) {
        const r = schlussMenge(pos, fill);
        expect(r.menge + r.rest).toBeCloseTo(pos, 12);
      }
    });
  });

  describe('Float-Rauschen erzeugt keine Geisterposition', () => {
    it('schließt ganz, wenn der Rest unterhalb der Rauschgrenze liegt', () => {
      // Ein Rest von 1e-9 Stück ist nicht handelbar, würde aber ab da in
      // jedem Abgleich als Drift auftauchen.
      expect(schlussMenge(10, 10 - 1e-12).ganz).toBe(true);
      expect(schlussMenge(10, 9.999999999999).ganz).toBe(true);
    });

    it('ein echter Rest bleibt aber ein Rest', () => {
      expect(schlussMenge(10, 9.99).ganz).toBe(false);
    });
  });

  /* ── Was der Fehler in Geld bedeutete ────────────────────────────────────
   *
   * Beispiel aus dem Befund: 40 AAPL zu 220,00 Einstand, Schutz-Stop füllt
   * 12 zu 208,50, Rest storniert. Gebühr bei stocks_us = 0.
   */
  describe('Rechenprobe am Befund-Szenario', () => {
    const posQty = 40;
    const avgEntry = 220;
    const eff = 208.5;

    it('Erlös läuft über den gefüllten Teil, nicht über die Position', () => {
      const { menge } = schlussMenge(posQty, 12);
      expect(menge * eff).toBeCloseTo(2502, 6);
      // Vorher: 40 × 208,50 = 8.340 $ — 5.838 $ zu viel im Barbestand.
      expect(posQty * eff).toBeCloseTo(8340, 6);
    });

    it('realisierter P&L ebenso', () => {
      const { menge } = schlussMenge(posQty, 12);
      expect((eff - avgEntry) * menge).toBeCloseTo(-138, 6);
      // Vorher: −460 $ — ein um 322 $ zu großer Verlust.
    });

    it('und der Rest bleibt im Buch, also unter Aufsicht', () => {
      expect(schlussMenge(posQty, 12).rest).toBe(28);
    });
  });
});

/* ── Quelltext-Wächter ─────────────────────────────────────────────────────
 *
 * Der Fehler war kein Tippfehler, sondern eine Zeile, die sich beim Lesen
 * völlig harmlos ausnimmt (`const qty = pos.qty`). Genau deshalb pinnt ein
 * Wächter sie fest: Wer sie zurückschreibt, bricht den Test, nicht erst das
 * Konto eines Nutzers.
 */
describe('Wächter: die schließenden Zweige lesen die ausgeführte Menge', () => {
  const quelle = readFileSync(join(__dirname, '../src/core/broker.ts'), 'utf8');

  it('beide Schluss-Zweige gehen durch schlussMenge', () => {
    const treffer = quelle.match(/const \{ menge: qty, rest, ganz \} = schlussMenge\(pos\.qty, req\.qty\)/g);
    expect(treffer?.length).toBe(2); // sell und cover
  });

  it('keiner der Schluss-Zweige setzt die Menge mehr blind auf pos.qty', () => {
    expect(quelle).not.toContain('const qty = pos.qty;');
  });

  it('gelöscht wird nur beim vollen Schluss, sonst verkleinert', () => {
    // `tx.delete(posRef)` darf nirgends mehr ohne die Ganz-Bedingung stehen.
    const loeschungen = quelle.match(/tx\.delete\(posRef\)/g) ?? [];
    const bedingte = quelle.match(/if \(ganz\) tx\.delete\(posRef\);\s*\n\s*else tx\.update\(posRef, \{ qty: rest \}\);/g) ?? [];
    expect(loeschungen.length).toBe(bedingte.length);
    expect(bedingte.length).toBe(2);
  });

  it('Erlös, P&L, Margin und Gebühr rechnen mit der gebuchten Menge', () => {
    expect(quelle).toContain('const proceeds = qty * eff;');
    expect(quelle).toContain('const pnl = (eff - pos.avgEntry) * qty;');
    expect(quelle).toContain('const pnl = (pos.avgEntry - eff) * qty;');
    expect(quelle).toContain('const margin = qty * pos.avgEntry;');
    expect((quelle.match(/fee: kosten\(qty\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('ein Teilschluss ist am Trade erkennbar', () => {
    // Ohne Markierung wäre im Nachhinein nicht feststellbar, ob der Fall live
    // überhaupt vorkommt — und genau das ist die offene Frage an die Daten.
    expect((quelle.match(/teilSchluss: true as const/g) ?? []).length).toBe(2);
    expect((quelle.match(/restMenge: rest/g) ?? []).length).toBe(2);
  });
});
