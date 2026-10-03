/**
 * Margin und Hebel.
 *
 * Von allen Modulen in diesem Repo ist das hier dasjenige, bei dem ein
 * stiller Fehler am teuersten wäre — und am plausibelsten aussähe. Ein
 * Simulator, der Hebel gewährt, aber nie zwangsschließt, zeigt fantastische
 * Ergebnisse, und niemand fragt nach. Die Tests halten deshalb vor allem
 * die Stellen fest, an denen der Hebel geschmeichelt würde.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAINTENANCE_MARGIN,
  MARGIN_CONFLUENCE_BONUS,
  MARGIN_MIN_CONFLUENCE,
  MAX_LEVERAGE,
  effectiveLeverage,
  canAfford,
  liquidationPlan,
  marginInterest,
  marginState,
  needsLiquidation,
  sizeWithMargin,
} from '../src/margin.js';

describe('marginState: Kaufkraft', () => {
  it('ohne Hebel ist die Kaufkraft schlicht das Eigenkapital', () => {
    const s = marginState(10_000, 0, 1);
    expect(s.equity).toBe(10_000);
    expect(s.buyingPower).toBe(10_000);
    expect(s.borrowed).toBe(0);
  });

  it('3× Hebel verdreifacht die Kaufkraft', () => {
    expect(marginState(10_000, 0, 3).buyingPower).toBe(30_000);
  });

  it('bereits Investiertes wird abgezogen', () => {
    // 10k Eigenkapital: 5k Cash + 5k in Positionen. Bei 3× sind 30k
    // insgesamt erlaubt, 5k davon sind belegt.
    expect(marginState(5_000, 5_000, 3).buyingPower).toBe(25_000);
  });

  it('ein SHORT senkt die Auslastung nicht — er bindet Sicherheit', () => {
    // Der scharfe Fall: Mit dem vorzeichenbehafteten Positionswert hätte ein
    // perfekt gehedgtes Konto (long 5k, short −5k) unendliche Kaufkraft. An
    // keiner echten Börse ist das so; beide Seiten binden Marge.
    const gehedgt = marginState(10_000, -5_000, 2);
    expect(gehedgt.equity).toBe(5_000);
    // 5k Eigenkapital × 2 = 10k erlaubt, 5k Betrag belegt ⇒ 5k frei
    expect(gehedgt.buyingPower).toBe(5_000);
  });

  it('negativer Cash heißt geliehen', () => {
    const s = marginState(-4_000, 14_000, 3);
    expect(s.borrowed).toBe(4_000);
    expect(s.equity).toBe(10_000);
  });

  it('Kaufkraft wird bei 0 abgeschnitten, nie negativ', () => {
    // Nach einem heftigen Verlust wäre der Rohwert negativ. Eine negative
    // Kaufkraft würde in Vergleichen wie „cost <= buyingPower" seltsam
    // wirken; 0 ist eindeutig „nichts geht mehr".
    expect(marginState(-9_000, 10_000, 1).buyingPower).toBe(0);
  });

  it('Hebel unter 1 wird auf 1 gehoben — es gibt kein negatives Leihen', () => {
    expect(marginState(10_000, 0, 0).buyingPower).toBe(10_000);
    expect(marginState(10_000, 0, -5).buyingPower).toBe(10_000);
  });
});

describe('marginState: Margin-Level', () => {
  it('ohne Positionen ist das Level null, nicht Unendlich', () => {
    // „Unendlich sicher" ist keine Zahl, mit der eine Vergleichslogik
    // rechnen sollte — und Infinity in Firestore wäre ohnehin ungültig.
    expect(marginState(10_000, 0).marginLevel).toBeNull();
  });

  it('rechnet Eigenkapital ÷ Positionswert', () => {
    // 4k Eigenkapital auf 20k Position ⇒ 20 %
    expect(marginState(-16_000, 20_000, 3).marginLevel).toBeCloseTo(0.2, 4);
  });
});

describe('needsLiquidation', () => {
  it('greift, sobald das Eigenkapital unter die Erhaltungsmarge fällt', () => {
    // 20k Position, 4k Eigenkapital ⇒ 20 % < 25 %
    const s = marginState(-16_000, 20_000, 3);
    expect(needsLiquidation(s)).toBe(true);
  });

  it('greift NICHT bei ausreichender Deckung', () => {
    // 20k Position, 6k Eigenkapital ⇒ 30 % > 25 %
    expect(needsLiquidation(marginState(-14_000, 20_000, 3))).toBe(false);
  });

  it('ohne Positionen niemals — auch bei negativem Cash', () => {
    // Ein Konto ohne Risiko kann keinen Margin Call haben. Ohne diese
    // Ausnahme würde ein Konto mit Schulden und ohne Position endlos
    // „liquidiert" werden, ohne dass es etwas zu schließen gäbe.
    expect(needsLiquidation(marginState(-500, 0, 3))).toBe(false);
  });

  it('die Grenze selbst löst noch nicht aus (strikt kleiner)', () => {
    const s = marginState(-15_000, 20_000, 3); // exakt 25 %
    expect(s.marginLevel).toBeCloseTo(DEFAULT_MAINTENANCE_MARGIN, 6);
    expect(needsLiquidation(s)).toBe(false);
  });

  it('eine höhere Erhaltungsmarge löst früher aus', () => {
    const s = marginState(-14_000, 20_000, 3); // 30 %
    expect(needsLiquidation(s, 0.25)).toBe(false);
    expect(needsLiquidation(s, 0.35)).toBe(true);
  });
});

describe('marginInterest', () => {
  it('rechnet taggenau auf 360-Tage-Basis', () => {
    // 10.000 geliehen, 8 % p. a., 30 Tage ⇒ 10000 · 0,08 · 30/360 = 66,67
    expect(marginInterest(10_000, 30, 0.08)).toBeCloseTo(66.67, 2);
  });

  it('ein Intraday-Roundtrip kostet praktisch nichts', () => {
    // Genau das soll die Wahl zwischen kurz und lang halten beeinflussen:
    // Über Nacht spürbar, innerhalb des Tages vernachlässigbar.
    expect(marginInterest(10_000, 0.02, 0.08)).toBeLessThan(0.05);
  });

  it('ohne Schulden keine Zinsen', () => {
    expect(marginInterest(0, 30)).toBe(0);
    expect(marginInterest(-100, 30)).toBe(0);
  });

  it('unsinnige Eingaben ergeben 0 statt NaN', () => {
    expect(marginInterest(10_000, -5)).toBe(0);
    expect(marginInterest(10_000, 30, 0)).toBe(0);
  });
});

describe('canAfford', () => {
  const s = marginState(10_000, 0, 2); // 20k Kaufkraft

  it('lässt durch, was in die Kaufkraft passt', () => {
    expect(canAfford(s, 19_999)).toBe(true);
  });

  it('lehnt ab, was darüber liegt', () => {
    expect(canAfford(s, 20_001)).toBe(false);
  });

  it('exakt die Kaufkraft geht noch', () => {
    expect(canAfford(s, 20_000)).toBe(true);
  });

  it('eine Order über 0 ist keine Order', () => {
    expect(canAfford(s, 0)).toBe(false);
  });
});

describe('sizeWithMargin', () => {
  it('die Tranche skaliert mit dem Hebel — ohne das bliebe er folgenlos', () => {
    // Der wichtigste Test dieses Moduls, und der, der zuerst falsch herum
    // stand. Rechnete die Tranche vom blanken Eigenkapital, kam das Depot
    // bei 10 % je Position und höchstens 10 Positionen (Voreinstellung) auf
    // exakt 100 % — die Kaufkraft von 300 % wurde nie erreicht. Der Hebel
    // war ein Schalter, der nichts tut.
    const s = marginState(10_000, 0, 3); // Kaufkraft 30k, Eigenkapital 10k
    // 10 000 × 3 × 10 % = 3 000 ⇒ 30 Stück; zehn davon sind 30 000 = 3×.
    expect(sizeWithMargin(s, 10, 100, false, 3)).toBe(30);
    // Ohne Hebel unverändert.
    expect(sizeWithMargin(s, 10, 100)).toBe(10);
  });

  it('doppelt wirkt der Hebel trotzdem nicht — die Kaufkraft deckelt die Summe', () => {
    const s = marginState(10_000, 0, 3);
    const stueck = sizeWithMargin(s, 10, 100, false, 3);
    expect(stueck * 100 * 10).toBe(s.buyingPower);
  });

  it('ein Hebel über der Hülle wird geklemmt', () => {
    const s = marginState(10_000, 0, 3);
    expect(sizeWithMargin(s, 10, 100, false, 99)).toBe(
      sizeWithMargin(s, 10, 100, false, MAX_LEVERAGE));
  });

  it('die Kaufkraft bleibt trotzdem die harte Grenze', () => {
    // Eigenkapital 10k, aber nur noch 500 Kaufkraft frei: Die Tranche von
    // 2000 darf nicht durchgehen.
    const s = marginState(-19_500, 29_500, 3);
    expect(s.buyingPower).toBeLessThan(2_000);
    expect(sizeWithMargin(s, 20, 100) * 100).toBeLessThanOrEqual(s.buyingPower + 1e-9);
  });

  it('rundet auf ganze Stücke ab', () => {
    expect(sizeWithMargin(marginState(1_000, 0, 1), 100, 300)).toBe(3);
  });

  it('Bruchstücke für Krypto', () => {
    const s = marginState(1_000, 0, 1);
    expect(sizeWithMargin(s, 100, 64_000, true)).toBeCloseTo(0.015625, 6);
  });

  it('ohne Kaufkraft oder mit unsinnigem Preis ⇒ 0', () => {
    expect(sizeWithMargin(marginState(0, 0, 3), 10, 100)).toBe(0);
    expect(sizeWithMargin(marginState(10_000, 0, 1), 10, 0)).toBe(0);
    expect(sizeWithMargin(marginState(10_000, 0, 1), 0, 100)).toBe(0);
  });
});

describe('Hebel wirkt in BEIDE Richtungen', () => {
  it('verdreifacht Gewinn und Verlust gleichermaßen', () => {
    // Das ist die Eigenschaft, die in jeder Werbung für Hebelprodukte fehlt.
    // 10k Eigenkapital, 3× ⇒ 30k Position.
    const einstand = 30_000;
    for (const [kursAenderung, erwartet] of [
      [0.1, 3_000],
      [-0.1, -3_000],
    ] as const) {
      const wert = einstand * (1 + kursAenderung);
      const s = marginState(10_000 - einstand, wert, 3);
      expect(s.equity - 10_000).toBeCloseTo(erwartet, 2);
    }
  });

  it('bei 33 % Kursverlust wäre das Konto rechnerisch bei null', () => {
    const s = marginState(10_000 - 30_000, 30_000 * (1 - 1 / 3), 3);
    expect(s.equity).toBeCloseTo(0, 0);
    // Die Nachschussgrenze hat lange vorher gegriffen — deshalb darf dieser
    // Zustand in der Simulation gar nicht erst erreicht werden.
    expect(needsLiquidation(marginState(10_000 - 30_000, 30_000 * 0.8, 3))).toBe(true);
  });

  it('die Risiko-Hülle deckelt den Hebel', () => {
    expect(MAX_LEVERAGE).toBe(3);
  });
});

describe('effectiveLeverage: Hebel nur bei Überzeugung', () => {
  // Owner-Vorgabe 28.07.: „Margin-Trades dürfen nur ausgeführt werden, wenn
  // der Algorithmus sich sehr sicher ist." Das ist die Sicherung dafür.

  it('gewährt Hebel erst ab Schwelle + Bonus', () => {
    expect(effectiveLeverage(2 + MARGIN_CONFLUENCE_BONUS, 2, 3)).toBe(3);
  });

  it('verweigert ihn EINE Stimme darunter — ganz, nicht anteilig', () => {
    // Ein halber Hebel auf ein halbes Signal wäre ein Kompromiss, den
    // niemand begründen könnte. Unterhalb der Schwelle läuft der Trade
    // bar gedeckt wie bisher.
    expect(effectiveLeverage(2 + MARGIN_CONFLUENCE_BONUS - 1, 2, 3)).toBe(1);
  });

  it('misst den ABSTAND zur Schwelle, nicht die absolute Stimmenzahl', () => {
    // Dieselben 3 Stimmen sind bei Schwelle 1 ein starkes Signal und bei
    // Schwelle 3 ein Grenzsignal. Eine absolute Grenze würde beide gleich
    // behandeln und ausgerechnet dem schwächeren Hebel geben.
    expect(effectiveLeverage(3, 1, 3)).toBe(3);
    expect(effectiveLeverage(3, 3, 3)).toBe(1);
  });

  it('ohne eingestellten Hebel bleibt alles bei 1', () => {
    expect(effectiveLeverage(99, 1, 1)).toBe(1);
  });

  it('deckelt auf die Risiko-Hülle', () => {
    expect(effectiveLeverage(99, 1, 10)).toBe(MAX_LEVERAGE);
  });

  it('unsinnige Eingaben führen zu KEINEM Hebel, nicht zu vollem', () => {
    // Die sichere Richtung im Zweifel: Fehlt die Konfluenz, wird nicht
    // gehebelt — nicht umgekehrt.
    expect(effectiveLeverage(Number.NaN, 2, 3)).toBe(1);
    expect(effectiveLeverage(5, Number.NaN, 3)).toBe(1);
  });
});

describe('marginState: Gegenwert getrennt vom Rückfluss', () => {
  it('ohne exposure gilt der Positionswert — Long-Depot, beides gleich', () => {
    const s = marginState(5_000, 5_000, 2);
    expect(s.buyingPower).toBe(15_000); // 10k Equity × 2 − 5k belegt
    expect(s.marginLevel).toBe(2);
  });

  it('beim Short zählt der GEGENWERT, nicht der Rückfluss', () => {
    // Short über 100 Stück zu 100 $: Cash sank beim Öffnen um 10 000 $
    // (100-%-Margin), der Kurs steht unverändert. Rückfluss beim Schließen
    // = 10 000 $, bewegter Gegenwert ebenfalls 10 000 $ — hier noch gleich.
    // Fällt der Kurs auf 50: Rückfluss 15 000 $, Gegenwert nur 5 000 $.
    const s = marginState(0, 15_000, 1, 5_000);
    expect(s.equity).toBe(15_000);
    // Ohne die Trennung stünde hier 1 statt 3 — der Short sähe dreimal so
    // riskant aus, wie er ist, und die Kaufkraft wäre entsprechend zu klein.
    expect(s.marginLevel).toBe(3);
    expect(s.buyingPower).toBe(10_000);
  });

  it('unsinniges exposure fällt auf den Positionswert zurück', () => {
    expect(marginState(5_000, 5_000, 2, Number.NaN).buyingPower).toBe(15_000);
  });
});

describe('liquidationPlan: der Zwangsverkauf', () => {
  const long = (symbol: string, value: number) => ({ symbol, value, exposure: Math.abs(value) });

  it('ein gesundes Konto wird nie angefasst', () => {
    expect(liquidationPlan([long('AAPL', 5_000)], 5_000)).toEqual([]);
  });

  it('ein bar geführtes Konto kann nie unter die Grenze fallen', () => {
    // Ohne Kredit ist der Cash ≥ 0 ⇒ Eigenkapital ≥ Positionswert ⇒ 100 %.
    // Genau deshalb ist der Hebel ohne Risiko für alle, die ihn auslassen.
    expect(liquidationPlan([long('AAPL', 100_000)], 0)).toEqual([]);
  });

  it('ohne Positionen gibt es nichts zu schließen — auch bei negativem Cash', () => {
    expect(liquidationPlan([], -5_000)).toEqual([]);
  });

  it('unter der Erhaltungsmarge wird geschlossen', () => {
    // 30 000 $ Positionen, 22 500 $ geliehen ⇒ 7 500 $ Eigenkapital = 25 %.
    // Ein Cent weniger, und die Grenze ist gerissen.
    expect(liquidationPlan([long('AAPL', 30_000)], -22_500)).toEqual([]);
    expect(liquidationPlan([long('AAPL', 30_000)], -22_501)).toEqual(['AAPL']);
  });

  it('schließt nur so viel wie nötig, größte Position zuerst', () => {
    // 40 000 $ in vier Positionen, 31 000 $ geliehen ⇒ 9 000 $ Equity
    // (22,5 %). Nach dem größten Verkauf: 9 000 / 20 000 = 45 % ⇒ genug.
    const plan = liquidationPlan(
      [long('A', 20_000), long('B', 10_000), long('C', 6_000), long('D', 4_000)],
      -31_000,
    );
    expect(plan).toEqual(['A']);
  });

  it('schließt weiter, wenn ein Verkauf nicht reicht', () => {
    // Gleiches Konto, aber die Größe ist gleichmäßig verteilt: Ein Verkauf
    // von 10 000 $ lässt 9 000 / 30 000 = 30 % … das reicht bereits.
    // Mit 35 000 $ Schulden (5 000 Equity, 12,5 %) reicht es nicht:
    // 5 000/30 000 = 16,7 %, 5 000/20 000 = 25 % ⇒ zwei Verkäufe.
    const plan = liquidationPlan(
      [long('A', 10_000), long('B', 10_000), long('C', 10_000), long('D', 10_000)],
      -35_000,
    );
    expect(plan).toHaveLength(2);
  });

  it('bei aufgezehrtem Eigenkapital geht ALLES zu', () => {
    // Equity ≤ 0: Keine Teilmenge stellt die Marge wieder her, also endet
    // der Plan erst, wenn nichts mehr offen ist. Ein Abbruch nach der
    // ersten Position wäre hier der gefährlichste Bug des Moduls.
    const plan = liquidationPlan([long('A', 10_000), long('B', 10_000)], -21_000);
    expect(plan).toEqual(['A', 'B']);
  });

  it('rechnet den Short über seinen Gegenwert, nicht über den Rückfluss', () => {
    // Short, der ins Minus gelaufen ist: Einstand 10 000 $ (Margin weg vom
    // Cash), Kurs hat sich verdoppelt ⇒ Gegenwert 20 000 $, Rückfluss
    // 10 000 − 10 000 = 0. Eigenkapital 0 ⇒ Zwangsschluss.
    expect(liquidationPlan([{ symbol: 'TSLA', value: 0, exposure: 20_000 }], 0)).toEqual(['TSLA']);
  });

  it('ignoriert kaputte Einträge, statt den ganzen Plan zu verwerfen', () => {
    const plan = liquidationPlan(
      [long('A', 30_000), { symbol: '', value: 5_000 }, { symbol: 'X', value: Number.NaN }],
      -25_000,
    );
    expect(plan).toEqual(['A']);
  });
});

describe('effectiveLeverage: die absolute Untergrenze', () => {
  it('eine niedrige Einstiegsschwelle senkt die Hebel-Schwelle NICHT beliebig', () => {
    // Der Fehlanreiz, gegen den MARGIN_MIN_CONFLUENCE steht: Mit Schwelle 1
    // und Bonus 2 wären 3 Stimmen genug — wer die Einstiegsschwelle also
    // lockert, bekäme den Hebel leichter. Bei Schwelle 1 sind 3 Stimmen
    // gerade noch erlaubt (Untergrenze), 2 aber nicht.
    expect(effectiveLeverage(MARGIN_MIN_CONFLUENCE, 1, 3)).toBe(3);
    expect(effectiveLeverage(MARGIN_MIN_CONFLUENCE - 1, 1, 3)).toBe(1);
  });

  it('bei Schwelle 0 greift allein die Untergrenze', () => {
    expect(effectiveLeverage(MARGIN_MIN_CONFLUENCE - 1, 0, 3)).toBe(1);
    expect(effectiveLeverage(MARGIN_MIN_CONFLUENCE, 0, 3)).toBe(3);
  });

  it('die strengere der beiden Bedingungen gewinnt', () => {
    // Schwelle 3 + Bonus 2 = 5 liegt über der Untergrenze 3 — dann zählt 5.
    expect(effectiveLeverage(4, 3, 3)).toBe(1);
    expect(effectiveLeverage(5, 3, 3)).toBe(3);
  });
});
