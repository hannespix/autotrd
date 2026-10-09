/**
 * Task 17 (08.10.): Einstiegsweg eines geschlossenen Trades.
 *
 * Krypto verliert nach Gebühren — aber WELCHER Pfad? Die Antwort steckt in
 * Feldern, die das Trade-Dokument ohnehin trägt (bucket, source, riskExit,
 * sync). Die Quelle ist der EINSTIEGSWEG, nie der Ausstieg (Red-Team H1/H2):
 * Steckbrief zuerst, dann die Rückfälle ohne Steckbrief.
 */
import { describe, expect, it } from 'vitest';
import { TRADE_QUELLEN, einstiegsQuelle, istEinstiegsweg, LAUF_WEG_SUFFIX, laufMitWeg, quelleAusLauf, quelleBekannt, tradeQuelle } from '../src/tradeQuelle.js';

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

describe('Task 18 — beim Öffnen gestempelte Quelle', () => {
  it('zählt NACH dem Steckbrief und VOR den Rückfällen; sync/unbekannt/Fremdwerte werden ignoriert', () => {
    expect(tradeQuelle({ source: 'engine', bucket: 'crypto|daily|momentum|long|alle', quelle: 'hand' })).toBe('momentum');
    expect(tradeQuelle({ source: 'manual', quelle: 'momentum' })).toBe('momentum');
    expect(tradeQuelle({ source: 'engine', riskExit: 'momentum_rebalance', quelle: 'konfluenz' })).toBe('konfluenz');
    expect(tradeQuelle({ source: 'engine', sync: true, quelle: 'sockel' })).toBe('sockel');
    expect(tradeQuelle({ source: 'engine', quelle: 'sync' })).toBe('unbekannt');
    expect(tradeQuelle({ source: 'engine', quelle: 'unbekannt', riskExit: 'core_rebalance' })).toBe('sockel');
    expect(tradeQuelle({ source: 'engine', quelle: 'einhorn' })).toBe('unbekannt');
    expect(tradeQuelle({ source: 'engine', quelle: 42 })).toBe('unbekannt');
  });

  it('istEinstiegsweg: nur benannte Wege', () => {
    expect(istEinstiegsweg('konfluenz')).toBe(true);
    expect(istEinstiegsweg('hand')).toBe(true);
    expect(istEinstiegsweg('sync')).toBe(false);
    expect(istEinstiegsweg('unbekannt')).toBe(false);
    expect(istEinstiegsweg('')).toBe(false);
    expect(istEinstiegsweg(null)).toBe(false);
  });

  it('einstiegsQuelle: ausdrücklich, sonst aus dem Steckbrief, sonst null (nie sync/unbekannt)', () => {
    expect(einstiegsQuelle({ quelle: 'momentum', source: 'engine', bucket: 'crypto|daily|rsi|long|trend' })).toBe('momentum');
    expect(einstiegsQuelle({ source: 'engine', bucket: 'crypto|daily|rsi|long|trend' })).toBe('konfluenz');
    expect(einstiegsQuelle({ source: 'manual' })).toBe('hand');
    expect(einstiegsQuelle({ source: 'engine' })).toBeNull();
    expect(einstiegsQuelle({ quelle: 'sync', source: 'engine' })).toBeNull();
  });
});

describe('Task 18 — quelleAusLauf: Einstiegsweg aus der Lauf-Kennung', () => {
  it('liest das ENDE der clientOrderId (uid gekappt oder nicht) und die bloße laufId', () => {
    expect(quelleAusLauf('uid123-BTC-USD-buy-0_5-man-2026-10-08T10_03Z')).toBe('hand');
    expect(quelleAusLauf('uid123-AAPL-buy-10-mom-2026-10-08')).toBe('momentum');
    expect(quelleAusLauf('u-AAPL-buy-10-core-2026-10-08')).toBe('sockel');
    expect(quelleAusLauf('man-2026-10-08T10:03Z')).toBe('hand'); // Rohform mit Doppelpunkt
    expect(quelleAusLauf('mom-2026-10-08')).toBe('momentum');
    expect(quelleAusLauf('core-2026-10-08')).toBe('sockel');
  });

  it('Scan-Wege stehen als Suffix in der Kennung (09.10.) — Konfluenz, Regelbaum, KI-Probe werden unterscheidbar', () => {
    expect(laufMitWeg('2026-10-09T13:00Z', 'konfluenz')).toBe('2026-10-09T13:00Z-kfl');
    expect(laufMitWeg('2026-10-09T13:00Z', 'regelbaum')).toBe('2026-10-09T13:00Z-rgb');
    expect(laufMitWeg('2026-10-09T13:00Z', 'ki_probe')).toBe('2026-10-09T13:00Z-kip');
    // Präfix-Wege und Lücken bleiben unverändert — ihre Regexe sind am Ende verankert.
    expect(laufMitWeg('mom-2026-10-09', 'momentum')).toBe('mom-2026-10-09');
    expect(laufMitWeg('core-2026-10-09', 'sockel')).toBe('core-2026-10-09');
    expect(laufMitWeg('man-2026-10-09T10:03Z', 'hand')).toBe('man-2026-10-09T10:03Z');
    expect(laufMitWeg('2026-10-09T13:00Z', null)).toBe('2026-10-09T13:00Z');
    expect(laufMitWeg('2026-10-09T13:00Z', 'unbekannt')).toBe('2026-10-09T13:00Z');
    // Rückweg über die volle clientOrderId (uid-symbol-side-qty-lauf), auch nach der Zeichen-Säuberung.
    expect(quelleAusLauf('uid123-AAPL-buy-10-2026-10-09T13_00Z-kfl')).toBe('konfluenz');
    expect(quelleAusLauf('uid123-AAPL-buy-10-2026-10-09T13:00Z-rgb')).toBe('regelbaum');
    expect(quelleAusLauf('uid123-AAPL-buy-10-2026-10-09T13_00Z-kip')).toBe('ki_probe');
    // Ein Symbol, das zufällig so endet, zählt nicht: Suffix braucht den Bindestrich davor.
    expect(quelleAusLauf('uid-AAPL-buy-10-2026-10-09T13_00Zkfl')).toBeNull();
    expect(Object.values(LAUF_WEG_SUFFIX).every((s) => /^[a-z]{3}$/.test(s))).toBe(true);
    // Präfixierte Kennungen bekommen NIE ein Suffix — sonst überstimmte es beim Lesen den Präfix (Red-Team N4).
    expect(laufMitWeg('man-2026-10-09T10:03Z', 'konfluenz')).toBe('man-2026-10-09T10:03Z');
    expect(laufMitWeg('mom-2026-10-09', 'ki_probe')).toBe('mom-2026-10-09');
    expect(laufMitWeg('exit-2026-10-09T10_03_00_000Z-q10', 'regelbaum')).toBe('exit-2026-10-09T10_03_00_000Z-q10');
    expect(quelleAusLauf(`uid-AAPL-buy-10-${laufMitWeg('man-2026-10-09T10:03Z', 'konfluenz')}`)).toBe('hand');
  });

  it('die Kombination aus executeTrade: Steckbrief → Weg → Kennung, für alle sechs Einstiegswege', () => {
    const kennung = (bucket: string, laufId = '2026-10-09T13:00Z'): string =>
      laufMitWeg(laufId, einstiegsQuelle({ source: 'engine', bucket }));
    // Steckbrief = klasse|zeitrahmen|signatur|richtung|regime — die Signatur entscheidet.
    expect(kennung('stocks_us|daily|rsi+macd|long|trend')).toBe('2026-10-09T13:00Z-kfl');
    expect(kennung('crypto|daily|regelbaum|long|trend')).toBe('2026-10-09T13:00Z-rgb');
    expect(kennung('crypto|daily|ki+rsi|long|trend')).toBe('2026-10-09T13:00Z-kip');
    expect(kennung('stocks_us|daily|manuell|long|trend', 'man-2026-10-09T13:00Z')).toBe('man-2026-10-09T13:00Z');
    expect(kennung('stocks_us|daily|momentum|long|trend', 'mom-2026-10-09')).toBe('mom-2026-10-09');
    expect(kennung('stocks_us|daily|core|long|trend', 'core-2026-10-09')).toBe('core-2026-10-09');
    // Ohne Steckbrief bleibt die Kennung roh — und der Rückweg ehrlich null.
    expect(kennung('')).toBe('2026-10-09T13:00Z');
    expect(quelleAusLauf(`u-AAPL-buy-1-${kennung('')}`)).toBeNull();
  });

  it('ein Scan-Zeitstempel ist mehrdeutig; Exits, Puls, Schutz und fill-sync sind keine Einstiege', () => {
    expect(quelleAusLauf('uid123-AAPL-buy-10-2026-10-08T10_03Z')).toBeNull();
    expect(quelleAusLauf('uid123-AAPL-sell-10-exit-2026-10-08T10_03_00_000Z-q10')).toBeNull();
    expect(quelleAusLauf('uid123-AAPL-buy-10-puls-2026-10-08T10_03Z')).toBeNull();
    expect(quelleAusLauf('uid123-AAPL-sell-10-2026-10-08T10_03Z-schutz')).toBeNull();
    expect(quelleAusLauf('fill-sync')).toBeNull();
    // „man" muss ein eigenes Segment sein — ein Symbol namens HUMAN zählt nicht
    expect(quelleAusLauf('uid-HUMAN-buy-1-2026-10-08T10_03Z')).toBeNull();
    expect(quelleAusLauf('batman-2026-10-08T10_03Z')).toBeNull(); // „man" nur als eigenes Segment
    expect(quelleAusLauf('uid-AAPL-buy-1-custom-2026-10-08')).toBeNull(); // „mom" ebenso
    expect(quelleAusLauf('')).toBeNull();
    expect(quelleAusLauf(undefined)).toBeNull();
    expect(quelleAusLauf(7)).toBeNull();
  });
});
