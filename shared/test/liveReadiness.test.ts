/**
 * Tests des Live-Reife-Gates.
 *
 * Dieses Gate steht zwischen Papiergeld und echtem Geld. Ein Fehler hier ist
 * teurer als überall sonst im System — deshalb prüfen die Tests vor allem,
 * dass es NICHT zu früh öffnet:
 *
 *   - jedes einzelne Kriterium sperrt für sich allein
 *   - fehlende Zahlen (null) gelten NIE als erfüllt
 *   - der reale Zustand vom 04.08. fällt durch
 */

import { describe, expect, it } from 'vitest';
import {
  REIFE_SCHWELLEN,
  kanteJeTrade,
  liveReife,
  type ReifeKennzahlen,
} from '../src/liveReadiness.js';

/** Kennzahlen, die alle Kriterien erfüllen — Basis für Einzelfall-Tests. */
const reif = (over: Partial<ReifeKennzahlen> = {}): ReifeKennzahlen => ({
  trades: 250,
  profitFactor: 1.4,
  feeShare: 0.3,
  netPnl: 1200,
  tageStrecke: 45,
  ...over,
});

describe('liveReife — öffnet nur, wenn ALLES stimmt', () => {
  it('gibt bei erfüllten Kriterien frei', () => {
    const b = liveReife(reif());
    expect(b.bereit).toBe(true);
    expect(b.erfuellt).toBe(b.gesamt);
  });

  it('sperrt bei zu kleiner Stichprobe', () => {
    // Grenze seit 13.08. (Owner-Rekalibrierung): 40 Tages-Trades.
    const b = liveReife(reif({ trades: 39 }));
    expect(b.bereit).toBe(false);
    expect(b.fazit).toContain('Stichprobe');
    expect(liveReife(reif({ trades: 40 })).bereit).toBe(true);
  });

  it('sperrt bei Profitfaktor knapp unter der Schwelle', () => {
    // 1,19 gegen 1,20: Der Puffer über 1,0 ist Absicht — Papierhandel
    // unterschätzt Slippage und Teilausführungen systematisch.
    expect(liveReife(reif({ profitFactor: 1.19 })).bereit).toBe(false);
    expect(liveReife(reif({ profitFactor: 1.2 })).bereit).toBe(true);
  });

  it('sperrt, wenn Gebühren mehr als die Hälfte des Bruttos fressen', () => {
    expect(liveReife(reif({ feeShare: 0.51 })).bereit).toBe(false);
    expect(liveReife(reif({ feeShare: 0.5 })).bereit).toBe(true);
  });

  it('sperrt bei negativem oder genau null Nettoergebnis', () => {
    expect(liveReife(reif({ netPnl: -1 })).bereit).toBe(false);
    // Genau null ist kein Gewinn — die Maxime sagt „nur noch Gewinn".
    expect(liveReife(reif({ netPnl: 0 })).bereit).toBe(false);
    expect(liveReife(reif({ netPnl: 0.01 })).bereit).toBe(true);
  });

  it('sperrt bei zu kurzer Messstrecke — Gewinn über drei Tage ist Wetter', () => {
    // Grenze seit 13.08.: zwei Wochen ununterbrochene Strecke.
    expect(liveReife(reif({ tageStrecke: 13 })).bereit).toBe(false);
    expect(liveReife(reif({ tageStrecke: 14 })).bereit).toBe(true);
  });

  it('behandelt eine fehlende Messstrecke als null Tage, nicht als erfüllt', () => {
    const k = reif();
    delete (k as { tageStrecke?: number }).tageStrecke;
    expect(liveReife(k).bereit).toBe(false);
  });
});

describe('liveReife — fehlende Zahlen öffnen nie', () => {
  it('wertet einen Profitfaktor von null NICHT als erfüllt', () => {
    // null heißt „keine Verlusttrades". Das ist entweder eine zu kleine
    // Stichprobe oder ein Buchungsfehler — beides kein Grund für echtes Geld.
    const b = liveReife(reif({ profitFactor: null }));
    expect(b.bereit).toBe(false);
    expect(b.kriterien.find((x) => x.name === 'Profitfaktor')?.ist).toBe('—');
  });

  it('wertet einen zurückgehaltenen Nettobetrag NICHT als erfüllt', () => {
    // `netPnl` ist null, solange zu wenige Konten beitragen (Datenschutz-
    // Schwelle in tradingHealth). Unbekannt ist nicht dasselbe wie gut.
    expect(liveReife(reif({ netPnl: null })).bereit).toBe(false);
  });

  it('wertet einen unbekannten Gebührenanteil NICHT als erfüllt', () => {
    expect(liveReife(reif({ feeShare: null })).bereit).toBe(false);
  });
});

describe('liveReife — Diagnose', () => {
  it('wertet ALLE Kriterien aus, nicht nur bis zum ersten Fehler', () => {
    const b = liveReife({ trades: 0, profitFactor: null, feeShare: null, netPnl: null });
    expect(b.kriterien).toHaveLength(b.gesamt);
    expect(b.erfuellt).toBe(0);
  });

  it('nennt jedes offene Kriterium im Fazit', () => {
    const b = liveReife(reif({ trades: 10, netPnl: -5 }));
    expect(b.fazit).toContain('Stichprobe');
    expect(b.fazit).toContain('Nettoergebnis');
  });

  it('zeigt Ist und Soll je Kriterium, damit die Zahl sichtbar bleibt', () => {
    const k = liveReife(reif({ profitFactor: 0.61 })).kriterien.find(
      (x) => x.name === 'Profitfaktor',
    );
    expect(k?.ist).toBe('0.61');
    expect(k?.soll).toBe('≥ 1.20');
  });

  it('sperrt den realen Zustand vom 04.08.', () => {
    // Die Zahlen aus dem Heartbeat von 16:30 — genau der Fall, für den das
    // Gate gebaut ist. 514 Trades reichen zwar, aber sonst nichts.
    const b = liveReife({
      trades: 514,
      profitFactor: 0.6107,
      feeShare: 2.0944,
      netPnl: -1593.19,
      tageStrecke: 7,
    });
    expect(b.bereit).toBe(false);
    expect(b.erfuellt).toBe(1); // nur die Stichprobe steht
  });
});

describe('Schwellen — Rekalibrierung 13.08. (Owner-Ansage)', () => {
  /* „bitte optimiere die cashguards. es soll möglich sein innerhalb von ca.
   * zwei Wochen live oder mit echtgeld Handeln zu können, wenn es alles gut
   * funktioniert." — Die MENGEN-Hürden wurden aufs Tages-Regime kalibriert
   * (200→40 Trades, 30→14 Tage). Die QUALITÄTS-Hürden sind der Teil, den
   * „wenn alles gut funktioniert" bedeutet — die Wächter unten verhindern,
   * dass sie je stillschweigend mitgelockert werden. */

  it('verlangt mehr als bloße Kostendeckung — unverändert', () => {
    // Bei exakt 1,0 schaltet man live auf unter 1,0 — Papierhandel
    // unterschätzt die Wirklichkeit.
    expect(REIFE_SCHWELLEN.minProfitFactor).toBeGreaterThanOrEqual(1.2);
  });

  it('Gebührenanteil und Nettoergebnis bleiben scharf — unverändert', () => {
    expect(REIFE_SCHWELLEN.maxFeeShare).toBeLessThanOrEqual(0.5);
    expect(REIFE_SCHWELLEN.minNetPnl).toBeGreaterThanOrEqual(0);
  });

  it('die Mengen-Hürden stehen exakt auf dem Owner-kalibrierten Wert', () => {
    // Bewusst EXAKT statt >=: Jede weitere Änderung — höher wie tiefer —
    // soll diesen Test brechen und damit eine dokumentierte Entscheidung
    // erzwingen, keinen stillen Drift.
    expect(REIFE_SCHWELLEN.minTrades).toBe(40);
    expect(REIFE_SCHWELLEN.minTageStrecke).toBe(14);
  });

  it('zwei schlechte Wochen öffnen NICHT — die Qualität bleibt die Bedingung', () => {
    // 40 Trades und 14 Tage erreicht, aber Profitfaktor unter Wasser:
    // exakt die Lage von heute (PF 0,96) nach zwei Wochen mehr Handel.
    const b = liveReife({
      trades: 60,
      profitFactor: 0.96,
      feeShare: 1.06,
      netPnl: -140.75,
      tageStrecke: 20,
    });
    expect(b.bereit).toBe(false);
    expect(b.erfuellt).toBe(2); // nur Stichprobe + Messstrecke stehen
  });
});

describe('kanteJeTrade — was ein Trade bringt gegen das, was er kostet', () => {
  it('rechnet den realen Stand vom 04.08. nach', () => {
    // 514 Trades, brutto +1.455,82 $, Gebühren 3.049,01 $, Roundtrip 0,3 %.
    // Erwartung: rund +0,14 % Bruttorendite gegen 0,3 % Kosten.
    const k = kanteJeTrade(514, 1455.82, 3049.01, 0.003);
    expect(k.bruttoPct).toBeCloseTo(0.1432, 3);
    expect(k.kostenPct).toBeCloseTo(0.3, 4);
    expect(k.nettoPct).toBeLessThan(0);
    // Deckung < 1 heißt: strukturell defizitär, unabhängig von der Marktphase.
    expect(k.deckung).toBeCloseTo(0.477, 2);
  });

  it('meldet Deckung über 1, wenn die Kante die Kosten trägt', () => {
    const k = kanteJeTrade(100, 1000, 300, 0.003);
    expect(k.nettoPct).toBeGreaterThan(0);
    expect(k.deckung).toBeGreaterThan(1);
  });

  it('gibt null statt einer erfundenen Zahl, wenn Eingaben fehlen', () => {
    expect(kanteJeTrade(0, 100, 100, 0.003).bruttoPct).toBeNull();
    expect(kanteJeTrade(10, 100, 0, 0.003).bruttoPct).toBeNull();
    expect(kanteJeTrade(10, 100, 100, 0).bruttoPct).toBeNull();
  });

  it('bildet einen Bruttoverlust als negative Kante ab', () => {
    const k = kanteJeTrade(100, -500, 300, 0.003);
    expect(k.bruttoPct).toBeLessThan(0);
    expect(k.deckung).toBeLessThan(0);
  });
});
