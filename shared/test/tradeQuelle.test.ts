/**
 * Task 17 (08.10.): Einstiegsweg eines geschlossenen Trades.
 *
 * Krypto verliert nach Gebühren — aber WELCHER Pfad? Die Antwort steckt in
 * Feldern, die das Trade-Dokument ohnehin trägt (source, bucket, riskExit,
 * sync). Die Prüfreihenfolge ist Vertrag: Hand vor Sync vor Steckbrief vor
 * Ausstiegsgrund.
 */
import { describe, expect, it } from 'vitest';
import { TRADE_QUELLEN, tradeQuelle } from '../src/tradeQuelle.js';

describe('tradeQuelle', () => {
  it('Hand-Trades zuerst — auch wenn die Position einen Engine-Steckbrief trug', () => {
    expect(tradeQuelle({ source: 'manual' })).toBe('hand');
    expect(tradeQuelle({ source: 'manual', bucket: 'crypto|daily|momentum|long|alle' })).toBe('hand');
  });

  it('nachgebuchter Broker-Bestand (adoptBroker) ist kein eigener Einstieg', () => {
    expect(tradeQuelle({ source: 'engine', sync: true, bucket: 'crypto|daily|rsi+macd|long|trend' })).toBe('sync');
    expect(tradeQuelle({ source: 'engine', sync: false, bucket: 'crypto|daily|rsi+macd|long|trend' })).toBe('konfluenz');
  });

  it('liest den Steckbrief: Probe vor festen Signaturen vor Konfluenz', () => {
    expect(tradeQuelle({ source: 'engine', bucket: 'crypto|daily|ki+rsi|long|trend' })).toBe('ki_probe');
    expect(tradeQuelle({ source: 'engine', bucket: 'crypto|intraday|lex|short|seitwaerts' })).toBe('ki_probe');
    expect(tradeQuelle({ source: 'engine', bucket: 'crypto|daily|momentum|long|alle' })).toBe('momentum');
    expect(tradeQuelle({ source: 'engine', bucket: 'crypto|daily|core|long|alle' })).toBe('sockel');
    expect(tradeQuelle({ source: 'engine', bucket: 'crypto|daily|regelbaum|long|trend' })).toBe('regelbaum');
    expect(tradeQuelle({ source: 'engine', bucket: 'crypto|daily|rsi+macd|long|trend' })).toBe('konfluenz');
    expect(tradeQuelle({ source: 'engine', bucket: 'stocks_us|daily|bollinger|short|stress' })).toBe('konfluenz');
  });

  it("die Signatur 'keine' ist kein Konfluenz-Einstieg", () => {
    expect(tradeQuelle({ source: 'engine', bucket: 'crypto|daily|keine|long|alle' })).toBe('unbekannt');
  });

  it('ohne Steckbrief verrät der Ausstiegsgrund Momentum und Sockel — sonst unbekannt', () => {
    expect(tradeQuelle({ source: 'engine', riskExit: 'momentum_rebalance' })).toBe('momentum');
    expect(tradeQuelle({ source: 'engine', riskExit: 'core_rebalance' })).toBe('sockel');
    expect(tradeQuelle({ source: 'engine', riskExit: 'core_aufloesung' })).toBe('sockel');
    expect(tradeQuelle({ source: 'engine', riskExit: 'stop_loss' })).toBe('unbekannt');
    expect(tradeQuelle({ source: 'engine', riskExit: 'fill_sync' })).toBe('unbekannt');
    expect(tradeQuelle({})).toBe('unbekannt');
  });

  it('kaputte Felder werfen nicht', () => {
    expect(tradeQuelle({ source: 42, bucket: 7, riskExit: null, sync: 'ja' })).toBe('unbekannt');
    expect(tradeQuelle({ bucket: '' })).toBe('unbekannt');
    expect(tradeQuelle({ bucket: 'nur|zwei' })).toBe('unbekannt');
  });

  it('jeder Wert ist in der Anzeige-Reihenfolge enthalten', () => {
    expect(TRADE_QUELLEN).toEqual(['konfluenz', 'regelbaum', 'momentum', 'sockel', 'ki_probe', 'hand', 'sync', 'unbekannt']);
  });
});
