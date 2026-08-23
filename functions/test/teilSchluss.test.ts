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

/* ── Die Gegenprobe zum Fix (Nahtstellen-Prüfung 23.08.) ──────────────────
 *
 * Ein Rest im Buch ist NUR dann harmlos, wenn der Rest der schließenden Order
 * beim Broker tot ist. Eine schließende Order bleibt aber bei ausbleibendem
 * Fill BEWUSST stehen (`orderRouting.ts`: „ein später Fill ist erwünscht").
 * Füllt sie später doch durch, hält der Broker null Stücke — und der nächste
 * Puls sähe im Buch einen Rest, für den er eine ZWEITE Verkaufsorder
 * losschickt. Aus dem Ausstieg würde ein ungewollter Leerverkauf ohne Stop.
 *
 * Nur `pflegeSchutz` storniert den Rest selbst und darf deshalb zusichern.
 * `schutzAufheben` gehört ausdrücklich NICHT dazu: Dort ist der Stornoversuch
 * gerade fehlgeschlagen (`nicht_stornierbar`), die Order lebt weiter.
 */
describe('ohne Zusicherung wird NICHT verkleinert — die wichtigste Sperre', () => {
  it('schließt ganz, wenn der Rest der Order weiterleben könnte', () => {
    expect(schlussMenge(40, 12)).toEqual({ menge: 40, rest: 0, ganz: true });
    expect(schlussMenge(40, 12, false)).toEqual({ menge: 40, rest: 0, ganz: true });
    expect(schlussMenge(40, 12, undefined)).toEqual({ menge: 40, rest: 0, ganz: true });
  });

  it('verkleinert erst mit ausdrücklicher Zusicherung', () => {
    expect(schlussMenge(40, 12, true)).toEqual({ menge: 12, rest: 28, ganz: false });
  });

  it('nur ein echtes true zählt, nichts Wahrheitsähnliches', () => {
    // Ein versehentlich durchgereichter Wahrheitswert darf die Sperre nicht
    // öffnen — die Zusicherung ist eine Aussage über den Broker, kein Schalter.
    expect(schlussMenge(40, 12, 1 as unknown as boolean).ganz).toBe(true);
    expect(schlussMenge(40, 12, 'ja' as unknown as boolean).ganz).toBe(true);
  });
});

describe('schlussMenge — was eine schließende Buchung wirklich bewegt', () => {
  describe('Vollausführung: alles bleibt wie bisher', () => {
    it('schließt ganz, wenn die Wunschmenge der Position entspricht', () => {
      expect(schlussMenge(10, 10, true)).toEqual({ menge: 10, rest: 0, ganz: true });
    });

    it('schließt ganz, wenn keine Menge angegeben ist', () => {
      // Der Normalfall aller Aufrufer: `callable/trade.ts` setzt beim Verkauf
      // bewusst kein `qty`. Eine fehlende Angabe darf nie einen Rest erzeugen,
      // den niemand angefordert hat.
      expect(schlussMenge(7, undefined, true)).toEqual({ menge: 7, rest: 0, ganz: true });
    });

    it('bucht NIE mehr als die offene Menge', () => {
      // Ein Fill über die Position hinaus wäre ein Leerverkauf aus Versehen.
      expect(schlussMenge(5, 8, true)).toEqual({ menge: 5, rest: 0, ganz: true });
    });

    it('behandelt unbrauchbare Angaben wie „keine Angabe"', () => {
      expect(schlussMenge(4, 0, true).ganz).toBe(true);
      expect(schlussMenge(4, -3, true).ganz).toBe(true);
      expect(schlussMenge(4, Number.NaN, true).ganz).toBe(true);
      expect(schlussMenge(4, Number.POSITIVE_INFINITY, true).ganz).toBe(true);
    });
  });

  describe('Teilausführung: der eigentliche Befund', () => {
    it('bucht nur den gefüllten Teil und lässt den Rest stehen', () => {
      expect(schlussMenge(40, 12, true)).toEqual({ menge: 12, rest: 28, ganz: false });
    });

    it('kann auch Bruchstücke (Krypto)', () => {
      const r = schlussMenge(0.5, 0.2, true);
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
        const r = schlussMenge(pos, fill, true);
        expect(r.menge + r.rest).toBeCloseTo(pos, 12);
      }
    });
  });

  describe('Float-Rauschen erzeugt keine Geisterposition', () => {
    it('schließt ganz, wenn der Rest unterhalb der Rauschgrenze liegt', () => {
      // Ein Rest von 1e-9 Stück ist nicht handelbar, würde aber ab da in
      // jedem Abgleich als Drift auftauchen.
      expect(schlussMenge(10, 10 - 1e-12, true).ganz).toBe(true);
      expect(schlussMenge(10, 9.999999999999, true).ganz).toBe(true);
    });

    it('ein echter Rest bleibt aber ein Rest', () => {
      expect(schlussMenge(10, 9.99, true).ganz).toBe(false);
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
      const { menge } = schlussMenge(posQty, 12, true);
      expect(menge * eff).toBeCloseTo(2502, 6);
      // Vorher: 40 × 208,50 = 8.340 $ — 5.838 $ zu viel im Barbestand.
      expect(posQty * eff).toBeCloseTo(8340, 6);
    });

    it('realisierter P&L ebenso', () => {
      const { menge } = schlussMenge(posQty, 12, true);
      expect((eff - avgEntry) * menge).toBeCloseTo(-138, 6);
      // Vorher: −460 $ — ein um 322 $ zu großer Verlust.
    });

    it('und der Rest bleibt im Buch, also unter Aufsicht', () => {
      expect(schlussMenge(posQty, 12, true).rest).toBe(28);
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

  it('beide Zweige reichen die Zusicherung durch — nie ohne', () => {
    const treffer = quelle.match(/schlussMenge\(pos\.qty, req\.qty, req\.restStorniert\)/g);
    expect(treffer?.length).toBe(2);
    // Kein Aufruf ohne drittes Argument: sonst verkleinerte der geroutete
    // Exit-Pfad wieder, und der Rest im Buch würde eine zweite Order auslösen.
    expect(quelle).not.toMatch(/schlussMenge\(pos\.qty, req\.qty\)/);
  });

  it('ein Teilschluss ist am Trade erkennbar', () => {
    // Ohne Markierung wäre im Nachhinein nicht feststellbar, ob der Fall live
    // überhaupt vorkommt — und genau das ist die offene Frage an die Daten.
    expect((quelle.match(/teilSchluss: true as const/g) ?? []).length).toBe(2);
    expect((quelle.match(/restMenge: rest/g) ?? []).length).toBe(2);
  });
});

/* ── Wächter an den Aufrufern ─────────────────────────────────────────────
 *
 * Die Zusicherung darf genau dort stehen, wo sie beweisbar stimmt. Wandert
 * sie irgendwann an eine zweite Stelle, muss das eine bewusste Entscheidung
 * sein — nicht ein Nebeneffekt beim Kopieren eines Aufrufs.
 */
describe('Wächter: wer darf den Rest für tot erklären', () => {
  const scan = readFileSync(join(__dirname, '../src/scheduled/scanMarket.ts'), 'utf8');
  const stop = readFileSync(join(__dirname, '../src/core/schutzStop.ts'), 'utf8');

  it('genau ein Aufrufer im ganzen Scan sichert zu', () => {
    expect((scan.match(/restStorniert: true/g) ?? []).length).toBe(1);
  });

  it('und die Zusicherung stimmt: pflegeSchutz storniert den Rest selbst', () => {
    // Fällt dieses Storno weg, ist die Zusicherung falsch — und der Rest im
    // Buch wäre wieder eine geladene Waffe.
    expect(stop).toMatch(/if \(stand\.status === 'partially_filled'\) \{\s*\n\s*await alpacaOrderStornieren\(/);
  });

  it('schutzAufheben sichert NICHTS zu — dort ist das Storno gescheitert', () => {
    // Der Zweig heißt `nicht_stornierbar`; die Order lebt weiter.
    expect(stop).toContain("// `nicht_stornierbar`: nachsehen, ob (und wie viel) ausgeführt wurde.");
    const aufheben = stop.slice(stop.indexOf('export async function schutzAufheben'));
    const bisNaechste = aufheben.slice(0, aufheben.indexOf('export type SchutzAufhebung') + 1 || aufheben.indexOf('export type SchutzBefund'));
    expect(bisNaechste).not.toContain('restStorniert');
  });

  it('ein Teilschluss überlebt die Buchhaltung des laufenden Scans', () => {
    // Sonst zählt das Positionslimit den Rest nicht, und ein Kauf desselben
    // Symbols liefe in den Nachkauf-Zweig, der Einstand und Stop neu schriebe.
    expect(scan).toContain("if (r.trade?.teilSchluss !== true) positions.delete(symbol);");
  });
});
