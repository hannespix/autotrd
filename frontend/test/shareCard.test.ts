/**
 * Die teilbare Ergebnis-Grafik.
 *
 * Diese Grafik verlässt die App und landet dort, wo niemand nachfragen kann.
 * Zwei der Tests hier sind deshalb keine Formalität, sondern der eigentliche
 * Grund für die Datei:
 *
 *  · Das Papier-Siegel MUSS drauf sein, solange auf Papier gehandelt wird.
 *    Eine Grafik ohne diesen Hinweis ist ein Falschzeugnis — auch wenn der
 *    Absender es nicht so meint.
 *  · Beträge dürfen NUR erscheinen, wenn sie ausdrücklich angeschaltet
 *    wurden. Die Kontogröße gehört niemandem außer dem Besitzer.
 */
import { describe, expect, it } from 'vitest';
import { type DepotTag, type HistoryTrade, zerlegeDepot } from '@autotrd/shared';
import { KARTE, type ShareDaten, shareCard, shareDateiname, shareText } from '../src/shareCard.js';

const SERIE: DepotTag[] = [
  { date: '2026-07-06', equity: 10_000 },
  { date: '2026-07-20', equity: 10_180 },
  { date: '2026-08-07', equity: 10_640 },
];
const TRADES: HistoryTrade[] = [
  { symbol: 'NVDA', side: 'sell', qty: 1, price: 100, pnl: 240, executedAt: '2026-07-20T19:00:00.000Z' },
  { symbol: 'EWJ', side: 'sell', qty: 1, price: 100, pnl: -60, executedAt: '2026-08-07T19:00:00.000Z' },
];

function daten(ueber: Partial<ShareDaten> = {}): ShareDaten {
  return {
    zerlegung: zerlegeDepot(SERIE, TRADES),
    renditePct: 6.4,
    ergebnis: 640,
    waehrung: 'USD',
    trefferquotePct: 52.4,
    profitFaktor: 1.83,
    trades: 2,
    maxDrawdownPct: -4.2,
    bestes: { label: 'NVDA', pct: 2.4 },
    schlechtestes: { label: 'EWJ', pct: -0.6 },
    echtgeld: false,
    betraege: false,
    ...ueber,
  };
}

describe('shareCard — die Regeln, die nicht verhandelbar sind', () => {
  it('trägt das Papier-Siegel, solange auf Papier gehandelt wird', () => {
    expect(shareCard(daten())).toContain('PAPIERKONTO');
  });

  it('schaltet das Siegel auf ECHTGELD um, statt es wegzulassen', () => {
    const svg = shareCard(daten({ echtgeld: true }));
    expect(svg).toContain('ECHTGELD');
    expect(svg).not.toContain('PAPIERKONTO');
  });

  it('zeigt ohne ausdrückliche Freigabe KEINE Beträge', () => {
    const svg = shareCard(daten());
    expect(svg).not.toContain('640,00');
    expect(svg).toContain('Beträge ausgeblendet');
  });

  it('zeigt sie erst, wenn sie angeschaltet wurden', () => {
    const svg = shareCard(daten({ betraege: true }));
    expect(svg).toContain('640,00');
    expect(svg).toContain('USD');
  });

  it('nennt autotrd.net auf jedem Bild', () => {
    expect(shareCard(daten())).toContain('autotrd.net');
    expect(shareCard(daten({ echtgeld: true, betraege: true }))).toContain('autotrd.net');
  });
});

describe('shareCard — Inhalt', () => {
  const svg = shareCard(daten());

  it('ist quadratisch und eigenständig — kein externer Verweis, keine CSS-Variable', () => {
    expect(svg).toContain(`width="${KARTE}" height="${KARTE}"`);
    expect(svg).not.toMatch(/var\(--/);
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it('stellt die Rendite groß voran, mit Vorzeichen', () => {
    expect(svg).toContain('+6,40 %');
  });

  it('färbt ein Minus rot statt es zu verstecken', () => {
    const rot = shareCard(daten({ renditePct: -3.1 }));
    expect(rot).toContain('−3,10 %');
    expect(rot).toContain('#ff5f5f');
  });

  it('nennt Zeitraum, Kennzahlen und die stärksten Beiträge', () => {
    expect(svg).toContain('2026-07-06 → 2026-08-07');
    expect(svg).toContain('TREFFERQUOTE');
    expect(svg).toContain('52,4 %');
    expect(svg).toContain('1,83');
    expect(svg).toContain('NVDA');
  });

  it('escaped Symbolnamen — das Bild darf nicht am Katalog zerbrechen', () => {
    const boes = shareCard(daten({ bestes: { label: 'A"><script>', pct: 1 } }));
    expect(boes).not.toContain('<script>');
  });

  it('kommt ohne Kurve aus, wenn die Serie zu kurz ist', () => {
    const kurz = shareCard(
      daten({ zerlegung: zerlegeDepot([SERIE[0]!], TRADES) }),
    );
    expect(kurz).toContain('zu wenige Tage');
    expect(kurz).toContain('PAPIERKONTO');
  });

  it('fehlende Kennzahlen werden zu Gedankenstrichen, nicht zu Nullen', () => {
    const leer = shareCard(daten({ trefferquotePct: null, profitFaktor: null, maxDrawdownPct: null }));
    expect(leer).toContain('—');
    expect(leer).not.toContain('0,00 %');
  });
});

describe('shareText', () => {
  it('nennt Papierkonto, Zeitraum, Rendite, Trades und den Link', () => {
    const t = shareText(daten());
    expect(t).toContain('(Papierkonto)');
    expect(t).toContain('+6,40 %');
    expect(t).toContain('2 Trades');
    expect(t).toContain('autotrd.net');
  });

  it('lässt den Papier-Zusatz bei Echtgeld weg', () => {
    expect(shareText(daten({ echtgeld: true }))).not.toContain('Papierkonto');
  });
});

describe('shareDateiname', () => {
  it('trägt den letzten Tag im Namen, damit Bilder unterscheidbar bleiben', () => {
    expect(shareDateiname(daten())).toBe('autotrd-depot-2026-08-07.png');
  });

  it('kommt ohne Serie klar', () => {
    expect(shareDateiname(daten({ zerlegung: zerlegeDepot([], []) }))).toBe(
      'autotrd-depot-aktuell.png',
    );
  });
});
