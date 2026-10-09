/** Task 21: Entscheidungsgründe eines Trades in Alltagssprache. */
import { describe, expect, it } from 'vitest';
import { ausstiegsGruende, einstiegsGruende } from '../src/tradeGruende.js';

const texte = (r: { gruende: { text: string }[] }): string => r.gruende.map((g) => g.text).join(' | ');

describe('einstiegsGruende', () => {
  it('Konfluenz-Kauf: Zahl der Anzeichen, wer dafür und wer dagegen war, Marktlage, Klasse', () => {
    const r = einstiegsGruende({
      side: 'buy', source: 'engine', assetClass: 'stocks_us',
      signalContext: { typ: 'konfluenz', konfluenz: 2, minKonfluenz: 2, votes: { rsi: 'hold', macd: 'buy', bollinger: 'sell', forecast: 'buy' }, regime: 'trend' },
    });
    expect(r.titel).toBe('Gekauft');
    expect(texte(r)).toContain('2 von mindestens 2 nötigen Anzeichen zeigten gleichzeitig auf steigende Kurse: der Trend-Messer (MACD) und die Kursprognose des Systems.');
    expect(texte(r)).toContain('Dagegen sprach: das Schwankungsband (Bollinger).');
    expect(texte(r)).toContain('ruhiger Aufwärtstrend');
    expect(texte(r)).toContain('Anlageklasse: US-Aktien.');
    expect(r.gruende.find((g) => g.text.startsWith('Dagegen'))!.art).toBe('contra');
  });

  it('KI-Probe: die Technik allein reichte nicht, die Nachricht trug den Kauf in Probegröße', () => {
    const r = einstiegsGruende({ side: 'buy', source: 'engine', signalContext: { typ: 'konfluenz', konfluenz: 1, minKonfluenz: 2, votes: { macd: 'buy' }, ki: { richtung: 'positiv', probe: true } } });
    expect(texte(r)).toContain('Die Technik allein reichte nicht');
    const mitKiStimme = einstiegsGruende({ side: 'buy', signalContext: { typ: 'konfluenz', konfluenz: 1, minKonfluenz: 2, votes: { macd: 'buy', ki: 'buy' }, ki: { richtung: 'positiv', probe: true } } });
    expect(texte(mitKiStimme)).toContain('(1 von mindestens 2 nötigen Anzeichen: der Trend-Messer (MACD)).');
    expect(texte(r)).toContain('als gut für das Unternehmen eingestuft — der Kauf kam nur deshalb zustande');
  });

  it('Prognose-Pfeil: gespeichert wird buy/sell (Alt: up/down) — „nach oben" ist pro beim Kauf', () => {
    const r = einstiegsGruende({ side: 'buy', signalContext: { typ: 'konfluenz', konfluenz: 2, forecast: { dir: 'buy', weight: 0.5 } } });
    expect(r.gruende.find((g) => g.text.includes('Deine eigene Kursprognose (der Pfeil, den du im Chart gezeichnet hast) zeigte nach oben'))!.art).toBe('pro');
    const alt = einstiegsGruende({ side: 'buy', signalContext: { typ: 'konfluenz', konfluenz: 2, forecast: { dir: 'up' } } });
    expect(texte(alt)).toContain('nach oben');
  });

  it('Systemprognose (Stimme) und eigener Pfeil (Journal) sind zwei Dinge', () => {
    const r = einstiegsGruende({ side: 'buy', signalContext: { typ: 'konfluenz', konfluenz: 2, votes: { macd: 'buy', forecast: 'buy' }, forecast: { dir: 'sell' } } });
    expect(texte(r)).toContain('der Trend-Messer (MACD) und die Kursprognose des Systems');
    expect(r.gruende.find((g) => g.text.startsWith('Deine eigene Kursprognose'))!.art).toBe('contra');
  });

  it('ohne Journal: Stimmen und Weg aus dem Steckbrief (wie im Lagebericht)', () => {
    const r = einstiegsGruende({ side: 'buy', source: 'engine', bucket: 'crypto|intraday|macd+rsi|long|seitwaerts' });
    expect(texte(r)).toContain('Mehrere Anzeichen zeigten gleichzeitig auf steigende Kurse: der Trend-Messer (MACD) und der Überhitzungs-Messer (RSI).');
    expect(texte(r)).toContain('Gesamtmarkt ohne klare Richtung');
    expect(texte(r)).toContain('Anlageklasse: Krypto.');
    const hand = einstiegsGruende({ side: 'buy', source: 'engine', bucket: 'stocks_us|daily|manuell|long|alle' });
    expect(texte(hand)).toContain('Von dir selbst ausgelöst');
    const probe = einstiegsGruende({ side: 'buy', source: 'engine', bucket: 'stocks_us|intraday|ki|long|trend' });
    expect(texte(probe)).toContain('Nachrichten-Bewertung');
    expect(texte(probe)).not.toContain('Mehrere Anzeichen');
  });

  it('Momentum, Sockel, Regelbaum, Hand und Leerverkauf haben eigene Sätze', () => {
    expect(texte(einstiegsGruende({ side: 'buy', signalContext: { typ: 'momentum' } }))).toContain('stärksten Kursanstieg der letzten zwölf Monate');
    expect(texte(einstiegsGruende({ side: 'buy', quelle: 'sockel' }))).toContain('Grundbestands (Sockel)');
    expect(texte(einstiegsGruende({ side: 'buy', signalContext: { typ: 'regelbaum', regime: 'seitwaerts' } }))).toContain('kleinerem Einsatz');
    expect(texte(einstiegsGruende({ side: 'buy', source: 'manual' }))).toBe('Von dir selbst ausgelöst (manueller Trade).');
    const short = einstiegsGruende({ side: 'sell', short: true, signalContext: { typ: 'konfluenz', konfluenz: 2, votes: { rsi: 'sell' } } });
    expect(short.titel).toContain('Leerverkauf');
    expect(texte(short)).toContain('fallende Kurse');
  });

  it('Lücken werden ehrlich benannt, nie geraten', () => {
    expect(einstiegsGruende({ side: 'buy' }).gruende[0]).toMatchObject({ art: 'luecke' });
    expect(texte(einstiegsGruende({ side: 'buy', sync: true }))).toContain('aus dem Broker-Depot übernommen');
    // Steckbrief allein reicht für den Weg.
    expect(texte(einstiegsGruende({ side: 'buy', bucket: 'crypto|daily|momentum|long|trend' }))).toContain('Momentum-Auswahl');
  });
});

describe('ausstiegsGruende', () => {
  it('Verlustbremse mit Ergebnis, Kursänderung, Gebühren und Haltedauer', () => {
    const r = ausstiegsGruende({ side: 'sell', riskExit: 'stop_loss', pnl: -42.5, entryPrice: 100, price: 95, fee: 1.2, holdingDays: 3.2 });
    expect(r.titel).toBe('Verkauft');
    expect(texte(r)).toContain('Die Verlustbremse hat ausgelöst (Stop-Loss)');
    expect(texte(r)).toContain('Ergebnis: −42,50 $ (−5,0 % Kursänderung), Gebühren 1,20 $.');
    expect(texte(r)).toContain('Gehalten: etwa 3 Tage.');
    expect(r.gruende.find((g) => g.text.startsWith('Ergebnis'))!.art).toBe('contra');
  });

  it('Signal-Ausstieg nennt, welche Anzeichen gedreht haben; Eindeckung rechnet die Richtung um', () => {
    expect(texte(ausstiegsGruende({ side: 'sell', source: 'engine', pnl: 5, signalContext: { typ: 'konfluenz', votes: { macd: 'sell', rsi: 'sell' } } })))
      .toContain('Die Anzeichen haben gedreht: der Trend-Messer (MACD) und der Überhitzungs-Messer (RSI) zeigten nun auf fallende Kurse.');
    const cover = ausstiegsGruende({ side: 'buy', cover: true, pnl: 10, entryPrice: 50, price: 45 });
    expect(cover.titel).toContain('eingedeckt');
    expect(texte(cover)).toContain('(+10,0 % Kursänderung)');
  });

  it('Trailing-Stop zeigt den Höchstkurs; unbekannter Grund fällt ehrlich zurück; Hand und Übernahme', () => {
    expect(texte(ausstiegsGruende({ riskExit: 'trailing_stop', peakPrice: 120, price: 110, pnl: 8 }))).toContain('Höchster Kurs während der Haltezeit: 120,00; verkauft bei 110,00.');
    expect(texte(ausstiegsGruende({ riskExit: 'neuer_grund' }))).toContain('Grund: neuer_grund');
    expect(texte(ausstiegsGruende({ source: 'manual', pnl: 1 }))).toContain('Von dir selbst verkauft');
    expect(ausstiegsGruende({ sync: true }).gruende[0]).toMatchObject({ art: 'luecke' });
    for (const g of ['momentum_rebalance', 'core_rebalance', 'core_aufloesung', 'margin_call', 'ki_news', 'ki_stop', 'breaker', 'max_hold', 'exit_nachlauf', 'fill_sync']) {
      expect(texte(ausstiegsGruende({ riskExit: g })), g).not.toContain(`Grund: ${g}`);
    }
  });
});

describe('Zahlformat', () => {
  it('Tausenderpunkt und Komma wie im Rest des Blatts', () => {
    const r = ausstiegsGruende({ side: 'sell', pnl: 1234.5, riskExit: 'trailing_stop', peakPrice: 66020, price: 64210, entryPrice: 61070 });
    expect(texte(r)).toContain('Höchster Kurs während der Haltezeit: 66.020,00; verkauft bei 64.210,00.');
    expect(texte(r)).toContain('Ergebnis: +1.234,50 $');
  });
});
