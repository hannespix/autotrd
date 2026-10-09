/**
 * Standardwert + Wirkung je Trading-Option (Task 24, Owner 09.10.):
 * „bei den Werten in die Infos noch grob die Standards reinschreiben. Und
 * vor allem wie stark Änderungen ungefähr auf was auswirken … so weiß man
 * die Standards und kann einfach wieder zurücksetzen und kann besser die
 * Folgen abschätzen." Und: „alles so einfach verständlich wie möglich!!"
 *
 * Drei Regeln, damit das nicht wieder verfällt:
 *
 *   1. Der STANDARD kommt aus denselben Konstanten wie der Server
 *      (`DEFAULT_STRATEGY`, `MIN_EDGE_MULTIPLE`, …) — nie als Zahl im Text.
 *      Ein Text „Standard 2 %" wäre nach der nächsten Umstellung eine Lüge;
 *      der Wächter `optionenStandard.test.ts` prüft jeden Eintrag gegen die
 *      Quelle.
 *   2. Die WIRKUNG beschreibt, was eine Änderung um einen SCHRITT tut —
 *      in Alltagssprache, ein bis drei Sätze, ohne Fachwort ohne Erklärung.
 *      Das ist der Teil, den ein Laie liest, BEVOR er dreht.
 *   3. Das Modul kennt keinen DOM. Es liefert Markup als String; wer es
 *      zeigt (`infotips.ts`), liest den aktuellen Feldwert selbst.
 */
import {
  CORE_PCT_CAP,
  DEFAULT_CORE_PCT,
  DEFAULT_MAINTENANCE_MARGIN,
  DEFAULT_MARGIN_RATE,
  DEFAULT_MAX_OPEN_POSITIONS,
  DEFAULT_RISK_PER_TRADE_PCT,
  DEFAULT_STRATEGY,
  MAX_LEVERAGE,
  MAX_OPEN_POSITIONS_CAP,
  MAX_RISK_PER_TRADE_PCT,
  MIN_EDGE_MULTIPLE,
} from '@autotrd/shared';
import type { Sprache } from './i18n.js';

/** Wie das Feld im Options-Modal aussieht — bestimmt Anzeige und Rücksetzen. */
export type OptionArt = 'zahl' | 'wahl' | 'schalter';

export interface OptionStandard {
  /** DOM-ID des Eingabefelds (`owSl` …); fehlt bei Reglergruppen. */
  feld?: string;
  art: OptionArt;
  /** Der Standard — IMMER aus einer Konstante, nie als Literal hier. */
  standard: number | string | boolean;
  /** Einheit hinter der Zahl ('%', '×', …); nur bei `art: 'zahl'`. */
  einheit?: string;
  /** Der Schritt, auf den sich der Wirkungs-Satz bezieht. */
  schritt?: number;
  /** Bedeutung der Null (z. B. „aus") — Laien lesen 0 sonst als „nichts". */
  nullHeisst?: boolean;
  /** Bei `art: 'wahl'`: Feldwert → Wörterbuch-Schlüssel der Beschriftung. */
  wahl?: Record<string, string>;
}

/** Die Laien-Sätze je Option, zweisprachig wie die Tips. */
export interface OptionText {
  /** Ein Satz: Was stellt dieser Regler ein? */
  kurz: string;
  /** Ein bis drei Sätze: Was bewirkt eine Änderung um einen Schritt? */
  wirkung: string;
}

const E = DEFAULT_STRATEGY.engine;
const S = DEFAULT_STRATEGY.signals;
const B = DEFAULT_STRATEGY.broker;

/**
 * Die Tabelle — Schlüssel ist der Tip-Schlüssel (`iBtn('stopLoss')`), damit
 * der Block ohne zweite Verdrahtung im richtigen Popover erscheint.
 */
export const OPTIONEN_STANDARD: Record<string, OptionStandard> = {
  startkapital: { feld: 'owCap', art: 'zahl', standard: B.initialCapital, einheit: '$', schritt: 5000 },
  maxPos: { feld: 'owMax', art: 'zahl', standard: E.maxPositionPct, einheit: '%', schritt: 1 },
  riskPerTrade: { feld: 'owRisk', art: 'zahl', standard: DEFAULT_RISK_PER_TRADE_PCT, einheit: '%', schritt: 1, nullHeisst: true },
  maxOpenPositions: { feld: 'owMaxPos', art: 'zahl', standard: E.maxOpenPositions ?? DEFAULT_MAX_OPEN_POSITIONS, schritt: 1 },
  corePct: { feld: 'owCore', art: 'zahl', standard: E.corePct ?? DEFAULT_CORE_PCT, einheit: '%', schritt: 10, nullHeisst: true },
  leverage: {
    feld: 'owLev', art: 'wahl', standard: String(B.leverage ?? 1),
    wahl: { '1': 'opt.hebel1', '2': 'opt.hebel2', '3': 'opt.hebel3' },
  },
  stopLoss: { feld: 'owSl', art: 'zahl', standard: E.stopLossPct, einheit: '%', schritt: 1 },
  takeProfit: { feld: 'owTp', art: 'zahl', standard: E.takeProfitPct, einheit: '%', schritt: 1 },
  trailingStop: { feld: 'owTrail', art: 'zahl', standard: E.trailingStopPct ?? 0, einheit: '%', schritt: 1, nullHeisst: true },
  maxHold: { feld: 'owHold', art: 'zahl', standard: E.maxHoldDays ?? 0, schritt: 1, nullHeisst: true },
  atrStop: { feld: 'owAtrS', art: 'zahl', standard: E.atrStopMult ?? 0, einheit: '×', schritt: 0.5, nullHeisst: true },
  atrTake: { feld: 'owAtrT', art: 'zahl', standard: E.atrTakeMult ?? 0, einheit: '×', schritt: 0.5, nullHeisst: true },
  signalTimeframe: {
    feld: 'owTf', art: 'wahl', standard: S.timeframe ?? 'intraday',
    wahl: { intraday: 'opt.tf5m', daily: 'opt.tfDaily' },
  },
  cooldownMin: { feld: 'owCd', art: 'zahl', standard: E.cooldownMin ?? 15, schritt: 60 },
  minConfluence: { feld: 'owMinC', art: 'zahl', standard: S.minConfluence, schritt: 1 },
  exitConfluence: { feld: 'owExitC', art: 'zahl', standard: S.exitConfluence ?? 1, schritt: 1 },
  minEdgeMultiple: { feld: 'owEdge', art: 'zahl', standard: S.minEdgeMultiple ?? MIN_EDGE_MULTIPLE, einheit: '×', schritt: 1, nullHeisst: true },
  dailyLossLimit: { feld: 'owBreak', art: 'zahl', standard: E.dailyLossLimitPct ?? 0, einheit: '%', schritt: 1, nullHeisst: true },
  flattenOnBreach: { feld: 'owFlatten', art: 'schalter', standard: E.flattenOnBreach === true },
  regimeGate: { feld: 'owRegimeGate', art: 'schalter', standard: S.regimeGate !== false },
  newsVeto: { feld: 'owNewsVeto', art: 'schalter', standard: S.newsVeto !== false },
  kiNachrichten: { feld: 'owKiNachrichten', art: 'schalter', standard: S.kiNachrichten !== false },
  allowShort: { feld: 'owShort', art: 'schalter', standard: S.allowShort === true },
  classAutoTune: { feld: 'owClsAuto', art: 'schalter', standard: E.classAutoTune !== false },
  // Reglergruppe ohne einzelnes Feld: Standard und Wirkung ja, Rücksetzen nein.
  classWeights: { art: 'zahl', standard: 1, einheit: '×', schritt: 0.5, nullHeisst: true },
};

/* Zahlen, die in den Sätzen vorkommen — aus den Konstanten gebaut, damit
 * der Satz dieselbe Wahrheit sagt wie der Code. */
const ZINS = Math.round(DEFAULT_MARGIN_RATE * 100);
const EIGENANTEIL = Math.round(DEFAULT_MAINTENANCE_MARGIN * 100);

export const STANDARD_TEXT_DE: Record<string, OptionText> = {
  startkapital: {
    kurz: 'Mit so viel Übungsgeld fängt ein neues Depot an.',
    wirkung: 'Wirkt nur auf ein neues oder zurückgesetztes Depot. Ein laufendes Depot behält seinen Kontostand, egal was hier steht.',
  },
  maxPos: {
    kurz: 'So viel Prozent deines Geldes darf in einem einzigen Wert stecken.',
    wirkung: 'Gerechnet vom gerade freien Geld. Plus 1 heißt: Jede neue Position wird um 1 % davon größer — Gewinn und Verlust je Wert wachsen mit. Mehr als 25 lässt der Server nicht zu; mit „Risiko je Trade" ist das nur noch die Obergrenze.',
  },
  riskPerTrade: {
    kurz: 'Wie viel Prozent deines Geldes ein einzelner Trade höchstens verlieren darf, wenn sein Stop greift.',
    wirkung: `Bei 1 kostet ein gestoppter Trade höchstens etwa 1 % deines freien Geldes, egal welcher Wert — ruhige Werte bekommen mehr Stücke, wilde weniger. Plus 1 heißt: Jeder Stop darf 1 % mehr kosten. „Investment je Trade" bleibt die Obergrenze. 0 = aus. Höchstens ${MAX_RISK_PER_TRADE_PCT}.`,
  },
  maxOpenPositions: {
    kurz: 'So viele Werte darf das Depot gleichzeitig halten.',
    wirkung: `Plus 1 heißt: Ein Wert mehr darf gleichzeitig offen sein. Mehr Werte verteilen das Risiko, jeder einzelne zählt dann weniger. Der ruhige Sockel zählt nicht mit. Höchstens ${MAX_OPEN_POSITIONS_CAP}.`,
  },
  corePct: {
    kurz: 'So viel Prozent deines Geldes liegt ruhig in den stärksten Werten, statt aktiv gehandelt zu werden.',
    wirkung: `Plus 10 heißt: 10 % mehr von deinem Geld ruht im Sockel (selten umgeschichtet, kaum Gebühren), 10 % weniger steht der aktiven Engine zur Verfügung. 0 = kein Sockel: Die vorhandenen Sockel-Positionen werden dann am Abend verkauft, mit Gebühren. Höchstens ${CORE_PCT_CAP}.`,
  },
  leverage: {
    kurz: 'Ob das Depot mit geliehenem Geld handeln darf.',
    wirkung: `Bei 2× werden Gewinne UND Verluste doppelt so groß. Auf das geliehene Geld laufen ${ZINS} % Zinsen im Jahr, und fällt dein Eigenanteil unter ${EIGENANTEIL} %, wird zwangsweise verkauft. Greift nur bei sehr klaren Signalen; höchstens ${MAX_LEVERAGE}×.`,
  },
  stopLoss: {
    kurz: 'Fällt ein Wert um so viel Prozent unter den Kaufkurs, wird er zum Schutz verkauft.',
    wirkung: 'Plus 1 heißt: Der Schutzverkauf kommt 1 % später — seltener von normalem Zittern rausgeworfen, aber jeder Schutzverkauf kostet 1 % mehr. Gilt für neue Käufe; offene Positionen behalten ihre Marke. 0 ist nicht „aus": dann bleibt eine weite Notbremse bei 25 %. Krypto, Rohstoffe, Devisen, Indizes haben eigene Werte.',
  },
  takeProfit: {
    kurz: 'Steigt ein Wert um so viel Prozent über den Kaufkurs, wird der Gewinn mitgenommen.',
    wirkung: 'Plus 1 heißt: Das Ziel liegt 1 % höher — seltener erreicht, bringt dann aber mehr. Faustregel: etwa doppelt so groß wie der Stop-Loss, damit ein Treffer zwei Fehlschläge bezahlt. Gilt für neue Käufe; offene Positionen behalten ihr Ziel.',
  },
  trailingStop: {
    kurz: 'Ein Schutzverkauf, der mit dem Kurs nach oben wandert und so Gewinne sichert.',
    wirkung: 'Plus 1 heißt: Der Stop läuft 1 % weiter hinter dem Höchstkurs her — er hält Schwankungen besser aus, gibt vom erreichten Gewinn aber 1 % mehr wieder her. 0 = aus; dann schließt eine Position am Ziel, am Stop-Loss oder per Verkaufssignal.',
  },
  maxHold: {
    kurz: 'Nach so vielen Tagen wird ein Wert verkauft, egal wie der Kurs steht.',
    wirkung: 'Plus 1 heißt: ein Tag länger. 0 = keine Frist. Vorsicht beim Einschalten: Alle Positionen, die schon älter sind als die Frist, werden beim nächsten Durchlauf sofort verkauft.',
  },
  atrStop: {
    kurz: 'Der Schutzverkauf wird in „normalen Tagesschwankungen" des Werts gemessen statt in festen Prozent.',
    wirkung: 'Bei 2 rechnet die Engine mit zwei Tagesschwankungen Abstand — das bestimmt zurzeit nur, wie viele Stücke sie kauft (mit „Risiko je Trade"). Verkauft wird weiter am Stop-Loss in Prozent. Plus 0,5 heißt: eine halbe Schwankung mehr Abstand, also etwas kleinere Positionen. 0 = aus.',
  },
  atrTake: {
    kurz: 'Das Gewinnziel in „normalen Tagesschwankungen" des Werts statt in festen Prozent.',
    wirkung: 'Bei 4 liegt das Ziel vier Tagesschwankungen über dem Kaufkurs — aber nur, wenn „Take-Profit %" auf 0 steht; sonst gilt das Prozent-Ziel. Plus 0,5 heißt: eine halbe Schwankung weiter weg — seltener erreicht, mehr Gewinn. 0 = aus.',
  },
  signalTimeframe: {
    kurz: 'Ob die Engine auf Tages- oder auf 5-Minuten-Kerzen schaut.',
    wirkung: 'Tageskerzen: wenige Trades, wenig Gebühren, Signale ändern sich nur alle paar Tage. 5-Minuten: viele Trades am Tag — in der Messung fraßen die Gebühren dabei ein Mehrfaches des Gewinns.',
  },
  cooldownMin: {
    kurz: 'So viele Minuten wartet die Engine nach einem Verkauf (Stop, Ziel, Frist oder Signal), bevor sie denselben Wert wieder kauft.',
    wirkung: 'Plus 60 heißt: eine Stunde länger warten — weniger Hin-und-Her, weniger Gebühren, dafür mal eine verpasste Chance. Im Seitwärtsmarkt wartet sie von selbst doppelt so lang. Mindestens 5 Minuten, höchstens 1440 (ein Tag).',
  },
  minConfluence: {
    kurz: 'So viele Anzeichen müssen gleichzeitig „kaufen" sagen, bevor gekauft wird.',
    wirkung: 'Plus 1 heißt: Ein Anzeichen mehr muss zusammenkommen — deutlich weniger Käufe, dafür verlässlichere (schon bei 2 kam im ruhigen Markt kaum ein Kauf zustande). Bei 1 reicht ein einzelnes Anzeichen, solange keins dagegen spricht. Im Aufwärtstrend reicht für Käufe ohnehin die Trendstimme allein.',
  },
  exitConfluence: {
    kurz: 'So viele Anzeichen müssen „verkaufen" sagen, bevor eine Position per Signal verkauft wird.',
    wirkung: 'Minus 1 heißt: Der Signal-Verkauf kommt leichter — mehr frühe Verkäufe, die Gewinne abschneiden. Plus 1 gibt der Position länger Zeit. Stop-Loss, Ziel und nachziehender Stop gelten davon unabhängig immer.',
  },
  minEdgeMultiple: {
    kurz: 'Wie viel größer die erwartete Kursbewegung sein muss als die Gebühren, damit überhaupt gehandelt wird.',
    wirkung: `Plus 1 heißt: Die Bewegung muss das ${MIN_EDGE_MULTIPLE + 1}-Fache der Gebühren schaffen statt das ${MIN_EDGE_MULTIPLE}-Fache — ruhige Werte fallen weg, es gibt weniger, aber lohnendere Trades. 0 = Filter aus (nicht empfohlen).`,
  },
  dailyLossLimit: {
    kurz: 'Ab so viel Prozent Tagesverlust kauft die Engine bis zum nächsten Tag nichts mehr.',
    wirkung: 'Plus 1 heißt: Die Bremse greift erst bei 1 % mehr Verlust am Tag. Offene Positionen bleiben; nur neue Käufe stoppen. 0 = aus.',
  },
  flattenOnBreach: {
    kurz: 'Ob bei der Tages-Notbremse zusätzlich alles verkauft wird.',
    wirkung: 'An: Bei der Notbremse werden alle aktiven Positionen sofort verkauft, auch mit Verlust; der ruhige Sockel bleibt. Aus: Nur neue Käufe stoppen; Stop-Loss und Ziel laufen für jede Position weiter.',
  },
  regimeGate: {
    kurz: 'Ob die Engine Käufe gegen die Richtung des Gesamtmarkts und in Stress-Phasen sperrt.',
    wirkung: 'Aus: Auch Wetten gegen den Markt und Käufe bei großer Nervosität sind erlaubt — mehr Trades, mehr Risiko. Verkäufe sind nie betroffen.',
  },
  newsVeto: {
    kurz: 'Ob direkt um große Nachrichten (Quartalszahlen, Klagen, Übernahmen) nicht gekauft wird.',
    wirkung: 'Aus: Die Engine kauft auch, während ein Wert wegen solcher Nachrichten springt — der Stop greift dann oft nicht zum geplanten Kurs. Verkäufe sind nie betroffen.',
  },
  kiNachrichten: {
    kurz: 'Ob eine KI frische Nachrichten zu deinen Werten mitbewertet.',
    wirkung: 'Aus: Gute Nachrichten lösen keine Probe-Käufe mehr aus; schlechte sperren keine Käufe, ziehen keine Stops enger und verkaufen nichts. Alle anderen Prüfungen bleiben gleich.',
  },
  allowShort: {
    kurz: 'Ob die Engine auch auf fallende Kurse setzen darf.',
    wirkung: 'An: Ein Verkaufssignal ohne Position eröffnet eine Wette auf fallende Kurse. Dabei kann der Verlust größer werden als der Einsatz — Stop und Notbremse gelten gespiegelt.',
  },
  classAutoTune: {
    kurz: 'Ob die Gewichte je Anlageklasse täglich automatisch nachgestellt werden.',
    wirkung: 'Aus: Die Gewichte bleiben, wie du sie stellst; Vorschläge werden nur angezeigt. An: Schritte von 0,25 pro Tag in Richtung des gemessenen Vorschlags; eine Klasse, die nachweislich Geld verbrennt, wird sofort auf 0 gesetzt.',
  },
  classWeights: {
    kurz: 'Wie groß Positionen je Anlageklasse ausfallen — 1 ist normal.',
    wirkung: 'Plus 0,5 heißt: Käufe in dieser Klasse werden um die Hälfte größer. 0 = in dieser Klasse wird nichts Neues gekauft; offene Positionen werden trotzdem normal geschlossen.',
  },
};

export const STANDARD_TEXT_EN: Record<string, Partial<OptionText>> = {
  startkapital: {
    kurz: 'The practice money a new wallet starts with.',
    wirkung: 'Only affects a new or reset wallet. A running wallet keeps its balance whatever you enter here.',
  },
  maxPos: {
    kurz: 'The share of your money that may sit in one single symbol.',
    wirkung: 'Computed from the money currently free. Plus 1 means every new position is 1% of that larger — profit and loss per symbol grow with it. The server allows at most 25; with "risk per trade" it is only the upper limit.',
  },
  riskPerTrade: {
    kurz: 'How much of your money a single trade may lose at most when its stop fires.',
    wirkung: `At 1, a stopped trade costs at most about 1% of your free money, whatever the symbol — calm symbols get more shares, wild ones fewer. Plus 1 means each stop may cost 1% more. "Investment per trade" stays the upper limit. 0 = off. At most ${MAX_RISK_PER_TRADE_PCT}.`,
  },
  maxOpenPositions: {
    kurz: 'How many symbols the wallet may hold at the same time.',
    wirkung: `Plus 1 means one more symbol may be open at once. More symbols spread the risk; each one matters less. The calm core does not count. At most ${MAX_OPEN_POSITIONS_CAP}.`,
  },
  corePct: {
    kurz: 'The share of your money that rests in the strongest symbols instead of being traded actively.',
    wirkung: `Plus 10 means 10% more of your money rests in the core (rarely reshuffled, hardly any fees) and 10% less is available to the active engine. 0 = no core: the existing core positions are then sold in the evening, with fees. At most ${CORE_PCT_CAP}.`,
  },
  leverage: {
    kurz: 'Whether the wallet may trade with borrowed money.',
    wirkung: `At 2×, gains AND losses double. Borrowed money costs ${ZINS}% interest per year, and if your own share drops below ${EIGENANTEIL}% positions are sold by force. Only used on very clear signals; at most ${MAX_LEVERAGE}×.`,
  },
  stopLoss: {
    kurz: 'If a symbol falls this many percent below the buy price, it is sold for protection.',
    wirkung: 'Plus 1 means the protective sale comes 1% later — thrown out by normal wobble less often, but each protective sale costs 1% more. Applies to new buys; open positions keep their mark. 0 is not "off": a wide emergency stop at 25% remains. Crypto, commodities, forex and indices have their own values.',
  },
  takeProfit: {
    kurz: 'If a symbol rises this many percent above the buy price, the profit is taken.',
    wirkung: 'Plus 1 means the target sits 1% higher — reached less often, but worth more when it is. Rule of thumb: about twice the stop-loss, so one hit pays for two misses. Applies to new buys; open positions keep their target.',
  },
  trailingStop: {
    kurz: 'A protective sale that moves up with the price and locks in gains.',
    wirkung: 'Plus 1 means the stop follows 1% further behind the peak — it survives more wobble but gives back 1% more of the gain. 0 = off; a position then closes at the target, the stop-loss or on a sell signal.',
  },
  maxHold: {
    kurz: 'After this many days a symbol is sold, whatever the price.',
    wirkung: 'Plus 1 means one day longer. 0 = no limit. Careful when switching it on: every position already older than the limit is sold on the next run.',
  },
  atrStop: {
    kurz: 'The protective sale measured in the symbol\'s "normal daily swings" instead of fixed percent.',
    wirkung: 'At 2 the engine assumes two daily swings of distance — for now that only sets how many shares it buys (with "risk per trade"). Selling still happens at the percent stop-loss. Plus 0.5 means half a swing more distance, so slightly smaller positions. 0 = off.',
  },
  atrTake: {
    kurz: 'The profit target in the symbol\'s "normal daily swings" instead of fixed percent.',
    wirkung: 'At 4 the target sits four daily swings above the buy price — but only if "Take-profit %" is 0; otherwise the percent target applies. Plus 0.5 means half a swing further away — reached less often, more profit. 0 = off.',
  },
  signalTimeframe: {
    kurz: 'Whether the engine looks at daily or at 5-minute candles.',
    wirkung: 'Daily: few trades, low fees, signals change only every few days. 5-minute: many trades a day — in our measurement fees ate several times the profit.',
  },
  cooldownMin: {
    kurz: 'How many minutes the engine waits after a sale (stop, target, time limit or signal) before buying the same symbol again.',
    wirkung: 'Plus 60 means one hour longer — less back-and-forth, fewer fees, but the odd missed chance. In a sideways market it waits twice as long by itself. At least 5 minutes, at most 1440 (one day).',
  },
  minConfluence: {
    kurz: 'How many signs must say "buy" at the same time before a buy happens.',
    wirkung: 'Plus 1 means one more sign has to line up — far fewer buys, but more reliable ones (even at 2 hardly any buy happened in a calm market). At 1 a single sign is enough as long as none speaks against it. In an uptrend the trend vote alone is enough for buys anyway.',
  },
  exitConfluence: {
    kurz: 'How many signs must say "sell" before a position is sold on signal.',
    wirkung: 'Minus 1 means the signal sale comes easier — more early sales that cut profits short. Plus 1 gives the position more time. Stop-loss, target and trailing stop always apply regardless.',
  },
  minEdgeMultiple: {
    kurz: 'How much larger the expected price move must be than the fees before a trade happens at all.',
    wirkung: `Plus 1 means the move must reach ${MIN_EDGE_MULTIPLE + 1} times the fees instead of ${MIN_EDGE_MULTIPLE} — calm symbols drop out, fewer but more worthwhile trades. 0 = filter off (not recommended).`,
  },
  dailyLossLimit: {
    kurz: 'From this daily loss in percent the engine buys nothing more until the next day.',
    wirkung: 'Plus 1 means the brake kicks in 1% of daily loss later. Open positions stay; only new buys stop. 0 = off.',
  },
  flattenOnBreach: {
    kurz: 'Whether the daily brake also sells everything.',
    wirkung: 'On: when the brake fires, all active positions are sold at once, even at a loss; the calm core stays. Off: only new buys stop; stop-loss and target keep running for each position.',
  },
  regimeGate: {
    kurz: 'Whether the engine blocks buys against the overall market direction and during stress.',
    wirkung: 'Off: bets against the market and buys during high nervousness are allowed too — more trades, more risk. Sales are never affected.',
  },
  newsVeto: {
    kurz: 'Whether buying is blocked right around big news (earnings, lawsuits, takeovers).',
    wirkung: 'Off: the engine buys even while a symbol jumps on such news — the stop then often does not fire at the planned price. Sales are never affected.',
  },
  kiNachrichten: {
    kurz: 'Whether an AI rates fresh news on your symbols.',
    wirkung: 'Off: good news no longer triggers trial buys; bad news no longer blocks buys, tightens stops or sells anything. All other checks stay the same.',
  },
  allowShort: {
    kurz: 'Whether the engine may also bet on falling prices.',
    wirkung: 'On: a sell signal without a position opens a bet on falling prices. The loss can exceed the stake — stop and daily brake apply mirrored.',
  },
  classAutoTune: {
    kurz: 'Whether the weights per asset class are adjusted automatically every day.',
    wirkung: 'Off: the weights stay as you set them; suggestions are only shown. On: steps of 0.25 per day towards the measured suggestion; a class that demonstrably burns money is set to 0 at once.',
  },
  classWeights: {
    kurz: 'How large positions are per asset class — 1 is normal.',
    wirkung: 'Plus 0.5 means buys in this class become half as large again. 0 = nothing new is bought in this class; open positions are still closed normally.',
  },
};

/** Feldweiser Fallback wie bei den Tips: Englisch, sonst Deutsch — nie leer. */
export function waehleStandardText(sprache: Sprache): Record<string, OptionText> {
  if (sprache !== 'en') return STANDARD_TEXT_DE;
  const out: Record<string, OptionText> = {};
  for (const [id, de] of Object.entries(STANDARD_TEXT_DE)) {
    const en = STANDARD_TEXT_EN[id];
    out[id] = {
      kurz: en?.kurz && en.kurz.length > 0 ? en.kurz : de.kurz,
      wirkung: en?.wirkung && en.wirkung.length > 0 ? en.wirkung : de.wirkung,
    };
  }
  return out;
}

/** Zahl in der Sprache des Nutzers (1,5 statt 1.5 im Deutschen). */
function zahlText(n: number, sprache: Sprache): string {
  return n.toLocaleString(sprache === 'en' ? 'en-US' : 'de-DE', { maximumFractionDigits: 2 });
}

/**
 * Einen Wert so zeigen, wie ein Laie ihn liest: „2 %", „1× — kein Hebel",
 * „An", „0 (aus)". `t` löst Wörterbuch-Schlüssel der Wahl-Felder auf.
 */
export function wertText(
  o: OptionStandard,
  wert: number | string | boolean,
  sprache: Sprache,
  t: (k: string) => string,
): string {
  if (o.art === 'schalter') return wert === true ? t('tip.an') : t('tip.aus');
  if (o.art === 'wahl') {
    const k = o.wahl?.[String(wert)];
    return k ? t(k) : String(wert);
  }
  const n = typeof wert === 'number' ? wert : Number(wert);
  if (!Number.isFinite(n)) return String(wert);
  if (n === 0 && o.nullHeisst) return `0 (${t('tip.aus')})`;
  return o.einheit === '$' ? `${zahlText(n, sprache)} $` : `${zahlText(n, sprache)}${o.einheit ? ` ${o.einheit}` : ''}`;
}

/** Zwei Werte gleich? (Zahlen numerisch, sonst als String.) */
export function gleichStandard(o: OptionStandard, aktuell: number | string | boolean | null): boolean {
  if (aktuell === null) return false;
  if (o.art === 'zahl') return Number(aktuell) === Number(o.standard);
  if (o.art === 'schalter') return aktuell === o.standard;
  return String(aktuell) === String(o.standard);
}

const esc = (s: string): string =>
  s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

/**
 * Der Block fürs Popover — OBEN, vor dem ausführlichen Text:
 *
 *   Kurz-Satz
 *   Standard: 2 %   ·   Dein Wert: 3 % (abweichend)      [Auf Standard setzen]
 *   Was eine Änderung bewirkt: …
 *
 * `aktuell` ist der Feldwert (null = Feld nicht im DOM, dann ohne Vergleich).
 * Der Knopf erscheint nur, wenn der Wert abweicht UND ein Feld existiert.
 */
export function standardBlockHtml(
  key: string,
  aktuell: number | string | boolean | null,
  sprache: Sprache,
  t: (k: string) => string,
): string {
  const o = OPTIONEN_STANDARD[key];
  if (!o) return '';
  const text = waehleStandardText(sprache)[key];
  const gleich = gleichStandard(o, aktuell);
  const deinWert = aktuell === null
    ? ''
    : `<span class="ipop-mein">${esc(t('tip.deinWert'))}: <b>${esc(wertText(o, aktuell, sprache, t))}</b>${
      gleich ? ` <span class="ipop-ok">${esc(t('tip.wieStandard'))}</span>` : ''}</span>`;
  const knopf = !gleich && o.feld && aktuell !== null
    ? `<button type="button" class="ipop-reset" data-reset="${esc(key)}">${esc(t('tip.aufStandard'))}</button>`
    : '';
  return `<div class="ipop-std">
    ${text ? `<p class="ipop-kurz">${esc(text.kurz)}</p>` : ''}
    <div class="ipop-werte"><span>${esc(t('tip.standard'))}: <b>${esc(wertText(o, o.standard, sprache, t))}</b></span>${deinWert}${knopf}</div>
    ${text ? `<p class="ipop-wirkung"><b>${esc(t('tip.wirkung'))}:</b> ${esc(text.wirkung)}</p>` : ''}
  </div>`;
}
