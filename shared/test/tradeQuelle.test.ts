/**
 * Task 17 (08.10.): Einstiegsweg eines geschlossenen Trades.
 *
 * Krypto verliert nach Gebühren — aber WELCHER Pfad? Die Antwort steckt in
 * Feldern, die das Trade-Dokument ohnehin trägt (bucket, source, riskExit,
 * sync). Die Quelle ist der EINSTIEGSWEG, nie der Ausstieg (Red-Team H1/H2):
 * Steckbrief zuerst, dann die Rückfälle ohne Steckbrief.
 */
import { describe, expect, it } from 'vitest';
import { TRADE_QUELLEN, quelleBekannt, tradeQuelle } from '../src/tradeQuelle.js';

describe('tradeQuelle — der Steckbrief entscheidet, nicht der Ausstieg', () => {
  it("Hand-KAUF trägt die Signatur 'manuell' (trade.ts) → hand, auch wenn die Engine ihn ausstoppt (H1)", () => {
    expect(tradeQuelle({ source: 'engine', bucket: 'crypto|daily|manuell|long|alle', riskExit: 'stop_loss' })).toBe('hand');
    expect(tradeQuelle({ source: 'engine', bucket: 'crypto|daily|manuell|long|alle', riskExit: 'momentum_rebalance' })).toBe('hand');
  });

  it('Hand-VERKAUF einer Engine-Position bleibt beim Einstiegsweg (H2)', () => {
    expect(tradeQuelle({ source: 'manual', bucket: 'crypto|daily|momentum|long|alle' })).toBe('momentum');
    expect(tradeQuelle({ source: 'manual', bucket: 'crypto|daily|rsi+macd|long|trend' })).toBe('konfluenz');
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

  it("die Signatur 'keine' ist kein Einstiegsweg — es greifen die Rückfälle", () => {
    expect(tradeQuelle({ source: 'engine', bucket: 'crypto|daily|keine|long|alle' })).toBe('unbekannt');
    expect(tradeQuelle({ source: 'manual', bucket: 'crypto|daily|keine|long|alle' })).toBe('hand');
  });

  it('ohne Steckbrief: Hand-Trade vor dem Stempel, dann der Ausstiegsgrund, dann sync, sonst unbekannt', () => {
    expect(tradeQuelle({ source: 'manual' })).toBe('hand');
    expect(tradeQuelle({ source: 'engine', riskExit: 'momentum_rebalance' })).toBe('momentum');
    expect(tradeQuelle({ source: 'engine', riskExit: 'core_rebalance' })).toBe('sockel');
    expect(tradeQuelle({ source: 'engine', riskExit: 'core_aufloesung' })).toBe('sockel');
    // adoptBroker bucht mit sync: true und OHNE Steckbrief — eine Lücke, kein Pfad
    expect(tradeQuelle({ source: 'engine', sync: true })).toBe('sync');
    expect(tradeQuelle({ source: 'engine', sync: true, riskExit: 'momentum_rebalance' })).toBe('momentum');
    expect(tradeQuelle({ source: 'engine', riskExit: 'stop_loss' })).toBe('unbekannt');
    expect(tradeQuelle({ source: 'engine', riskExit: 'fill_sync' })).toBe('unbekannt');
    expect(tradeQuelle({})).toBe('unbekannt');
  });

  it('kaputte Felder werfen nicht', () => {
    expect(tradeQuelle({ source: 42, bucket: 7, riskExit: null, sync: 'ja' })).toBe('unbekannt');
    expect(tradeQuelle({ bucket: '' })).toBe('unbekannt');
    expect(tradeQuelle({ bucket: 'nur|zwei' })).toBe('unbekannt');
  });

  it('sync und unbekannt sind Lücken, keine Pfade', () => {
    expect(TRADE_QUELLEN).toEqual(['konfluenz', 'regelbaum', 'momentum', 'sockel', 'ki_probe', 'hand', 'sync', 'unbekannt']);
    expect(TRADE_QUELLEN.filter(quelleBekannt)).toEqual(['konfluenz', 'regelbaum', 'momentum', 'sockel', 'ki_probe', 'hand']);
  });
});
