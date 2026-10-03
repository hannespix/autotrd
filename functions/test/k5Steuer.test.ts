/**
 * Quelltext-Wächter: Reset + Übernahme erzeugen keine Duplikate mehr
 * (Audit 13.08., K-5).
 *
 * Der Befund: `adoptBroker` legte Trades mit Zufalls-ID an und
 * deduplizierte nur gegen die Live-Sammlung — der von reset.ts selbst
 * empfohlene Ablauf „Reset → Depot übernehmen" importierte dieselben
 * Orders erneut, und der Steuerbericht (liest trades UND tradesArchive)
 * wies jede Veräußerung doppelt aus. In einem Dokument fürs Finanzamt.
 *
 * Alles daran ist Firestore-Verdrahtung; die puren P&L-Rechnungen sind in
 * `adoptPnl.test.ts` getestet. Dieser Wächter hält die Verdrahtung fest.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const adopt = readFileSync(join(hier, '../src/callable/adoptBroker.ts'), 'utf8');
const steuer = readFileSync(join(hier, '../src/callable/taxReport.ts'), 'utf8');

describe('K-5a: adoptBroker dedupliziert vollständig', () => {
  it('legt Trades mit deterministischer ID an — keine Zufalls-Duplikate', () => {
    expect(adopt).toContain("doc(`alpaca_${o.id}`)");
    // Die alte Form darf nicht zurückkommen: .doc() ohne Argument in der
    // Import-Schleife war die Duplikat-Quelle bei jeder Doppel-Übernahme.
    const schleife = adopt.slice(adopt.indexOf('for (const o of eigeneOrders)'));
    expect(schleife).not.toMatch(/collection\('trades'\)\.doc\(\)/);
  });

  it('liest die Dedupe-Basis aus trades UND tradesArchive', () => {
    expect(adopt).toContain("collection('tradesArchive').select('brokerOrderId')");
  });

  it('setzt den Lauf-Marker gegen den parallelen Scan und räumt ihn auf', () => {
    const setzt = adopt.indexOf('resetLaeuftSeit: new Date().toISOString()');
    const raeumt = adopt.indexOf('resetLaeuftSeit: null');
    expect(setzt).toBeGreaterThan(-1);
    expect(raeumt).toBeGreaterThan(setzt);
  });

  it('markiert den Mess-Schnitt und protokolliert die Cash-Rechnung', () => {
    expect(adopt).toContain("'wallet.resetAt': now");
    expect(adopt).toContain("'wallet.uebernahmeAt': now");
    // Das Diagnose-Protokoll trägt die Formel, die den −167.720-$-Fall
    // erklärt hätte — je Übernahme, dauerhaft nachlesbar.
    expect(adopt).toContain("collection('adoptLog')");
    expect(adopt).toContain('2×Σ(Short-Menge×Einstand)');
  });

  it('schneidet die Equity-Serie vor dem Übernahme-Tag', () => {
    expect(adopt).toMatch(/collection\('equity'\)\s*\n?\s*\.where\('date', '<', heute\)/);
  });
});

describe('K-5b: der Steuerbericht zählt jede Order genau einmal', () => {
  it('entdoppelt über die brokerOrderId, trades gewinnt vor dem Archiv', () => {
    const fn = steuer.slice(steuer.indexOf('async function historie'));
    const set = fn.indexOf('const gesehen = new Set<string>()');
    const schleife = fn.indexOf("for (const sammlung of ['trades', 'tradesArchive'])");
    expect(set).toBeGreaterThan(-1);
    // Das Set entsteht VOR der Sammlungs-Schleife — es gilt über beide.
    expect(set).toBeLessThan(schleife);
    expect(fn).toContain('gesehen.has(orderId)');
  });
});
