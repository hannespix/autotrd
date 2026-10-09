/**
 * autotrd — Entscheidungsgründe eines Trades in Alltagssprache (Task 21,
 * Owner 09.10.: „wenn man drauf klickt, die Entscheidungsgründe fürs Kaufen
 * und Nicht-Kaufen und Rausgehen … festhalten, so dass man quasi ein richtig
 * schönes Trading-Journal hat").
 *
 * `journalThese` (journalText.ts) bleibt der kompakte Fach-Satz, den auch
 * der KI-Bericht als Faktenbasis liest. Dieses Modul ist die LAIEN-Fassung
 * für das Detail-Blatt der Trade-Historie: mehrere kurze Punkte statt eines
 * Satzes, jeder Fachbegriff in Klammern hinter einer Alltagserklärung.
 *
 * Grundsätze:
 *  - Nur eingefrorene Fakten (Journal-Doc, Trade-Doc) — nichts nachträglich
 *    berechnet, kein Blick auf spätere Kurse. Was nicht gespeichert wurde,
 *    steht als ehrliche Lücke da („für diesen Trade nicht aufgezeichnet").
 *  - Kein Fremdtext: Nachrichten erscheinen nur als Richtung/Status, nie als
 *    Schlagzeile (die ist Fremdtext und gehört nicht in eine Erklärung).
 *  - Pur: Server, Frontend und Tests rechnen dasselbe.
 */
import { CLASS_LABELS } from './universe.js';
import { tradeQuelle } from './tradeQuelle.js';

/** Die Fakten, die ein Trade-Doc und sein Journal-Doc tragen können (`| undefined`: Felder werden aus Docs durchgereicht, die sie oft nicht tragen). */
export interface TradeGrundFakten {
  side?: string | undefined;
  source?: string | undefined;
  qty?: number | undefined;
  price?: number | undefined;
  pnl?: number | undefined;
  riskExit?: string | undefined;
  short?: boolean | undefined;
  cover?: boolean | undefined;
  nachkauf?: boolean | undefined;
  teilSchluss?: boolean | undefined;
  sync?: boolean | undefined;
  bucket?: string | undefined;
  quelle?: string | undefined;
  entryPrice?: number | undefined;
  holdingDays?: number | undefined;
  peakPrice?: number | undefined;
  fee?: number | undefined;
  assetClass?: string | undefined;
  signalContext?: {
    typ?: string | undefined;
    votes?: Record<string, string> | undefined;
    konfluenz?: number | undefined;
    minKonfluenz?: number | undefined;
    forecast?: { dir?: string | undefined; weight?: number } | undefined;
    regime?: string | undefined;
    soloTrend?: boolean | undefined;
    ki?: { richtung?: string | undefined; probe?: boolean | undefined; eingepreist?: string | null } | undefined;
    lexikon?: { dir?: string | undefined; probe?: boolean } | undefined;
  } | undefined;
}

export type GrundArt = 'pro' | 'contra' | 'info' | 'luecke';

export interface Grund {
  art: GrundArt;
  text: string;
}

export interface TradeGruende {
  /** Kauf, Verkauf, Leerverkauf, Eindeckung … */
  art: 'einstieg' | 'ausstieg';
  titel: string;
  gruende: Grund[];
}

/** Indikatoren mit einer Alltagserklärung — der Fachname steht in Klammern. */
const INDIKATOR: Record<string, string> = {
  rsi: 'der Überhitzungs-Messer (RSI)',
  macd: 'der Trend-Messer (MACD)',
  bollinger: 'das Schwankungsband (Bollinger)',
  forecast: 'die Kursprognose des Systems',
  trend: 'der Trendfilter',
  ki: 'die KI-Nachrichtenbewertung',
  lex: 'die Nachrichten-Wortliste',
};

/* `seitwaerts` ist zugleich der Ersatzwert, wenn die Marktlage nicht messbar
 * war (regime.ts) — der Satz behauptet deshalb keine gemessene Seitwärtslage. */
const MARKTLAGE: Record<string, string> = {
  trend: 'Marktlage beim Einstieg: ruhiger Aufwärtstrend am Gesamtmarkt.',
  seitwaerts: 'Marktlage beim Einstieg: keine klare Richtung am Gesamtmarkt (oder nicht messbar) — dann wird seltener und mit kleinerem Einsatz gehandelt.',
  stress: 'Marktlage beim Einstieg: unruhiger Gesamtmarkt.',
};

/** Ausstiegsgründe einer LONG-Position. Unbekannte Gründe fallen auf eine ehrliche Formulierung zurück. */
const AUSSTIEG: Record<string, string> = {
  stop_loss: 'Die Verlustbremse hat ausgelöst (Stop-Loss): Der Kurs fiel auf die vorher festgelegte Schmerzgrenze, damit der Verlust nicht größer wird.',
  take_profit: 'Das Kursziel war erreicht (Take-Profit): Der Gewinn wurde mitgenommen.',
  trailing_stop: 'Die mitlaufende Verlustbremse hat ausgelöst (Trailing-Stop): Sie zieht mit steigendem Kurs nach oben mit; als der Kurs um den festgelegten Abstand vom Höchststand zurückfiel, wurde verkauft.',
  trailing_stop_broker: 'Die mitlaufende Verlustbremse beim Broker hat ausgelöst (Trailing-Stop): Der Kurs fiel um den festgelegten Abstand vom Höchststand zurück.',
  max_hold: 'Die maximale Haltedauer war erreicht: Die Position wurde planmäßig geschlossen.',
  breaker: 'Die Tages-Notbremse hat ausgelöst: An diesem Tag waren die Verluste des Kontos zu hoch, deshalb wurden die automatischen Positionen geschlossen.',
  margin_call: 'Sicherheitsverkauf: Für das geliehene Geld fehlte Deckung, deshalb musste geschlossen werden.',
  ki_news: 'Eine von der KI gelesene und gegengeprüfte Nachricht sprach klar gegen diese Position — deshalb wurde geschlossen.',
  ki_stop: 'Nach einer Nachricht gegen die Position wurde die Verlustbremse enger gezogen (KI-Stop), und diese hat ausgelöst.',
  exit_nachlauf: 'Der Auftrag zum Schließen lag zunächst beim Broker und wurde erst später ausgeführt; das wurde danach verbucht.',
  fill_sync: 'Der Broker hat ein Schließen der Position gemeldet, das nachträglich verbucht wurde.',
  momentum_rebalance: 'Regelmäßiger Umbau der Momentum-Auswahl: Das Symbol gehörte nicht mehr zu den stärksten oder der Marktfilter stand auf Vorsicht.',
  core_rebalance: 'Der Grundbestand (Sockel) wurde neu zusammengestellt; diese Position gehörte nicht mehr dazu.',
  core_aufloesung: 'Der Grundbestand (Sockel) wurde aufgelöst.',
};

/** Gespiegelte Texte für das Eindecken einer SHORT-Position — wo die Richtung zählt. */
const AUSSTIEG_SHORT: Record<string, string> = {
  stop_loss: 'Die Verlustbremse hat ausgelöst (Stop-Loss): Der Kurs stieg auf die vorher festgelegte Schmerzgrenze, deshalb wurde zurückgekauft, damit der Verlust nicht größer wird.',
  take_profit: 'Das Kursziel war erreicht (Take-Profit): Der Kurs war weit genug gefallen, der Gewinn wurde mitgenommen.',
  trailing_stop: 'Die mitlaufende Verlustbremse hat ausgelöst (Trailing-Stop): Sie zieht mit fallendem Kurs nach unten mit; als der Kurs um den festgelegten Abstand vom Tiefststand wieder stieg, wurde zurückgekauft.',
  trailing_stop_broker: 'Die mitlaufende Verlustbremse beim Broker hat ausgelöst (Trailing-Stop): Der Kurs stieg um den festgelegten Abstand vom Tiefststand.',
};

/** Deutsches Zahlformat mit Tausenderpunkt — ohne Intl, damit Server und Browser gleich rechnen. */
const zahl = (x: number, stellen = 2): string => {
  const [ganz, rest] = x.toFixed(stellen).split('.');
  const mitPunkt = (ganz ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return rest !== undefined ? `${mitPunkt},${rest}` : mitPunkt;
};
const vz = (x: number, stellen = 2): string => `${x > 0 ? '+' : x < 0 ? '−' : ''}${zahl(Math.abs(x), stellen)}`;
const geld = (x: number): string => `${vz(x)} $`;
/** Punktzahl ohne überflüssige Nachkommastellen („2", „1,5"). */
const punkte = (x: number): string => (Number.isInteger(x) ? String(x) : zahl(x, 1));
const punkteWort = (x: number): string => `${punkte(x)} ${x === 1 ? 'Punkt' : 'Punkte'}`;

/** Aktive Stimmen einer Richtung als Aufzählung („der Trend-Messer (MACD) und …"). */
function stimmenText(votes: Record<string, string> | undefined, richtung: 'buy' | 'sell'): string[] {
  if (!votes) return [];
  return Object.entries(votes)
    .filter(([, v]) => v === richtung)
    .map(([k]) => INDIKATOR[k] ?? k);
}

function aufzaehlen(teile: string[]): string {
  if (teile.length <= 1) return teile.join('');
  return `${teile.slice(0, -1).join(', ')} und ${teile[teile.length - 1]}`;
}

/** Stimmen aus der Steckbrief-Signatur (3. Segment, z. B. „macd+rsi"), falls das Journal keine Stimmen trägt. */
function stimmenAusSteckbrief(bucket: string | undefined, richtung: 'buy' | 'sell'): Record<string, string> | undefined {
  if (typeof bucket !== 'string' || bucket.length === 0) return undefined;
  const sig = bucket.split('|')[2] ?? '';
  if (!sig || ['keine', 'manuell', 'momentum', 'core', 'regelbaum'].includes(sig)) return undefined;
  return Object.fromEntries(sig.split('+').filter((k) => k.length > 0).map((k) => [k, richtung]));
}

/** Einstiegsweg: der Steckbrief zuerst (Sockel-Käufe tragen `typ: 'momentum'`,
 *  aber die Signatur `core`), sonst die gestempelte Quelle, sonst `typ`. */
function einstiegsweg(f: TradeGrundFakten): string {
  const ausDoc = tradeQuelle({ source: f.source, bucket: f.bucket, sync: f.sync, quelle: f.quelle });
  if (ausDoc !== 'unbekannt') return ausDoc;
  const typ = f.signalContext?.typ;
  if (typ === 'manuell') return 'hand';
  return typ ?? 'unbekannt';
}

/** Warum gekauft (bzw. leerverkauft) — aus dem Journal-Doc des EINSTIEGS. */
export function einstiegsGruende(f: TradeGrundFakten): TradeGruende {
  // Ein nachgebuchter Verkauf ohne Ergebnis ist kein Leerverkauf (adoptBroker
  // setzt pnl nur bei bekannter Deckung) — bei `sync` zählt nur `short`.
  const short = f.short === true || (f.side === 'sell' && f.sync !== true);
  const titel = f.nachkauf === true
    ? (short ? 'Leerverkauf aufgestockt' : 'Position aufgestockt')
    : (short ? 'Leerverkauf eröffnet (Wette auf fallende Kurse)' : 'Gekauft');
  const g: Grund[] = [];
  const sc = f.signalContext;
  const weg = einstiegsweg(f);
  const geschaeft = short ? 'Leerverkauf' : 'Kauf';

  if (f.sync === true || weg === 'sync') {
    g.push({ art: 'luecke', text: 'Diese Position wurde aus dem Broker-Depot übernommen. Warum sie ursprünglich eröffnet wurde, ist nicht aufgezeichnet.' });
    return { art: 'einstieg', titel, gruende: g };
  }
  if (weg === 'hand') {
    g.push({ art: 'info', text: 'Von dir selbst ausgelöst (manueller Trade).' });
    return { art: 'einstieg', titel, gruende: g };
  }

  const richtung: 'buy' | 'sell' = short ? 'sell' : 'buy';
  const votes = sc?.votes ?? stimmenAusSteckbrief(f.bucket, richtung);
  const wohin = short ? 'fallende' : 'steigende';
  if (weg === 'momentum') {
    g.push({ art: 'pro', text: 'Das Symbol gehörte zu den Werten mit dem stärksten Kursanstieg der letzten zwölf Monate (Momentum-Auswahl). Die Idee: Was lange stark gestiegen ist, steigt oft noch eine Weile weiter.' });
  } else if (weg === 'sockel' || weg === 'core') {
    g.push({ art: 'pro', text: 'Teil des Grundbestands (Sockel): Ein breit gestreuter Bestand, der unabhängig von kurzfristigen Signalen gehalten wird.' });
  } else if (weg === 'regelbaum') {
    g.push({ art: 'pro', text: `Ein festes Regelwerk (Regelbaum) hat ein Signal für ${wohin} Kurse gegeben.` });
  } else if (typeof sc?.konfluenz === 'number' || weg === 'konfluenz' || weg === 'ki_probe') {
    const probe = sc?.ki?.probe === true || sc?.lexikon?.probe === true;
    // Bei einer Probe zählt die Konfluenz nur die TECHNIK — die Nachrichten-
    // Stimme steht in einer eigenen Zeile und gehört nicht in diese Aufzählung.
    const dafuer = stimmenText(votes, richtung).filter((n) => !probe || (n !== INDIKATOR['ki'] && n !== INDIKATOR['lex']));
    const wer = dafuer.length > 0 ? ` Dafür ${dafuer.length === 1 ? 'sprach' : 'sprachen'}: ${aufzaehlen(dafuer)}.` : '';
    if (sc?.soloTrend === true && !short) {
      // engine.ts trendSolo: im ruhigen Aufwärtstrend genügt EINE Stimme —
      // die des Trend-Messers. Die Schwelle ist dann 1, nicht minKonfluenz.
      g.push({ art: 'pro', text: 'Der Trend-Messer (MACD) zeigte auf steigende Kurse, und der Gesamtmarkt lag in einem ruhigen Aufwärtstrend — in dieser Lage genügt dieses eine Anzeichen.' });
    } else if (typeof sc?.konfluenz === 'number') {
      // `konfluenz` ist eine PUNKTZAHL: Die Systemprognose und dein Prognose-
      // Pfeil können mit Gewicht mehr als einen Punkt geben (engine.ts,
      // scanMarket) — deshalb nicht „Anzeichen" zählen.
      const latte = typeof sc.minKonfluenz === 'number' ? ` (nötig: mindestens ${punkte(sc.minKonfluenz)})` : '';
      g.push({
        art: probe ? 'info' : 'pro',
        text: probe
          ? `Die Technik allein reichte nicht für einen ${geschaeft}: ${punkteWort(sc.konfluenz)}${latte}.${wer}`
          : `Die Anzeichen für ${wohin} Kurse kamen auf ${punkteWort(sc.konfluenz)}${latte}.${wer}`,
      });
    } else if (weg === 'ki_probe') {
      // Ohne Journal: Der Steckbrief verrät nur, DASS eine Nachrichten-Bewertung trug.
      g.push({ art: 'info', text: `Der ${geschaeft} kam über eine Nachrichten-Bewertung zustande — darum mit kleinerem Einsatz (Probegröße).` });
    } else if (dafuer.length > 0) {
      g.push({ art: 'pro', text: `Laut Aufzeichnung ${dafuer.length === 1 ? 'sprach' : 'sprachen'} für ${wohin} Kurse: ${aufzaehlen(dafuer)}.` });
    } else {
      g.push({ art: 'luecke', text: 'Einstieg über das Anzeichen-System; welche Anzeichen es waren, ist für diesen Trade nicht aufgezeichnet.' });
    }
    const dagegen = stimmenText(votes, short ? 'buy' : 'sell');
    if (dagegen.length > 0) g.push({ art: 'contra', text: `Dagegen sprach: ${aufzaehlen(dagegen)}.` });
  } else {
    g.push({ art: 'luecke', text: `Für diesen ${geschaeft} ist kein Grund aufgezeichnet (älterer Trade oder nachträglich verbucht).` });
  }

  // `forecast` im Journal ist der Pfeil, den DU im Chart gezeichnet hast
  // (predictionVote) — nicht die Systemprognose unter den Stimmen.
  if (sc?.forecast?.dir) {
    // Gespeichert wird buy/sell; ältere Einträge tragen up/down.
    const auf = sc.forecast.dir === 'buy' || sc.forecast.dir === 'up';
    g.push({ art: auf !== short ? 'pro' : 'contra', text: `Deine eigene Kursprognose (der Pfeil, den du im Chart gezeichnet hast) zeigte ${auf ? 'nach oben' : 'nach unten'}.` });
  }
  if (sc?.ki?.richtung) {
    const pos = sc.ki.richtung === 'positiv';
    const text = `Die KI hat eine Nachricht gelesen, gegengeprüft und als ${pos ? 'gut' : 'schlecht'} für den Wert eingestuft`
      + (sc.ki.probe ? ` — der ${geschaeft} kam nur deshalb zustande, darum mit kleinerem Einsatz (Probegröße).` : '.');
    g.push({ art: pos !== short ? 'pro' : 'contra', text });
  }
  if (sc?.lexikon?.dir) {
    const pos = sc.lexikon.dir === 'buy';
    g.push({ art: pos !== short ? 'pro' : 'contra', text: `Eine Wortliste hat Nachrichten als ${pos ? 'positiv' : 'negativ'} gewertet (Ersatz, weil das KI-Tagesbudget aufgebraucht war)${sc.lexikon.probe ? ' — darum mit kleinerem Einsatz.' : '.'}` });
  }
  const regime = sc?.regime ?? (typeof f.bucket === 'string' ? f.bucket.split('|')[4] : undefined);
  if (regime && MARKTLAGE[regime]) g.push({ art: 'info', text: MARKTLAGE[regime]! });
  const klasse = f.assetClass ?? (typeof f.bucket === 'string' ? f.bucket.split('|')[0] : undefined);
  if (klasse && CLASS_LABELS[klasse]) g.push({ art: 'info', text: `Anlageklasse: ${CLASS_LABELS[klasse]}.` });
  return { art: 'einstieg', titel, gruende: g };
}

/** Warum verkauft (bzw. eingedeckt) und mit welchem Ergebnis — aus Trade- und Journal-Doc des AUSSTIEGS. */
export function ausstiegsGruende(f: TradeGrundFakten): TradeGruende {
  const cover = f.cover === true || (f.side === 'buy' && typeof f.pnl === 'number');
  const titel = f.teilSchluss === true
    ? (cover ? 'Leerverkauf teilweise eingedeckt' : 'Teilweise verkauft')
    : (cover ? 'Leerverkauf eingedeckt (zurückgekauft)' : 'Verkauft');
  const g: Grund[] = [];
  const sc = f.signalContext;
  if (f.sync === true) {
    g.push({ art: 'luecke', text: 'Aus der Broker-Historie übernommen — der Grund ist nicht aufgezeichnet.' });
  } else if (f.riskExit) {
    const text = (cover ? AUSSTIEG_SHORT[f.riskExit] : undefined) ?? AUSSTIEG[f.riskExit];
    g.push({ art: 'info', text: text ?? `Automatisch geschlossen (Grund: ${f.riskExit}).` });
  } else if (f.source === 'manual' || sc?.typ === 'manuell') {
    g.push({ art: 'info', text: cover ? 'Von dir selbst zurückgekauft (manueller Trade).' : 'Von dir selbst verkauft (manueller Trade).' });
  } else if (sc?.typ === 'regelbaum') {
    g.push({ art: 'info', text: `Das feste Regelwerk (Regelbaum) hat ein Signal zum ${cover ? 'Zurückkaufen' : 'Verkaufen'} gegeben.` });
  } else {
    const gedreht = stimmenText(sc?.votes, cover ? 'buy' : 'sell');
    g.push(gedreht.length > 0
      ? { art: 'info', text: `Die Anzeichen haben gedreht: ${aufzaehlen(gedreht)} ${gedreht.length === 1 ? 'zeigte' : 'zeigten'} nun auf ${cover ? 'steigende' : 'fallende'} Kurse.` }
      // Ohne Stimmen nichts behaupten: Auch dein Prognose-Pfeil kann den
      // Ausstieg allein auslösen, und der wird am Ausstieg nicht gespeichert.
      : { art: 'luecke', text: 'Vom Anzeichen-System geschlossen; welches Anzeichen den Ausschlag gab, ist für diesen Trade nicht aufgezeichnet.' });
  }
  if ((f.riskExit === 'trailing_stop' || f.riskExit === 'trailing_stop_broker')
    && typeof f.peakPrice === 'number' && typeof f.price === 'number' && f.peakPrice > 0) {
    // Am Short ist peakPrice der TIEFSTSTAND (broker.ts: lowWater).
    g.push({ art: 'info', text: cover
      ? `Tiefster Kurs während der Haltezeit: ${zahl(f.peakPrice)}; zurückgekauft bei ${zahl(f.price)}.`
      : `Höchster Kurs während der Haltezeit: ${zahl(f.peakPrice)}; verkauft bei ${zahl(f.price)}.` });
  }
  if (typeof f.pnl === 'number') {
    // pnl ist NETTO: Kommission und Slippage beider Seiten stecken schon drin
    // (broker.ts, effektive Preise). `fee` ist nur die Gebühr dieses Auftrags.
    const einsatz = typeof f.entryPrice === 'number' && f.entryPrice > 0 && typeof f.qty === 'number' && f.qty > 0
      ? f.entryPrice * f.qty : null;
    const pct = einsatz !== null ? (f.pnl / einsatz) * 100 : null;
    const gebuehr = typeof f.fee === 'number' && f.fee > 0
      ? ` Darin schon abgezogen: ${zahl(f.fee)} $ Gebühr für ${cover ? 'den Rückkauf' : 'den Verkauf'}.` : '';
    g.push({
      art: f.pnl >= 0 ? 'pro' : 'contra',
      text: `Ergebnis nach Gebühren: ${geld(f.pnl)}${pct !== null ? ` (${vz(pct, 1)} % auf den Einsatz)` : ''}.${gebuehr}`,
    });
  }
  if (typeof f.holdingDays === 'number' && f.holdingDays >= 0) {
    const tage = f.holdingDays < 1 ? 'weniger als einen Tag' : f.holdingDays < 1.5 ? 'etwa einen Tag' : `etwa ${Math.round(f.holdingDays)} Tage`;
    g.push({ art: 'info', text: `Gehalten: ${tage}.` });
  }
  return { art: 'ausstieg', titel, gruende: g };
}
