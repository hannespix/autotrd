/**
 * Wächter der Engine-Karte und der Datenschicht des Auto-Traders.
 *
 * Der Umbau hat den Handelskern getauscht: Ein Firebase-Takt handelt je
 * Minute bei Alpaca und spiegelt nach Firestore. Die Oberfläche darf NUR
 * noch über diese Schnittstellen sprechen — jeder Aufruf eines gelöschten
 * Callables (`trade`, `quoteNow`, `resetBreaker`, `adoptBroker`, …) wäre ein
 * Knopf, der sichtbar nichts tut. Und der Engine-Schalter muss dasselbe Feld
 * schreiben, das der Takt liest (`settings.strategy.engine.running`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { leseChampion, leseEngine } from '../src/data.js';

const lese = (name: string): string => readFileSync(join(import.meta.dirname, '..', 'src', name), 'utf8');
const dashboard = lese('dashboard.ts');
const data = lese('data.ts');

describe('Datenschicht — nur die Callables des neuen Kerns', () => {
  it('gelöschte Callables werden nirgends mehr aufgerufen', () => {
    for (const name of ['trade', 'savePrediction', 'quoteNow', 'resetBreaker', 'adoptBroker', 'runBacktest', 'saveStrategyDraft']) {
      expect(data, `Callable ${name} ist noch verdrahtet`).not.toMatch(new RegExp(`httpsCallable\\(fns\\(\\), '${name}'\\)`));
    }
    expect(data).not.toContain("action: 'abgleich'");
    expect(data).not.toContain("action: 'uebernahmeVormerken'");
  });

  it('die bleibenden Callables sind genau die des Functions-Index', () => {
    const erwartet = [
      'ensureProfile', 'resetWallet', 'taxReport', 'fxNachtragen', 'brokerStatus',
      'connectBroker', 'setLiveMode', 'saveStrategy', 'engineCommand', 'nachricht', 'adminUsers',
    ];
    const gefunden = [...new Set([...data.matchAll(/httpsCallable\(fns\(\), '([a-zA-Z]+)'\)/g)].map((m) => m[1]!))].sort();
    expect(gefunden).toEqual([...erwartet].sort());
  });

  it('saveStrategy kennt genau zwei Nutzlasten: den Schalter und die Einstellungen', () => {
    expect(data).toContain('export type SaveStrategyPayload = { engineRunning: boolean } | { auto: AutoSettings };');
    // Nie beides in einem Aufruf — der Server prüft jede Änderung einzeln.
    expect(dashboard).toContain('await saveStrategy({ engineRunning: on });');
    expect(dashboard).toContain('await saveStrategy({ auto: probe.wert ?? auto });');
    expect(dashboard).not.toContain('saveStrategy({ strategy');
  });

  it('der Engine-Schalter liest das Feld, das der Takt abfragt', () => {
    // Der Takt filtert `users where settings.strategy.engine.running == true`.
    expect(dashboard).toContain("renderEngineBadge(st.strategy.engine.running === true);");
    expect(data).toContain("strategy: (snap.get('settings.strategy') as Strategy | undefined) ?? null,");
    expect(data).toContain("const autoRoh = snap.get('settings.auto') as unknown;");
  });

  it('die Positionen bewerten sich mit market/{sym}.quote — nur der Kurs, über den Mux', () => {
    expect(data).toContain("`marketDoc:${symbol}`");
    expect(data).toContain("emit(snap.exists() ? { quote: snap.get('quote') as Quote | undefined } : null)");
  });

  it('der Optimierer-Bericht kommt einmalig, nicht als Listener — er ist bis zu 900 kB groß', () => {
    const fn = data.slice(data.indexOf('export async function loadOptimizeReport'));
    expect(fn.slice(0, 600)).toContain("orderBy('date', 'desc'), limit(1)");
    expect(fn.slice(0, 600)).toContain('await getDocs(q)');
    expect(fn.slice(0, 600)).not.toContain('onSnapshot');
  });
});

describe('Engine-Spiegel lesen (users/{uid}.engine)', () => {
  it('ein leerer oder fremder Wert ergibt null', () => {
    expect(leseEngine(undefined)).toBeNull();
    expect(leseEngine('x')).toBeNull();
    expect(leseEngine([])).toBeNull();
  });

  it('halb geschriebene Felder werden zu null/leer statt zu falschen Zahlen', () => {
    const e = leseEngine({ mode: 'paper', halt: { halted: true, reason: 'drawdown' }, equity: 'viel', positions: ['AAPL', 3] });
    expect(e).not.toBeNull();
    expect(e!.mode).toBe('paper');
    expect(e!.halt).toEqual({ halted: true, reason: 'drawdown', since: null, until: null, note: null });
    expect(e!.equity).toBeNull();
    expect(e!.positions).toEqual(['AAPL']);
    expect(e!.deferred).toEqual([]);
    expect(e!.notes).toEqual([]);
    expect(e!.champion).toBeNull();
  });

  it('ein voller Spiegel kommt vollständig an', () => {
    const e = leseEngine({
      mode: 'live', halt: { halted: false, reason: null, since: null, until: null, note: null },
      equity: 101_000, cash: 50_000, dayStartEquity: 100_000, peakEquity: 102_000, day: '2026-09-04',
      dayTradeCount: 2, localDayTrades: 0, patternDayTrader: false, positions: ['SPY'], pendingEntries: [],
      pendingExits: ['SPY'], deferred: ['QQQ'], consecutiveErrors: 0, entryLock: null,
      lastTickAt: '2026-09-04T15:00:00.000Z', lastError: null, champion: { source: 'champion', symbols: ['SPY', 'QQQ'] },
      notes: ['AAPL: kein Champion'], configSource: 'auto', commandAt: null,
    });
    expect(e!.mode).toBe('live');
    expect(e!.champion).toEqual({ source: 'champion', symbols: ['SPY', 'QQQ'] });
    expect(e!.deferred).toEqual(['QQQ']);
    expect(e!.notes).toEqual(['AAPL: kein Champion']);
    expect(e!.entryLock).toBeNull();
  });
});

describe('Champion lesen (meta/champion)', () => {
  it('nur Einträge mit Strategie-Namen zählen; Zahlen sind null statt NaN', () => {
    const c = leseChampion({
      version: 1, updatedAt: 1_757_000_000_000,
      symbols: { SPY: { strategy: 'trend_donchian', timeframe: 5, score: 1.2, oos: { trades: 80, netProfit: 512.5 } }, KAPUTT: { score: 3 } },
      noTrade: { TSLA: { reason: 'psr unter 0,9', decidedAt: 1, bestScore: 0.3 }, X: 'nein' },
    });
    expect(c).not.toBeNull();
    expect(Object.keys(c!.symbols)).toEqual(['SPY']);
    expect(c!.symbols['SPY']!.oos.trades).toBe(80);
    expect(c!.symbols['SPY']!.oos.profitFactor).toBeNull();
    expect(c!.symbols['SPY']!.gates).toEqual([]);
    expect(Object.keys(c!.noTrade)).toEqual(['TSLA']);
    expect(c!.noTrade['TSLA']!.reason).toBe('psr unter 0,9');
  });

  it('die Champion-Karte zeigt „kein Handel" mit Grund — als Ergebnis, nicht als Fehler', () => {
    const fn = dashboard.slice(dashboard.indexOf('function renderChampion'));
    const block = fn.slice(0, fn.indexOf('\n}'));
    expect(block).toContain("t('ch.noTrade')");
    expect(block).toContain('title="${escText(e.reason)}"');
    expect(block).toContain("t('ch.leer')");
  });

  it('der Bericht wird als TEXT gesetzt — Markdown aus Firestore wird nie als HTML gedeutet', () => {
    const fn = dashboard.slice(dashboard.indexOf('async function openReport'));
    const block = fn.slice(0, fn.indexOf('\n}'));
    expect(block).toContain("$('reportBody').textContent = r.markdown");
    expect(block).not.toContain('reportBody\').innerHTML');
  });
});
