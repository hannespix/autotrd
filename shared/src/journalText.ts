/**
 * autotrd — Journal-These in Worten (Owner-Go 08.08., „Zweites Gehirn").
 *
 * Das M12-Journal friert je Trade den Signal-Kontext ein (Votes, Konfluenz,
 * Prognose, Regime) — fälschungssicherer als jeder handgeschriebene Satz,
 * aber als Datenzeile für Menschen mühsam zu lesen. Dieses Modul übersetzt
 * die eingefrorenen Fakten DETERMINISTISCH in einen deutschen Satz: „Einstieg
 * long, weil …". Kein LLM, keine Interpretation — nur eine zweite Darstellung
 * derselben Zahlen. Erst damit wird das Review in Sekunden statt Minuten
 * möglich; und ein späterer KI-Bericht liest dieselben Sätze als Faktenbasis.
 */

/** Schmale Sicht auf eine Journal-Zeile — kompatibel zu Server UND Frontend. */
export interface JournalThesenFakten {
  art?: string;
  side?: string;
  source?: string;
  riskExit?: string;
  pnl?: number;
  nachkauf?: boolean;
  signalContext?: {
    typ?: string;
    votes?: Record<string, string>;
    konfluenz?: number;
    minKonfluenz?: number;
    forecast?: { dir?: string; weight?: number };
    regime?: string;
    ki?: { richtung?: string; probe?: boolean };
    lexikon?: { dir?: string; probe?: boolean };
  };
}

const VOTE_NAME: Record<string, string> = { rsi: 'RSI', macd: 'MACD', bollinger: 'Bollinger' };
const VOTE_VERB: Record<string, string> = { buy: 'kauft', sell: 'verkauft' };
const EXIT_GRUND: Record<string, string> = {
  stop_loss: 'über den Stop-Loss',
  take_profit: 'über das Gewinnziel',
  trailing_stop: 'über den Trailing-Stop',
  // Die GTC-Order beim Broker, die am Trailing-Niveau stand (23.08.). Eigener
  // Grund, weil sie sich anders verhält als der Engine-Ausstieg: Sie füllt
  // bei einer Kurslücke beliebig weit unter der Marke.
  trailing_stop_broker: 'über den Trailing-Stop beim Broker',
  max_hold: 'nach Ablauf der maximalen Haltedauer',
  breaker: 'durch die Tages-Notbremse',
  // KI-Kaskade Stufe 2b (06.10.)
  ki_news: 'auf eine gegengeprüfte Nachricht gegen die Position (KI)',
  ki_stop: 'über den nach einer Gegen-Nachricht nachgezogenen KI-Stop',
  // Drift-Paket 08.10.: die Order stand beim Broker, der Fill kam später.
  exit_nachlauf: 'über eine stehen gebliebene Ausstiegs-Order (nachgebucht)',
};

/** Geldbetrag deutsch: Vorzeichen, Komma, Dollar. */
const geld = (x: number): string =>
  `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2).replace('.', ',')} $`;

/** Aktive Indikator-Stimmen als Klartext („MACD kauft, RSI verkauft"). */
function stimmen(votes: Record<string, string> | undefined): string | null {
  if (!votes) return null;
  const aktiv = Object.entries(votes)
    .filter(([, v]) => v === 'buy' || v === 'sell')
    .map(([k, v]) => `${VOTE_NAME[k] ?? k.toUpperCase()} ${VOTE_VERB[v] ?? v}`);
  if (aktiv.length === 0) return 'alle Indikatoren neutral';
  return aktiv.join(', ');
}

/**
 * Die eingefrorenen Fakten einer Journal-Zeile als deutschen Satz.
 *
 * Bewusst defensiv gegenüber Lücken: Alte Einträge (vor M12-Vollausbau)
 * tragen keinen oder einen dünneren Kontext — dann wird der Satz kürzer,
 * nie falsch.
 */
export function journalThese(e: JournalThesenFakten): string {
  const sc = e.signalContext;
  const manuell = e.source === 'manual' || sc?.typ === 'manuell';

  if (e.art === 'exit') {
    const wie =
      (e.riskExit ? EXIT_GRUND[e.riskExit] : undefined) ??
      (e.riskExit ? `über ${e.riskExit}` : undefined) ??
      (manuell
        ? 'von Hand'
        : sc?.typ === 'regelbaum'
          ? 'per Regelbaum-Signal'
          : typeof sc?.konfluenz === 'number'
            ? `am Signal (Konfluenz ${sc.konfluenz})`
            : 'am Signal');
    const was = e.side === 'buy' ? 'Short eingedeckt' : 'Position geschlossen';
    const pnl = typeof e.pnl === 'number' ? ` — Ergebnis ${geld(e.pnl)}` : '';
    const regime = sc?.regime ? ` (Regime ${sc.regime})` : '';
    return `${was} ${wie}${pnl}${regime}.`;
  }

  // Entry: Richtung + Begründung aus dem eingefrorenen Kontext.
  const richtung = e.side === 'sell' ? 'short' : 'long';
  const kopf = e.nachkauf === true ? `Nachkauf ${richtung}` : `Einstieg ${richtung}`;
  if (manuell) return `${kopf} — von Hand ausgelöst.`;

  const gruende: string[] = [];
  if (sc?.typ === 'regelbaum') {
    gruende.push('der Regelbaum ein Signal gab');
  } else if (typeof sc?.konfluenz === 'number') {
    const latte = typeof sc.minKonfluenz === 'number' ? `/${sc.minKonfluenz}` : '';
    const s = stimmen(sc.votes);
    // KI-Probe: Die Technik allein hat die Latte NICHT gerissen — dann darf
    // der Satz nicht „erreicht" behaupten (`konfluenz` ist die Zahl ohne KI).
    const probe = sc.ki?.probe === true || sc.lexikon?.probe === true;
    gruende.push(
      probe
        ? `die Technik bei ${sc.konfluenz}${latte} stand${s ? ` (${s})` : ''}`
        : `die Konfluenz ${sc.konfluenz}${latte} erreicht war${s ? ` (${s})` : ''}`,
    );
  } else if (sc?.typ === 'momentum') {
    gruende.push('das Momentum-Ranking das Symbol gekürt hat');
  } else if (sc?.typ) {
    gruende.push(`der Pfad „${sc.typ}" ausgelöst hat`);
  }
  if (sc?.forecast?.dir) {
    const wohin = sc.forecast.dir === 'up' ? 'aufwärts' : 'abwärts';
    const gewicht =
      typeof sc.forecast.weight === 'number'
        ? ` (Gewicht ${sc.forecast.weight.toFixed(2).replace('.', ',')})`
        : '';
    gruende.push(`die Prognose ${wohin} zeigte${gewicht}`);
  }
  if (sc?.ki?.richtung) {
    gruende.push(
      `eine gegengeprüfte Nachricht ${sc.ki.richtung} bewertet wurde (KI${sc.ki.probe ? ', Probegröße' : ''})`,
    );
  }
  if (sc?.lexikon?.dir) {
    gruende.push(
      `das Nachrichten-Lexikon ${sc.lexikon.dir === 'buy' ? 'positiv' : 'negativ'} stimmte (KI-Budget aufgebraucht${sc.lexikon.probe ? ', Probegröße' : ''})`,
    );
  }
  const regime = sc?.regime ? ` — Regime ${sc.regime}` : '';
  if (gruende.length === 0) return `${kopf}${regime}.`;
  return `${kopf}, weil ${gruende.join(' und ')}${regime}.`;
}
