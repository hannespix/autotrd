/**
 * Kostenschwelle.
 *
 * Die Tests halten vor allem fest, dass die Schwelle in der RICHTIGEN
 * Richtung irrt: Im Zweifel darf sie einen Trade durchlassen (ein still
 * ausfallendes System merkt niemand), aber sie darf niemals rechnen, als
 * bewegten sich Kurse linear mit der Zeit — dann wäre sie wirkungslos.
 */

import { describe, expect, it } from 'vitest';
import {
  BAR_MINUTES,
  MIN_EDGE_MULTIPLE,
  costGate,
  expectedMovePct,
  holdBars,
  roundtripCostPct,
  CLASS_CAPTURE,
  DEFAULT_CAPTURE,
  captureForClass,
} from '../src/costGate.js';
import { feeRateForClass } from '../src/strategy.js';

describe('roundtripCostPct', () => {
  it('rechnet beide Seiten', () => {
    // Krypto: 0,25 % je Seite ⇒ 0,5 % hin und zurück
    expect(roundtripCostPct(0.0025)).toBeCloseTo(0.5, 10);
    // US-Aktien: 0,05 % je Seite ⇒ 0,1 %
    expect(roundtripCostPct(0.0005)).toBeCloseTo(0.1, 10);
  });

  it('unsinniger Satz ⇒ 0, nicht NaN', () => {
    expect(roundtripCostPct(Number.NaN)).toBe(0);
    expect(roundtripCostPct(-1)).toBe(0);
  });
});

describe('holdBars', () => {
  it('60 Minuten sind 12 Fünf-Minuten-Kerzen', () => {
    expect(holdBars(60, BAR_MINUTES.intraday)).toBe(12);
  });

  it('Haltedauer „aus" ergibt eine Kerze, nicht null', () => {
    // 0 heißt „der Signal-Ausstieg darf sofort feuern" — die Position bekommt
    // trotzdem mindestens die laufende Kerze. Mit 0 Kerzen wäre die erwartete
    // Bewegung 0 und die Schwelle würde ALLES blockieren.
    expect(holdBars(0, BAR_MINUTES.intraday)).toBe(1);
    expect(holdBars(undefined, BAR_MINUTES.intraday)).toBe(1);
  });

  it('auf Tagesbasis ist eine Stunde weniger als eine Kerze', () => {
    expect(holdBars(60, BAR_MINUTES.daily)).toBe(1);
    expect(holdBars(2880, BAR_MINUTES.daily)).toBe(2);
  });
});

describe('expectedMovePct: √-Skalierung', () => {
  it('vier Kerzen verdoppeln die erwartete Bewegung, nicht vervierfachen', () => {
    expect(expectedMovePct(0.1, 4)).toBeCloseTo(0.2, 10);
  });

  it('der lineare Fehler wäre dramatisch', () => {
    // 0,05 % je Kerze über 12 Kerzen: linear 0,60 %, korrekt 0,17 %.
    // Genau dieser Faktor 3,5 entscheidet, ob die Schwelle etwas tut.
    const korrekt = expectedMovePct(0.05, 12);
    expect(korrekt).toBeCloseTo(0.1732, 3);
    expect(korrekt).toBeLessThan(0.05 * 12);
  });

  it('ohne ATR oder Kerzen ⇒ 0', () => {
    expect(expectedMovePct(0, 12)).toBe(0);
    expect(expectedMovePct(0.1, 0)).toBe(0);
    expect(expectedMovePct(Number.NaN, 12)).toBe(0);
  });
});

describe('costGate: die eigentliche Entscheidung', () => {
  const basis = { minHoldMin: 60, timeframe: 'intraday' as const };

  it('ruhiges Devisenkreuz wird abgelehnt', () => {
    // EUR/CHF: ~0,01 % ATR je 5-min-Kerze ⇒ über 12 Kerzen 0,035 %.
    // Kosten 0,06 %, nötig 0,18 %. Solche Trades können im Mittel nicht
    // aufgehen, egal wie gut das Signal ist — sie machten einen großen Teil
    // der 297 Verlust-Trades aus.
    const r = costGate({ ...basis, atrPct: 0.01, feeRate: feeRateForClass('forex') });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bewegung_unter_kosten');
    expect(r.expectedPct).toBeLessThan(r.needPct);
  });

  it('bewegliche US-Aktie kommt durch', () => {
    // 0,15 % ATR je Kerze ⇒ 0,52 % über 12 Kerzen; nötig 0,3 %.
    const r = costGate({ ...basis, atrPct: 0.15, feeRate: feeRateForClass('stocks_us') });
    expect(r.ok).toBe(true);
    expect(r.expectedPct).toBeGreaterThan(r.needPct);
  });

  it('Krypto braucht wegen der hohen Gebühren deutlich mehr Bewegung', () => {
    // Gleiche Volatilität, andere Klasse: 0,15 % ATR reicht bei US-Aktien,
    // bei Krypto (0,25 % je Seite ⇒ 1,5 % nötig) nicht.
    const atrPct = 0.15;
    expect(costGate({ ...basis, atrPct, feeRate: feeRateForClass('stocks_us') }).ok).toBe(true);
    expect(costGate({ ...basis, atrPct, feeRate: feeRateForClass('crypto') }).ok).toBe(false);
  });

  it('längere Mindest-Haltedauer öffnet das Tor — aber nur mit √', () => {
    const eng = { ...basis, atrPct: 0.06, feeRate: feeRateForClass('stocks_us') };
    expect(costGate(eng).ok).toBe(false); // 60 min: 0,21 % < 0,3 %
    expect(costGate({ ...eng, minHoldMin: 240 }).ok).toBe(true); // 4 h: 0,42 %
  });

  it('genau auf der Schwelle wird durchgelassen', () => {
    // needPct = 0,3 %; atr so gewählt, dass expected exakt 0,3 % ergibt.
    const atrPct = 0.3 / Math.sqrt(12);
    const r = costGate({ ...basis, atrPct, feeRate: feeRateForClass('stocks_us') });
    expect(r.ok).toBe(true);
  });

  it('fehlender ATR lässt DURCH und sagt warum', () => {
    // Bewusst permissiv: Ein Datenloch darf die Engine nicht still abschalten.
    for (const atrPct of [null, undefined, 0, Number.NaN]) {
      const r = costGate({ ...basis, atrPct, feeRate: feeRateForClass('stocks_us') });
      expect(r.ok).toBe(true);
      expect(r.reason).toBe('kein_atr');
    }
  });

  it('der Sicherheitsfaktor ist einstellbar und wirkt', () => {
    const eng = { ...basis, atrPct: 0.05, feeRate: feeRateForClass('stocks_us') };
    expect(costGate({ ...eng, multiple: 1 }).ok).toBe(true); // 0,17 % > 0,1 %
    expect(costGate({ ...eng, multiple: MIN_EDGE_MULTIPLE }).ok).toBe(false); // < 0,3 %
  });

  it('meldet immer alle drei Zahlen, auch bei Ablehnung', () => {
    const r = costGate({ ...basis, atrPct: 0.01, feeRate: feeRateForClass('forex') });
    expect(r.costPct).toBeCloseTo(0.06, 10);
    expect(r.needPct).toBeCloseTo(0.18, 10);
    expect(r.expectedPct).toBeGreaterThan(0);
  });

  it('auf Tagesbasis rechnet sie mit Tageskerzen', () => {
    // 1 % ATR am Tag, Haltedauer 60 min ⇒ 1 Kerze ⇒ 1 % erwartete Bewegung.
    const r = costGate({
      atrPct: 1,
      minHoldMin: 60,
      timeframe: 'daily',
      feeRate: feeRateForClass('stocks_us'),
    });
    expect(r.ok).toBe(true);
    expect(r.expectedPct).toBeCloseTo(1, 10);
  });
});

describe('Einfangquote — Bewegung ist kein Gewinn (04.08.)', () => {
  /** Kryptonahe Werte: 0,25 % je Seite, kräftiger Tages-ATR. */
  const krypto = {
    atrPct: 4,
    minHoldMin: 60,
    timeframe: 'daily' as const,
    feeRate: 0.0025,
  };

  it('lässt ohne Einfangquote alles durch — der Zustand vor dem Umbau', () => {
    // Genau der Grund, warum `unter_kosten` bei `geprueft: 12` auf 0 stand:
    // 4 % Auslenkung gegen 0,5 % Kosten × 3 = 1,5 % Schwelle.
    const r = costGate(krypto);
    expect(r.ok).toBe(true);
    expect(r.expectedPct).toBeCloseTo(4, 6);
    expect(r.edgePct).toBeCloseTo(4, 6); // ohne Quote identisch zur Auslenkung
  });

  it('blockt denselben Trade, sobald die Einfangquote zählt', () => {
    // 10 % der Bewegung eingefangen ⇒ 0,4 % erwarteter Gewinn gegen 1,5 %
    // Schwelle. Der Trade bewegt sich genug — er verdient nur nichts daran.
    const r = costGate({ ...krypto, capture: 0.1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bewegung_unter_kosten');
    expect(r.edgePct).toBeCloseTo(0.4, 6);
    expect(r.expectedPct).toBeCloseTo(4, 6); // Auslenkung bleibt unverändert
  });

  it('lässt dieselbe Bewegung bei besserer Signalgüte durch', () => {
    // Der Unterschied zwischen den Anlageklassen in einer Zeile: dieselbe
    // Bewegung, dieselben Kosten — nur fängt die Klasse mehr davon ein.
    expect(costGate({ ...krypto, capture: 0.1 }).ok).toBe(false);
    expect(costGate({ ...krypto, capture: 0.5 }).ok).toBe(true);
  });

  it('behandelt eine unsinnige Quote wie „nicht angegeben"', () => {
    // 0, negativ oder > 1 darf nicht dazu führen, dass plötzlich alles
    // blockiert (oder der Gewinn größer als die Bewegung wird).
    for (const q of [0, -0.5, 1.5, Number.NaN]) {
      const r = costGate({ ...krypto, capture: q });
      expect(r.edgePct).toBeCloseTo(r.expectedPct, 6);
      expect(r.ok).toBe(true);
    }
  });

  it('lässt ohne ATR weiterhin durch, auch mit Quote', () => {
    // Die permissive Richtung bei fehlendem ATR bleibt unangetastet —
    // still ausfallende Systeme sind schlimmer als schlechte.
    const r = costGate({ ...krypto, atrPct: null, capture: 0.1 });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('kein_atr');
    expect(r.edgePct).toBe(0);
  });
});

describe('captureForClass', () => {
  it('gibt Krypto die niedrigste und thematischen ETFs die höchste Quote', () => {
    // Nach der Messung vom 04.08.: crypto −0,19 % Kante gegen
    // etf_thematic +0,81 % bei denselben Signalen.
    expect(captureForClass('crypto')).toBeLessThan(captureForClass('stocks_us'));
    expect(captureForClass('stocks_us')).toBeLessThan(captureForClass('etf_thematic'));
  });

  it('gibt unbekannten Klassen keinen Vertrauensvorschuss', () => {
    expect(captureForClass('etwas_neues')).toBe(DEFAULT_CAPTURE);
    expect(captureForClass(undefined)).toBe(DEFAULT_CAPTURE);
    expect(DEFAULT_CAPTURE).toBeLessThanOrEqual(0.25);
  });

  it('hält alle Quoten in einem plausiblen Band', () => {
    // Über 1 wäre unmöglich (mehr einfangen als sich bewegt), unter 0,05
    // hieße, die Klasse praktisch abzuschalten — dann gehört sie aus dem
    // Universum, nicht in eine Feinjustierung.
    for (const q of Object.values(CLASS_CAPTURE)) {
      expect(q).toBeGreaterThanOrEqual(0.05);
      expect(q).toBeLessThanOrEqual(1);
    }
  });
});
