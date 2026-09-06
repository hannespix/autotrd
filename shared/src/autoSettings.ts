/**
 * Einstellungen des Auto-Traders je Nutzer (`users/{uid}.settings.auto`).
 *
 * Das ist der EINZIGE nutzerabhängige Teil der Engine-Config: Welche
 * Strategie mit welchen Parametern gehandelt wird, entscheidet der Champion
 * für alle (`meta/champion`); Universum, Zeitrahmen, Kosten und Sitzung
 * stehen global in `meta/engineConfig`. Hier steht nur, was ein Nutzer
 * anders haben darf als der nächste: Risiko-Budget je Trade, Positions-
 * deckel, Positionsanzahl, Tages-Notbremse, Drawdown-Sperre, Shorts, optional
 * eine Teilmenge der Plattform-Symbole und der Telegram-Schalter.
 *
 * Geschrieben wird `settings.auto` AUSSCHLIESSLICH über das Callable
 * `saveStrategy` (geprüft mit `validateAutoSettings`); der Engine-Takt
 * (`functions/src/engine/config.ts`) reicht die Felder als `risk`-Teil in
 * `parseConfig()` durch. Die Grenzen hier sind deshalb DIESELBEN wie im
 * Schema des Kerns (`src/core/config.ts`, `risk`): Der Client soll nichts
 * speichern können, was der Takt beim Lesen ablehnt — ein Nutzer mit
 * ungültiger Config würde dort übersprungen, still und jeden Takt aufs Neue.
 *
 * Pure Funktionen, keine Laufzeit-Abhängigkeiten — Frontend UND Functions
 * importieren von hier.
 *
 * ── Meldungen sind CODES, keine Prosa (Format wie in validate.ts) ─────────
 *
 *   val.objekt|auto                         kein Objekt
 *   val.zahl|<feld>                         fehlt oder keine endliche Zahl
 *   val.bereich|<feld>|<min>|<max>          außerhalb der Hülle (inklusive)
 *   val.ganzzahl|<feld>                     keine ganze Zahl (maxPositions)
 *   val.boolean|<feld>                      kein Wahrheitswert
 *   val.symbole|symbols                     keine Liste gültiger Ticker
 *   val.hoechstens|symbols|<n>              mehr als AUTO_SYMBOLS_MAX Symbole
 *   val.unbekannteSymbole|symbols|<liste>   nicht im übergebenen Universum
 *
 * Parameter enthalten nie ein `|`; der Klartext (DE/EN) entsteht im Frontend
 * (`valText`), die Callable wirft dieselben Codes als HttpsError.
 */

export interface AutoSettings {
  /** Risiko je Trade in % der Equity (Distanz Einstand ↔ Stop × Stück). 0 = keine Einstiege. */
  riskPerTradePct: number;
  /** Maximaler Positionswert in % der Equity. */
  maxPositionPct: number;
  /** Gleichzeitig offene Positionen. */
  maxPositions: number;
  /** Tages-Notbremse: Verlust seit Tagesbeginn in % ⇒ glattstellen, Halt bis zum nächsten Handelstag. 0 = aus. */
  maxDailyLossPct: number;
  /** Drawdown-Sperre: Abstand zum Equity-Hoch in % ⇒ Halt bis `resume`. 0 = aus. */
  maxDrawdownPct: number;
  /** Leerverkäufe erlauben. */
  allowShort: boolean;
  /** Teilmenge des Plattform-Universums (Großschreibung, ohne Duplikate); fehlend = alle Symbole. */
  symbols?: string[];
  /** Telegram-Benachrichtigungen über den Plattform-Bot. */
  notifyTelegram?: boolean;
}

/** Voreinstellungen — identisch mit den Schema-Defaults des Kerns (`risk`). */
export const AUTO_DEFAULTS: Readonly<AutoSettings> = {
  riskPerTradePct: 0.5,
  maxPositionPct: 20,
  maxPositions: 4,
  maxDailyLossPct: 2,
  maxDrawdownPct: 10,
  allowShort: false,
  notifyTelegram: false,
};

export type AutoZahlFeld =
  | 'riskPerTradePct'
  | 'maxPositionPct'
  | 'maxPositions'
  | 'maxDailyLossPct'
  | 'maxDrawdownPct';

/** Reihenfolge = Reihenfolge der Meldungen. */
export const AUTO_ZAHL_FELDER: readonly AutoZahlFeld[] = [
  'riskPerTradePct',
  'maxPositionPct',
  'maxPositions',
  'maxDailyLossPct',
  'maxDrawdownPct',
];

/** Zulässige Bereiche (inklusive) — dieselben wie `pct(max)` im Schema des Takts. */
export const AUTO_GRENZEN: Readonly<Record<AutoZahlFeld, readonly [min: number, max: number]>> = {
  riskPerTradePct: [0, 5],
  maxPositionPct: [0, 100],
  maxPositions: [1, 50],
  maxDailyLossPct: [0, 50],
  maxDrawdownPct: [0, 90],
};

/**
 * Höchstzahl gewählter Symbole. Jedes Symbol kostet im Takt Bars-Abrufe und
 * Entscheidungen; 30 ist mehr, als das eingebaute Universum überhaupt hat.
 */
export const AUTO_SYMBOLS_MAX = 30;

/** Was als Ticker durchgeht: Aktien (`BRK.B`), Krypto (`BTC/USD`), Kürzel mit Bindestrich. Nie `|`, nie Leerzeichen. */
const SYMBOL_MUSTER = /^[A-Z0-9][A-Z0-9./-]{0,23}$/;

export interface AutoSettingsPruefung {
  ok: boolean;
  /** Normalisierter Wert (Symbole groß, ohne Duplikate, leer ⇒ weggelassen) — null bei Fehlern. */
  wert: AutoSettings | null;
  /** Codes `val.<muster>|<feld>|…`; leer ⇒ gültig. */
  fehler: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Symbol-Liste in die gespeicherte Form bringen: trimmen, Großschreibung,
 * Leeres raus, Duplikate raus (erste Nennung gewinnt). Dieselbe Normalisierung
 * läuft über das Universum, damit „aapl" und „AAPL" dasselbe Symbol sind.
 * Die Broker-Schreibweise (BRK-B → BRK.B, btcusd → BTC/USD) ist NICHT Sache
 * dieses Moduls — das macht `normalizeUserSymbol` an der Alpaca-Grenze.
 */
export function normalisiereSymbole(liste: readonly string[]): string[] {
  const out: string[] = [];
  const gesehen = new Set<string>();
  for (const roh of liste) {
    const s = roh.trim().toUpperCase();
    if (s.length === 0 || gesehen.has(s)) continue;
    gesehen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Prüft einen unbekannten Wert gegen das Schema und liefert die
 * normalisierte Form. Alle fünf Zahlen und `allowShort` sind PFLICHT —
 * wer nur ein Feld ändern will, schickt trotzdem das ganze Objekt: Ein
 * halbes Objekt, das der Server mit Voreinstellungen auffüllte, setzte still
 * zurück, was der Nutzer vorher bewusst eingestellt hatte.
 *
 * `symbols`: optional; leere Liste ⇒ weggelassen (= ganzes Universum), weil
 * ein gespeichertes `[]` den Takt für diesen Nutzer mit „kein Symbol des
 * Universums" scheitern ließe. Ist `universe` übergeben, muss jedes Symbol
 * darin vorkommen (Vergleich nach derselben Normalisierung).
 *
 * Unbekannte Schlüssel werden nicht übernommen (der Server schreibt `wert`,
 * nie die Eingabe).
 */
export function validateAutoSettings(a: unknown, universe?: readonly string[]): AutoSettingsPruefung {
  if (!isRecord(a)) return { ok: false, wert: null, fehler: ['val.objekt|auto'] };
  const fehler: string[] = [];
  const zahlen: Partial<Record<AutoZahlFeld, number>> = {};

  for (const feld of AUTO_ZAHL_FELDER) {
    const v = a[feld];
    if (!isFiniteNumber(v)) {
      fehler.push(`val.zahl|${feld}`);
      continue;
    }
    const [min, max] = AUTO_GRENZEN[feld];
    if (v < min || v > max) {
      fehler.push(`val.bereich|${feld}|${min}|${max}`);
      continue;
    }
    if (feld === 'maxPositions' && !Number.isInteger(v)) {
      fehler.push(`val.ganzzahl|${feld}`);
      continue;
    }
    zahlen[feld] = v;
  }

  if (typeof a.allowShort !== 'boolean') fehler.push('val.boolean|allowShort');
  if (a.notifyTelegram !== undefined && typeof a.notifyTelegram !== 'boolean') {
    fehler.push('val.boolean|notifyTelegram');
  }

  let symbols: string[] | undefined;
  if (a.symbols !== undefined) {
    const s = a.symbols;
    if (!Array.isArray(s) || !s.every((x) => typeof x === 'string')) {
      fehler.push('val.symbole|symbols');
    } else {
      const liste = normalisiereSymbole(s as string[]);
      if (!liste.every((x) => SYMBOL_MUSTER.test(x))) {
        fehler.push('val.symbole|symbols');
      } else if (liste.length > AUTO_SYMBOLS_MAX) {
        fehler.push(`val.hoechstens|symbols|${AUTO_SYMBOLS_MAX}`);
      } else {
        if (universe) {
          const bekannt = new Set(normalisiereSymbole(universe));
          const fremd = liste.filter((x) => !bekannt.has(x));
          if (fremd.length > 0) fehler.push(`val.unbekannteSymbole|symbols|${fremd.join(', ')}`);
        }
        if (liste.length > 0) symbols = liste;
      }
    }
  }

  if (fehler.length > 0) return { ok: false, wert: null, fehler };

  const wert: AutoSettings = {
    riskPerTradePct: zahlen.riskPerTradePct as number,
    maxPositionPct: zahlen.maxPositionPct as number,
    maxPositions: zahlen.maxPositions as number,
    maxDailyLossPct: zahlen.maxDailyLossPct as number,
    maxDrawdownPct: zahlen.maxDrawdownPct as number,
    allowShort: a.allowShort as boolean,
    notifyTelegram: a.notifyTelegram === true,
  };
  if (symbols) wert.symbols = symbols;
  return { ok: true, wert, fehler: [] };
}

const num = (v: unknown): number | null => (isFiniteNumber(v) ? v : null);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Risiko-Werte aus dem ALTEN `settings.strategy` ableiten (Übergang, solange
 * ein Konto noch kein `settings.auto` hat). Dieselbe Ableitung liest der
 * Engine-Takt (`functions/src/engine/config.ts`), damit Anzeige und Handel
 * nie auseinanderlaufen.
 *
 * Die Alt-Felder werden in die Hülle des Schemas GEKLEMMT, weil sie aus
 * einer anderen Welt stammen: `riskPerTradePct: 0` hieß dort „Prozent-
 * Tranche statt Risiko-Budget", hier hieße es „kein Budget ⇒ Stückzahl 0" —
 * deshalb fällt 0 auf die Voreinstellung zurück. `dailyLossLimitPct: 0`
 * hieß „aus" und heißt hier dasselbe (der Kern prüft `> 0`). Für die
 * Drawdown-Sperre gab es kein Alt-Feld ⇒ Voreinstellung. Shorts kommen aus
 * `signals.allowShort`, Symbole gibt es nicht (ganzes Universum): Die alte
 * Watchlist meinte Katalog-Symbole eines anderen Datenpfads.
 */
export function autoSettingsFromLegacy(strategy: unknown): AutoSettings {
  const s = isRecord(strategy) ? strategy : {};
  const engine = isRecord(s.engine) ? s.engine : {};
  const signals = isRecord(s.signals) ? s.signals : {};
  const out: AutoSettings = { ...AUTO_DEFAULTS };

  const rpt = num(engine.riskPerTradePct);
  if (rpt !== null && rpt > 0) out.riskPerTradePct = clamp(rpt, 0.01, 5);
  const mpp = num(engine.maxPositionPct);
  if (mpp !== null && mpp > 0) out.maxPositionPct = clamp(mpp, 0.1, 100);
  const mop = num(engine.maxOpenPositions);
  if (mop !== null && mop >= 1) out.maxPositions = clamp(Math.floor(mop), 1, 50);
  const dll = num(engine.dailyLossLimitPct);
  if (dll !== null && dll >= 0) out.maxDailyLossPct = clamp(dll, 0, 50);
  if (typeof signals.allowShort === 'boolean') out.allowShort = signals.allowShort;
  return out;
}
