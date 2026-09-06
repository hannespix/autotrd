/**
 * Inkrementeller Backfill: je Symbol nur das nachladen, was im Cache fehlt
 * (ab letzter Bar + 1 ms, mindestens ab `from`). Anfragen werden gebündelt
 * (≤ 50 Symbole, bei Minutenbars ≤ 30 Tage je Anfrage), Fehler je Block
 * geloggt und übersprungen — ein Symbol ohne Daten darf den Start der
 * anderen nicht verhindern; die Engine blockiert Einstiege für Symbole
 * ohne frische Bars ohnehin über die Datenfrische.
 */
import type { AlpacaClient } from '../alpaca/types.ts';
import { errMsg } from '../core/log.ts';
import { DAY } from '../core/time.ts';
import type { Bar, Ms } from '../core/types.ts';
import type { BarStore, BaseTimeframe } from './store.ts';

export const BACKFILL_MAX_SYMBOLS = 50;
export const BACKFILL_MAX_SPAN_MS = 30 * DAY;

export interface BackfillArgs {
  client: AlpacaClient;
  store: BarStore;
  symbols: string[];
  tf: BaseTimeframe;
  from: Ms;
  to: Ms;
  feed: 'iex' | 'sip';
  log?: ((msg: string) => void) | undefined;
}

function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Zeitfenster [start, end] in Blöcke von höchstens `span` zerlegen. */
export function splitSpan(start: Ms, end: Ms, span: number): Array<{ start: Ms; end: Ms }> {
  const out: Array<{ start: Ms; end: Ms }> = [];
  let cur = start;
  while (cur <= end) {
    const e = Math.min(end, cur + span - 1);
    out.push({ start: cur, end: e });
    cur = e + 1;
  }
  return out;
}

/**
 * Startzeit je Symbol: Minutenbars ab letzter Bar + 1 ms. Tagesbars ab der
 * letzten Bar selbst — die kann der unfertige laufende Tag sein, den der
 * Broker beim nächsten Abruf vollständig liefert (upsert überschreibt).
 */
export function backfillStart(store: BarStore, symbol: string, tf: BaseTimeframe, from: Ms): Ms {
  const last = store.lastTime(symbol, tf);
  if (last === null) return from;
  return Math.max(from, tf === '1Min' ? last + 1 : last);
}

export async function backfill(a: BackfillArgs): Promise<Map<string, Bar[]>> {
  const log = a.log ?? (() => undefined);
  const symbols = [...new Set(a.symbols)];
  // Symbole mit gleicher Startzeit teilen sich eine Anfrage.
  const byStart = new Map<Ms, string[]>();
  for (const sym of symbols) {
    const start = backfillStart(a.store, sym, a.tf, a.from);
    if (start > a.to) continue;
    const list = byStart.get(start) ?? [];
    list.push(sym);
    byStart.set(start, list);
  }
  for (const [start, syms] of byStart) {
    const windows = a.tf === '1Min' ? splitSpan(start, a.to, BACKFILL_MAX_SPAN_MS) : [{ start, end: a.to }];
    for (const group of chunk(syms, BACKFILL_MAX_SYMBOLS)) {
      for (const w of windows) {
        try {
          const res = await a.client.getBars({ symbols: group, timeframe: a.tf, start: w.start, end: w.end, feed: a.feed });
          let n = 0;
          for (const [sym, bars] of res) {
            if (!group.includes(sym) || bars.length === 0) continue;
            a.store.upsert(sym, a.tf, bars);
            n += bars.length;
          }
          log(`Backfill ${a.tf}: ${group.length} Symbole, ${new Date(w.start).toISOString()} → ${new Date(w.end).toISOString()}: ${n} Bars`);
        } catch (e) {
          log(`Backfill-Block fehlgeschlagen (${group.join(',')} ${new Date(w.start).toISOString()} → ${new Date(w.end).toISOString()}): ${errMsg(e)}`);
        }
      }
    }
  }
  const out = new Map<string, Bar[]>();
  for (const sym of symbols) out.set(sym, a.store.load(sym, a.tf).filter((b) => b.t >= a.from));
  return out;
}
