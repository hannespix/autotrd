/**
 * Inkrementeller Backfill: je Symbol nur das nachladen, was im Cache fehlt
 * (ab letzter Bar + 1 ms, mindestens ab `from`). Anfragen werden gebündelt
 * (≤ 50 Symbole, bei Minutenbars ≤ 30 Tage je Anfrage), Fehler je Block
 * geloggt und übersprungen — ein Symbol ohne Daten darf den Start der
 * anderen nicht verhindern.
 *
 * Lücken heilen: Ein Loch MITTEN im Cache (Stream-Abriss 10:01–10:14, Bars
 * ab 10:15) würde „ab letzter Bar + 1" nie mehr geschlossen — die Engine
 * aggregierte den Bucket aus Rest-Minuten, der Optimierer trainierte auf
 * einer Serie mit Loch. Deshalb werden nach dem inkrementellen Teil Lücken
 * innerhalb der regulären Sitzung (mehr als eine fehlende Minute zwischen
 * zwei Bars desselben Handelstags) gezielt nachgeladen — höchstens
 * `maxGapRanges` je Lauf, und jede Lücke nur EINMAL: IEX-Lücken ohne Trades
 * bleiben zu Recht leer (Marker im Cache, siehe BarStore.gapMarks).
 * `exact: true` lädt genau [from, to] — für den Nachlauf nach einem
 * Stream-Reconnect (ab letzter Nachricht − 2 min).
 *
 * Bereinigte Tagesbars (`adjustment` ≠ raw, nur `1Day`) gehen einen eigenen
 * Weg — nie inkrementell (siehe `backfillAdjustedDaily`). Die Bereinigung
 * kommt aus der Config über den Aufrufer; fehlt sie, gilt die des Stores.
 * Beides zusammen muss passen, sonst bricht der Backfill ab: Rohe und
 * bereinigte Tagesbars dürfen sich nie eine Datei teilen. Minutenbars
 * werden in jedem Fall roh angefordert (der Client erzwingt das ebenfalls).
 */
import type { AlpacaClient, BarAdjustment, BarsRequest } from '../alpaca/types.ts';
import { errMsg } from '../core/log.ts';
import { DAY, MIN, dayKeyFor, sessionBounds, type Calendar, type SessionBounds } from '../core/time.ts';
import type { AssetClass, Bar, Ms } from '../core/types.ts';
import type { BarStore, BaseTimeframe } from './store.ts';

export const BACKFILL_MAX_SYMBOLS = 50;
export const BACKFILL_MAX_SPAN_MS = 30 * DAY;
export const BACKFILL_MAX_GAPS = 20;

export interface BackfillArgs {
  client: AlpacaClient;
  store: BarStore;
  symbols: string[];
  tf: BaseTimeframe;
  from: Ms;
  to: Ms;
  feed: 'iex' | 'sip';
  log?: ((msg: string) => void) | undefined;
  /** Für die Lückenprüfung (Sitzungsgrenzen); Default us_equity ohne Broker-Kalender. */
  assetClass?: AssetClass | undefined;
  calendar?: Calendar | undefined;
  /** Höchstzahl nachgeladener Lücken je Lauf (nur 1Min); 0 = keine Lückenprüfung. */
  maxGapRanges?: number | undefined;
  /** Genau [from, to] laden statt ab der letzten Bar (Stream-Reconnect). */
  exact?: boolean | undefined;
  /**
   * Bereinigung der Tagesbars (`broker.adjustment`); fehlt sie, gilt die des
   * Stores. Muss zum Store passen (`store.adjustment`) — sonst Abbruch.
   * Wirkt nur bei `1Day`; Minutenbars bleiben roh.
   */
  adjustment?: BarAdjustment | undefined;
}

export interface GapRange {
  start: Ms;
  end: Ms;
}

function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Zeitfenster [start, end] in Blöcke von höchstens `span` zerlegen. */
export function splitSpan(start: Ms, end: Ms, span: number): GapRange[] {
  const out: GapRange[] = [];
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

/**
 * Die fehlende Spanne VOR dem Cache — null, wenn keine fehlt.
 *
 * `backfillStart` schaut nur auf die LETZTE Bar und läuft von dort vorwärts.
 * Damit konnte ein einmal gefüllter Cache nie nach hinten wachsen: Wer
 * `optimizer.lookbackDays` erhöhte oder den Zeitrahmen wechselte, bekam
 * stillschweigend weiter nur die alte Tiefe.
 *
 * Gekostet hat das am 09.09.2026 einen Produktivlauf: Die Plattform ging auf
 * Tagesbars, im Cache lagen aber nur die ~130 Tage, die die Universumswahl
 * für ihr Umsatzfenster lädt. `fetch` holte NICHTS nach (0 Sekunden), der
 * Optimierer fand 127 statt der nötigen 815 Tage und meldete für jede
 * Strategie „nicht bewertbar" — bei grünem Workflow und geschriebenem
 * Champion. Ein Loch, das sich als Erfolg meldet.
 */
export function backfillRueckstand(store: BarStore, symbol: string, tf: BaseTimeframe, from: Ms): { start: Ms; end: Ms } | null {
  const first = store.firstTime(symbol, tf);
  // Ohne Bars holt der Vorwärtslauf ohnehin alles ab `from`.
  if (first === null) return null;
  if (from >= first) return null;
  // Ende auf der ersten bekannten Bar (nicht davor): Der Broker liefert den
  // Rand doppelt, `upsert` dedupliziert — eine fehlende Bar wäre schlimmer.
  return { start: from, end: first };
}

/**
 * Lücken in Minutenbars: mehr als eine fehlende Minute zwischen zwei
 * aufeinanderfolgenden Bars desselben Handelstags innerhalb der regulären
 * Sitzung. Die Zeit vor der ersten und nach der letzten Bar eines Tages
 * ist keine Lücke (Sitzungsrand, laufender Tag).
 */
export function findGaps(bars: readonly Bar[], from: Ms, to: Ms, assetClass: AssetClass, calendar?: Calendar): GapRange[] {
  const out: GapRange[] = [];
  let prev: Bar | null = null;
  let prevDay = '';
  let bounds: SessionBounds | null = null;
  for (const b of bars) {
    if (b.t < from || b.t > to) {
      prev = null;
      continue;
    }
    const day = dayKeyFor(b.t, assetClass);
    if (day !== prevDay) {
      prevDay = day;
      bounds = sessionBounds(day, assetClass, calendar);
      prev = null;
    }
    if (!bounds || b.t < bounds.open || b.t >= bounds.close) {
      prev = null;
      continue;
    }
    if (prev && b.t - prev.t > 2 * MIN) out.push({ start: prev.t + MIN, end: b.t - MIN });
    prev = b;
  }
  return out;
}

export const gapKey = (g: GapRange): string => `${g.start}-${g.end}`;

/** Welche Bereinigung dieser Backfill fährt — die des Aufrufers, sonst die des Stores; ein Widerspruch wirft. */
export function backfillAdjustment(a: Pick<BackfillArgs, 'store' | 'adjustment'>): BarAdjustment {
  const wanted = a.adjustment ?? a.store.adjustment;
  if (wanted !== a.store.adjustment) {
    throw new Error(
      `Backfill: Bereinigung '${wanted}' passt nicht zum Bars-Cache '${a.store.adjustment}' (${a.store.root}) — ` +
        'bereinigte und rohe Tagesbars dürfen sich nie mischen (barStoreRoot mit derselben Bereinigung bilden).',
    );
  }
  return wanted;
}

/**
 * Bereinigte Tagesbars: den GANZEN Bestand neu laden und die Datei ersetzen —
 * nie inkrementell.
 *
 * Warum: Bereinigte Kurse sind relativ zum Abrufdatum. Jede Ausschüttung und
 * jeder Split NACH dem Abruf skaliert alle Bars davor. Ein Cache, der nur die
 * neuen Bars anhängt, hielte die alte Historie auf altem Stand und die neuen
 * Bars auf neuem — genau die Stufe, die die Bereinigung wegräumen soll, nur
 * an die Nahtstelle des Caches verschoben, und mit jeder Ausschüttung eine
 * mehr. Nach einem Jahr TLT wären das rund 3 % im Momentum, unsichtbar.
 *
 * Tagesbars sind billig (ein Abruf je 50 Symbole, 10 000 Bars je Seite), also
 * kommt alles neu: mindestens [from, to], und darüber hinaus alles, was der
 * Cache schon hatte — sonst schrumpfte ein tiefer Cache bei einem kürzeren
 * Abruf (`universe` lädt 130 Tage, `fetch` 1400) oder behielte einen Rand
 * auf altem Stand. Ein fehlgeschlagener Block lässt den alten Stand der
 * Symbole stehen (Meldung), statt ihn zu löschen; ein Symbol ohne Bars bleibt
 * ebenfalls, wie es war.
 *
 * Mit Stichtag (`to` in der Vergangenheit) ist die Reihe trotzdem auf HEUTE
 * bereinigt: Alle Bars bis zum Stichtag tragen denselben Faktor der Ereignisse
 * danach — Renditen und Ränge bleiben gleich, nur das Kursniveau ist um diesen
 * Faktor verschoben (Sizing, Mindestkurs). Geschnitten wird beim Lesen
 * (`src/app.ts`), nicht hier.
 */
async function backfillAdjustedDaily(a: BackfillArgs, adjustment: BarAdjustment, symbols: readonly string[], log: (msg: string) => void): Promise<void> {
  const iso = (ms: Ms) => new Date(ms).toISOString();
  // Symbole mit gleichem Fenster teilen sich eine Anfrage.
  const byWindow = new Map<string, { start: Ms; end: Ms; symbols: string[] }>();
  for (const sym of symbols) {
    const first = a.store.firstTime(sym, '1Day');
    const last = a.store.lastTime(sym, '1Day');
    const start = first === null ? a.from : Math.min(a.from, first);
    const end = last === null ? a.to : Math.max(a.to, last);
    if (start > end) continue;
    const key = `${start}:${end}`;
    const w = byWindow.get(key) ?? { start, end, symbols: [] };
    w.symbols.push(sym);
    byWindow.set(key, w);
  }
  for (const w of byWindow.values()) {
    for (const group of chunk(w.symbols, BACKFILL_MAX_SYMBOLS)) {
      try {
        const res = await a.client.getBars({ symbols: group, timeframe: '1Day', start: w.start, end: w.end, feed: a.feed, adjustment });
        let n = 0;
        let leer = 0;
        for (const sym of group) {
          const bars = res.get(sym) ?? [];
          if (bars.length === 0) {
            leer++;
            continue;
          }
          // Ersetzen, nicht einarbeiten: Die Datei trägt danach EINEN Bereinigungsstand.
          a.store.save(sym, '1Day', bars);
          n += bars.length;
        }
        log(`Backfill 1Day (${adjustment}, vollständig): ${group.length} Symbole, ${iso(w.start)} → ${iso(w.end)}: ${n} Bars${leer ? `, ${leer} ohne Bars (Stand bleibt)` : ''}`);
      } catch (e) {
        log(`Backfill-Block (${adjustment}) fehlgeschlagen (${group.join(',')} ${iso(w.start)} → ${iso(w.end)}): ${errMsg(e)} — alter Stand bleibt`);
      }
    }
  }
}

export async function backfill(a: BackfillArgs): Promise<Map<string, Bar[]>> {
  const log = a.log ?? (() => undefined);
  const symbols = [...new Set(a.symbols)];
  const iso = (ms: Ms) => new Date(ms).toISOString();
  const adjustment = backfillAdjustment(a);
  const collect = (): Map<string, Bar[]> => {
    const out = new Map<string, Bar[]>();
    for (const sym of symbols) out.set(sym, a.store.load(sym, a.tf).filter((b) => b.t >= a.from));
    return out;
  };
  if (a.tf === '1Day' && adjustment !== 'raw') {
    await backfillAdjustedDaily(a, adjustment, symbols, log);
    return collect();
  }
  // Die Bereinigung geht nur mit Tagesbars auf die Reise; Minutenbars bleiben roh.
  const request = (syms: string[], start: Ms, end: Ms): BarsRequest =>
    a.tf === '1Day'
      ? { symbols: syms, timeframe: a.tf, start, end, feed: a.feed, adjustment }
      : { symbols: syms, timeframe: a.tf, start, end, feed: a.feed };
  // Symbole mit gleicher Startzeit teilen sich eine Anfrage.
  const byStart = new Map<Ms, string[]>();
  // Spannen VOR dem Cache, je Symbol; ohne sie wüchse der Cache nur vorwärts.
  const rueckstaende = new Map<string, string[]>();
  const spanneVon = new Map<string, { start: Ms; end: Ms }>();
  for (const sym of symbols) {
    const start = a.exact ? a.from : backfillStart(a.store, sym, a.tf, a.from);
    if (start <= a.to) {
      const list = byStart.get(start) ?? [];
      list.push(sym);
      byStart.set(start, list);
    }
    if (!a.exact) {
      const rueck = backfillRueckstand(a.store, sym, a.tf, a.from);
      if (rueck) {
        const key = `${rueck.start}:${rueck.end}`;
        const list = rueckstaende.get(key) ?? [];
        list.push(sym);
        rueckstaende.set(key, list);
        spanneVon.set(key, rueck);
      }
    }
  }
  for (const [key, syms] of rueckstaende) {
    const spanne = spanneVon.get(key)!;
    const windows = a.tf === '1Min' ? splitSpan(spanne.start, spanne.end, BACKFILL_MAX_SPAN_MS) : [spanne];
    for (const group of chunk(syms, BACKFILL_MAX_SYMBOLS)) {
      for (const w of windows) {
        try {
          const res = await a.client.getBars(request(group, w.start, w.end));
          let n = 0;
          for (const [sym, bars] of res) {
            if (!group.includes(sym) || bars.length === 0) continue;
            a.store.upsert(sym, a.tf, bars);
            n += bars.length;
          }
          log(`Backfill ${a.tf} (Rückstand): ${group.length} Symbole, ${iso(w.start)} → ${iso(w.end)}: ${n} Bars`);
        } catch (e) {
          log(`Backfill-Rückstand fehlgeschlagen (${group.join(',')} ${iso(w.start)} → ${iso(w.end)}): ${errMsg(e)}`);
        }
      }
    }
  }
  for (const [start, syms] of byStart) {
    const windows = a.tf === '1Min' ? splitSpan(start, a.to, BACKFILL_MAX_SPAN_MS) : [{ start, end: a.to }];
    for (const group of chunk(syms, BACKFILL_MAX_SYMBOLS)) {
      for (const w of windows) {
        try {
          const res = await a.client.getBars(request(group, w.start, w.end));
          let n = 0;
          for (const [sym, bars] of res) {
            if (!group.includes(sym) || bars.length === 0) continue;
            a.store.upsert(sym, a.tf, bars);
            n += bars.length;
          }
          log(`Backfill ${a.tf}: ${group.length} Symbole, ${iso(w.start)} → ${iso(w.end)}: ${n} Bars`);
        } catch (e) {
          log(`Backfill-Block fehlgeschlagen (${group.join(',')} ${iso(w.start)} → ${iso(w.end)}): ${errMsg(e)}`);
        }
      }
    }
  }

  // Lücken innerhalb der Sitzung nachladen — je Lücke genau ein Versuch.
  const maxGaps = a.maxGapRanges ?? BACKFILL_MAX_GAPS;
  if (a.tf === '1Min' && maxGaps > 0) {
    const assetClass = a.assetClass ?? 'us_equity';
    let budget = maxGaps;
    for (const sym of symbols) {
      if (budget <= 0) break;
      const checked = a.store.gapMarks(sym, a.tf);
      const gaps = findGaps(a.store.load(sym, a.tf), a.from, a.to, assetClass, a.calendar).filter((g) => !checked.has(gapKey(g)));
      const done: string[] = [];
      for (const g of gaps) {
        if (budget <= 0) break;
        budget--;
        try {
          const res = await a.client.getBars(request([sym], g.start, g.end));
          const bars = res.get(sym) ?? [];
          if (bars.length > 0) a.store.upsert(sym, a.tf, bars);
          done.push(gapKey(g));
          log(`Backfill-Lücke ${sym} ${iso(g.start)} → ${iso(g.end)}: ${bars.length} Bars${bars.length === 0 ? ' (keine Trades — bleibt leer)' : ''}`);
        } catch (e) {
          log(`Backfill-Lücke ${sym} ${iso(g.start)} → ${iso(g.end)} fehlgeschlagen: ${errMsg(e)}`);
        }
      }
      if (done.length > 0) a.store.markGapsChecked(sym, a.tf, done);
    }
  }

  return collect();
}
