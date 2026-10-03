/**
 * Quelltext-Wächter: Härtung der Außen-Grenzen (Audit 13.08.,
 * Sicherheits-Strang).
 *
 * Zwei Befunde: (1) `connectBroker`, `brokerStatus` und `adoptBroker`
 * prüften die Freischaltung NICHT — jedes frisch registrierte, nie
 * freigeschaltete Konto konnte Schlüssel hinterlegen und Alpaca-Aufrufe
 * auslösen (Tagesquoten × Wegwerf-Konten = Fremd-API-Kosten vor jeder
 * menschlichen Prüfung). (2) `meta/bestPractice` veröffentlichte die
 * komplette Strategie-Konfiguration des besten Kontos ab EINEM geeigneten
 * Konto — bei zwei, drei Konten ist „das beste Konto" eine Person; die
 * Anonymitätsschwelle von `meta/health` griff dort nicht.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const q = (rel: string): string => readFileSync(join(hier, '../src', rel), 'utf8');

describe('Freischaltungs-Gate vor jedem Alpaca-Außen-Call', () => {
  it('connectBroker: Gate NACH dem Trennen-Zweig, VOR Quota und Probe-Call', () => {
    const src = q('callable/connectBroker.ts');
    const trennen = src.indexOf("if (action === 'disconnect') return trenneBroker(uid);");
    // Seit der Härtung 24.08. (mayTradeSnap statt mayTrade(.data())) —
    // dieselbe Lücke, die ein bereits gelöschtes Konto mit einem noch
    // gültigen Token wieder erreichbar machte (Nahtstellen-Befund).
    const gate = src.indexOf('if (!mayTradeSnap(zugangSnap))');
    const quota = src.indexOf("consumeQuota(uid, 'connectBroker'");
    expect(trennen).toBeGreaterThan(-1);
    // Trennen bleibt frei: Ein gesperrtes Konto darf seine Schlüssel
    // immer entfernen — das Gate steht dahinter.
    expect(gate).toBeGreaterThan(trennen);
    expect(gate).toBeLessThan(quota);
  });

  it('brokerStatus: Gate direkt nach dem User-Doc, vor jedem Broker-Aufruf', () => {
    const src = q('callable/brokerStatus.ts');
    const fn = src.slice(src.indexOf('export async function pruefeBrokerStatus'));
    const gate = fn.indexOf('if (!mayTradeSnap(userDoc))');
    const aufruf = fn.indexOf('alpacaKonto(');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(aufruf);
  });

  it('adoptBroker: Gate vor Quota, Lauf-Marker und Broker-Abruf', () => {
    const src = q('callable/adoptBroker.ts');
    const gate = src.indexOf('if (!mayTradeSnap(zugangSnap))');
    const quota = src.indexOf("consumeQuota(uid, 'adoptBroker'");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(quota);
  });

  it('alle drei nennen den Grund über accessDeniedReason — keine stummen 403', () => {
    for (const rel of ['callable/connectBroker.ts', 'callable/brokerStatus.ts', 'callable/adoptBroker.ts']) {
      expect(q(rel)).toContain('accessDeniedReason(accessLevelOfSnap(');
    }
  });

  it('trade.ts: dieselbe Härtung (vierte Fundstelle, Verifikations-Befund 24.08.)', () => {
    // Ein Verifikations-Agent fand denselben ungehärteten mayTrade(.data())-
    // Aufruf hier — aktuell nur zufällig unschädlich, weil ein direkt
    // folgender strategy-Read bei fehlendem Dokument ebenfalls abbricht.
    // Zufälliger Schutz durch eine unabhängige zweite Prüfung ist kein
    // Entwurf; jede künftige Änderung an der strategy-Fallback-Logik hätte
    // die Lücke wieder geöffnet.
    const src = q('callable/trade.ts');
    expect(src).toContain('mayTradeSnap(userSnap)');
    expect(src).toContain('accessDeniedReason(accessLevelOfSnap(userSnap))');
    expect(src).not.toContain('mayTrade(userSnap.data())');
  });
});

describe('bestPractice hinter der Anonymitätsschwelle', () => {
  const src = q('scheduled/snapshotEquity.ts');

  it('veröffentlicht Einstellungen erst ab MIN_ACCOUNTS_PUBLIC beitragenden Konten', () => {
    expect(src).toContain('beitragende < MIN_ACCOUNTS_PUBLIC');
    expect(src).toContain("stand: 'zurueckgehalten'");
    // Die Zählung nutzt dieselbe Beitrags-Definition wie meta/health.
    expect(src).toContain('beitraege.filter((b) => (b.stats?.n ?? 0) > 0).length');
  });
});
