/**
 * Einstellungs-Prüfer.
 *
 * Die wichtigsten Tests sind die NEGATIVEN: Ein Prüfer, der bei einer
 * vernünftigen Konfiguration Vorschläge erfindet, erzieht dazu, ihn zu
 * ignorieren — und dann übersieht man den einen Befund, der zählt.
 */

import { describe, expect, it } from 'vitest';
import {
  adviseStrategy,
  applySuggestions,
  erreichbarePositionen,
  marginCallDrawdownPct,
} from '../src/tuneAdvisor.js';
import { DEFAULT_STRATEGY, type Strategy } from '../src/strategy.js';

const mit = (patch: (s: Strategy) => void): Strategy => {
  const s = structuredClone(DEFAULT_STRATEGY);
  patch(s);
  return s;
};
const keys = (s: Strategy): string[] => adviseStrategy(s).map((v) => v.key);

describe('marginCallDrawdownPct', () => {
  it('ohne Hebel gibt es keinen Zwangsverkauf', () => {
    expect(marginCallDrawdownPct(1)).toBeNull();
  });

  it('3× kippt bei 11,1 % Marktrückgang', () => {
    expect(marginCallDrawdownPct(3)).toBeCloseTo(11.1, 1);
  });

  it('2× erst bei 33,3 % — der Sprung ist der eigentliche Punkt', () => {
    // Von 3× auf 2× verdreifacht sich der Puffer. „Ein Drittel weniger
    // Hebel" klingt nach einem Drittel weniger Risiko; es sind Welten.
    expect(marginCallDrawdownPct(2)).toBeCloseTo(33.3, 1);
    expect(marginCallDrawdownPct(2)! / marginCallDrawdownPct(3)!).toBeGreaterThan(2.9);
  });

  it('eine strengere Erhaltungsmarge senkt den Puffer', () => {
    expect(marginCallDrawdownPct(3, 0.3)!).toBeLessThan(marginCallDrawdownPct(3, 0.25)!);
  });
});

describe('erreichbarePositionen', () => {
  it('rechnet aus dem Katalog, nicht aus einer Schätzung', () => {
    const n = erreichbarePositionen();
    expect(n).toBeGreaterThan(10);
    expect(n % 3).toBe(0); // Blöcke × MAX_PER_CLUSTER
  });
});

describe('adviseStrategy: die Voreinstellung ist sauber', () => {
  it('DEFAULT_STRATEGY erzeugt KEINEN Vorschlag', () => {
    // Der wichtigste Test des Moduls. Meldete der Prüfer schon beim Standard
    // etwas, wäre jede spätere Meldung Rauschen.
    expect(adviseStrategy(DEFAULT_STRATEGY)).toEqual([]);
  });
});

describe('adviseStrategy: der Fall aus dem echten Konto (28.07.)', () => {
  const echt = mit((s) => {
    s.broker.leverage = 3;
    s.engine.trailingStopPct = 0;
    s.engine.maxPositionPct = 10;
    s.engine.maxOpenPositions = 30;
  });

  it('findet alle vier Widersprüche', () => {
    expect(keys(echt).sort()).toEqual(
      ['leverage', 'maxOpenPositions', 'maxPositionPct', 'trailingStopPct'].sort(),
    );
  });

  it('sortiert das Kritische nach oben', () => {
    const v = adviseStrategy(echt);
    expect(v[0]?.severity).toBe('kritisch');
    expect(v[0]?.key).toBe('trailingStopPct');
  });

  it('jeder Vorschlag nennt seinen Grund — kein Zauberknopf', () => {
    for (const v of adviseStrategy(echt)) {
      expect(v.reason.length, v.key).toBeGreaterThan(80);
    }
  });

  it('die Positionsgröße wird so gewählt, dass Hebel × Anteil ≤ 25 % bleibt', () => {
    const v = adviseStrategy(echt).find((x) => x.key === 'maxPositionPct');
    expect((v?.suggested as number) * 3).toBeLessThanOrEqual(25);
  });
});

describe('adviseStrategy: einzelne Regeln', () => {
  it('Trailing aus OHNE Hebel ist kein Fehler', () => {
    // Bewusster Gegentest: Ohne Hebel ist ein abgeschalteter Trailing-Stop
    // eine legitime Wahl. Ihn trotzdem zu melden wäre Bevormundung.
    expect(keys(mit((s) => { s.engine.trailingStopPct = 0; }))).not.toContain('trailingStopPct');
  });

  it('2× Hebel wird nicht angemahnt — nur 3×', () => {
    expect(keys(mit((s) => { s.broker.leverage = 2; }))).not.toContain('leverage');
    expect(keys(mit((s) => { s.broker.leverage = 3; }))).toContain('leverage');
  });

  it('abgeschaltete Kostenschwelle ist kritisch', () => {
    const v = adviseStrategy(mit((s) => { s.signals.minEdgeMultiple = 0; }));
    expect(v.find((x) => x.key === 'minEdgeMultiple')?.severity).toBe('kritisch');
  });

  it('Momentum mit Hebel ist kritisch — dort gibt es keinen Stop', () => {
    const v = mit((s) => { s.engine.mode = 'momentum'; s.broker.leverage = 2; });
    expect(keys(v)).toContain('leverageMomentum');
  });

  it('Momentum OHNE Hebel ist völlig in Ordnung', () => {
    expect(keys(mit((s) => { s.engine.mode = 'momentum'; }))).not.toContain('leverageMomentum');
  });

  it('gar kein Stop wird gemeldet — ATR-Stop zählt aber als Stop', () => {
    expect(keys(mit((s) => { s.engine.stopLossPct = 0; }))).toContain('stopLossPct');
    expect(
      keys(mit((s) => { s.engine.stopLossPct = 0; s.engine.atrStopMult = 2; })),
    ).not.toContain('stopLossPct');
  });

  it('abgeschaltetes News-Veto ist ein Hinweis — fehlend (= an) aber nicht', () => {
    expect(keys(mit((s) => { s.signals.newsVeto = false; }))).toContain('newsVeto');
    expect(keys(mit((s) => { delete s.signals.newsVeto; }))).not.toContain('newsVeto');
    const next = applySuggestions(mit((s) => { s.signals.newsVeto = false; }), ['newsVeto']);
    expect(next.signals.newsVeto).toBe(true);
  });

  it('zu kurze Haltedauer nur bei 5-Minuten-Signalen', () => {
    expect(keys(mit((s) => { s.engine.minHoldMin = 5; }))).toContain('minHoldMin');
    expect(
      keys(mit((s) => { s.engine.minHoldMin = 5; s.signals.timeframe = 'daily'; })),
    ).not.toContain('minHoldMin');
  });
});

describe('applySuggestions', () => {
  const echt = mit((s) => {
    s.broker.leverage = 3;
    s.engine.trailingStopPct = 0;
    s.engine.maxOpenPositions = 30;
  });

  it('ändert NUR das Angehakte', () => {
    const next = applySuggestions(echt, ['trailingStopPct']);
    expect(next.engine.trailingStopPct).toBe(3);
    expect(next.broker.leverage).toBe(3); // nicht angehakt ⇒ unverändert
    expect(next.engine.maxOpenPositions).toBe(30);
  });

  it('lässt das Original unangetastet', () => {
    applySuggestions(echt, ['trailingStopPct', 'leverage']);
    expect(echt.engine.trailingStopPct).toBe(0);
    expect(echt.broker.leverage).toBe(3);
  });

  it('alles übernehmen macht die Strategie widerspruchsfrei', () => {
    const alle = adviseStrategy(echt).map((v) => v.key);
    const next = applySuggestions(echt, alle);
    // Der Prüfer muss auf seinem eigenen Ergebnis schweigen — sonst dreht
    // sich die Oberfläche im Kreis: übernehmen, wieder Vorschläge, übernehmen.
    expect(adviseStrategy(next)).toEqual([]);
  });

  it('unbekannte Schlüssel werden ignoriert statt zu werfen', () => {
    expect(() => applySuggestions(echt, ['gibtsnicht'])).not.toThrow();
  });
});
