import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STRATEGY,
  LOADOUTS,
  validateStrategy,
  vergleicheEinstellungen,
  wendeLoadoutAn,
  type Strategy,
} from '../src/index.js';

const EIGENE: Strategy = {
  ...DEFAULT_STRATEGY,
  broker: { ...DEFAULT_STRATEGY.broker, initialCapital: 25_000, leverage: 3 },
  watchlist: ['BTC-USD', 'NVDA'],
  engine: { ...DEFAULT_STRATEGY.engine, running: true },
};

describe('LOADOUTS (die eingebauten Charaktere)', () => {
  it('jedes Loadout besteht angewandt die volle Server-Validierung', () => {
    // DER Test des Milestones: Ein Preset, das saveStrategy ablehnen würde,
    // wäre ein Knopf, der nicht funktioniert.
    for (const l of LOADOUTS) {
      expect(validateStrategy(wendeLoadoutAn(DEFAULT_STRATEGY, l)), l.id).toEqual([]);
      expect(validateStrategy(wendeLoadoutAn(EIGENE, l)), l.id).toEqual([]);
    }
  });

  it('Kennungen sind eindeutig, Titel und Risiko-Zeile nie leer', () => {
    expect(new Set(LOADOUTS.map((l) => l.id)).size).toBe(LOADOUTS.length);
    for (const l of LOADOUTS) {
      expect(l.titel.length).toBeGreaterThan(0);
      expect(l.risiko.length).toBeGreaterThan(10);
      expect(l.beschreibung.length).toBeGreaterThan(10);
    }
  });

  it('running taucht in keinem Loadout auf — ein Preset startet keine Engine', () => {
    for (const l of LOADOUTS) {
      expect(l.einstellungen.engine['running'], l.id).toBeUndefined();
    }
  });

  it('nur YOLO trägt Hebel — und sagt es in der Risiko-Zeile', () => {
    for (const l of LOADOUTS) {
      if (l.id === 'yolo') {
        expect(l.hebel).toBe(3);
        expect(l.risiko).toMatch(/hebel/i);
      } else {
        expect(l.hebel, l.id).toBeUndefined();
      }
    }
  });
});

describe('wendeLoadoutAn', () => {
  const boomer = LOADOUTS.find((l) => l.id === 'boomer')!;
  const yolo = LOADOUTS.find((l) => l.id === 'yolo')!;

  it('Kapital, Anbieter, Watchlist und Start/Stop bleiben die eigenen', () => {
    const neu = wendeLoadoutAn(EIGENE, boomer);
    expect(neu.broker.initialCapital).toBe(25_000);
    expect(neu.broker.provider).toBe('paper');
    expect(neu.broker.mode).toBe('paper');
    expect(neu.watchlist).toEqual(['BTC-USD', 'NVDA']);
    expect(neu.engine.running).toBe(true);
  });

  it('ohne hebel-Feld wird der Hebel auf 1 ZURÜCKgesetzt — kein Etikettenschwindel', () => {
    // EIGENE fährt 3×; das Boomer-Depot verspricht „kein Hebel".
    expect(wendeLoadoutAn(EIGENE, boomer).broker.leverage).toBe(1);
  });

  it('YOLO setzt 3× Hebel und erlaubt Shorts', () => {
    const neu = wendeLoadoutAn(DEFAULT_STRATEGY, yolo);
    expect(neu.broker.leverage).toBe(3);
    expect(neu.signals.allowShort).toBe(true);
  });

  it('Werkseinstellung angewandt auf die Werkseinstellung ergibt keinen Diff', () => {
    const werk = LOADOUTS.find((l) => l.id === 'werk')!;
    expect(vergleicheEinstellungen(DEFAULT_STRATEGY, werk.einstellungen)).toEqual([]);
  });
});
