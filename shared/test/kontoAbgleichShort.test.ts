/**
 * Short-bewusster Kontoabgleich (Audit 13.08., H3 Alpaca-Grenze).
 *
 * Das Buch führt Leerverkäufe als 100-%-Margin (Cash sinkt um
 * Menge × Einstand), Alpaca schreibt den Erlös GUT (Cash steigt um
 * denselben Betrag). Je offenem Short liegen die Kontostände damit
 * systematisch 2 × Menge × Einstand auseinander — bei korrekter
 * Buchführung auf BEIDEN Seiten. Ohne Korrektur war die Einstiegs-Sperre
 * ab ~2,5 % Equity in Shorts dauerhaft an, und ein Dauer-Alarm macht
 * blind für echte Fälle wie die 84 598 $ vom 12.08.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { kontoAbgleich } from '../src/kontoAbgleich.js';

/* Der Lehrbuch-Fall: 10 000 $ Konto, ein Short über 100 Stück zu 50 $.
 * Buch: 10 000 − 5 000 Margin = 5 000. Alpaca: 10 000 + 5 000 Erlös = 15 000. */
const BUCH = { cash: 5_000, equity: 10_000 };
const BROKER = { cash: 15_000, equity: 10_000 };
const SHORT_MARGIN = 5_000;

describe('kontoAbgleich — short-bewusst', () => {
  it('die erwartete Short-Differenz ist KEINE Drift', () => {
    const b = kontoAbgleich(BUCH, BROKER, undefined, undefined, SHORT_MARGIN);
    expect(b.zustand).toBe('sauber');
    expect(b.cashDiff).toBe(0);
    expect(b.sperre).toBe(false);
  });

  it('ohne die Korrektur wäre dasselbe Konto dauerhaft gesperrt — der Befund', () => {
    const b = kontoAbgleich(BUCH, BROKER);
    expect(b.zustand).toBe('grob');
    expect(b.sperre).toBe(true);
  });

  it('sicheresCash rechnet auf dem NORMALISIERTEN Broker-Cash', () => {
    // Broker 15 000 − 2×5 000 = 5 000 vergleichbar; min(5 000, 5 000) = 5 000.
    expect(kontoAbgleich(BUCH, BROKER, undefined, undefined, SHORT_MARGIN).sicheresCash).toBe(5_000);
    // Läge das Buch ZU HOCH, deckt die Normalisierung das echte Loch auf:
    // Broker vergleichbar 5 000 < Buch 8 000 ⇒ mit 5 000 wird gerechnet.
    expect(
      kontoAbgleich({ cash: 8_000, equity: 10_000 }, BROKER, undefined, undefined, SHORT_MARGIN)
        .sicheresCash,
    ).toBe(5_000);
  });

  it('eine echte Drift bleibt trotz Korrektur sichtbar', () => {
    // Broker fehlt zusätzlich 8 000 $ (unverbuchte Käufe wie am 12.08.).
    const b = kontoAbgleich(
      BUCH,
      { cash: 7_000, equity: 10_000 },
      undefined,
      undefined,
      SHORT_MARGIN,
    );
    expect(b.cashDiff).toBe(-8_000);
    expect(b.zustand).toBe('grob');
    expect(b.sperre).toBe(true);
  });

  it('unsinnige Korrektur zählt als 0 — nie eine erfundene Differenz wegrechnen', () => {
    expect(kontoAbgleich(BUCH, BROKER, undefined, undefined, Number.NaN).zustand).toBe('grob');
    expect(kontoAbgleich(BUCH, BROKER, undefined, undefined, -5_000).zustand).toBe('grob');
  });
});

describe('Short-Korrektur — die Verdrahtung (Quelltext-Wächter)', () => {
  it('der Abgleich liefert die Short-Margin aus den eigenen Positionen', () => {
    const hier = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(hier, '../../functions/src/core/brokerAbgleich.ts'),
      'utf8',
    );
    expect(src).toContain("p.side === 'short'");
    expect(src).toMatch(/kontoAbgleich\(\s*\{ cash: buch\.cash[\s\S]{0,200}shortMargin,\s*\)/);
  });
});
