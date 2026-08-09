/**
 * Der Exit-Umbau (MX, Owner-Go 09.08.) — die Migration bestehender Konten.
 *
 * Anlass war eine Rechnung: Aus 317 Trades folgen 32,5 % Trefferquote und ein
 * Gewinn/Verlust-Verhältnis von 1,18, daraus ein Kelly-Einsatz von −24,6 %.
 * Der optimale Einsatz ist negativ, das System lässt sich also nicht größer
 * machen, nur reparieren. Die Ausstiegs-Statistik sagt wo: 275 von 317 Trades
 * enden am Signal (Trefferquote dort 26,9 %), während 26 von 26 Ziel-Exits
 * gewinnen.
 *
 * Diese Funktion ändert fremde Handelseinstellungen. Sie muss deshalb an
 * jeder Grenze festgenagelt sein — besonders dort, wo „größer" und „strenger"
 * auseinanderfallen (maxHoldDays 0 = unbegrenzt).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STRATEGY,
  EXIT_UMBAU_STAND,
  EXIT_UMBAU_ZIEL,
  exitUmbauPlan,
} from '../src/strategy.js';

describe('exitUmbauPlan — greift genau einmal', () => {
  it('ein bereits migriertes Konto wird nicht erneut angefasst', () => {
    expect(exitUmbauPlan({ exitUmbauStand: EXIT_UMBAU_STAND }, {})).toBeNull();
  });

  it('ein höherer Stand als der geforderte gilt ebenfalls als erledigt', () => {
    expect(exitUmbauPlan({ exitUmbauStand: 5 }, {}, 1)).toBeNull();
  });

  it('ein Konto ohne Stand wird migriert', () => {
    expect(exitUmbauPlan({}, {})).not.toBeNull();
  });
});

describe('exitUmbauPlan — verschärft nur, lockert nie', () => {
  it('hebt eine zu kurze Mindesthaltedauer an', () => {
    expect(exitUmbauPlan({ minHoldMin: 60 }, {})?.minHoldMin).toBe(EXIT_UMBAU_ZIEL.minHoldMin);
  });

  it('lässt eine LÄNGERE Mindesthaltedauer stehen', () => {
    // Wer bewusst drei Tage hält, soll nicht auf einen Tag zurückgesetzt
    // werden — die Migration soll den Ausstieg bremsen, nicht angleichen.
    expect(exitUmbauPlan({ minHoldMin: 4320 }, {})?.minHoldMin).toBeUndefined();
  });

  it('hebt eine zu schwache Ausstiegs-Konfluenz an', () => {
    expect(exitUmbauPlan({}, { exitConfluence: 2 })?.exitConfluence).toBe(3);
  });

  it('behandelt eine FEHLENDE Ausstiegs-Konfluenz als den schwächsten Wert', () => {
    // Fehlt das Feld, rechnet die Engine mit `minConfluence - 1` — bei der
    // Voreinstellung also EINE Gegenstimme. Genau der Zustand, der die
    // Positionen zerschneidet; er darf nicht als „bewusst gewählt" gelten.
    expect(exitUmbauPlan({}, {})?.exitConfluence).toBe(3);
  });

  it('lässt eine STRENGERE Ausstiegs-Konfluenz stehen', () => {
    expect(exitUmbauPlan({}, { exitConfluence: 4 })?.exitConfluence).toBeUndefined();
  });
});

describe('exitUmbauPlan — was BEWUSST nicht angefasst wird', () => {
  it('lässt maxHoldDays in Ruhe', () => {
    // Der erste Entwurf setzte hier 10 Tage. Die Testsuite hat sofort
    // widersprochen (mehrere Exit-Tests meldeten `max_hold` statt `null`),
    // und der Grund dahinter wiegt schwerer als der Nutzen: Die Frist misst
    // AB EINSTIEG. Sie einzuschalten hieße, beim nächsten Scan jede ältere
    // Position quer durch alle Konten zu schließen — mit Gebühren auf jede
    // einzelne und ohne Bezug zu ihrer Aussicht.
    const p = exitUmbauPlan({ maxHoldDays: 0 }, {});
    expect(p).not.toHaveProperty('maxHoldDays');
  });
});

describe('exitUmbauPlan — Randfälle', () => {
  it('ein Konto, das schon alles erfüllt, bekommt einen leeren Plan (nicht null)', () => {
    // Der Unterschied zählt: `null` heißt „schon migriert", `{}` heißt
    // „muss migriert werden, aber es ist nichts zu ändern" — nur im zweiten
    // Fall wird der Stand gesetzt, damit die Prüfung künftig entfällt.
    const p = exitUmbauPlan({ minHoldMin: 1440 }, { exitConfluence: 3 });
    expect(p).toEqual({});
  });

  it('undefined für beide Seiten stürzt nicht ab', () => {
    expect(exitUmbauPlan(undefined, undefined)).toEqual({
      minHoldMin: EXIT_UMBAU_ZIEL.minHoldMin,
      exitConfluence: EXIT_UMBAU_ZIEL.exitConfluence,
    });
  });
});

describe('Voreinstellung und Migrationsziel sind dieselbe Zahl', () => {
  // Liefen sie auseinander, bekämen neue und bestehende Konten unterschiedliche
  // Einstellungen — und niemand würde es merken, weil beide für sich plausibel
  // aussehen.
  it('DEFAULT_STRATEGY trägt genau die Zielwerte', () => {
    expect(DEFAULT_STRATEGY.engine.minHoldMin).toBe(EXIT_UMBAU_ZIEL.minHoldMin);
    expect(DEFAULT_STRATEGY.signals.exitConfluence).toBe(EXIT_UMBAU_ZIEL.exitConfluence);
  });

  it('ein frisches Konto braucht keine Migration der Werte', () => {
    expect(
      exitUmbauPlan(DEFAULT_STRATEGY.engine, DEFAULT_STRATEGY.signals),
    ).toEqual({});
  });
});
