/**
 * Ein Broker-Depot gehört genau einem autotrd-Konto.
 *
 * Der Anlassfall vom 12.08. steht als eigener Test drin: zwei Konten, ein
 * Alpaca-Depot, addierte Positionen.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { bindungsMeldung, pruefeBindung, type Bindung } from '../src/brokerBindung.js';

const bestand = (uid: string): Bindung => ({ uid, at: '2026-08-01T10:00:00.000Z' });

describe('pruefeBindung', () => {
  it('lässt ein unbelegtes Depot zu', () => {
    const b = pruefeBindung('fp-abc', 'user-1', null);
    expect(b.ok).toBe(true);
    expect(b.zustand).toBe('frei');
  });

  it('lässt dasselbe Konto erneut verbinden (Schlüsselwechsel)', () => {
    const b = pruefeBindung('fp-abc', 'user-1', bestand('user-1'));
    expect(b.ok).toBe(true);
    expect(b.zustand).toBe('eigen');
  });

  it('weist ein fremdes Konto ab', () => {
    const b = pruefeBindung('fp-abc', 'user-2', bestand('user-1'));
    expect(b.ok).toBe(false);
    if (b.ok) throw new Error('unerwartet');
    expect(b.zustand).toBe('fremd');
    expect(b.belegtVon).toBe('user-1');
    expect(b.seit).toBe('2026-08-01T10:00:00.000Z');
  });

  it('gilt ohne Fingerabdruck als frei — fehlende Daten sind kein Beleg', () => {
    // Liefert der Broker keine Konto-ID, ist das ein Datenproblem und kein
    // Nachweis, dass zwei Konten dasselbe Depot teilen. Blockieren träfe
    // den Falschen.
    for (const fp of [null, undefined, '']) {
      expect(pruefeBindung(fp, 'user-2', bestand('user-1')).ok).toBe(true);
    }
  });

  it('gilt ohne uid als frei', () => {
    expect(pruefeBindung('fp-abc', '', bestand('user-1')).ok).toBe(true);
  });

  it('behandelt einen Bestand ohne uid als unbelegt', () => {
    const kaputt = { uid: '', at: '2026-08-01T10:00:00.000Z' };
    expect(pruefeBindung('fp-abc', 'user-2', kaputt).ok).toBe(true);
  });

  it('reproduziert den Anlassfall: zweites Konto, dasselbe Depot', () => {
    // Owner 12.08.: autotrd zeigt 10 offene Positionen (sein Limit), Alpaca
    // 17 — vier davon bis auf die sechste Nachkommastelle identisch, sechs
    // beim Broker größer. Ein Depot, zwei Bücher.
    const b = pruefeBindung('fp-alpaca-paper-1', 'konto-B', bestand('konto-A'));
    expect(b.ok).toBe(false);
    if (b.ok) throw new Error('unerwartet');
    expect(b.belegtVon).toBe('konto-A');
  });
});

describe('bindungsMeldung', () => {
  it('nennt das Datum, aber NICHT das fremde Konto', () => {
    const text = bindungsMeldung('2026-08-01T10:00:00.000Z');
    expect(text).toContain('2026-08-01');
    expect(text).not.toContain('konto-A');
    expect(text).not.toContain('user-1');
  });

  it('erklärt den Grund statt nur abzulehnen — der Wortlaut wohnt im Wörterbuch', () => {
    // Seit Task #145 liefert der Helfer den Parameter-Code; die Erklärung
    // („eine einzige Position je Symbol") steht im Frontend-Wörterbuch und
    // wird hier gegen genau den Code gepinnt, den der Helfer liefert.
    const text = bindungsMeldung('2026-08-01T10:00:00.000Z');
    expect(text.startsWith('srv.depotBereitsGebunden|')).toBe(true);
    const woerterbuch = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../frontend/src/i18n.ts'),
      'utf8',
    );
    const zeile = woerterbuch
      .split('\n')
      .find((l) => l.includes("'srv.depotBereitsGebunden':") && l.includes('einzige Position'));
    expect(zeile, 'Erklärtext fehlt im DE-Wörterbuch').toBeTruthy();
  });
});
