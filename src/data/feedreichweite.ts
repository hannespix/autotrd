/**
 * Feed-Reichweite — welchen Datenfeed erreicht dieser Key, und ab wann?
 *
 * ── Warum das eine eigene Diagnose ist ───────────────────────────────────
 *
 * Jede Messung dieses Projekts läuft auf `iex`, und jede beginnt bei
 * 2020-07-27. Das ist kein Zufall und keine Eigenschaft des Marktes: Es ist
 * der Anfang der bereinigten Tagesbars des IEX-Feeds. Die Fold-Kette hängt
 * am Datenende und wächst rückwärts (§5a), also bestimmt der Datenanfang,
 * wie viele Folds es überhaupt geben kann — und damit, ob eine Kennzahl wie
 * `probabilistic_sharpe_oos` je erreichbar ist. Dieselbe Abo-Stufe setzt
 * über `IEX_STREAM_SYMBOL_MAX` auch die Korbgrösse auf 30.
 *
 * Bevor jemand daraus einen Strategie-Befund macht, soll nachlesbar sein,
 * ob der Feed die Grenze ist und ob der vorhandene Key schon weiter reicht.
 *
 * ── Was hier NICHT behauptet wird ────────────────────────────────────────
 *
 * Sondiert werden einzelne JAHRE, nicht der exakte erste Handelstag.
 * `abJahr` ist deshalb „das früheste SONDIERTE Jahr mit Bars" — eine
 * Untergrenze der Reichweite, keine Feststellung des Datenbeginns. Wer den
 * genauen Anfang braucht, lädt und sieht nach; diese Diagnose beantwortet
 * die gröbere Frage, um die es hier geht.
 *
 * Read-only: nur Marktdaten-Abfragen, keine Order, kein Schreiben.
 */
import type { AlpacaClient, BarAdjustment } from '../alpaca/types.ts';
import type { Ms } from '../core/types.ts';

/** Feeds, die das Schema kennt (`core/config.ts`). */
export const FEEDS = ['iex', 'sip'] as const;
export type Feed = (typeof FEEDS)[number];

/**
 * Sondierungsjahre, grob gestuft: Alpacas Aktien-Historie beginnt je nach
 * Abo irgendwo zwischen 2016 und 2021. Fünf Stufen genügen, um „reicht
 * weiter als heute" von „reicht nicht weiter" zu unterscheiden, ohne die
 * API mit einer Binärsuche zu belasten.
 */
export const SONDIERUNGSJAHRE = [2016, 2018, 2020, 2021, 2022] as const;

/** Fenster der Gegenwartsprobe: zehn Tage decken auch ein langes Wochenende samt Feiertag ab. */
export const AKTUELL_FENSTER_MS = 10 * 86_400_000;

export interface JahrProbe {
  jahr: number;
  bars: number;
}

export interface FeedBefund {
  feed: Feed;
  /** Antwortet der Feed überhaupt? Falsch heisst in aller Regel: kein Abo. */
  erreichbar: boolean;
  /** Geschwärzte Fehlermeldung, wenn nicht erreichbar. */
  fehler?: string;
  /** Frühestes SONDIERTES Jahr mit Bars — Untergrenze, nicht der Datenbeginn. */
  abJahr: number | null;
  proben: JahrProbe[];
  /**
   * Die Frage, an der alles hängt (§0.1): Liefert der Feed auch AKTUELLE Bars?
   *
   * Historie und Gegenwart sind bei Alpaca getrennt freigeschaltet. Ein Feed,
   * der 2016 hergibt, aber die letzten Tage mit 403 ablehnt, taugt für einen
   * Backtest und NICHT für den Betrieb — und ein Backtest auf Daten, die die
   * Engine nie sieht, ist genau der Fehler des Vorgängersystems (§2:
   * „Backtest maß Tagesbars/Long-Flat, live lief Intraday/Short").
   *
   * `null` heisst: nicht sondiert.
   */
  aktuell: { bars: number; fehler?: undefined } | { bars?: undefined; fehler: string } | null;
}

/** 1. Januar eines Jahres als Epoch-ms (UTC) — der Sondierungsfenster-Beginn. */
function jahrBeginn(jahr: number): Ms {
  return Date.UTC(jahr, 0, 1);
}

/**
 * Ein Fenster von rund fünf Wochen. Kürzer wäre riskant: Über Neujahr und
 * einen Feiertagsblock hinweg kann eine einzelne Woche leer sein, und eine
 * leere Woche sähe aus wie ein Feed ohne Historie.
 */
function jahrEnde(jahr: number): Ms {
  return Date.UTC(jahr, 1, 5);
}

/**
 * Sondiert einen Feed über die angegebenen Jahre.
 *
 * Ein Fehler beendet die Sondierung dieses Feeds sofort: Wer kein Abo hat,
 * bekommt für JEDES Jahr denselben 403, und vier weitere Anfragen belegen
 * nichts. `erreichbar: false` trägt die Meldung.
 */
export async function sondiereFeed(a: {
  client: Pick<AlpacaClient, 'getBars'>;
  symbol: string;
  feed: Feed;
  adjustment: BarAdjustment;
  jahre?: readonly number[];
  /** Referenzzeit für die Gegenwartsprobe; Vorgabe `Date.now()`. */
  jetzt?: Ms;
}): Promise<FeedBefund> {
  const jahre = [...(a.jahre ?? SONDIERUNGSJAHRE)].sort((x, y) => x - y);
  const proben: JahrProbe[] = [];
  for (const jahr of jahre) {
    let bars: number;
    try {
      const res = await a.client.getBars({
        symbols: [a.symbol],
        timeframe: '1Day',
        start: jahrBeginn(jahr),
        end: jahrEnde(jahr),
        feed: a.feed,
        adjustment: a.adjustment,
      });
      bars = res.get(a.symbol)?.length ?? 0;
    } catch (e) {
      return { feed: a.feed, erreichbar: false, fehler: e instanceof Error ? e.message : String(e), abJahr: null, proben, aktuell: null };
    }
    proben.push({ jahr, bars });
  }
  const treffer = proben.find((p) => p.bars > 0);

  // Gegenwartsprobe: die letzten zehn Tage. Ein eigener try — sie darf die
  // Historien-Sondierung nicht entwerten, und ihr Fehler ist die Auskunft.
  let aktuell: FeedBefund['aktuell'];
  const jetzt = a.jetzt ?? Date.now();
  try {
    const res = await a.client.getBars({
      symbols: [a.symbol],
      timeframe: '1Day',
      start: jetzt - AKTUELL_FENSTER_MS,
      end: jetzt,
      feed: a.feed,
      adjustment: a.adjustment,
    });
    aktuell = { bars: res.get(a.symbol)?.length ?? 0 };
  } catch (e) {
    aktuell = { fehler: e instanceof Error ? e.message : String(e) };
  }

  return { feed: a.feed, erreichbar: true, abJahr: treffer?.jahr ?? null, proben, aktuell };
}

/** Alle Feeds nacheinander — nacheinander, damit ein Abo-Fehler nicht als Lastproblem ankommt. */
export async function feedReichweite(a: {
  client: Pick<AlpacaClient, 'getBars'>;
  symbol: string;
  adjustment: BarAdjustment;
  feeds?: readonly Feed[];
  jahre?: readonly number[];
  jetzt?: Ms;
}): Promise<FeedBefund[]> {
  const out: FeedBefund[] = [];
  for (const feed of a.feeds ?? FEEDS) {
    out.push(await sondiereFeed({ client: a.client, symbol: a.symbol, feed, adjustment: a.adjustment, ...(a.jahre ? { jahre: a.jahre } : {}), ...(a.jetzt !== undefined ? { jetzt: a.jetzt } : {}) }));
  }
  return out;
}
