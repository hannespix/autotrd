/**
 * Einfangquote je Anlageklasse — gemessen statt geschätzt.
 *
 * ── Warum es das gibt ─────────────────────────────────────────────────────
 *
 * `costGate` entscheidet über jeden Einstieg mit der Frage: „Erwartete
 * Bewegung × Einfangquote — trägt das die Kosten?" Die Einfangquote stand
 * bisher als Konstantentabelle in `costGate.ts`, geschätzt aus EINER
 * Messwoche (04.08.). Der Quelltext dort sagt das selbst und benennt auch
 * den Ausweg:
 *
 *   „Der Wert ist eine ANNAHME über die Signalgüte, keine gemessene
 *    Konstante. Sobald genug Trades je Klasse vorliegen, gehört er aus der
 *    laufenden Attribution nachgeführt statt hier gepflegt."
 *
 * Inzwischen liegen sie vor — und die Annahme ist da am weitesten daneben,
 * wo sie am meisten kostet. `etf_thematic` bekam mit 0,5 den höchsten Wert
 * der Tabelle, weil es in jener Woche +0,81 % Kante zeigte. Am 11.08. steht
 * dieselbe Klasse bei −0,74 % Kante über 64 Trades und −1 812 $ — der größte
 * Einzelverlust im Buch. Die optimistischste Annahme sitzt auf dem größten
 * Verlustbringer.
 *
 * ── Was hier gemessen wird ────────────────────────────────────────────────
 *
 * Die Definition der Quote ist ein Bruch, und der Signal-Schatten liefert
 * beide Seiten:
 *
 *   Einfangquote = eingefangene Bewegung / erwartete Bewegung
 *                = rohBeiErwartetPct / erwartetPct
 *
 * Zähler: Wie weit sich der Kurs in Signalrichtung tatsächlich bewegt hat
 * (vor Kosten — es geht um die Güte der Richtungsaussage, nicht um die
 * Gebührenordnung). Nenner: Wie weit er sich laut ATR bewegen konnte.
 *
 * Beide Summen stammen aus GENAU DERSELBEN Signalmenge (siehe
 * `summeRohBeiErwartet` in classShadow.ts). Ein Bruch aus verschieden
 * erhobenen Summen wäre eine Zahl, die zufällig entsteht — und an ihr hängt,
 * wie viel Kapital eine Anlageklasse bekommt.
 *
 * ── Warum sie nur senken darf, nie anheben ────────────────────────────────
 *
 * `costGate.ts` begründet die Asymmetrie schon für die Schätzung, und für
 * die Messung gilt sie unverändert:
 *
 *   „Eine zu klein geschätzte Einfangquote lässt einen guten Trade aus
 *    (Kosten: entgangener Gewinn), eine zu große lässt einen schlechten zu
 *    (Kosten: echtes Geld). Die beiden sind nicht gleich teuer."
 *
 * Dazu kommt ein zweiter Grund, der speziell für gemessene Werte gilt: Eine
 * Klasse, die gerade eine gute Phase hat, würde sich selbst mehr Kapital
 * freigeben — genau dann, wenn die Rückkehr zum Mittel bevorsteht. Das ist
 * die Mechanik, die aus einer Glückssträhne einen Klumpen macht. Nach unten
 * gibt es diese Rückkopplung nicht: Wer drosselt, riskiert entgangenen
 * Gewinn, nicht wachsende Verluste.
 *
 * ── Warum eine abgeschaltete Klasse weitermisst ───────────────────────────
 *
 * Der Schatten läuft unabhängig von der Ausführung (das ist sein Zweck).
 * Eine auf 0 gedrosselte Klasse sammelt also weiter Signale und kann sich
 * zurückverdienen. Ohne das wäre die Drosselung endgültig — dieselbe
 * Zirkularität wie beim Live-Reife-Gate und bei der Kostenschwelle selbst.
 */

import { captureForClass } from './costGate.js';
import type { SchattenAuswertung } from './classShadow.js';

/**
 * Wie viele Signale eine gemessene Quote tragen muss.
 *
 * Dieselbe Schwelle wie `SCHATTEN_MIN_N` und aus demselben Grund: Ein Signal
 * je Scan und Symbol ist ein schwacher Datenpunkt. Sie wird hier bewusst
 * wiederholt statt importiert — die Zahl gehört zur Frage „reicht das für
 * eine KAPITALENTSCHEIDUNG", und die darf sich unabhängig von der Frage
 * „reicht das für eine Anzeige" bewegen.
 */
export const QUOTE_MIN_N = 200;

/**
 * Wie weit die gemessene Quote die Annahme höchstens unterschreiten darf.
 *
 * Nicht 0. Der Grund ist keine Vorsicht gegenüber der Messung, sondern
 * gegenüber ihrer Wirkung: Eine Quote von exakt 0 lässt `costGate` jeden
 * Einstieg der Klasse ablehnen, in jedem Marktzustand, unbefristet. Die
 * Signalquelle bekäme nie wieder eine Gelegenheit, sich in AUSGEFÜHRTEN
 * Trades zu bewähren — nur noch im Schatten, wo Stop, Ziel und Haltedauer
 * fehlen.
 *
 * 0,02 heißt praktisch: Nur noch Instrumente mit sehr großer erwarteter
 * Bewegung im Verhältnis zu ihren Kosten kommen durch. Das ist scharf genug,
 * um die Reibungsverluste zu beenden, und lässt die Tür einen Spalt offen.
 */
export const QUOTE_UNTERGRENZE = 0.02;

export interface EinfangquoteBefund {
  /** Die Quote, mit der `costGate` rechnen soll. */
  quote: number;
  /** Woher sie stammt — für den Heartbeat und die Erklärung im UI. */
  herkunft: 'gemessen' | 'annahme' | 'annahme_zu_wenig_daten';
  /** Die reine Messung, auch wenn sie verworfen wurde (null ohne Evidenz). */
  gemessen: number | null;
  /** Die Konstante aus `costGate.ts`. */
  annahme: number;
  /** Wie viele Signale die Messung trägt. */
  n: number;
}

/**
 * Die gemessene Einfangquote einer Klasse — `null`, wenn sie nicht belegt ist.
 *
 * Negative Werte werden auf 0 gekappt, nicht durchgereicht: Eine
 * Signalquelle, die im Mittel in die FALSCHE Richtung zeigt, hat keine
 * negative Einfangquote — sie hat keine. Ein negativer Faktor in `costGate`
 * würde die Vergleichsrichtung umdrehen und aus dem schlechtesten Signal das
 * am leichtesten durchkommende machen.
 */
export function gemesseneEinfangquote(
  auswertung: Pick<SchattenAuswertung, 'nErwartet' | 'erwartetPct' | 'rohBeiErwartetPct'> | undefined,
  minN = QUOTE_MIN_N,
): number | null {
  if (!auswertung) return null;
  const { nErwartet, erwartetPct, rohBeiErwartetPct } = auswertung;
  if (!(nErwartet >= minN)) return null;
  if (typeof erwartetPct !== 'number' || !(erwartetPct > 0)) return null;
  if (typeof rohBeiErwartetPct !== 'number' || !Number.isFinite(rohBeiErwartetPct)) return null;
  const quote = rohBeiErwartetPct / erwartetPct;
  if (!Number.isFinite(quote)) return null;
  return Math.max(0, Math.round(quote * 10_000) / 10_000);
}

/**
 * Die Quote, mit der gerechnet wird: Messung wenn belegt und SCHLECHTER als
 * die Annahme, sonst die Annahme.
 *
 * Die Klemmung nach oben ist der eigentliche Inhalt dieser Funktion — siehe
 * die Begründung im Dateikopf. Eine Messung, die besser aussieht als die
 * Annahme, wird bewusst nicht übernommen; sie erscheint aber als `gemessen`
 * im Befund, damit man ihr beim Nachjustieren der Konstanten ansieht, dass
 * sie da war.
 */
export function wirksameEinfangquote(
  assetClass: string | undefined,
  auswertung?: Pick<SchattenAuswertung, 'nErwartet' | 'erwartetPct' | 'rohBeiErwartetPct'>,
  minN = QUOTE_MIN_N,
): EinfangquoteBefund {
  const annahme = captureForClass(assetClass);
  const gemessen = gemesseneEinfangquote(auswertung, minN);
  const n = auswertung?.nErwartet ?? 0;
  if (gemessen === null) {
    return {
      quote: annahme,
      herkunft: n > 0 ? 'annahme_zu_wenig_daten' : 'annahme',
      gemessen: null,
      annahme,
      n,
    };
  }
  if (gemessen >= annahme) {
    // Messung besser als Annahme ⇒ Annahme behalten. Bewusst kein Anheben.
    return { quote: annahme, herkunft: 'annahme', gemessen, annahme, n };
  }
  return {
    quote: Math.max(QUOTE_UNTERGRENZE, gemessen),
    herkunft: 'gemessen',
    gemessen,
    annahme,
    n,
  };
}

/** Kurzform für Aufrufer, die nur die Zahl brauchen. */
export function einfangquote(
  assetClass: string | undefined,
  auswertung?: Pick<SchattenAuswertung, 'nErwartet' | 'erwartetPct' | 'rohBeiErwartetPct'>,
  minN = QUOTE_MIN_N,
): number {
  return wirksameEinfangquote(assetClass, auswertung, minN).quote;
}
