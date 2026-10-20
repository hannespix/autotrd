/**
 * Sockel ohne Prozent-Marken (Owner-Entscheidung 16.10., Task 29 + 31).
 *
 * Der Sockel schließt nur noch an der Notbremse (−25 % ab Einstand), am
 * wöchentlichen Rebalance, am Marktfilter und am Margin-Call. Diese Tests
 * halten zwei Dinge fest:
 *   1. VERHALTEN: Ein Altbestand mit gespeichertem −2-%-Level schließt bei
 *      −3 % NICHT mehr, bei −26 % sehr wohl; ein Ziel feuert nicht mehr.
 *   2. VERDRAHTUNG: Jede Stelle, die einem Sockel die alten Marken geben
 *      könnte (Kauf, Aufstockung, Puls, Broker-Schutz, Nachbuchungen), geht
 *      über dieselbe Weiche. Eine vergessene Stelle schriebe die −2 % zurück.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STRATEGY,
  SOCKEL_NOTBREMSE_PCT,
  positionLevels,
  resolveRisk,
  risikoFuer,
  sockelNachzugNoetig,
  sockelNotbremseLevel,
  sockelPruefPosition,
  sockelRisk,
  sockelSchutzVersuchFaellig,
  type Position,
} from '../../shared/src/index.js';
import { doppelkaufGesperrt, riskExitReason } from '../src/core/broker.js';

const hier = dirname(fileURLToPath(import.meta.url));
const lies = (rel: string): string => readFileSync(join(hier, rel), 'utf8');
const broker = lies('../src/core/broker.ts');
const puls = lies('../src/scheduled/riskPulse.ts');
const schutz = lies('../src/core/schutzStop.ts');
const fillSync = lies('../src/scheduled/fillSync.ts');
const adopt = lies('../src/callable/adoptBroker.ts');

const altSockel = (over: Partial<Position> = {}): Position => ({
  symbol: 'AXTI',
  qty: 10,
  avgEntry: 100,
  // Altbestand vor dem 16.10.: −2 % / +4 % beim Kauf gespeichert.
  stopLoss: 98,
  takeProfit: 104,
  openedAt: '2026-10-06T14:00:00.000Z',
  highWater: 110,
  core: true,
  ...over,
});

const pruefe = (p: Position, preis: number) =>
  riskExitReason(sockelPruefPosition(p), preis, { risk: risikoFuer(DEFAULT_STRATEGY.engine, 'stocks_us', p.core === true), now: new Date('2026-10-16T15:00:00Z') });

describe('Verhalten im Puls — Altbestand mit −2-%-Level', () => {
  it('−3 % schließt NICHT mehr (vorher: stop_loss)', () => {
    // Hoch = Einstand, damit das alte Verhalten am Stop (nicht am Trailing) schließt.
    const flach = altSockel({ highWater: 100 });
    expect(riskExitReason(flach, 97, { risk: resolveRisk(DEFAULT_STRATEGY.engine, 'stocks_us') })).toBe('stop_loss');
    expect(pruefe(flach, 97)).toBeNull();
    expect(pruefe(altSockel(), 97)).toBeNull();
  });

  it('+5 % schließt NICHT mehr (vorher: take_profit) und kein Trailing nach Hoch 110', () => {
    expect(pruefe(altSockel(), 105)).toBeNull();
    expect(pruefe(altSockel(), 103)).toBeNull(); // 110 → 103 wäre 3-%-Trailing gewesen
  });

  it('die Notbremse greift ab −25 % ab Einstand', () => {
    expect(pruefe(altSockel(), 75.5)).toBeNull();
    expect(pruefe(altSockel(), 74.9)).toBe('stop_loss');
  });

  it('Grenze genau bei 75 und Short-Seite gespiegelt (125)', () => {
    expect(pruefe(altSockel(), 75)).toBe('stop_loss');
    const kurz = altSockel({ side: 'short', stopLoss: 102, takeProfit: 96, highWater: undefined, lowWater: 90 });
    expect(pruefe(kurz, 103)).toBeNull(); // altes Short-Level 102 greift nicht mehr
    expect(pruefe(kurz, 124.9)).toBeNull();
    expect(pruefe(kurz, 125.1)).toBe('stop_loss');
  });

  it('Nicht-Sockel-Positionen bleiben exakt wie bisher', () => {
    const aktiv = altSockel({ core: false, highWater: 100 });
    expect(sockelPruefPosition(aktiv)).toBe(aktiv);
    expect(pruefe(aktiv, 97)).toBe('stop_loss');
  });
});

describe('Die Weiche (shared)', () => {
  it('Sockel-Hülle: nur Notbremse 25 %, kein Ziel/Trailing/ATR/Frist', () => {
    expect(SOCKEL_NOTBREMSE_PCT).toBe(25);
    expect(sockelRisk()).toEqual({ stopLossPct: 25, takeProfitPct: 0, trailingStopPct: 0, atrStopMult: 0, atrTakeMult: 0, maxHoldDays: 0 });
    expect(risikoFuer(DEFAULT_STRATEGY.engine, 'stocks_us', true)).toEqual(sockelRisk());
    expect(risikoFuer(DEFAULT_STRATEGY.engine, 'crypto', false)).toEqual(resolveRisk(DEFAULT_STRATEGY.engine, 'crypto'));
    expect(sockelNotbremseLevel(100)).toBe(75);
    expect(sockelNotbremseLevel(100, 'short')).toBe(125);
  });

  it('Nachzug: Altlevel und −2-%-Broker-Order werden erkannt, Neubestand nicht', () => {
    expect(sockelNachzugNoetig(altSockel())).toEqual({ level: true, broker: false });
    expect(sockelNachzugNoetig(altSockel({ broker: true, schutz: { orderId: 'o1', stopPreis: 98, qty: 10 } })))
      .toEqual({ level: true, broker: true });
    expect(sockelNachzugNoetig(altSockel({ stopLoss: 75, takeProfit: null, broker: true, schutz: { orderId: 'o2', stopPreis: 74.99, qty: 10 } })))
      .toEqual({ level: false, broker: false });
  });

  it('Anzeige: Sockel zeigt nur die Notbremse, kein Ziel, kein Trailing', () => {
    const lv = positionLevels(altSockel(), resolveRisk(DEFAULT_STRATEGY.engine, 'stocks_us'));
    expect(lv).toMatchObject({ stop: 75, target: null, trail: null, trailWartet: false, stopKi: false });
  });

  it('Backoff: Broker-Nachzug höchstens alle 30 Minuten', () => {
    const jetzt = new Date('2026-10-16T15:00:00Z');
    expect(sockelSchutzVersuchFaellig(undefined, jetzt)).toBe(true);
    expect(sockelSchutzVersuchFaellig('kaputt', jetzt)).toBe(true);
    expect(sockelSchutzVersuchFaellig('2026-10-16T14:31:00Z', jetzt)).toBe(false);
    expect(sockelSchutzVersuchFaellig('2026-10-16T14:30:00Z', jetzt)).toBe(true);
  });

  it('Task 31: eine nachgebuchte Sockel-Teilausführung wird nicht mehr als Doppelkauf abgewiesen', () => {
    const req = { source: 'engine' as const, side: 'buy' as const, aufstockung: true };
    expect(doppelkaufGesperrt(req, { core: true }, false)).toBe(true); // ohne Kennung: abgewiesen
    expect(doppelkaufGesperrt({ ...req, core: true }, { core: true }, false)).toBe(false);
  });
});

describe('Verdrahtung — jede Stelle über die Weiche', () => {
  it('Kauf und Aufstockung setzen Sockel-Level über risikoFuer, Aufstockung ohne Ziel', () => {
    expect(broker).toContain('const risk = risikoFuer(strategy.engine, req.assetClass ?? null, req.core === true, einstieg);');
    expect(broker).toContain('const sockel = pos.core === true;');
    expect(broker).toContain('const risk = risikoFuer(strategy.engine, req.assetClass ?? classify(req.symbol), sockel, pos.quelle ?? null);');
    expect(broker).toContain('takeProfit: sockel\n            ? null\n');
  });

  it('Broker-Schutz: Aufrufer UND Modul nehmen für Sockel nur die Notbremse', () => {
    expect(broker).toContain('risikoFuer(strategy.engine, klasse, req.core === true, einstiegsQuelle({ quelle: req.quelle, source: req.source, bucket: req.bucket })),');
    expect(schutz).toContain('const wirksam = pos.core === true ? sockelRisk() : umkehrBesitz(pos) ? umkehrRisk(umkehrParameterFuer(klasse)) : risk;');
    expect(schutz).toContain('if (pos.core === true) risk = sockelRisk();');
  });

  it('Puls: prüft die Sockel-Prüfposition mit der Sockel-Hülle und zieht Altlevel + Broker-Order nach', () => {
    expect(puls).toContain('const pruefPos = umkehr ? umkehrPruefPosition(pos, cls) : sockelPruefPosition(pos);');
    expect(puls).toContain('risk: sockel ? sockelRisk() : umkehr ? umkehrRisk(umkehrParameterFuer(cls)) : resolveRisk(clamped.engine, cls),');
    expect(puls).toContain('riskExitReason(pruefPos, preis, {');
    expect(puls).toContain('const nachzug = sockelNachzugNoetig(pos);');
    expect(puls).toContain('.update({ stopLoss: sockelNotbremseLevel(pos.avgEntry, pos.side ?? null), takeProfit: null }, {');
    expect(puls).toContain('if (nachzug.level) {');
    expect(puls).toContain("if (v) await schutzAnlegen(v, userDoc.id, pos.symbol, sockelRisk(), cls, `puls-${now.toISOString().slice(0, 16)}Z-sockel`);");
  });

  it('Puls: Vorbedingung, Backoff-Stempel und Notbremse auch im Momentum-Modus', () => {
    expect(puls).toContain('takeProfit: null }, { lastUpdateTime: doc.updateTime })');
    expect(puls).toContain('if (nachzug.broker && sockelSchutzVersuchFaellig(pos.sockelSchutzVersuch, now)) {');
    expect(puls).toContain('.update({ sockelSchutzVersuch: now.toISOString() })');
    expect(puls).toContain(": clamped.engine.mode === 'momentum' && !sockel");
  });

  it('Broker-Schutz: „nicht stornierbar" (schon gefüllt) legt KEINE neue Order an', () => {
    expect(schutz).toContain("if (storno === 'nicht_stornierbar') {");
  });

  it('Übernahme (adoptBroker): Sockel-Kennung und Notbremse überleben', () => {
    expect(adopt).toContain("const sockel = alt ? alt.core === true : quelle === 'sockel' && !short;");
    expect(adopt).toContain('const risk = risikoFuer(strategy.engine, cls, sockel);');
    expect(adopt).toContain('...(sockel ? { core: true } : {}),');
  });

  it('Task 31: alle drei Nachbuchungswege stempeln core: true für Sockel-Fills', () => {
    expect(broker).toContain("...(eroeffnend && quelleNach === 'sockel' ? { core: true } : {}),");
    expect(broker).toContain("...(quelleNach === 'sockel' && d.side === 'buy' ? { core: true } : {}),");
    expect(fillSync).toContain("...(!schliesst && quelleAusLauf(order.clientOrderId) === 'sockel' ? { core: true } : {}),");
  });
});
