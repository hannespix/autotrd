/**
 * Warum steht in dieser Zeile BUY, SELL oder HOLD? (Owner-Wunsch 22.08.)
 *
 * ── Der Anlass ────────────────────────────────────────────────────────────
 *
 * „kurz in worten einfach erklaert. damit man es als user besser versteht."
 * Die Auto-Signale-Karte zeigt heute `2▲ 1▼ / 2` — eine Rechnung ohne
 * Rechenweg. Wer nicht weiß, dass drei Indikatoren abstimmen und eine
 * Mehrheit über der Schwelle liegen muss, liest dort nichts.
 *
 * ── Warum eine REINE Funktion ─────────────────────────────────────────────
 *
 * Weil der gefährliche Teil hier der Text ist, nicht die Mechanik. Ein Satz,
 * der eine Erwartung über den Kursverlauf transportiert, ist Anlageberatung
 * — und die App sagt in ihrem eigenen Fuß, dass sie keine gibt. Ein Modul
 * ohne DOM lässt sich Satz für Satz gegen eine Verbotsliste prüfen; in einer
 * DOM-Funktion verschwände genau das im Rauschen.
 *
 * ── Die drei Regeln, an denen sich jeder Satz messen lassen muss ──────────
 *
 *  1. Nur Vergangenheit und Gegenwart. Beschrieben wird, was GEMESSEN wurde
 *     — nie, was daraus folgt.
 *  2. Keine Wertung. Kein „günstig", kein „überverkauft", keine „Chance".
 *     Auch technisch gemeinte Wörter tragen eine Erwartung.
 *  3. Keine erfundene Begründung. Ein Punkt entsteht NUR aus einem
 *     Stimm-Schlüssel, der wirklich im Signal-Dokument steht.
 *
 * ── Was hier bewusst NICHT erklärt wird ───────────────────────────────────
 *
 * Der naheliegende Schlusssatz „ein Signal ist noch keine Order — danach
 * entscheidet das Einstiegs-Tor" ist FALSCH, und zwar auf eine Art, die man
 * ihm nicht ansieht. Die angezeigte Zeile ist gar nicht die Eingabe des
 * Tors: Der Anzeige-Scan rechnet einmal je Symbol mit den Systemwerten und
 * nur der Marktampel; der Handelspfad rechnet je Konto KOMPLETT NEU — mit
 * den Einstellungen des Nutzers, seinem Bestand und seinem Zeitraster — und
 * dreht die Richtung danach womöglich noch per Prognose-Stimme. Die Karte
 * kann also BUY zeigen, während die Engine desselben Kontos HOLD rechnet.
 * Aus zwei parallelen Rechnungen eine Reihenschaltung zu machen, wäre eine
 * Kausalkette, die es im Code nicht gibt.
 *
 * Ebenso nicht: Ausstiegs-Schwellen (`exitConfluence` ist ein frei
 * einstellbarer Nutzerwert und kann den Ausstieg LEICHTER machen als den
 * Einstieg) und die Entwarnung „ohne Bestand gibt es nichts zu verkaufen"
 * (mit erlaubten Leerverkäufen eröffnet ein SELL eine Short-Position).
 */
import type { IndicatorRow, SignalRow } from './data.js';
import { t, sprachWahl } from './i18n.js';
import { zahl } from './shareCard.js';

/**
 * Schwellen der ANZEIGE, nicht der eigenen Strategie.
 *
 * Der Scan, der diese Zeile schreibt, rechnet mit den Systemwerten — nicht
 * mit `settings.strategy`. Wer hier die Nutzerwerte einsetzte, beschriftete
 * eine fremde Rechnung mit den eigenen Zahlen: Der Text sagte „unter der
 * Marke 25", während gegen 30 gerechnet wurde.
 */
export const ANZEIGE_RSI_KAUF = 30;
export const ANZEIGE_RSI_VERKAUF = 70;
export const ANZEIGE_BB_OBEN = 95;
/** Die Kaufgrenze ist die Spiegelung der Verkaufsgrenze (100 − 95). */
export const ANZEIGE_BB_UNTEN = 100 - ANZEIGE_BB_OBEN;

export interface ErklaerBaustein {
  /** Kurzer Name der Quelle — „RSI", „MACD", „Bollinger", „Prognose". */
  quelle: string;
  /** Der gemessene Wert als Text, falls vorhanden. Sonst leer. */
  wert: string;
  /** Was die Regel daraus gemacht hat. */
  stimme: string;
}

export interface SignalErklaerung {
  /** Überschrift: Richtung plus der Hinweis, dass es keine Empfehlung ist. */
  kopf: string;
  /** Ein Satz, der die Auszählung zusammenfasst. */
  zaehlung: string;
  /** Ein Punkt je GERECHNETER Quelle — nie mehr. */
  bausteine: ErklaerBaustein[];
  /** Ein bis zwei Schlusssätze: Herkunft der Zahlen, Trennung vom eigenen Konto. */
  fuss: string[];
}

/* Zahlen gehen durch `zahl()` aus shareCard — dieselbe Funktion, die auch
 * die Teilen-Karten sprachrichtig setzt. Eine zweite Konvention daneben
 * wäre genau die Naht, an der am 21.08. „118.40" mit Punkt neben „+10,7 %"
 * mit Komma in derselben Zeile stand. */
const z1 = (n: number): string => zahl(n, 1);
const z0 = (n: number): string => zahl(n, 0);

/**
 * Wie viele Indikator-Stimmen zeigen in diese Richtung?
 *
 * `forecast` bleibt draußen: Ihre Stimme wiegt mehr als eine (das Gewicht
 * hängt an der bisherigen Trefferquote), und sie wird deshalb als DIFFERENZ
 * zur Gesamtzahl bestimmt statt nachgebaut. Ein nachgebauter Deckel wäre
 * eine zweite Wahrheit neben der Engine — und die erste, die auseinanderläuft.
 */
function indikatorStimmen(sig: SignalRow, richtung: 'buy' | 'sell'): number {
  let n = 0;
  for (const k of ['rsi', 'macd', 'bollinger'] as const) {
    if (sig.votes[k] === richtung) n += 1;
  }
  return n;
}

/** Baustein für den RSI — nur wenn eine Stimme vorliegt. */
function rsiBaustein(sig: SignalRow, ind: IndicatorRow | null): ErklaerBaustein | null {
  const v = sig.votes.rsi;
  if (v === undefined) return null;
  const wert = typeof ind?.rsi === 'number' ? z1(ind.rsi) : '';
  if (v === 'buy') {
    return { quelle: t('se.rsi'), wert, stimme: `${t('se.unterMarke')} ${ANZEIGE_RSI_KAUF} · ${t('se.kaufstimme')}` };
  }
  if (v === 'sell') {
    return { quelle: t('se.rsi'), wert, stimme: `${t('se.ueberMarke')} ${ANZEIGE_RSI_VERKAUF} · ${t('se.verkaufsstimme')}` };
  }
  return { quelle: t('se.rsi'), wert, stimme: `${t('se.zwischenMarken')} ${ANZEIGE_RSI_KAUF}/${ANZEIGE_RSI_VERKAUF} · ${t('se.keineStimme')}` };
}

/**
 * Baustein für den MACD.
 *
 * Kein „neutral"-Fall: Das Histogramm ist die Differenz aus Linie und
 * Signallinie, ein exakter Gleichstand kommt praktisch nicht vor. Ein
 * Baustein dafür wäre toter Text, der nur bei der Prüfung Arbeit macht.
 */
function macdBaustein(sig: SignalRow, ind: IndicatorRow | null): ErklaerBaustein | null {
  const v = sig.votes.macd;
  if (v !== 'buy' && v !== 'sell') return null;
  const wert = ind?.macd ? z1(ind.macd.line) : '';
  return {
    quelle: t('se.macd'),
    wert,
    stimme:
      v === 'buy'
        ? `${t('se.macdUeber')} · ${t('se.kaufstimme')}`
        : `${t('se.macdUnter')} · ${t('se.verkaufsstimme')}`,
  };
}

/** Baustein für Bollinger — nur wenn eine Stimme vorliegt. */
function bollingerBaustein(sig: SignalRow, ind: IndicatorRow | null): ErklaerBaustein | null {
  const v = sig.votes.bollinger;
  if (v === undefined) return null;
  const wert = ind?.bollinger ? `${z0(ind.bollinger.pctB)} %` : '';
  if (v === 'buy') {
    return { quelle: t('se.bollinger'), wert, stimme: `${t('se.unterMarke')} ${ANZEIGE_BB_UNTEN} % · ${t('se.kaufstimme')}` };
  }
  if (v === 'sell') {
    return { quelle: t('se.bollinger'), wert, stimme: `${t('se.ueberMarke')} ${ANZEIGE_BB_OBEN} % · ${t('se.verkaufsstimme')}` };
  }
  return {
    quelle: t('se.bollinger'),
    wert,
    stimme: `${t('se.zwischenMarken')} ${ANZEIGE_BB_UNTEN} %/${ANZEIGE_BB_OBEN} % · ${t('se.keineStimme')}`,
  };
}

/**
 * Baustein für die Prognose — mit ihrem tatsächlichen Stimmgewicht.
 *
 * Das Gewicht wird als REST bestimmt (Gesamtzahl minus Indikator-Stimmen),
 * nicht aus der Gewichtsformel nachgebaut. Fehlt der Schlüssel ganz, hat die
 * Prognose nicht mitgezählt — dann entfällt der Punkt ersatzlos statt einer
 * Erklärung, warum nichts passiert ist.
 */
function prognoseBaustein(sig: SignalRow): ErklaerBaustein | null {
  const v = sig.votes.forecast;
  if (v !== 'buy' && v !== 'sell') return null;
  const gesamt = v === 'buy' ? sig.buyVotes : sig.sellVotes;
  const rest = gesamt - indikatorStimmen(sig, v);
  const n = rest > 0 ? rest : 1;
  return {
    quelle: t('se.prognose'),
    wert: '',
    stimme: `${t('se.zaehltHier')} ${n} ${n === 1 ? (v === 'buy' ? t('se.kaufstimme') : t('se.verkaufsstimme')) : v === 'buy' ? t('se.kaufstimmen') : t('se.verkaufsstimmen')}`,
  };
}

/**
 * Der Zählsatz — die eine Stelle, an der die Fälle streng getrennt bleiben
 * müssen.
 *
 * Bei GLEICHSTAND darf die Schwelle nicht als Ursache genannt werden: Die
 * Sperre ist dann, dass keine Seite vorn liegt, und das gilt unabhängig von
 * der Schwelle. Wer hier „es fehlte eine Stimme" schreibt, nennt einen
 * Grund, der nicht der Grund war.
 */
function zaehlsatz(sig: SignalRow): string {
  const { buyVotes: b, sellVotes: s, requiredConfluence: n, direction } = sig;
  const stimmen = `${b} ${b === 1 ? t('se.kaufstimme') : t('se.kaufstimmen')}, ${s} ${s === 1 ? t('se.verkaufsstimme') : t('se.verkaufsstimmen')}`;
  if (direction !== 'hold') {
    // Trendstimme: Reichte EINE Stimme, weil die Marktampel auf Trend stand?
    if (direction === 'buy' && n < 2 && sig.votes.macd === 'buy') {
      return `${stimmen}. ${t('se.trendSolo')}`;
    }
    return `${stimmen}. ${t('se.noetig')} ${n} ${t('se.aufEinerSeite')}`;
  }
  if (b === s) return `${stimmen}. ${t('se.gleichstand')}`;
  const vorn = Math.max(b, s);
  if (vorn === n - 1) return `${stimmen}. ${t('se.eineFehlte')} ${n}.`;
  return `${stimmen}. ${t('se.noetig')} ${n} ${t('se.aufEinerSeite')}`;
}

/** Uhrzeit des Signals, kurz. Leer, wenn der Zeitstempel unbrauchbar ist. */
function standSatz(sig: SignalRow): string {
  const ms = Date.parse(sig.at);
  if (!Number.isFinite(ms)) return t('se.systemwerte');
  const uhr = new Date(ms).toLocaleTimeString(sprachWahl() === 'en' ? 'en-US' : 'de-DE', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${t('se.stand')} ${uhr} · ${t('se.systemwerte')}`;
}

/**
 * Die vollständige Erklärung einer Signal-Zeile.
 *
 * `ind` darf null sein — dann stehen die Bausteine ohne Messwert da. Das ist
 * ehrlicher als eine Zahl aus einem anderen Moment: Die Indikator-Werte
 * treffen über einen eigenen Kanal ein und können hinter dem Signal
 * zurückliegen.
 */
export function signalErklaerung(sig: SignalRow, ind: IndicatorRow | null): SignalErklaerung {
  const bausteine = [
    rsiBaustein(sig, ind),
    macdBaustein(sig, ind),
    bollingerBaustein(sig, ind),
    prognoseBaustein(sig),
  ].filter((b): b is ErklaerBaustein => b !== null);
  return {
    kopf: `${sig.direction.toUpperCase()} — ${t('se.soGezaehlt')}`,
    zaehlung: zaehlsatz(sig),
    bausteine,
    fuss: [standSatz(sig), t('se.getrenntGerechnet')],
  };
}
