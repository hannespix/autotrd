/**
 * Wächter der Treasury-Rechnung (src/risk/parken.ts).
 *
 * Geprüft wird hier die reine Rechnung: Band, Puffer, Freikauf, Rundung,
 * Rückzug. Die Eigenschaften „blockiert keinen Einstieg", „belegt keinen
 * Positionsplatz", „kein Stop" und „Backtest = Live" hängen an `decide()`
 * und stehen in test/core/parken.test.ts; der Orderpfad in
 * test/engine/parken.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { istParkPosition, planeParken, planeRueckzug, PARK_STRATEGY_ID, type ParkPlanInput } from '../../src/risk/parken.ts';

function inp(over: Partial<ParkPlanInput> = {}): ParkPlanInput {
  return {
    equity: 100_000,
    cash: 100_000,
    price: 100,
    qty: 0,
    reserviert: 0,
    bandPct: 5,
    bufferPct: 2,
    qtyStep: 1,
    umschichten: true,
    kaufErlaubt: true,
    ...over,
  };
}

describe('Zielquote und Band', () => {
  it('parkt alles außer dem Puffer', () => {
    const p = planeParken(inp());
    expect(p.kind).toBe('buy');
    // Ziel = 100 000 − 2 % Puffer = 98 000 $; mit 20 bp Kaufmarge: 98 000 / 100,2 = 978,04 ⇒ 978 Stück
    expect(p.qty).toBe(978);
    expect(p.pflicht).toBe(false);
  });

  it('schichtet unterhalb des Bandes NICHT um — die Krankheit „zu Tode gehandelt" hat hier keine Tür', () => {
    // 980 Stück geparkt (98 000 $), Kasse 2 000 $: exakt am Ziel.
    expect(planeParken(inp({ cash: 2_000, qty: 980 })).kind).toBe('none');
    // 4 Pp daneben (4 000 $ Kasse zu viel) ⇒ noch unter dem Band von 5 Pp.
    const knapp = planeParken(inp({ cash: 6_000, qty: 940 }));
    expect(knapp.kind).toBe('none');
    expect(knapp.grund).toMatch(/unter dem Band/);
    // 6 Pp daneben ⇒ es wird gekauft.
    expect(planeParken(inp({ cash: 8_000, qty: 920 })).kind).toBe('buy');
  });

  it('füllt den Puffer wieder auf, wenn die Kasse unter ihn fällt (Verkauf)', () => {
    // Kasse 0, alles geparkt: Ziel = 98 000 $, Parkwert 100 000 $ ⇒ 2 Pp … unter dem Band.
    expect(planeParken(inp({ cash: 0, qty: 1_000 })).kind).toBe('none');
    // Mit einem Band von 1 Pp wird verkauft, und zwar auf den Puffer.
    const p = planeParken(inp({ cash: 0, qty: 1_000, bandPct: 1 }));
    expect(p.kind).toBe('sell');
    expect(p.qty).toBe(20);
    expect(p.pflicht).toBe(false);
  });

  it('ohne Puffer bleibt trotzdem Geld für die Kosten des Kaufs übrig', () => {
    const p = planeParken(inp({ bufferPct: 0 }));
    expect(p.kind).toBe('buy');
    expect(p.qty).toBe(998); // 100 000 / (100 · 1,002) = 998,00 ⇒ 200 $ bleiben für Spread und Gebühren
    expect(p.qty * 100).toBeLessThan(100_000);
  });
});

describe('Freikauf — das Parken blockiert nie einen Einstieg', () => {
  it('verkauft, was den Einstiegen dieses Zyklus fehlt, mit Zuschlag für die eigenen Kosten', () => {
    const p = planeParken(inp({ cash: 2_000, qty: 980, reserviert: 50_000 }));
    expect(p.kind).toBe('sell');
    expect(p.pflicht).toBe(true);
    // Fehlbetrag 48 000 $ ⇒ 48 000 · 1,002 / 100 = 480,96 ⇒ aufgerundet 481 Stück
    expect(p.qty).toBe(481);
    expect(p.grund).toMatch(/Freikauf/);
  });

  it('gilt auch im Halt und außerhalb des Bandes — er kennt beide nicht', () => {
    const p = planeParken(inp({ cash: 0, qty: 980, reserviert: 1_000, umschichten: false, kaufErlaubt: false }));
    expect(p.kind).toBe('sell');
    expect(p.pflicht).toBe(true);
    expect(p.qty).toBe(11);
  });

  it('verkauft nie mehr, als geparkt ist', () => {
    const p = planeParken(inp({ cash: 0, qty: 10, reserviert: 1_000_000 }));
    expect(p.qty).toBe(10);
  });

  it('ohne Bestand gibt es nichts freizukaufen (und keine Order ins Leere)', () => {
    expect(planeParken(inp({ cash: 0, qty: 0, reserviert: 5_000 })).kind).toBe('none');
  });
});

describe('Sperren', () => {
  it('umschichten: false ⇒ nichts (Halt, Daten alt, heute schon umgeschichtet)', () => {
    expect(planeParken(inp({ umschichten: false })).kind).toBe('none');
  });

  it('kaufErlaubt: false sperrt den Kauf, nicht den Verkauf (PDT, Einstiegssperre)', () => {
    expect(planeParken(inp({ kaufErlaubt: false })).kind).toBe('none');
    const verkauf = planeParken(inp({ cash: 0, qty: 1_000, bandPct: 1, kaufErlaubt: false }));
    expect(verkauf.kind).toBe('sell');
  });

  it('unbrauchbarer Kurs oder Equity ⇒ nichts, nie geraten', () => {
    expect(planeParken(inp({ price: 0 })).kind).toBe('none');
    expect(planeParken(inp({ price: Number.NaN })).kind).toBe('none');
    expect(planeParken(inp({ equity: 0 })).kind).toBe('none');
  });

  it('Bruchstücke unter einer Stückelung werden nicht gehandelt', () => {
    // Ziel 50 $ bei Kurs 100 $ ⇒ weniger als ein Stück.
    expect(planeParken(inp({ equity: 1_000, cash: 50, bufferPct: 0, bandPct: 1 })).kind).toBe('none');
  });
});

describe('Rückzug', () => {
  it('verkauft alles und ist Pflicht (läuft auch im Halt)', () => {
    const p = planeRueckzug(123, 'risk.cashParking aus');
    expect(p).toMatchObject({ kind: 'sell', qty: 123, pflicht: true });
    expect(p.grund).toMatch(/Rückzug/);
  });

  it('ohne Bestand passiert nichts', () => {
    expect(planeRueckzug(0, 'aus').kind).toBe('none');
  });
});

describe('Erkennung der Parkposition', () => {
  it('nur die Kennung der Treasury zählt — eine fremde Position im selben Symbol nie', () => {
    expect(istParkPosition({ strategy: PARK_STRATEGY_ID })).toBe(true);
    expect(istParkPosition({ strategy: 'regime_allocation' })).toBe(false);
    expect(istParkPosition(null)).toBe(false);
    expect(istParkPosition(undefined)).toBe(false);
  });
});
