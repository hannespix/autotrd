/**
 * Wächter des Story-Videos (Owner 20.08.).
 *
 * Ehrlichkeit ist nicht animierbar: Das Papier-Siegel muss auf JEDEM Frame
 * jeder Zahlen-Szene in voller Deckkraft stehen — auch beim allerersten
 * (p=0) und letzten (p=1). Die Einladungs-Szene behauptet keine Ziffer.
 * Der Stub zeichnet jeden fillText mitsamt der in dem Moment wirksamen
 * Deckkraft auf — genau die Größen, um die es geht.
 */
import { zerlegeDepot } from '@autotrd/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ShareDaten } from '../src/shareCard.js';
import { maleSzene, videoSzenen, zerlegeHaupt } from '../src/shareVideo.js';

beforeEach(() => {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => undefined,
  } as unknown as Storage;
});

/** Aufzeichnender 2D-Kontext: Texte mit Deckkraft, sonst stumme Züge. */
class StubKontext {
  globalAlpha = 1;
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 0;
  font = '';
  textAlign = 'left';
  texte: Array<{ text: string; alpha: number }> = [];
  fillText(text: string): void {
    this.texte.push({ text, alpha: this.globalAlpha });
  }
  strokeText(): void {}
  measureText(text: string): { width: number } {
    return { width: text.length * 14 };
  }
  fillRect(): void {}
  beginPath(): void {}
  closePath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  arcTo(): void {}
  arc(): void {}
  fill(): void {}
  stroke(): void {}
  setLineDash(): void {}
  save(): void {}
  restore(): void {}
  scale(): void {}
}

function fixture(): ShareDaten {
  const tage = [
    { date: '2026-08-14', equity: 10_000 },
    { date: '2026-08-17', equity: 10_120 },
    { date: '2026-08-19', equity: 10_240 },
  ];
  const trades = [
    { symbol: 'NVDA', side: 'sell', qty: 1, price: 100, pnl: 180, executedAt: '2026-08-16T19:00:00.000Z' },
    { symbol: 'EWJ', side: 'sell', qty: 1, price: 100, pnl: -60, executedAt: '2026-08-17T19:00:00.000Z' },
  ];
  return {
    zerlegung: zerlegeDepot(tage, trades),
    renditePct: 2.4,
    ergebnis: 240,
    waehrung: 'USD',
    trefferquotePct: 50,
    profitFaktor: 3,
    trades: 2,
    maxDrawdownPct: -1.1,
    bestes: { label: 'NVDA', pct: 1.8 },
    schlechtestes: { label: 'EWJ', pct: -0.6 },
    echtgeld: false,
    betraege: false,
    tradeBilanz: 120,
    vonTag: '2026-08-16',
    bisTag: '2026-08-17',
  };
}

const male = (id: 'ergebnis' | 'verlauf' | 'womit' | 'cta', p: number): StubKontext => {
  const ctx = new StubKontext();
  maleSzene(ctx as unknown as CanvasRenderingContext2D, fixture(), id, p);
  return ctx;
};

describe('videoSzenen — gleiche Auswahllogik wie die Karten', () => {
  it('volle Daten ⇒ vier Szenen, ohne Kurve nur Ergebnis + Einladung', () => {
    expect(videoSzenen(fixture()).map((s) => s.id)).toEqual(['ergebnis', 'verlauf', 'womit', 'cta']);
    const leer = { ...fixture(), zerlegung: zerlegeDepot([], []) };
    expect(videoSzenen(leer).map((s) => s.id)).toEqual(['ergebnis', 'cta']);
  });
});

describe('Ehrlichkeit im Bewegtbild', () => {
  it('das Siegel steht auf JEDEM Frame jeder Zahlen-Szene in voller Deckkraft', () => {
    for (const id of ['ergebnis', 'verlauf', 'womit'] as const) {
      for (const p of [0, 0.01, 0.5, 1]) {
        const siegel = male(id, p).texte.find((z) => z.text === 'PAPIERKONTO');
        expect(siegel, `${id} bei p=${p}`).toBeDefined();
        expect(siegel!.alpha, `${id} bei p=${p}`).toBe(1);
      }
    }
  });

  it('die Einladungs-Szene behauptet keine Ziffer — zu keinem Zeitpunkt', () => {
    for (const p of [0.2, 0.6, 1]) {
      for (const z of male('cta', p).texte) {
        expect(z.text, `CTA p=${p}: „${z.text}"`).not.toMatch(/\d/);
      }
    }
  });

  it('die Zahl zählt hoch: unterwegs kleiner, am Ende exakt die Aussage', () => {
    const unterwegs = male('ergebnis', 0.2).texte.map((z) => z.text);
    const ende = male('ergebnis', 1).texte.map((z) => z.text);
    expect(ende).toContain('+2,40 %');
    expect(unterwegs).not.toContain('+2,40 %');
  });
});

describe('zerlegeHaupt — die Zerlegung fürs Hochzählen', () => {
  it('zerlegt Vorzeichen, Wert, Dezimalstellen und Rest', () => {
    expect(zerlegeHaupt('+6,40 %')).toEqual({ vorzeichen: '+', wert: 6.4, dezimal: 2, rest: ' %' });
    expect(zerlegeHaupt('−12,3 %')).toEqual({ vorzeichen: '−', wert: 12.3, dezimal: 1, rest: ' %' });
  });

  it('Unparsebares wird nicht angefasst', () => {
    expect(zerlegeHaupt('Noch keine abgeschlossenen Trades')).toBeNull();
  });
});
