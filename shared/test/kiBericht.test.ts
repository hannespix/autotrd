/**
 * KI-Lagebericht: Hier ist der teure Fehler ein Aufruf zu viel, und der
 * gefährliche ein Prompt, der Fremdtext transportiert. Beide Klassen sind
 * unten abgedeckt — die Guards sind pur, also ohne Netz prüfbar.
 */
import { describe, expect, it } from 'vitest';
import {
  KI_MAX_LAEUFE_MONAT,
  KI_MAX_TOKENS,
  KI_SYSTEM,
  QUELLEN_JE_KLASSE,
  baueEingabe,
  entscheideLauf,
  schreibeChronik,
  type KiBerichtDoc,
  type KiFakten,
} from '../src/index.js';

const T = new Date('2026-08-08T22:25:00.000Z');
const chronik = schreibeChronik(
  undefined,
  {
    trading: {
      trades: 317,
      feeShare: 2.96,
      exits: { signal: { share: 0.8675, winRate: 0.269, n: 275 } },
      klassen: { crypto: { n: 144, kantePct: -0.1238 } },
    },
  },
  T.toISOString(),
);

describe('entscheideLauf', () => {
  it('erster Lauf des Monats darf', () => {
    const e = entscheideLauf(undefined, true, true, T);
    expect(e).toMatchObject({ laufen: true, grund: 'ok', laufNr: 1, monat: '2026-08' });
  });

  it('zweiter Lauf am selben Tag ist ein No-Op und verbraucht KEINEN Zähler', () => {
    const vorher: KiBerichtDoc = {
      stand: 'bericht',
      at: T.toISOString(),
      date: '2026-08-08',
      monat: '2026-08',
      laeufeImMonat: 1,
    };
    const e = entscheideLauf(vorher, true, true, T);
    expect(e.laufen).toBe(false);
    expect(e.grund).toBe('schon_gelaufen');
  });

  it('ein FEHLVERSUCH von heute blockiert den nächsten Anlauf nicht', () => {
    const vorher: KiBerichtDoc = {
      stand: 'fehler',
      at: T.toISOString(),
      date: '2026-08-08',
      monat: '2026-08',
      laeufeImMonat: 1,
    };
    const e = entscheideLauf(vorher, true, true, T);
    expect(e.laufen).toBe(true);
    expect(e.laufNr).toBe(2); // der Fehlversuch zählt trotzdem gegen den Deckel
  });

  it('ohne Schlüssel wird nicht gerufen', () => {
    expect(entscheideLauf(undefined, true, false, T)).toMatchObject({
      laufen: false,
      grund: 'kein_schluessel',
    });
  });

  it('ohne Chronik wird nicht gerufen — es gäbe nichts zu berichten', () => {
    expect(entscheideLauf(undefined, false, true, T)).toMatchObject({
      laufen: false,
      grund: 'keine_chronik',
    });
  });

  it('Monatsdeckel greift hart', () => {
    const voll: KiBerichtDoc = {
      stand: 'bericht',
      at: '2026-08-07T22:25:00.000Z',
      date: '2026-08-07',
      monat: '2026-08',
      laeufeImMonat: KI_MAX_LAEUFE_MONAT,
    };
    expect(entscheideLauf(voll, true, true, T)).toMatchObject({
      laufen: false,
      grund: 'monatsdeckel',
    });
  });

  it('der Zähler startet im neuen Monat bei 1', () => {
    const alterMonat: KiBerichtDoc = {
      stand: 'bericht',
      at: '2026-07-31T22:25:00.000Z',
      date: '2026-07-31',
      monat: '2026-07',
      laeufeImMonat: KI_MAX_LAEUFE_MONAT,
    };
    const e = entscheideLauf(alterMonat, true, true, T);
    expect(e).toMatchObject({ laufen: true, laufNr: 1, monat: '2026-08' });
  });
});

describe('baueEingabe', () => {
  const fakten: KiFakten = {
    trading: {
      trades: 317,
      winRatePct: 32.49,
      profitFactor: 0.5689,
      feeShare: 2.9631,
      klassen: { crypto: { n: 144, kantePct: -0.1238 }, stocks_us: { n: 37, kantePct: -0.054 } },
      exits: { signal: { share: 0.8675, winRate: 0.2691, n: 275 } },
    },
    signalSchatten: { live: { n: 523, trefferquote: 0.5277, kantePct: -0.3269 } },
    regime: { state: 'trend', vix: 14.9, aboveSma200: true },
    regimeKante: { trend: { n: 12, winRatePct: 50 }, seitwaerts: { n: 6, winRatePct: null }, stress: { n: 1, winRatePct: null }, ohne_regime: { n: 30, winRatePct: 43.3 } },
  };

  it('trägt Thesen samt Status und Belegen hinein', () => {
    const s = baueEingabe(chronik, fakten);
    expect(s).toContain('Stand: 2026-08-08');
    expect(s).toContain('[gilt,');
    expect(s).toContain('anteilSignalPct=86,80');
    expect(s).toContain('Klasse crypto: n=144');
    expect(s).toContain('live: n=523');
    expect(s).toContain('REGIME: trend');
  });

  it('ist deterministisch — gleiche Fakten, gleicher Prompt', () => {
    expect(baueEingabe(chronik, fakten)).toBe(baueEingabe(chronik, fakten));
  });

  it('bleibt klein genug, dass der Aufruf billig ist', () => {
    // Grobe Schranke gegen unbemerktes Wachstum: 6 000 Zeichen sind rund
    // 2 000 Token — ein Bruchteil des Token-Deckels der Antwort.
    expect(baueEingabe(chronik, fakten).length).toBeLessThan(6000);
  });

  it('verträgt fehlende Abschnitte, statt zu werfen', () => {
    expect(() => baueEingabe(chronik, {})).not.toThrow();
  });
});

describe('KI_SYSTEM', () => {
  it('verbietet Anlageempfehlungen und begrenzt die Länge', () => {
    expect(KI_SYSTEM).toContain('empfehlung');
    expect(KI_SYSTEM).toContain('200 Wörtern');
    expect(KI_SYSTEM).toContain('Deutsch');
  });

  it('der Token-Deckel ist gesetzt und moderat', () => {
    expect(KI_MAX_TOKENS).toBeGreaterThan(1000);
    expect(KI_MAX_TOKENS).toBeLessThanOrEqual(8000);
  });
});

describe('Stufe 4a — KI-Abschnitt im Lagebericht', () => {
  it('erscheint nur mit kiBewertung, nennt Quote, Über-Markt und Holdout', () => {
    const chronik = { date: '2026-10-08', eintraege: {} } as unknown as Parameters<typeof baueEingabe>[0];
    expect(baueEingabe(chronik, {})).not.toContain('KI-NACHRICHTEN');
    const text = baueEingabe(chronik, {
      kiBewertung: { faelleWirksam: 42, faelleGesamt: 90, quotePct: 55.5, nettoAvgPct: 0.3, ueberMarktQuotePct: 48, holdoutN: 20, holdoutQuotePct: 45, faelleWirksamLong: 62, gewicht: 1 },
    });
    expect(text).toContain('KI-NACHRICHTEN (Urteile nach Horizont gegen den Kurs bewertet, netto nach Kosten; Fallanteile, keine Renditen):');
    // Zahlen mit Komma wie der Rest des Prompts (pz), Anteile als Anteile benannt
    expect(text).toContain('- Arm A (steuert das Gewicht): n=42, Trefferquote 55,50 %, Ø netto 0,30 %, Anteil der Fälle über der Symbol-Drift 48,00 %');
    expect(text).toContain('- Holdout B (steuert nicht): n=20, Trefferquote 45,00 %; wirksame Long-Urteile gesamt n=62; alle Urteile n=90; Gewicht der KI-Stimme ×1,00');
    expect(text).not.toContain('55.5');
  });
});

describe('Task 17 — Quellen je Klasse im Lagebericht', () => {
  const chronik = { date: '2026-10-08', eintraege: {} } as unknown as Parameters<typeof baueEingabe>[0];
  const q = (n: number, konten: number, kantePct: number | null, gebuehrPct: number | null) => ({ n, konten, kantePct, gebuehrPct });

  it('nur bei Verlust-Klassen, mit Deckung und Erklärung, schlechteste Kante zuerst, ungemessene ans Ende, leere Quellen nicht', () => {
    const text = baueEingabe(chronik, {
      trading: {
        klassen: {
          stocks_us: { n: 37, kantePct: 0.2, quellen: { konfluenz: q(37, 3, 0.2, 0.1) }, deckungPct: 100 },
          crypto: {
            n: 146,
            kantePct: -0.42,
            deckungPct: 95.8901,
            deckung7tPct: 100,
            quellen: {
              konfluenz: q(40, 3, 0.3, 0.5),
              momentum: q(100, 3, -0.9, 0.48),
              hand: q(0, 0, null, null),
              unbekannt: q(6, 1, null, null),
            },
          },
        },
      },
    });
    const zeilen = text.split('\n');
    const i = zeilen.findIndex((z) => z.startsWith('- Klasse crypto: n=146'));
    expect(i).toBeGreaterThan(-1);
    expect(zeilen[i + 1]).toContain('(Quelle = Einstiegsweg aus dem Steckbrief; ki_probe = nur KI-allein-Einstiege; sync/unbekannt = ohne Steckbrief, ');
    expect(zeilen[i + 1]).toContain('Buchungen = Tranchen der letzten 500 Buchungen je Konto, nur realisiert.');
    expect(zeilen[i + 1]).toContain('Kante/Gebühr je Quelle erst ab der Konten-Schwelle, sonst --.)');
    expect(zeilen[i + 2]).toBe('  Deckung bekannter Einstiegswege: 95,89 % (letzte 7 Tage: 100,00 %)');
    expect(zeilen[i + 3]).toBe('  · Quelle momentum: Buchungen 100, Konten 3, Kante -0.9 %, Gebühr 0.48 %');
    expect(zeilen[i + 4]).toBe('  · Quelle konfluenz: Buchungen 40, Konten 3, Kante 0.3 %, Gebühr 0.5 %');
    // ungemessen (--) steht HINTER den gemessenen, nicht in der Mitte (Red-Team M6)
    expect(zeilen[i + 5]).toBe('  · Quelle unbekannt: Buchungen 6, Konten 1, Kante -- %, Gebühr -- %');
    expect(text).not.toContain('Quelle hand');
    // Gewinn-Klasse bekommt keine Quellen-Zeilen — die Frage ist, wo es verbrennt
    const j = zeilen.findIndex((z) => z.startsWith('- Klasse stocks_us'));
    expect(zeilen[j + 1] ?? '').not.toContain('Quelle');
    expect(text.split('(Quelle = Einstiegsweg').length - 1).toBe(1);
  });

  it('deckelt auf QUELLEN_JE_KLASSE Zeilen je Klasse und bleibt auch voll besetzt unter der Größenschranke', () => {
    expect(QUELLEN_JE_KLASSE).toBe(5);
    const quellen = Object.fromEntries(
      ['konfluenz', 'regelbaum', 'momentum', 'sockel', 'ki_probe', 'hand', 'sync', 'unbekannt'].map((k, i) => [k, q(100 + i, 3, -1 + i * 0.1, 0.5)]),
    );
    const klassen = Object.fromEntries(
      ['crypto', 'stocks_us', 'stocks_eu', 'etf', 'fx', 'gold', 'indices', 'bonds', 'commodities', 'stocks_global'].map((k) => [
        k,
        { n: 800, kantePct: -0.5, quellen, deckungPct: 75 },
      ]),
    );
    const text = baueEingabe(chronik, { trading: { klassen } });
    expect(text.split('· Quelle ').length - 1).toBe(10 * QUELLEN_JE_KLASSE);
    expect(text).not.toContain('Quelle sync');
    expect(text).not.toContain('Quelle unbekannt');
    expect(text.length).toBeLessThan(6000);
  });
});

describe('Hebel 2, Messung — Kante je Regime im Lagebericht', () => {
  it('erscheint nur mit Daten, mit Kommazahlen', () => {
    const chronik = { date: '2026-10-08', eintraege: {} } as unknown as Parameters<typeof baueEingabe>[0];
    expect(baueEingabe(chronik, {})).not.toContain('KANTE JE REGIME');
    // Task 19 Teil 2c: Fundamental-Schatten nur mit Deckung; Zahlen und Parameter sichtbar.
    expect(baueEingabe(chronik, {})).not.toContain('FUNDAMENTAL-SCHATTEN');
    expect(baueEingabe(chronik, { fundamentalSchatten: { mitProfil: 0, ohneProfil: 0 } })).not.toContain('FUNDAMENTAL-SCHATTEN');
    const fund = baueEingabe(chronik, {
      fundamentalSchatten: { mitProfil: 60, ohneProfil: 106, mitVolumen: 150, gewinnterminNah: 3, illiquide: 1, kleinstwert: 0, parameter: { sperrtage: 2, dollarVolMinUsd: 2_000_000, marktkapMinMio: 300 } },
    });
    expect(fund).toContain('FUNDAMENTAL-SCHATTEN (Messung im letzten Scan, blockt nichts');
    expect(fund).toContain('- Deckung: 60 Symbole mit Profil, 106 ohne, 150 mit Ø-Volumen');
    expect(fund).toContain('- Gewinntermin ≤ 2 Tage: 3; Tagesumsatz < 2 Mio USD: 1; Marktkap < 300 Mio USD: 0');
    const text = baueEingabe(chronik, { regimeKante: { trend: { n: 12, winRatePct: 50 }, seitwaerts: { n: 6, winRatePct: null }, ohne_regime: { n: 30, winRatePct: 43.3 } } });
    expect(text).toContain('KANTE JE REGIME (realisierte Regelbaum-/Konfluenz-Trades aller Konten, UNTER der Seitwärts-Bremse seit 15.08. gemessen — ');
    expect(text).toContain('nur Trefferquote, weil die Bremse die Größe halbiert; ohne_regime = Momentum/Sockel/Hand/Altbestand ohne Bremse):');
    expect(text).toContain('- trend: n=12, Trefferquote 50,00 %');
    expect(text).toContain('- seitwaerts: n=6, Trefferquote -- %');
    expect(text).toContain('- ohne_regime: n=30, Trefferquote 43,30 %');
    // kein Geldbetrag — auch nicht, wenn ein alter Herzschlag noch pnlAvg trüge
    const alt = baueEingabe(chronik, { regimeKante: { trend: { n: 12, winRatePct: 50, pnlAvg: 1.67 } as never } });
    expect(alt).not.toContain('1,67');
    expect(alt).not.toContain('P&L je Trade');
  });
});
