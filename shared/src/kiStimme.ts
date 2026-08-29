/**
 * autotrd — tägliche KI-Stimme (Slice 1, Owner-Go 25.08.).
 *
 * ── Wie das mit der bestehenden Prognose-Stimme zusammenhängt ─────────────
 *
 * Es gibt bereits eine gewichtete Richtungsstimme in der Konfluenz
 * (`accuracyWeightedVote`, `forecast.ts`): Sie bekommt erst dann Gewicht,
 * wenn sie einen echten, gemessenen Track-Record hat — vorher zählt sie
 * null. Genau dieses Prinzip gilt hier von Anfang an, nur strenger: Diese
 * KI-Stimme hat AKTUELL GAR KEINE Wirkung auf einen einzigen Trade. Sie wird
 * ausschließlich geloggt und soll später — nach genau demselben
 * Beweislast-Mechanismus wie die Prognose — an echten, künftigen Kursen
 * bewertet werden (eigener Auswertungs-Lauf, noch zu bauen, nach demselben
 * Lookahead-Gate-Muster wie `evalForecasts.ts`).
 *
 * ── Warum das kein Rückfall in die abgeschaffte „KI-Staffel" ist ──────────
 *
 * Die KI-Staffel wurde am 28.07. abgeschafft, weil sie täglich Token
 * verbrannt hat, ohne eine Entscheidung zu verändern (Begründung in
 * `kiBericht.ts`). Diese Stimme verändert ebenfalls NICHTS — bewusst, noch
 * nicht. Der Unterschied zum Bericht: Sie erzeugt eine PRÜFBARE Behauptung
 * (Richtung + Konfidenz je Symbol, vor dem Ergebnis), keine Prosa. Das
 * macht sie zu einer Kandidatin für den Beweislast-Mechanismus — dem
 * Bericht fehlt dafür die Struktur.
 *
 * ── Eingebaute Gegenstimme (Owner-Wunsch 25.08.) ───────────────────────────
 *
 * Jede Stimme trägt eine eigene Selbstkritik: Was würde die Einschätzung
 * widerlegen, und wie ändert sich die Konfidenz, wenn man das ernst nimmt?
 * Das ist (noch) keine unabhängige zweite Instanz — dieselbe Anfrage
 * erzeugt beides in einem Aufruf, aus Kostengründen. Eine wirklich
 * unabhängige zweite Prüfung ist der naheliegende nächste Ausbauschritt,
 * sobald diese erste Stufe ihren eigenen Nutzen gezeigt hat.
 *
 * ── Eingabe: bewusst schmal, kein Fremdtext ────────────────────────────────
 *
 * Wie beim Lagebericht: ausschließlich selbst berechnete Zahlen (Momentum-
 * Rangliste, Regime). Keine Schlagzeilen, keine Nutzer-Notizen — der Prompt
 * ist damit gegen eingeschleuste Anweisungen immun, ohne Filter.
 *
 * ── Kostenrahmen ───────────────────────────────────────────────────────────
 *
 * Ein Aufruf pro Tag, idempotent je Datum, mit Monatsdeckel und hartem
 * Token-Limit — dasselbe Muster wie beim Lagebericht, dieselben Zahlen.
 *
 * Dieses Modul ist der PURE Teil: Prompt-Bau, Guards, Antwort-Parsing. Alles
 * ohne Netz und ohne Firestore testbar — der Aufrufer macht das IO.
 */

import type { SignalDirection } from './strategy.js';

/** Höchstens so viele Läufe je Kalendermonat — der harte Kostendeckel. */
export const KI_STIMME_MAX_LAEUFE_MONAT = 40;
/** Obergrenze der Antwort (Denken + Text zusammen). */
export const KI_STIMME_MAX_TOKENS = 4000;

/** Eine einzelne Stimme zu einem Symbol, inklusive eingebauter Gegenstimme. */
export interface KiStimmeVote {
  symbol: string;
  richtung: SignalDirection;
  /** 0..1 — die ursprüngliche Einschätzung, vor der Selbstkritik. */
  konfidenz: number;
  /** Ein Satz: worauf die Einschätzung sich stützt. */
  begruendung: string;
  /** Die eingebaute Gegenstimme: was würde diese Einschätzung widerlegen? */
  gegenstimme: string;
  /** 0..1 — die Konfidenz, NACHDEM die Gegenstimme berücksichtigt wurde. */
  konfidenzNachKritik: number;
}

/** Stand des zuletzt geschriebenen Laufs (`meta/aiVoteShadow`). */
export interface KiStimmeDoc {
  /** `stimmen` | `kein_schluessel` | `keine_daten` | `fehler` — was zuletzt passiert ist. */
  stand: string;
  at: string;
  date: string;
  votes?: KiStimmeVote[];
  modell?: string;
  tokens?: { ein: number; aus: number };
  monat?: string;
  laeufeImMonat?: number;
  fehler?: string;
}

export type KiStimmeGrund =
  | 'ok'
  | 'schon_gelaufen'
  | 'monatsdeckel'
  | 'keine_daten'
  | 'kein_schluessel';

export interface KiStimmeEntscheidung {
  laufen: boolean;
  grund: KiStimmeGrund;
  /** Zählerstand, mit dem der Lauf gebucht würde (1 = erster im Monat). */
  laufNr: number;
  monat: string;
}

/**
 * Darf heute ein Lauf stattfinden? Identisches Muster zu `entscheideLauf`
 * (`kiBericht.ts`) — dieselbe Reihenfolge aus demselben Grund: Der
 * Datums-Check kommt VOR dem Monatsdeckel, damit ein zweiter Aufruf am
 * selben Tag den Zähler nicht anfasst.
 */
export function entscheideKiStimmeLauf(
  vorher: KiStimmeDoc | undefined,
  datenDa: boolean,
  schluesselDa: boolean,
  jetzt: Date,
): KiStimmeEntscheidung {
  const date = jetzt.toISOString().slice(0, 10);
  const monat = date.slice(0, 7);
  const gleicherMonat = vorher?.monat === monat;
  const bisher = gleicherMonat ? (vorher?.laeufeImMonat ?? 0) : 0;
  const laufNr = bisher + 1;
  const nein = (grund: KiStimmeGrund): KiStimmeEntscheidung => ({ laufen: false, grund, laufNr, monat });

  if (vorher?.date === date && vorher.stand === 'stimmen') return nein('schon_gelaufen');
  if (!schluesselDa) return nein('kein_schluessel');
  if (!datenDa) return nein('keine_daten');
  if (laufNr > KI_STIMME_MAX_LAEUFE_MONAT) return nein('monatsdeckel');
  return { laufen: true, grund: 'ok', laufNr, monat };
}

/** Was die Stimme an Zahlen sieht — bewusst schmal und eigen. */
export interface KiStimmeFakten {
  /** Die Momentum-Rangliste des Tages (`meta/momentum.top`) — bereits berechnet. */
  top: ReadonlyArray<{ symbol: string; score: number }>;
  regime?: { state?: string; vix?: number; aboveSma200?: boolean };
}

const pz = (x: number, s = 2): string => x.toFixed(s).replace('.', ',');

/**
 * Die Eingabe für das Modell — deterministisch aus eigenen Messwerten.
 *
 * Bewusst KEIN Fremdtext (s. Modul-Kopf).
 */
export function baueKiStimmeEingabe(fakten: KiStimmeFakten): string {
  const zeilen: string[] = [];
  zeilen.push('MOMENTUM-RANGLISTE (12-1-Score, eigene Berechnung, absteigend):');
  for (const t of fakten.top) {
    zeilen.push(`- ${t.symbol}: Score ${pz(t.score, 4)}`);
  }
  if (fakten.regime) {
    zeilen.push(
      '',
      `REGIME: ${fakten.regime.state ?? '?'} (VIX ${fakten.regime.vix ?? '--'}, ` +
        `über SMA200: ${fakten.regime.aboveSma200 === true ? 'ja' : 'nein'})`,
    );
  }
  return zeilen.join('\n');
}

/**
 * Die Rolle des Modells.
 *
 * Verlangt striktes JSON, nichts drumherum — der Aufrufer parst die
 * Antwort ohne Markdown-Toleranz (`parseKiStimmeAntwort`), damit ein
 * stillschweigend abweichendes Format nicht unbemerkt Stimmen verliert.
 */
export const KI_STIMME_SYSTEM = [
  'Du bist eine von mehreren Messreihen in einem automatischen',
  'Paper-Trading-System. Du gibst KEINE Anlageempfehlung an einen Menschen —',
  'deine Antwort wird ausschließlich maschinell geloggt und später an den',
  'tatsächlichen Kursverläufen gemessen, bevor sie irgendeine Wirkung',
  'bekommt. Du bekommst ausschließlich eigene Messwerte des Systems: eine',
  'Momentum-Rangliste (12-1-Score) und den Marktregime-Zustand.',
  '',
  'Für JEDES gelistete Symbol gibst du ab: eine Richtung (`buy`, `sell`,',
  'oder `hold`), eine Konfidenz zwischen 0 und 1, eine BEGRÜNDUNG in einem',
  'Satz, eine GEGENSTIMME in einem Satz (das stärkste Argument GEGEN deine',
  'eigene Einschätzung — was müsste zutreffen, damit du falsch liegst?),',
  'und eine zweite Konfidenz zwischen 0 und 1, NACHDEM du die Gegenstimme',
  'ernst genommen hast. Diese zweite Zahl darf von der ersten abweichen —',
  'wenn die Gegenstimme trägt, MUSS sie niedriger sein.',
  '',
  'Regeln:',
  '- Wenn die Datenlage für eine Richtung zu dünn ist, wähle `hold` mit',
  '  niedriger Konfidenz statt zu raten.',
  '- Erfinde keine Zahlen und keine Ereignisse hinzu, die dir nicht',
  '  gegeben wurden.',
  '- Antworte AUSSCHLIESSLICH mit einem JSON-Array, ein Objekt je Symbol,',
  '  in genau dieser Form, ohne Erklärtext davor oder danach und ohne',
  '  Markdown-Codeblock:',
  '  [{"symbol":"AAPL","richtung":"buy","konfidenz":0.6,',
  '    "begruendung":"...","gegenstimme":"...","konfidenzNachKritik":0.45}]',
].join('\n');

/**
 * Die Antwort des Modells parsen — streng, kein Rateversuch.
 *
 * `null` heißt: unauswertbar (kein JSON, falsche Form, unbekanntes Symbol,
 * Konfidenz außerhalb [0,1]). Der Aufrufer behandelt das wie einen
 * regulären Fehlerfall (`stand: 'fehler'`), NIE wie eine teilweise
 * verwertbare Antwort — eine stillschweigend geflickte Stimme wäre beim
 * späteren Auswerten nicht mehr von einer echten zu unterscheiden.
 */
export function parseKiStimmeAntwort(
  text: string,
  erwarteteSymbole: readonly string[],
): KiStimmeVote[] | null {
  let roh: unknown;
  try {
    roh = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(roh) || roh.length === 0) return null;

  const erlaubt = new Set(erwarteteSymbole);
  const gesehen = new Set<string>();
  const votes: KiStimmeVote[] = [];
  const istKonfidenz = (x: unknown): x is number =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
  const istRichtung = (x: unknown): x is SignalDirection =>
    x === 'buy' || x === 'sell' || x === 'hold';

  for (const eintrag of roh) {
    if (typeof eintrag !== 'object' || eintrag === null) return null;
    const e = eintrag as Record<string, unknown>;
    if (typeof e['symbol'] !== 'string' || !erlaubt.has(e['symbol'])) return null;
    if (gesehen.has(e['symbol'])) return null; // Doppelnennung ist ebenfalls unauswertbar
    if (!istRichtung(e['richtung'])) return null;
    if (!istKonfidenz(e['konfidenz'])) return null;
    if (!istKonfidenz(e['konfidenzNachKritik'])) return null;
    if (typeof e['begruendung'] !== 'string' || e['begruendung'].length === 0) return null;
    if (typeof e['gegenstimme'] !== 'string' || e['gegenstimme'].length === 0) return null;
    gesehen.add(e['symbol']);
    votes.push({
      symbol: e['symbol'],
      richtung: e['richtung'],
      konfidenz: e['konfidenz'],
      begruendung: e['begruendung'],
      gegenstimme: e['gegenstimme'],
      konfidenzNachKritik: e['konfidenzNachKritik'],
    });
  }
  return votes;
}
