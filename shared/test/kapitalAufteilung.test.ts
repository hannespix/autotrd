/**
 * Kapitaleinsatz-Aufteilung — Werte-Tests (Red-Team-Befunde 3+6, 20.08.).
 *
 * Die erste Fassung hatte keinen einzigen Wertedurchlauf: Vier unabhängig
 * gerundete Prozente summierten nicht auf 100, und Margin/Short-Konten
 * lieferten Zahlen, die die Ampel falsch einfärbte. Diese Tests sind die
 * Fixtures, die das damals gezeigt hätten.
 */
import { describe, expect, it } from 'vitest';

import { kapitalAufteilung } from '../src/index.js';

describe('kapitalAufteilung — Identitäten und Vorzeichen', () => {
  it('Normalfall: Teile ergeben exakt das Ganze', () => {
    const k = kapitalAufteilung(10_000, 7_200, 5_500)!;
    expect(k.investiertPct).toBe(72);
    expect(k.sockelPct).toBe(55);
    expect(k.aktivPct).toBe(17);
    expect(k.cashPct).toBe(28);
    expect(k.investiertPct + k.cashPct).toBe(100);
    expect(k.sockelPct + k.aktivPct).toBe(k.investiertPct);
  });

  it('krumme Werte: die Identitäten überleben die Rundung', () => {
    /* 530/1600 = exakt 33,125 % — der binär exakte .5-Fall: Unabhängige
     * Rundung ergäbe 33,13 + 66,88 = 100,01. Die Identität liefert 66,87.
     * Genau dieses Fixture hat die Sabotage-Probe erzwungen: Ein „krummer"
     * Wert ohne echten .5-Konflikt fängt den Rückbau nicht. */
    const k = kapitalAufteilung(1_600, 530, 0)!;
    expect(k.investiertPct).toBe(33.13);
    expect(k.cashPct).toBe(66.87);
    expect(k.investiertPct + k.cashPct).toBe(100);
    const k2 = kapitalAufteilung(9_999.99, 3_333.33, 1_111.11)!;
    expect(k2.investiertPct + k2.cashPct).toBe(100);
    expect(Math.round((k2.sockelPct + k2.aktivPct) * 100) / 100).toBe(k2.investiertPct);
  });

  it('Margin-Konto: negatives Cash bleibt sichtbar negativ (Schulden)', () => {
    // balance −5.000, Positionen 30.000 → Equity 25.000.
    const k = kapitalAufteilung(25_000, 30_000, 0)!;
    expect(k.investiertPct).toBe(120);
    expect(k.cashPct).toBe(-20);
  });

  it('verlierender Short: negativer Positionswert wird nicht verbogen', () => {
    // balance 10.000, Short-Wert −2.000 → Equity 8.000. Die Zahl ist
    // ehrlich hässlich — verbiegen müsste sie lügen.
    const k = kapitalAufteilung(8_000, -2_000, 0)!;
    expect(k.investiertPct).toBe(-25);
    expect(k.cashPct).toBe(125);
  });

  it('Equity ≤ 0 → null, keine erfundenen Prozente', () => {
    expect(kapitalAufteilung(0, 0, 0)).toBeNull();
    expect(kapitalAufteilung(-100, 50, 0)).toBeNull();
  });
});
