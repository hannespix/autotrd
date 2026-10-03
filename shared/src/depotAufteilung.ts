/**
 * Depot-Verlauf zerlegen: Welche Trades haben die Kurve bewegt?
 *
 * ── Die Frage ─────────────────────────────────────────────────────────────
 *
 * Die Equity-Kurve zeigt, DASS das Depot gestiegen oder gefallen ist. Sie
 * verschweigt das Wichtigere: WOMIT. Zwei Konten mit derselben Kurve können
 * völlig verschieden entstanden sein — eines aus zwanzig kleinen Gewinnen,
 * das andere aus einem Glückstreffer und neunzehn Verlusten. Aus der Linie
 * allein ist das nicht zu sehen, und genau daran hängt jede Entscheidung
 * darüber, was am System zu ändern ist.
 *
 * ── Die Identität, auf der alles steht ────────────────────────────────────
 *
 * Für JEDEN Tag i des Fensters gilt exakt:
 *
 *     equity[i] = basis + Σ_b baender[b].werte[i] + offen[i]
 *
 * `basis` ist die Equity am ERSTEN Tag des Fensters, nicht das Startkapital
 * des Kontos: Die Serie ist ein Ausschnitt (120 Tage), und was davor
 * verdient wurde, steckt schon in dieser Zahl. Die Bänder tragen deshalb die
 * seit Fensterbeginn KUMULIERTEN realisierten Ergebnisse, `offen` den Rest.
 *
 * ── Warum `offen` ein Rest ist und keine eigene Messung ────────────────────
 *
 * Der Buchwert offener Positionen ändert sich täglich mit dem Kurs. Diese
 * Bewegung ist in der Equity enthalten, aber nirgends je Trade gespeichert —
 * sie ließe sich nur aus Tagesbars je gehaltenem Symbol rekonstruieren. Statt
 * das zu tun und dabei eine zweite, womöglich abweichende Rechnung neben die
 * Server-Wahrheit zu stellen, steht hier der Rest: alles, was die Equity
 * bewegt hat und NICHT aus einem geschlossenen Trade kam. Das ist ehrlich und
 * es ist per Konstruktion exakt — die Summe stimmt immer, weil `offen` als
 * Differenz definiert ist.
 *
 * Ein- und Auszahlungen gäbe es hier ebenfalls hinein; das Papierkonto kennt
 * keine, und beim Reset beginnt die Serie neu.
 */
import { type HistoryTrade, closedOnly } from './tradeAnalytics.js';

const r2 = (x: number): number => Math.round(x * 100) / 100;

/** Ein Tag der Equity-Serie (users/{uid}/equity). */
export interface DepotTag {
  /** YYYY-MM-DD, UTC — wie `snapshotEquity` sie schreibt. */
  date: string;
  equity: number;
}

/** Ein Band der Zerlegung: ein Symbol oder ein einzelner Trade. */
export interface DepotBand {
  /** Eindeutig innerhalb der Zerlegung. */
  key: string;
  label: string;
  /** Seit Fensterbeginn kumulierter Beitrag, ein Wert je Tag. */
  werte: number[];
  /** Beitrag am Ende des Fensters — das Vorzeichen entscheidet über oben/unten. */
  summe: number;
  /** Wie viele geschlossene Trades in diesem Band stecken. */
  trades: number;
}

export interface DepotZerlegung {
  tage: string[];
  equity: number[];
  /** Equity am ersten Tag — die Bezugslinie, von der aus gestapelt wird. */
  basis: number;
  /** Absteigend nach Betrag: die größten Bewegungen zuerst. */
  baender: DepotBand[];
  /** Rest je Tag (Buchwert-Bewegung offener Positionen). */
  offen: number[];
  /**
   * Geschlossene Trades, die NICHT in den Bändern stecken.
   *
   * `vorher`: vor dem Fenster geschlossen — ihr Ergebnis ist bereits in
   * `basis` enthalten und darf nicht ein zweites Mal gezählt werden.
   * `nachher`: nach dem letzten Snapshot geschlossen — noch in keiner
   * Equity-Zahl. Beides sind Zähler, keine Fehler; sie stehen hier, damit die
   * Anzeige „12 von 15 Trades" sagen kann statt stillschweigend zu kürzen.
   */
  ausserhalb: { vorher: number; nachher: number };
}

export interface ZerlegeOptionen {
  /** `symbol` bündelt alle Trades eines Papiers; `trade` zeigt jeden einzeln. */
  modus?: 'symbol' | 'trade';
  /**
   * Wie viele Bänder einzeln gezeigt werden; der Rest wird gebündelt.
   *
   * Ohne Deckel wird die Grafik bei hundert Trades unlesbar — und eine
   * unlesbare Zerlegung ist schlechter als eine gebündelte, weil sie
   * Genauigkeit vortäuscht, die niemand ablesen kann.
   */
  maxBaender?: number;
}

/** Wann `snapshotEquity` läuft, in Minuten nach ET-Mitternacht (17:15 ET). */
const SNAPSHOT_ET_MINUTEN = 17 * 60 + 15;

function naechsterTag(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Der Snapshot-Tag, dessen Equity diesen Trade zum ersten Mal enthält.
 *
 * Nicht einfach das UTC-Datum des Trades. `snapshotEquity` läuft um 17:15 ET;
 * ein Trade um 18:00 ET steht erst in der Equity des FOLGENDEN Tages. Ordnete
 * man ihn dem gleichen Tag zu, liefe sein Band einen Tag vor der Equity-Linie
 * her, und der Rest („offen") müsste den Vorlauf jeden Tag wieder ausgleichen
 * — ein Zickzack, das wie Marktbewegung aussieht und keine ist.
 *
 * Die ET-Umrechnung macht `Intl`, damit die Sommerzeit-Umstellung nicht als
 * Tabelle hier steht und irgendwann veraltet.
 */
function snapshotTag(iso: string): string {
  const teile = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const teil = (t: string): string => teile.find((p) => p.type === t)?.value ?? '00';
  const datum = `${teil('year')}-${teil('month')}-${teil('day')}`;
  const minuten = Number(teil('hour')) * 60 + Number(teil('minute'));
  return minuten < SNAPSHOT_ET_MINUTEN ? datum : naechsterTag(datum);
}

/**
 * Erster Snapshot-Tag der Serie, der am oder nach `datum` liegt.
 *
 * An Wochenenden und bei einem ausgefallenen Lauf fehlt ein Tag. Ein Trade
 * vom Samstag gehört dann in den Montags-Snapshot — sonst verschwände sein
 * Ergebnis im Rest und die Zerlegung wäre still um diesen Trade falsch.
 */
function tagIndex(tage: string[], datum: string): number {
  for (let i = 0; i < tage.length; i++) if (tage[i]! >= datum) return i;
  return -1;
}

export function zerlegeDepot(
  serie: DepotTag[],
  trades: HistoryTrade[],
  opts: ZerlegeOptionen = {},
): DepotZerlegung {
  const modus = opts.modus ?? 'symbol';
  const maxBaender = opts.maxBaender ?? 8;

  const sortiert = [...serie]
    .filter((s) => typeof s.equity === 'number' && Number.isFinite(s.equity))
    .sort((a, b) => a.date.localeCompare(b.date));
  const tage = sortiert.map((s) => s.date);
  const equity = sortiert.map((s) => s.equity);
  if (tage.length === 0) {
    return { tage: [], equity: [], basis: 0, baender: [], offen: [], ausserhalb: { vorher: 0, nachher: 0 } };
  }
  const basis = equity[0]!;

  // ── Beiträge einsammeln ──────────────────────────────────────────────────
  interface Roh {
    key: string;
    label: string;
    /** Beitrag je Tag, NICHT kumuliert. */
    proTag: number[];
    summe: number;
    trades: number;
  }
  const roh = new Map<string, Roh>();
  const ausserhalb = { vorher: 0, nachher: 0 };

  for (const t of closedOnly(trades)) {
    const datum = snapshotTag(t.executedAt);
    if (datum <= tage[0]!) {
      /*
       * Kleiner ODER GLEICH — und das Gleich ist der Punkt.
       *
       * `basis` ist die Equity des ersten Fenstertages; alles, was dieser
       * Snapshot schon kannte, steckt darin. Ein Trade, der genau auf diesen
       * Tag fällt, wäre sonst zweimal gezählt: einmal in der Bezugslinie und
       * einmal als Band. Die Summe stimmte trotzdem, weil der Rest ihn
       * spiegelverkehrt ausgliche — die Zerlegung wäre lautlos falsch.
       */
      ausserhalb.vorher += 1;
      continue;
    }
    const i = tagIndex(tage, datum);
    if (i < 0) {
      // Nach dem letzten Snapshot — noch in keiner Equity-Zahl.
      ausserhalb.nachher += 1;
      continue;
    }
    const key = modus === 'symbol' ? t.symbol : `${t.symbol}@${t.executedAt}`;
    const label = modus === 'symbol' ? t.symbol : `${t.symbol} · ${datum}`;
    let e = roh.get(key);
    if (!e) {
      e = { key, label, proTag: new Array<number>(tage.length).fill(0), summe: 0, trades: 0 };
      roh.set(key, e);
    }
    e.proTag[i]! += t.pnl!;
    e.summe += t.pnl!;
    e.trades += 1;
  }

  // ── Größte zuerst, Rest bündeln ──────────────────────────────────────────
  const alle = [...roh.values()].sort((a, b) => Math.abs(b.summe) - Math.abs(a.summe));
  const gezeigt = alle.slice(0, maxBaender);
  const uebrig = alle.slice(maxBaender);
  if (uebrig.length > 0) {
    const rest: Roh = {
      key: '__rest__',
      label: `Übrige (${uebrig.length})`,
      proTag: new Array<number>(tage.length).fill(0),
      summe: 0,
      trades: 0,
    };
    for (const e of uebrig) {
      for (let i = 0; i < tage.length; i++) rest.proTag[i]! += e.proTag[i]!;
      rest.summe += e.summe;
      rest.trades += e.trades;
    }
    gezeigt.push(rest);
  }

  // ── Kumulieren ───────────────────────────────────────────────────────────
  const baender: DepotBand[] = gezeigt.map((e) => {
    const werte: number[] = [];
    let lauf = 0;
    for (let i = 0; i < tage.length; i++) {
      lauf += e.proTag[i]!;
      werte.push(r2(lauf));
    }
    return { key: e.key, label: e.label, werte, summe: r2(e.summe), trades: e.trades };
  });

  // ── Rest: alles, was die Equity bewegt hat und aus keinem Abschluss kam ──
  const offen = equity.map((v, i) => {
    let realisiert = 0;
    for (const b of baender) realisiert += b.werte[i]!;
    return r2(v - basis - realisiert);
  });

  return { tage, equity, basis, baender, offen, ausserhalb };
}

/**
 * Die Bänder zu einer Wasserfall-Treppe stapeln.
 *
 * ── Warum Wasserfall und nicht „Gewinne hoch, Verluste runter" ────────────
 *
 * Der erste Entwurf stapelte positive Bänder von der Bezugslinie nach oben
 * und negative nach unten. Das liest sich gut — und macht die zentrale
 * Aussage der Grafik unprüfbar. Beispiel aus dem Test: +40 realisiert, −90
 * realisiert, +30 unrealisiert. Der Stapel reicht dann von −90 bis +70, die
 * Equity-Änderung ist aber −20. Sie liegt WEDER oben NOCH unten, sondern
 * irgendwo dazwischen. „Die Flächen ergeben zusammen dein Depot" wäre damit
 * eine Behauptung, die man am Bild nicht nachvollziehen kann.
 *
 * Deshalb eine laufende Summe: Jedes Band setzt an, wo das vorige aufhört.
 * Positive Bänder steigen, negative fallen zurück — die Oberkante des
 * LETZTEN Bandes ist exakt die Equity-Änderung, und die Depot-Linie läuft
 * sichtbar darauf. Verluste erscheinen als rote Flächen, die den grünen Berg
 * wieder abtragen; genau das ist die Aussage.
 *
 * Die Bänder sind bewusst nach Vorzeichen sortiert (erst Gewinner, dann
 * Verlierer, zuletzt der offene Anteil) — sonst zackt die Treppe hin und her
 * und niemand sieht mehr, wie hoch der Berg vor den Verlusten stand.
 */
export interface BandFlaeche {
  key: string;
  label: string;
  /** Je Tag: [untere Kante, obere Kante] relativ zur Bezugslinie. */
  kanten: Array<[number, number]>;
  /** Laufende Summe NACH diesem Band, je Tag. */
  lauf: number[];
  summe: number;
  trades: number;
}

export function stapelBaender(z: DepotZerlegung): BandFlaeche[] {
  const n = z.tage.length;
  const gewinner = z.baender.filter((b) => b.summe >= 0);
  const verlierer = z.baender.filter((b) => b.summe < 0);
  const reihe = [
    ...gewinner,
    ...verlierer,
    { key: '__offen__', label: 'Offene Positionen', werte: z.offen, summe: z.offen[n - 1] ?? 0, trades: 0 },
  ];

  const lauf = new Array<number>(n).fill(0);
  const flaechen: BandFlaeche[] = [];
  for (const b of reihe) {
    const kanten: Array<[number, number]> = [];
    const nachher: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = b.werte[i] ?? 0;
      const vorher = lauf[i]!;
      const neu = r2(vorher + v);
      kanten.push(v >= 0 ? [vorher, neu] : [neu, vorher]);
      lauf[i] = neu;
      nachher.push(neu);
    }
    flaechen.push({
      key: b.key,
      label: b.label,
      kanten,
      lauf: nachher,
      summe: r2(b.summe),
      trades: b.trades,
    });
  }
  return flaechen;
}
