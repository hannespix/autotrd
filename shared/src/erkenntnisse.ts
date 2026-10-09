/**
 * autotrd — Erkenntnis-Chronik (Owner-Go 08.08.: „Zweites Gehirn").
 *
 * ── Das Problem, das hier gelöst wird ─────────────────────────────────────
 *
 * Fast alles, was das System über sich selbst lernt, ist FLÜCHTIG:
 * `meta/health` wird alle fünf Minuten überschrieben, das `verdict` des
 * Trading-Aggregats jeden Tag. Der Satz „87 % der Trades enden am Signal"
 * stand wörtlich im Heartbeat — und wäre beim ersten Gegenbeispiel spurlos
 * verschwunden. Es gab keine Chronik dessen, was gilt, seit wann es gilt
 * und wann eine Annahme gekippt ist.
 *
 * ── Was dieses Modul tut ──────────────────────────────────────────────────
 *
 * Ein fester, kleiner Katalog von THESEN (Qualität statt Quantität) wird
 * täglich gegen die ohnehin vorhandenen Messstände geprüft. Jede These hat
 * einen stabilen Schlüssel und genau drei mögliche Zustände:
 *
 *   `gilt`            — die Daten stützen die These (mit Beleg-Zahlen)
 *   `gilt_nicht`      — die Daten widersprechen ihr; war sie vorher `gilt`,
 *                       ist das eine WIDERLEGUNG und landet in der Historie
 *   `wartet_auf_daten`— das Mindest-n ist nicht erreicht; die These wird
 *                       weder behauptet noch verworfen
 *
 * `seitAt` hält fest, seit wann der aktuelle Zustand besteht; die Historie
 * protokolliert jeden Wechsel (gedeckelt — eine Chronik, kein zweites Log).
 * Bewusst DETERMINISTISCH und ohne jede KI: Die Chronik ist die Faktenbasis,
 * auf der ein KI-Bericht später aufsetzen kann — nicht umgekehrt.
 *
 * Gespeichert als EIN Dokument `meta/erkenntnisse` (öffentlich lesbar wie
 * alle `meta/**`-Docs): nur Quoten, Kanten und Zählwerte — keine Beträge,
 * dieselbe Disziplin wie `tradingHealth` (MIN_ACCOUNTS_PUBLIC).
 */

/** Zustand einer These. */
import { CLASS_LABELS } from './universe.js';

export type ErkenntnisStatus = 'gilt' | 'gilt_nicht' | 'wartet_auf_daten';

/**
 * Was der Befund für den Betreiber BEDEUTET (09.10., Owner: „als Laie absolut
 * nicht verständlich"). `status` sagt nur, ob die These zutrifft — ob das gut
 * oder schlecht ist, hängt von der These ab („Gebühren dominieren: gilt" ist
 * schlecht, „Klasse trägt sich: gilt" ist gut). Der Ton nimmt dem Leser diese
 * Übersetzung ab. Er ändert nichts an Status, Chronik oder Logik.
 */
export type ErkenntnisTon = 'gut' | 'problem' | 'hinweis' | 'offen';

/** Fassung der Klartext-Sätze; Einträge ohne sie stammen aus der Fachsprache-Zeit. */
export const ERKENNTNIS_TEXT_V = 2;

/** Ein protokollierter Zustandswechsel — die eigentliche „Chronik". */
export interface ErkenntnisWechsel {
  at: string;
  von: ErkenntnisStatus;
  nach: ErkenntnisStatus;
  /** Der Wortlaut, der bis zu diesem Wechsel galt. */
  these: string;
  /** true = dieser Wortlaut ist schon Klartext (ab ERKENNTNIS_TEXT_V 2). */
  klar?: boolean;
}

export interface ErkenntnisEintrag {
  /** Klartext-Satz mit den aktuellen Zahlen. */
  these: string;
  status: ErkenntnisStatus;
  /** Seit wann der AKTUELLE Status besteht (Statuswechsel setzt neu). */
  seitAt: string;
  /** Letzte Prüfung — auch ohne Statuswechsel fortgeschrieben. */
  zuletztAt: string;
  /** Die Zahlen hinter dem Satz — nachrechenbar, keine Behauptung. */
  beleg: Record<string, number | string | null>;
  historie?: ErkenntnisWechsel[];
  /** Bedeutung für den Betreiber (ab ERKENNTNIS_TEXT_V 2). */
  ton?: ErkenntnisTon;
  /** Fassung des Wortlauts (ERKENNTNIS_TEXT_V). */
  v?: number;
}

export interface ErkenntnisChronik {
  at: string;
  date: string;
  eintraege: Record<string, ErkenntnisEintrag>;
}

/** Höchstens so viele Wechsel je These — Chronik, kein zweites Log-System. */
export const ERKENNTNIS_HISTORIE_MAX = 8;

/* Mindest-n je These: unter diesen Schwellen wird nichts behauptet.
 * Konservativ gewählt — eine Chronik, die bei n=5 urteilt, lehrt Rauschen. */
export const MIN_TRADES_EXITS = 50;
export const MIN_TRADES_KOSTEN = 50;
export const MIN_N_RICHTUNG = 200;
export const MIN_N_TAGESKANTE = 30;
export const MIN_N_KLASSE = 30;
/** Ab diesem Anteil Signal-Exits gilt „Stop und Ziel greifen kaum". */
export const SIGNAL_EXIT_DOMINANZ = 0.75;
/** Ab diesem Gebühren-Anteil am Bruttoergebnis gilt „Reibung dominiert". */
export const KOSTEN_DOMINANZ = 0.5;

/** Was die Ableitung braucht — schmale Sicht auf die vorhandenen Messstände. */
export interface ErkenntnisFakten {
  /** Trading-Aggregat aus `aggregateTradingHealth` (snapshotEquity). */
  trading?: {
    trades: number;
    feeShare: number | null;
    exits: Record<string, { share?: number; winRate?: number; n?: number }>;
    klassen: Record<string, { n?: number; kantePct?: number | null }>;
  };
  /** Signal-Schatten-Aggregate des Scans (`meta/health.signalSchatten`). */
  signalSchatten?: Record<
    string,
    {
      n?: number;
      treffer?: number;
      trefferquote?: number | null;
      rohPct?: number | null;
      kantePct?: number | null;
      /** Mittlerer gemessener Horizont in Minuten (17.08.) — Einheit der Kante. */
      alterMin?: number | null;
    }
  >;
  /** Letzter Struktursuche-Lauf (`meta/health.strukturSuche`). */
  strukturSuche?: { geprueft?: number; befoerdert?: number; date?: string };
}

/** Prozentzahl deutsch formatieren (Komma statt Punkt). */
const pz = (x: number, stellen = 1): string => x.toFixed(stellen).replace('.', ',');
/** Mit Vorzeichen: „+0,38" / „−0,32" — ein Laie liest das Minus sonst leicht über. */
const pzv = (x: number, stellen = 2): string => `${x > 0 ? '+' : x < 0 ? '−' : ''}${pz(Math.abs(x), stellen)}`;
/** Ganze Zahl mit Tausenderpunkt (60293 → „60.293"). */
const tz = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
/** Anlageklasse beim Namen statt beim Schlüssel („crypto" → „Krypto"). */
const klasseName = (k: string): string => CLASS_LABELS[k] ?? k;

interface Befund {
  status: ErkenntnisStatus;
  these: string;
  beleg: Record<string, number | string | null>;
  ton: ErkenntnisTon;
}

/* ── Der Thesen-Katalog ────────────────────────────────────────────────────
 * Feste Reihenfolge = Anzeige-Reihenfolge. Jede Regel ist eine reine
 * Funktion der Fakten; die Schlüssel sind STABIL (sie sind die Identität
 * der These über die Zeit — umbenennen hieße die Chronik abreißen). */

function exitAmSignal(f: ErkenntnisFakten): Befund {
  const t = f.trading;
  const sig = t?.exits?.signal;
  if (!t || t.trades < MIN_TRADES_EXITS || typeof sig?.share !== 'number') {
    return {
      status: 'wartet_auf_daten',
      these: `Wie Trades enden: Bisher sind erst ${tz(t?.trades ?? 0)} Trades abgeschlossen. Eine Aussage gibt es ab ${MIN_TRADES_EXITS} Trades.`,
      beleg: { nTrades: t?.trades ?? 0, minN: MIN_TRADES_EXITS },
      ton: 'offen',
    };
  }
  const anteil = sig.share;
  const beleg = {
    anteilSignalPct: Math.round(anteil * 1000) / 10,
    nTrades: t.trades,
    schwellePct: SIGNAL_EXIT_DOMINANZ * 100,
  };
  if (anteil >= SIGNAL_EXIT_DOMINANZ) {
    return {
      status: 'gilt',
      these: `${pz(anteil * 100, 0)} % der Trades werden verkauft, weil das Kaufsignal kippt. Verlustbremse (Stop-Loss) und Kursziel lösen kaum aus — die Absicherung spielt also fast keine Rolle.`,
      beleg,
      ton: 'hinweis',
    };
  }
  return {
    status: 'gilt_nicht',
    these: `Nur ${pz(anteil * 100, 0)} % der Trades werden verkauft, weil das Kaufsignal kippt. Die übrigen beenden Verlustbremse (Stop-Loss) und Kursziel — die Absicherung arbeitet wie vorgesehen.`,
    beleg,
    ton: 'gut',
  };
}

function kostenDominieren(f: ErkenntnisFakten): Befund {
  const t = f.trading;
  if (!t || t.trades < MIN_TRADES_KOSTEN || t.feeShare === null || t.feeShare === undefined) {
    return {
      status: 'wartet_auf_daten',
      these: `Gebühren: Für eine Aussage braucht es ${MIN_TRADES_KOSTEN} abgeschlossene Trades mit bekannten Kosten, bisher sind es ${tz(t?.trades ?? 0)}.`,
      beleg: { nTrades: t?.trades ?? 0, minN: MIN_TRADES_KOSTEN },
      ton: 'offen',
    };
  }
  const beleg = {
    feeSharePct: Math.round(t.feeShare * 1000) / 10,
    nTrades: t.trades,
    schwellePct: KOSTEN_DOMINANZ * 100,
  };
  if (t.feeShare >= KOSTEN_DOMINANZ) {
    return {
      status: 'gilt',
      these: `Die Gebühren sind zu hoch: Sie verschlingen ${pz(t.feeShare * 100, 0)} % dessen, was die Trades vor Kosten einbringen (Grenze: ${pz(KOSTEN_DOMINANZ * 100, 0)} %). Unterm Strich bleibt so wenig oder nichts übrig.`,
      beleg,
      ton: 'problem',
    };
  }
  return {
    status: 'gilt_nicht',
    these: `Die Gebühren sind im Rahmen: Sie kosten ${pz(t.feeShare * 100, 0)} % dessen, was die Trades vor Kosten einbringen (Grenze: ${pz(KOSTEN_DOMINANZ * 100, 0)} %).`,
    beleg,
    ton: 'gut',
  };
}

function richtungVsKante(f: ErkenntnisFakten): Befund {
  const live = f.signalSchatten?.live;
  const n = live?.n ?? 0;
  if (!live || n < MIN_N_RICHTUNG || typeof live.trefferquote !== 'number') {
    return {
      status: 'wartet_auf_daten',
      these: `Treffen die Signale die Kursrichtung? Bisher erst ${tz(n)} Messungen, verlässlich ab ${tz(MIN_N_RICHTUNG)}.`,
      beleg: { n, minN: MIN_N_RICHTUNG },
      ton: 'offen',
    };
  }
  const tq = live.trefferquote;
  const kante = typeof live.kantePct === 'number' ? live.kantePct : null;
  const beleg = { n, trefferquotePct: Math.round(tq * 1000) / 10, kantePct: kante };
  if (tq > 0.5 && kante !== null && kante < 0) {
    return {
      status: 'gilt',
      these: `Die Signale liegen bei der Kursrichtung öfter richtig als falsch (${pz(tq * 100, 1)} % von ${tz(n)} Messungen), verlieren nach Gebühren aber trotzdem (${pzv(kante)} % je Signal). Das Problem sind die Kosten und die Auswahl der Signale, nicht die Richtung.`,
      beleg,
      ton: 'problem',
    };
  }
  return {
    status: 'gilt_nicht',
    these:
      kante !== null && kante >= 0
        ? `Die Signale verdienen inzwischen mehr, als sie an Gebühren kosten (${pzv(kante)} % je Signal, ${pz(tq * 100, 1)} % lagen richtig, ${tz(n)} Messungen).`
        : `Die Signale treffen die Kursrichtung nicht besser als ein Münzwurf: ${pz(tq * 100, 1)} % lagen richtig (${tz(n)} Messungen).`,
    beleg,
    ton: kante !== null && kante >= 0 ? 'gut' : 'problem',
  };
}

function tagesKante(f: ErkenntnisFakten): Befund {
  const lt = f.signalSchatten?.live_tag;
  const n = lt?.n ?? 0;
  if (!lt || n < MIN_N_TAGESKANTE) {
    const zwischen =
      n > 0 && typeof lt?.kantePct === 'number'
        ? ` Zwischenstand: ${lt.treffer ?? 0} von ${n} lagen richtig, ${pzv(lt.kantePct)} % je Signal nach Gebühren.`
        : '';
    return {
      status: 'wartet_auf_daten',
      these: `Verdienen die Signale über einen ganzen Tag gehalten Geld? Bisher erst ${tz(n)} Messungen, verlässlich ab ${MIN_N_TAGESKANTE}.${zwischen} Diese Messung zeigt am klarsten, ob das System Geld verdienen kann.`,
      beleg: { n, minN: MIN_N_TAGESKANTE, kantePct: lt?.kantePct ?? null },
      ton: 'offen',
    };
  }
  const kante = typeof lt.kantePct === 'number' ? lt.kantePct : null;
  const beleg = { n, kantePct: kante, trefferquote: lt.trefferquote ?? null };
  if (kante !== null && kante > 0) {
    return {
      status: 'gilt',
      these: `Über einen ganzen Tag gehalten, verdienen die Signale mehr als ihre Gebühren (${pzv(kante)} % je Signal, ${tz(n)} Messungen). Ein Tag ist also ein guter Zeitraum zum Halten.`,
      beleg,
      ton: 'gut',
    };
  }
  return {
    status: 'gilt_nicht',
    these: `Auch über einen ganzen Tag gehalten, bleibt nach Gebühren nichts übrig (${pzv(kante ?? 0)} % je Signal, ${tz(n)} Messungen).`,
    beleg,
    ton: 'problem',
  };
}

/**
 * Die Kante über die ECHTE Haltedauer (17.08.) — die Reihe, die über den
 * Rückweg einer abgeschalteten Klasse entscheidet.
 *
 * ── Warum sie eine eigene These bekommt ───────────────────────────────────
 *
 * `tages_kante` darüber misst 24 h für jede Klasse. Live hält Krypto seit dem
 * 15.08. mindestens 48 h, und bis zum 17.08. entschied trotzdem eine
 * Fünf-Minuten-Messung über die Rückkehr. Die Chronik ist das Gedächtnis des
 * Systems; wenn dort nur eine Reihe steht, die NICHT entscheidet, merkt sich
 * das System das Falsche.
 *
 * Der Horizont wird mitgeschrieben, und zwar als Teil der These, nicht als
 * Fußnote: Genau seine Abwesenheit hat den Fehler zwölf Tage überleben
 * lassen.
 */
function halteKante(f: ErkenntnisFakten): Befund {
  const lh = f.signalSchatten?.live_halte;
  const n = lh?.n ?? 0;
  const fenster =
    typeof lh?.alterMin === 'number' && lh.alterMin > 0
      ? `im Schnitt ${pz(lh.alterMin / 60, 1)} Stunden gehalten`
      : 'Haltedauer noch nicht gemessen';
  if (!lh || n < MIN_N_TAGESKANTE) {
    return {
      status: 'wartet_auf_daten',
      these:
        `Verdienen die Signale über ihre echte Haltedauer Geld? Bisher erst ${tz(n)} Messungen, verlässlich ab ${MIN_N_TAGESKANTE} (${fenster}). `
        + 'Nur diese Messung entscheidet, ob eine abgeschaltete Anlageklasse wieder handeln darf.',
      beleg: { n, minN: MIN_N_TAGESKANTE, kantePct: lh?.kantePct ?? null, alterMin: lh?.alterMin ?? null },
      ton: 'offen',
    };
  }
  const kante = typeof lh.kantePct === 'number' ? lh.kantePct : null;
  const beleg = { n, kantePct: kante, rohPct: lh.rohPct ?? null, alterMin: lh.alterMin ?? null };
  if (kante !== null && kante > 0) {
    return {
      status: 'gilt',
      these:
        `Über ihre echte Haltedauer verdienen die Signale mehr als ihre Gebühren (${pzv(kante)} % je Signal, `
        + `${tz(n)} Messungen, ${fenster}). Abgeschaltete Anlageklassen können damit wieder in den Handel zurückkehren.`,
      beleg,
      ton: 'gut',
    };
  }
  return {
    status: 'gilt_nicht',
    these:
      `Auch über ihre echte Haltedauer bleibt nach Gebühren nichts übrig (`
      + `${pzv(kante ?? 0)} % je Signal, ${tz(n)} Messungen, ${fenster}).`,
    beleg,
    ton: 'problem',
  };
}

function klasseVerlustquelle(f: ErkenntnisFakten): Befund {
  const klassen = Object.entries(f.trading?.klassen ?? {}).filter(
    (e): e is [string, { n: number; kantePct: number }] =>
      typeof e[1]?.n === 'number' && e[1].n >= MIN_N_KLASSE && typeof e[1]?.kantePct === 'number',
  );
  if (klassen.length === 0) {
    return {
      status: 'wartet_auf_daten',
      these: `Welche Anlageklasse verliert Geld? Noch hat keine Klasse die nötigen ${MIN_N_KLASSE} Trades für eine Aussage.`,
      beleg: { minN: MIN_N_KLASSE },
      ton: 'offen',
    };
  }
  const [name, k] = klassen.reduce((a, b) => (b[1].kantePct < a[1].kantePct ? b : a));
  const beleg = { klasse: name, kantePct: k.kantePct, n: k.n };
  if (k.kantePct < 0) {
    return {
      status: 'gilt',
      these: `Am meisten Geld verliert die Anlageklasse ${klasseName(name)}: im Schnitt ${pzv(k.kantePct)} % je Trade nach Gebühren (${tz(k.n)} Trades). Eine solche Klasse sollte weniger handeln, statt an Feinheiten zu drehen.`,
      beleg,
      ton: 'problem',
    };
  }
  return {
    status: 'gilt_nicht',
    these: `Keine Anlageklasse mit genug Trades verliert derzeit Geld (schwächste: ${klasseName(name)}, ${pzv(k.kantePct)} % je Trade).`,
    beleg,
    ton: 'gut',
  };
}

function klasseTraegt(f: ErkenntnisFakten): Befund {
  const klassen = Object.entries(f.trading?.klassen ?? {}).filter(
    (e): e is [string, { n: number; kantePct: number }] =>
      typeof e[1]?.n === 'number' && e[1].n >= MIN_N_KLASSE && typeof e[1]?.kantePct === 'number',
  );
  if (klassen.length === 0) {
    return {
      status: 'wartet_auf_daten',
      these: `Welche Anlageklasse verdient Geld? Noch hat keine Klasse die nötigen ${MIN_N_KLASSE} Trades für eine Aussage.`,
      beleg: { minN: MIN_N_KLASSE },
      ton: 'offen',
    };
  }
  const [name, k] = klassen.reduce((a, b) => (b[1].kantePct > a[1].kantePct ? b : a));
  const beleg = { klasse: name, kantePct: k.kantePct, n: k.n };
  if (k.kantePct > 0) {
    return {
      status: 'gilt',
      these: `Mindestens eine Anlageklasse verdient nach Gebühren Geld: ${klasseName(name)} mit im Schnitt ${pzv(k.kantePct)} % je Trade (${tz(k.n)} Trades).`,
      beleg,
      ton: 'gut',
    };
  }
  return {
    status: 'gilt_nicht',
    these: `Noch verdient keine Anlageklasse nach Gebühren Geld (beste: ${klasseName(name)}, ${pzv(k.kantePct)} % je Trade bei ${tz(k.n)} Trades).`,
    beleg,
    ton: 'problem',
  };
}

function struktursucheLatte(f: ErkenntnisFakten): Befund {
  const s = f.strukturSuche;
  if (!s || typeof s.geprueft !== 'number' || s.geprueft <= 0) {
    return {
      status: 'wartet_auf_daten',
      these: 'Die Struktursuche (das System probiert täglich neue Regel-Varianten aus) hat noch keinen Durchlauf gemacht.',
      beleg: {},
      ton: 'offen',
    };
  }
  const beleg = { geprueft: s.geprueft, befoerdert: s.befoerdert ?? 0, datum: s.date ?? null };
  if ((s.befoerdert ?? 0) === 0) {
    return {
      status: 'gilt',
      these: `Die Struktursuche hat zuletzt ${s.geprueft} neue Regel-Varianten getestet; keine war verlässlich besser als die bisherigen Regeln. Die bleiben deshalb — Glückstreffer werden bewusst nicht übernommen.`,
      beleg,
      ton: 'hinweis',
    };
  }
  return {
    status: 'gilt_nicht',
    these: `Die Struktursuche hat bessere Regeln gefunden (${s.befoerdert ?? 0} Variante(n) am ${s.date ?? '?'}). Sie lösen die bisherigen im Testkonto der Struktursuche ab; echtes Geld handeln sie erst, wenn du sie im Studio übernimmst.`,
    beleg,
    ton: 'gut',
  };
}

/** Katalog in Anzeige-Reihenfolge. Schlüssel sind die Identität der These. */
const KATALOG: ReadonlyArray<readonly [string, (f: ErkenntnisFakten) => Befund]> = [
  ['exit_am_signal', exitAmSignal],
  ['kosten_dominieren', kostenDominieren],
  ['richtung_vs_kante', richtungVsKante],
  ['tages_kante', tagesKante],
  ['halte_kante', halteKante],
  ['klasse_verlustquelle', klasseVerlustquelle],
  ['klasse_traegt', klasseTraegt],
  ['struktursuche_latte', struktursucheLatte],
] as const;

/**
 * Chronik fortschreiben — der einzige Einstiegspunkt.
 *
 * Additiv und idempotent: Gleicher Status ⇒ `seitAt` bleibt stehen (nur
 * Wortlaut/Beleg/`zuletztAt` frischen auf); Statuswechsel ⇒ `seitAt` neu und
 * der ALTE Wortlaut wandert in die Historie. Ein Rerun am selben Tag mit
 * denselben Fakten ändert nichts außer `zuletztAt`.
 */
export function schreibeChronik(
  vorher: ErkenntnisChronik | undefined,
  fakten: ErkenntnisFakten,
  at: string,
): ErkenntnisChronik {
  const eintraege: Record<string, ErkenntnisEintrag> = {};
  for (const [key, regel] of KATALOG) {
    const befund = regel(fakten);
    const alt = vorher?.eintraege?.[key];
    if (alt && alt.status === befund.status) {
      eintraege[key] = {
        these: befund.these,
        status: befund.status,
        seitAt: alt.seitAt,
        zuletztAt: at,
        beleg: befund.beleg,
        ton: befund.ton,
        v: ERKENNTNIS_TEXT_V,
        ...(alt.historie && alt.historie.length > 0 ? { historie: alt.historie } : {}),
      };
      continue;
    }
    const historie = [
      ...(alt?.historie ?? []),
      ...(alt ? [{ at, von: alt.status, nach: befund.status, these: alt.these, ...(alt.v === ERKENNTNIS_TEXT_V ? { klar: true } : {}) }] : []),
    ].slice(-ERKENNTNIS_HISTORIE_MAX);
    eintraege[key] = {
      these: befund.these,
      status: befund.status,
      seitAt: at,
      zuletztAt: at,
      beleg: befund.beleg,
      ton: befund.ton,
      v: ERKENNTNIS_TEXT_V,
      ...(historie.length > 0 ? { historie } : {}),
    };
  }
  return { at, date: at.slice(0, 10), eintraege };
}
