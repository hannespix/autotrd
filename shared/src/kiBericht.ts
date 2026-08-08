/**
 * autotrd — täglicher KI-Lagebericht (Owner-Go 08.08.: „passende intelligente
 * AI Features — nicht Quantität sondern Qualität").
 *
 * ── Warum GENAU EIN KI-Feature ────────────────────────────────────────────
 *
 * Die KI-Staffel wurde am 28.07. abgeschafft, weil sie täglich Token verbrannt
 * hat, ohne eine Entscheidung zu verändern: eine Erklärung pro Tag, ein
 * Tuner-Review, das nichts tunte. Die Lehre daraus ist nicht „keine KI",
 * sondern: **KI nur dort, wo kein deterministischer Weg dasselbe kann.**
 *
 * Zahlen zu Zahlen verdichten kann Code (`tradingHealth`). Aus Zahlen Thesen
 * mit Status ableiten kann Code (`erkenntnisse`). Was Code NICHT kann, ist die
 * Frage beantworten, die dahinter steht: Welche zwei dieser Befunde hängen
 * zusammen, und was folgt daraus als nächster Schritt? Das ist Urteil über
 * einen Sachverhalt, den man vorher nicht kennt — genau die Aufgabe, für die
 * sich ein Modell lohnt.
 *
 * ── Was das Feature NIE tut ───────────────────────────────────────────────
 *
 * Es fasst NICHT an, was gehandelt wird. Der Bericht ist ein Text neben der
 * Maschine, keine Stimme in ihr: keine Order, keine Parameter-Änderung, keine
 * Beförderung. Ein Modell, das die Engine steuert, wäre eine zweite
 * Entscheidungsquelle ohne Evidenzpflicht — genau das, wogegen der Auto-Tuner
 * mit Signifikanztest und die Struktursuche mit DSR-Latte gebaut sind.
 *
 * ── Kostenrahmen ──────────────────────────────────────────────────────────
 *
 * Ein Aufruf pro Tag, idempotent je Datum, mit Monatsdeckel und hartem
 * Token-Limit. Bei dieser Eingabegröße liegt der Lauf im niedrigen
 * Cent-Bereich; der Monatsdeckel begrenzt den Worst Case auch dann, wenn
 * jemand den manuellen Auslöser in einer Schleife bedient.
 *
 * Dieses Modul ist der PURE Teil: Prompt-Bau und Guards. Beides ohne Netz und
 * ohne Firestore testbar — der Aufrufer macht das IO.
 */

import type { ErkenntnisChronik } from './erkenntnisse.js';

/** Höchstens so viele Läufe je Kalendermonat — der harte Kostendeckel. */
export const KI_MAX_LAEUFE_MONAT = 40;
/** Obergrenze der Antwort (Denken + Text zusammen). */
export const KI_MAX_TOKENS = 4000;

/** Stand des zuletzt geschriebenen Berichts (`meta/aiBericht`). */
export interface KiBerichtDoc {
  /** `bericht` | `kein_schluessel` | `fehler` — was zuletzt passiert ist. */
  stand: string;
  at: string;
  date: string;
  text?: string;
  /** Modell-Kennung — damit später nachvollziehbar ist, wer geschrieben hat. */
  modell?: string;
  /** Verbrauch des letzten Laufs; rein informativ. */
  tokens?: { ein: number; aus: number };
  /** Monatszähler für den Kostendeckel. */
  monat?: string;
  laeufeImMonat?: number;
  fehler?: string;
}

export type KiGrund =
  | 'ok'
  | 'schon_gelaufen'
  | 'monatsdeckel'
  | 'keine_chronik'
  | 'kein_schluessel';

export interface KiEntscheidung {
  laufen: boolean;
  grund: KiGrund;
  /** Zählerstand, mit dem der Lauf gebucht würde (1 = erster im Monat). */
  laufNr: number;
  monat: string;
}

/**
 * Darf heute ein Lauf stattfinden?
 *
 * Vier Nein-Gründe, jeder einzeln testbar. Die Reihenfolge ist Absicht: Der
 * Datums-Check kommt VOR dem Monatsdeckel, damit ein zweiter Aufruf am selben
 * Tag den Zähler nicht anfasst — sonst könnte ein hängender Timer den
 * Monatsdeckel an einem einzigen Tag aufbrauchen.
 */
export function entscheideLauf(
  vorher: KiBerichtDoc | undefined,
  chronikDa: boolean,
  schluesselDa: boolean,
  jetzt: Date,
): KiEntscheidung {
  const date = jetzt.toISOString().slice(0, 10);
  const monat = date.slice(0, 7);
  const gleicherMonat = vorher?.monat === monat;
  const bisher = gleicherMonat ? (vorher?.laeufeImMonat ?? 0) : 0;
  const laufNr = bisher + 1;
  const nein = (grund: KiGrund): KiEntscheidung => ({ laufen: false, grund, laufNr, monat });

  // Idempotenz zuerst: ein zweiter Aufruf am selben Tag ist ein No-Op, kein
  // verbrauchter Lauf. Nur ein ERFOLGREICHER Bericht sperrt den Tag —
  // ein Fehlversuch darf den nächsten Anlauf nicht blockieren.
  if (vorher?.date === date && vorher.stand === 'bericht') return nein('schon_gelaufen');
  if (!schluesselDa) return nein('kein_schluessel');
  if (!chronikDa) return nein('keine_chronik');
  if (laufNr > KI_MAX_LAEUFE_MONAT) return nein('monatsdeckel');
  return { laufen: true, grund: 'ok', laufNr, monat };
}

/** Was der Bericht an Zahlen sieht — bewusst schmal und eigen. */
export interface KiFakten {
  trading?: {
    trades?: number;
    winRatePct?: number | null;
    profitFactor?: number | null;
    feeShare?: number | null;
    verdict?: string;
    klassen?: Record<string, { n?: number; kantePct?: number | null }>;
    exits?: Record<string, { share?: number; winRate?: number; n?: number }>;
  };
  signalSchatten?: Record<string, { n?: number; trefferquote?: number | null; kantePct?: number | null }>;
  konten?: Record<string, number | string>;
  regime?: { state?: string; vix?: number; aboveSma200?: boolean };
}

const pz = (x: number, s = 2): string => x.toFixed(s).replace('.', ',');

/**
 * Die Eingabe für das Modell — deterministisch aus eigenen Messwerten.
 *
 * Bewusst KEIN Fremdtext: keine Schlagzeilen, keine Nutzer-Notizen, nichts aus
 * dem Netz. Alles hier ist selbst gerechnet. Damit ist der Prompt gegen
 * eingeschleuste Anweisungen immun, ohne dass ein Filter nötig wäre — die
 * einzige belastbare Art, diese Klasse von Angriffen auszuschließen.
 */
export function baueEingabe(chronik: ErkenntnisChronik, fakten: KiFakten): string {
  const zeilen: string[] = [];
  zeilen.push(`Stand: ${chronik.date}`);

  zeilen.push('', 'ERKENNTNIS-CHRONIK (deterministisch abgeleitet, mit Belegen):');
  const rang: Record<string, number> = { gilt: 0, gilt_nicht: 1, wartet_auf_daten: 2 };
  for (const [, e] of Object.entries(chronik.eintraege).sort(
    (a, b) => (rang[a[1].status] ?? 9) - (rang[b[1].status] ?? 9) || a[0].localeCompare(b[0]),
  )) {
    const belege = Object.entries(e.beleg ?? {})
      .map(([k, v]) => `${k}=${typeof v === 'number' ? pz(v) : (v ?? '--')}`)
      .join(', ');
    zeilen.push(`- [${e.status}, seit ${e.seitAt.slice(0, 10)}] ${e.these} (${belege})`);
    const letzter = e.historie?.[e.historie.length - 1];
    if (letzter) zeilen.push(`  Wechsel am ${letzter.at.slice(0, 10)}: zuvor „${letzter.these}"`);
  }

  const t = fakten.trading;
  if (t) {
    zeilen.push('', 'HANDELSBILANZ (alle Konten zusammen):');
    zeilen.push(
      `- ${t.trades ?? 0} geschlossene Trades, Trefferquote ${t.winRatePct ?? '--'} %, ` +
        `Profit-Faktor ${t.profitFactor ?? '--'}, Gebührenanteil ${t.feeShare ?? '--'}`,
    );
    for (const [k, v] of Object.entries(t.exits ?? {})) {
      zeilen.push(
        `- Ausstieg ${k}: Anteil ${v.share ?? '--'}, Trefferquote ${v.winRate ?? '--'}, n=${v.n ?? 0}`,
      );
    }
    const klassen = Object.entries(t.klassen ?? {}).sort(
      (a, b) => (a[1].kantePct ?? 0) - (b[1].kantePct ?? 0),
    );
    for (const [k, v] of klassen) {
      zeilen.push(`- Klasse ${k}: n=${v.n ?? 0}, Kante ${v.kantePct ?? '--'} %`);
    }
  }

  const s = fakten.signalSchatten;
  if (s) {
    zeilen.push('', 'SIGNAL-SCHATTEN (Richtungsgüte je Messreihe, roh vs. nach Kosten):');
    for (const [k, v] of Object.entries(s)) {
      zeilen.push(
        `- ${k}: n=${v.n ?? 0}, Trefferquote ${v.trefferquote ?? '--'}, Kante ${v.kantePct ?? '--'} %`,
      );
    }
  }

  if (fakten.regime) {
    zeilen.push(
      '',
      `REGIME: ${fakten.regime.state ?? '?'} (VIX ${fakten.regime.vix ?? '--'}, ` +
        `über SMA200: ${fakten.regime.aboveSma200 === true ? 'ja' : 'nein'})`,
    );
  }
  if (fakten.konten) {
    zeilen.push(
      `KONTEN: ${Object.entries(fakten.konten).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    );
  }
  return zeilen.join('\n');
}

/**
 * Die Rolle des Modells.
 *
 * Knapp gehalten und ohne Nachdruck-Formeln: Das Modell befolgt Anweisungen
 * ohnehin genau, und aufgeblasene Prompts erzeugen aufgeblasene Antworten.
 * Die Längenvorgabe steht explizit drin, weil sie sich sonst nicht einstellt.
 */
export const KI_SYSTEM = [
  'Du bist der Betriebs-Analyst eines automatischen Paper-Trading-Systems und schreibst',
  'den täglichen Lagebericht für den Betreiber. Du bekommst ausschließlich eigene',
  'Messwerte des Systems: eine Chronik geprüfter Thesen mit Status und Belegen sowie die',
  'aggregierten Handelszahlen.',
  '',
  'Deine Aufgabe ist das, was die Zahlen selbst nicht sagen: Welche Befunde hängen',
  'zusammen, was ist die wahrscheinlichste gemeinsame Ursache, und was wäre der nächste',
  'sinnvolle Schritt? Nenne dabei immer die Zahl, auf die du dich stützt.',
  '',
  'Regeln:',
  '- Antworte auf Deutsch, in höchstens 200 Wörtern, als Fließtext ohne Überschriften.',
  '- Beginne mit dem wichtigsten Befund des Tages in einem Satz.',
  '- Unterscheide klar zwischen belegt (Thesen mit Status „gilt") und noch offen',
  '  (Status „wartet_auf_daten"). Erfinde nichts hinzu und rechne nichts hoch.',
  '- Wenn die Datenlage für eine Aussage zu dünn ist, sage genau das.',
  '- Sprich über das System, nicht über einzelne Wertpapiere. Gib keine Anlage-',
  '  empfehlung und nenne keine Kauf- oder Verkaufsziele.',
  '- Schließe mit genau einem konkreten nächsten Schritt für den Betreiber.',
].join('\n');
