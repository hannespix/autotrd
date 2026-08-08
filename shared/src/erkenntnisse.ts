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
export type ErkenntnisStatus = 'gilt' | 'gilt_nicht' | 'wartet_auf_daten';

/** Ein protokollierter Zustandswechsel — die eigentliche „Chronik". */
export interface ErkenntnisWechsel {
  at: string;
  von: ErkenntnisStatus;
  nach: ErkenntnisStatus;
  /** Der Wortlaut, der bis zu diesem Wechsel galt. */
  these: string;
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
    }
  >;
  /** Letzter Struktursuche-Lauf (`meta/health.strukturSuche`). */
  strukturSuche?: { geprueft?: number; befoerdert?: number; date?: string };
}

/** Prozentzahl deutsch formatieren (Komma statt Punkt). */
const pz = (x: number, stellen = 1): string => x.toFixed(stellen).replace('.', ',');

interface Befund {
  status: ErkenntnisStatus;
  these: string;
  beleg: Record<string, number | string | null>;
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
      these: `Exit-Verhalten: erst ${t?.trades ?? 0} geschlossene Trades — ein Urteil über Stop und Ziel gibt es ab n=${MIN_TRADES_EXITS}.`,
      beleg: { nTrades: t?.trades ?? 0, minN: MIN_TRADES_EXITS },
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
      these: `${pz(anteil * 100, 0)} % der Trades enden am Signal — Stop und Ziel greifen kaum; die Exit-Entscheidung liegt fast allein beim Einstiegssignal.`,
      beleg,
    };
  }
  return {
    status: 'gilt_nicht',
    these: `Nur noch ${pz(anteil * 100, 0)} % der Trades enden am Signal — Stop und Ziel tragen inzwischen einen relevanten Teil der Exits.`,
    beleg,
  };
}

function kostenDominieren(f: ErkenntnisFakten): Befund {
  const t = f.trading;
  if (!t || t.trades < MIN_TRADES_KOSTEN || t.feeShare === null || t.feeShare === undefined) {
    return {
      status: 'wartet_auf_daten',
      these: `Kostenlast: noch keine belastbare Basis (n=${t?.trades ?? 0}, Urteil ab ${MIN_TRADES_KOSTEN} Trades mit Kostenprofil).`,
      beleg: { nTrades: t?.trades ?? 0, minN: MIN_TRADES_KOSTEN },
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
      these: `Die Reibung dominiert: Gebühren entsprechen ${pz(t.feeShare * 100, 0)} % des Bruttoergebnisses — unter dieser Last kann netto kein Gewinn entstehen.`,
      beleg,
    };
  }
  return {
    status: 'gilt_nicht',
    these: `Die Kostenlast ist unter Kontrolle: Gebühren entsprechen ${pz(t.feeShare * 100, 0)} % des Bruttoergebnisses.`,
    beleg,
  };
}

function richtungVsKante(f: ErkenntnisFakten): Befund {
  const live = f.signalSchatten?.live;
  const n = live?.n ?? 0;
  if (!live || n < MIN_N_RICHTUNG || typeof live.trefferquote !== 'number') {
    return {
      status: 'wartet_auf_daten',
      these: `Richtungsgüte der Live-Signale: erst n=${n} — belastbar ab n=${MIN_N_RICHTUNG}.`,
      beleg: { n, minN: MIN_N_RICHTUNG },
    };
  }
  const tq = live.trefferquote;
  const kante = typeof live.kantePct === 'number' ? live.kantePct : null;
  const beleg = { n, trefferquotePct: Math.round(tq * 1000) / 10, kantePct: kante };
  if (tq > 0.5 && kante !== null && kante < 0) {
    return {
      status: 'gilt',
      these: `Die Signale treffen die Richtung öfter als der Zufall (${pz(tq * 100, 1)} % bei n=${n}), verlieren aber nach Kosten (${pz(kante, 2)} % je Signal) — das Problem sind Kosten und Signal-Auswahl, nicht die Richtungslogik.`,
      beleg,
    };
  }
  return {
    status: 'gilt_nicht',
    these:
      kante !== null && kante >= 0
        ? `Die Live-Signale tragen ihre Kosten inzwischen selbst (Kante ${pz(kante, 2)} % bei n=${n}, Trefferquote ${pz(tq * 100, 1)} %).`
        : `Die Richtungsgüte ist auf Zufallsniveau gefallen (${pz(tq * 100, 1)} % bei n=${n}).`,
    beleg,
  };
}

function tagesKante(f: ErkenntnisFakten): Befund {
  const lt = f.signalSchatten?.live_tag;
  const n = lt?.n ?? 0;
  if (!lt || n < MIN_N_TAGESKANTE) {
    const zwischen =
      n > 0 && typeof lt?.kantePct === 'number'
        ? ` — Zwischenstand: ${lt.treffer ?? 0}/${n} Richtungstreffer, Kante ${pz(lt.kantePct, 2)} %`
        : '';
    return {
      status: 'wartet_auf_daten',
      these: `Tages-Kante der Live-Signale: erst n=${n}, belastbar ab n=${MIN_N_TAGESKANTE}${zwischen}. Das ist DIE Messreihe für Task „System profitabel machen".`,
      beleg: { n, minN: MIN_N_TAGESKANTE, kantePct: lt?.kantePct ?? null },
    };
  }
  const kante = typeof lt.kantePct === 'number' ? lt.kantePct : null;
  const beleg = { n, kantePct: kante, trefferquote: lt.trefferquote ?? null };
  if (kante !== null && kante > 0) {
    return {
      status: 'gilt',
      these: `Auf Tagesbasis tragen die Signale ihre Kosten (Kante +${pz(kante, 2)} % bei n=${n}) — der Tages-Horizont ist der richtige Betriebspunkt.`,
      beleg,
    };
  }
  return {
    status: 'gilt_nicht',
    these: `Auch auf Tagesbasis bleibt nach Kosten nichts übrig (Kante ${pz(kante ?? 0, 2)} % bei n=${n}).`,
    beleg,
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
      these: `Klassen-Bilanz: noch keine Anlageklasse mit n≥${MIN_N_KLASSE} Trades.`,
      beleg: { minN: MIN_N_KLASSE },
    };
  }
  const [name, k] = klassen.reduce((a, b) => (b[1].kantePct < a[1].kantePct ? b : a));
  const beleg = { klasse: name, kantePct: k.kantePct, n: k.n };
  if (k.kantePct < 0) {
    return {
      status: 'gilt',
      these: `Größte Verlustquelle ist die Klasse ${name} (Kante ${pz(k.kantePct, 2)} % über ${k.n} Trades) — eine Klasse mit negativer Kante gehört gedrosselt, nicht feinjustiert.`,
      beleg,
    };
  }
  return {
    status: 'gilt_nicht',
    these: `Keine Anlageklasse mit n≥${MIN_N_KLASSE} handelt aktuell negativ (schwächste: ${name}, ${pz(k.kantePct, 2)} %).`,
    beleg,
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
      these: `Positiv-Nachweis je Klasse: noch keine Anlageklasse mit n≥${MIN_N_KLASSE} Trades.`,
      beleg: { minN: MIN_N_KLASSE },
    };
  }
  const [name, k] = klassen.reduce((a, b) => (b[1].kantePct > a[1].kantePct ? b : a));
  const beleg = { klasse: name, kantePct: k.kantePct, n: k.n };
  if (k.kantePct > 0) {
    return {
      status: 'gilt',
      these: `Mindestens eine Anlageklasse trägt sich nach Kosten: ${name} (Kante +${pz(k.kantePct, 2)} % bei n=${k.n}).`,
      beleg,
    };
  }
  return {
    status: 'gilt_nicht',
    these: `Noch trägt sich keine Anlageklasse nach Kosten (beste: ${name}, ${pz(k.kantePct, 2)} % bei n=${k.n}).`,
    beleg,
  };
}

function struktursucheLatte(f: ErkenntnisFakten): Befund {
  const s = f.strukturSuche;
  if (!s || typeof s.geprueft !== 'number' || s.geprueft <= 0) {
    return {
      status: 'wartet_auf_daten',
      these: 'Die Struktursuche hat noch keinen Prüf-Lauf absolviert.',
      beleg: {},
    };
  }
  const beleg = { geprueft: s.geprueft, befoerdert: s.befoerdert ?? 0, datum: s.date ?? null };
  if ((s.befoerdert ?? 0) === 0) {
    return {
      status: 'gilt',
      these: `Die Struktursuche hat den amtierenden Bauplan zuletzt nicht schlagen können (${s.geprueft} geprüft, 0 befördert) — die Anti-Zufalls-Latte hält.`,
      beleg,
    };
  }
  return {
    status: 'gilt_nicht',
    these: `Die Struktursuche hat einen besseren Bauplan gefunden (${s.befoerdert ?? 0} Beförderung(en) am ${s.date ?? '?'}) — der Amtierende wurde abgelöst.`,
    beleg,
  };
}

/** Katalog in Anzeige-Reihenfolge. Schlüssel sind die Identität der These. */
const KATALOG: ReadonlyArray<readonly [string, (f: ErkenntnisFakten) => Befund]> = [
  ['exit_am_signal', exitAmSignal],
  ['kosten_dominieren', kostenDominieren],
  ['richtung_vs_kante', richtungVsKante],
  ['tages_kante', tagesKante],
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
        ...(alt.historie && alt.historie.length > 0 ? { historie: alt.historie } : {}),
      };
      continue;
    }
    const historie = [
      ...(alt?.historie ?? []),
      ...(alt ? [{ at, von: alt.status, nach: befund.status, these: alt.these }] : []),
    ].slice(-ERKENNTNIS_HISTORIE_MAX);
    eintraege[key] = {
      these: befund.these,
      status: befund.status,
      seitAt: at,
      zuletztAt: at,
      beleg: befund.beleg,
      ...(historie.length > 0 ? { historie } : {}),
    };
  }
  return { at, date: at.slice(0, 10), eintraege };
}
