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
import {
  type DepotTag,
  type HistoryTrade,
  waehleKurve,
  zerlegeDepot,
} from '@autotrd/shared';
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
    tradeBilanz: 180,
    vonTag: '2026-07-20',
    bisTag: '2026-08-07',
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

describe('Kurve aus Trades, wenn Snapshots fehlen (Owner-Befund 12.08.)', () => {
  /* Der Anlassfall: Die Karte zeigte „0,00 %", „noch kein Zeitraum" und
   * „Noch zu wenige Tage für eine Kurve" — bei NEUN geschlossenen Trades mit
   * Profit-Faktor 0,12. Die Kurve kam ausschliesslich aus Tages-Snapshots;
   * das Handelsjournal war voll und wurde nicht gelesen.
   *
   * Geprüft wird die KARTE, nicht nur die Rechenfunktion: Ein Test, der
   * `waehleKurve` bestätigt, kann nicht sagen, was im SVG steht. */
  const NEUN: HistoryTrade[] = [
    ['2026-08-10T14:00:00.000Z', -510.26],
    ['2026-08-10T15:00:00.000Z', -180.4],
    ['2026-08-10T16:00:00.000Z', 95.2],
    ['2026-08-11T14:00:00.000Z', -310.5],
    ['2026-08-11T15:00:00.000Z', -88.9],
    ['2026-08-11T16:00:00.000Z', 140.1],
    ['2026-08-12T14:00:00.000Z', -402.3],
    ['2026-08-12T15:00:00.000Z', -120.0],
    ['2026-08-12T16:00:00.000Z', 57.5],
  ].map(([at, pnl], i) => ({
    symbol: `SYM${i}`,
    side: 'sell' as const,
    qty: 1,
    price: 100,
    pnl: pnl as number,
    executedAt: at as string,
  }));

  const ohneSnapshots = (): ShareDaten => {
    const wahl = waehleKurve(
      [],
      NEUN.map((t) => ({ at: t.executedAt, pnl: t.pnl ?? 0 })),
      100_000,
    );
    return daten({
      zerlegung: zerlegeDepot(wahl.serie, NEUN),
      trades: 9,
      profitFaktor: 0.12,
      tradeBilanz: -1_319.56,
      vonTag: '2026-08-10',
      bisTag: '2026-08-12',
    });
  };

  it('zeichnet eine Kurve statt „Noch zu wenige Tage"', () => {
    const svg = shareCard(ohneSnapshots());
    expect(svg).not.toContain('Noch zu wenige Tage');
    // Eine Linie mit mehreren Stützstellen — nicht nur ein Strich.
    // (kurvenPfad liefert `points` für polyline/polygon, kein path-`d`.)
    const linie = /points="([^"]+)"/.exec(svg);
    expect(linie).not.toBeNull();
    expect(linie![1]!.trim().split(/\s+/).length).toBeGreaterThanOrEqual(4);
  });

  it('nennt einen echten Zeitraum statt „noch kein Zeitraum"', () => {
    const svg = shareCard(ohneSnapshots());
    expect(svg).not.toContain('noch kein Zeitraum');
    expect(svg).toContain('2026-08-12');
  });

  it('bleibt bei leerer Lage ehrlich — keine Kurve ohne Daten', () => {
    const leer = daten({
      zerlegung: zerlegeDepot([], []),
      trades: 0,
      tradeBilanz: 0,
      vonTag: undefined,
      bisTag: undefined,
    });
    expect(shareCard(leer)).toContain('Noch zu wenige Tage');
  });
});

describe('Ohne Zeitraum keine Prozentzahl (Owner-Befund 12.08.)', () => {
  /* Die Karte zeigte „0,00 %" in GRÜN neben Profit-Faktor 0,12 und
   * „noch kein Zeitraum". Sie verlässt die App mit Markenlogo und
   * „offen nachgerechnet" im Fuß — eine falsche Aussage wiegt hier
   * schwerer als in jeder internen Ansicht. */

  const leereKurveMitTrades = (): ShareDaten =>
    daten({
      zerlegung: zerlegeDepot([], []),
      renditePct: 0,
      ergebnis: 0,
      trades: 9,
      tradeBilanz: -1_719.54,
      profitFaktor: 0.12,
      trefferquotePct: 33.3,
      maxDrawdownPct: null,
      bestes: null,
      schlechtestes: null,
      betraege: true,
      vonTag: '2026-08-10',
      bisTag: '2026-08-12',
    });

  it('zeigt KEINE Prozentzahl, wenn die Kurve leer ist', () => {
    const svg = shareCard(leereKurveMitTrades());
    expect(svg).not.toContain('0,00 %');
    expect(svg).not.toContain('+0,00');
  });

  it('zeigt stattdessen die gemessene Trade-Bilanz mit ihrem Zeitraum', () => {
    const svg = shareCard(leereKurveMitTrades());
    expect(svg).toContain('−1719,54 USD');
    expect(svg).toContain('9 Trades');
    expect(svg).toContain('über 3 Tage');
  });

  it('färbt einen Verlust NICHT grün', () => {
    const svg = shareCard(leereKurveMitTrades());
    // Die grosse Zeile (font-size 140) trägt die Verlustfarbe.
    const haupt = /font-size="140"[^>]*fill="([^"]+)"|fill="([^"]+)"[^>]*font-size="140"/.exec(svg);
    expect(haupt).not.toBeNull();
    const farbe = haupt![1] ?? haupt![2];
    expect(farbe).toBe('#ff5f5f');
    expect(farbe).not.toBe('#34c77b');
  });

  it('blendet „WOMIT" aus, wenn darunter nichts steht', () => {
    const svg = shareCard(leereKurveMitTrades());
    expect(svg).not.toContain('WOMIT');
  });

  it('zeigt „WOMIT" weiterhin, wenn es Beiträge gibt', () => {
    expect(shareCard(daten())).toContain('WOMIT');
  });

  it('behauptet gar nichts, wenn weder Kurve noch Trades da sind', () => {
    const svg = shareCard(
      daten({
        zerlegung: zerlegeDepot([], []),
        renditePct: 0,
        ergebnis: 0,
        trades: 0,
        tradeBilanz: 0,
        vonTag: undefined,
        bisTag: undefined,
      }),
    );
    // Gezielt die GROSSE Zeile — die Prozentzeichen der Kennzahlen
    // (Trefferquote, Drawdown) dürfen bleiben.
    const haupt = /font-size="140"[^>]*>([^<]*)</.exec(svg);
    expect(haupt).not.toBeNull();
    expect(haupt![1]).toBe('—');
    expect(svg).toContain('Noch keine abgeschlossenen Trades');
  });
});
