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

import { CLASS_LABELS } from './universe.js';
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
/** Höchstens so viele Quellen-Zeilen je Verlust-Klasse — der Prompt bleibt bezahlbar. */
export const QUELLEN_JE_KLASSE = 5;

export interface KiFakten {
  trading?: {
    trades?: number;
    winRatePct?: number | null;
    profitFactor?: number | null;
    feeShare?: number | null;
    verdict?: string;
    klassen?: Record<
      string,
      {
        n?: number;
        kantePct?: number | null;
        /** Je Einstiegsweg (Task 17) — nur Verhältnisse, erst ab der Konten-Schwelle. */
        quellen?: Record<string, { n?: number; konten?: number; kantePct?: number | null; gebuehrPct?: number | null }>;
        /** Anteil der Buchungen mit bekanntem Einstiegsweg (0…100). */
        deckungPct?: number | null;
        /** Dasselbe nur über die letzten 7 Tage (Task 18). */
        deckung7tPct?: number | null;
      }
    >;
    exits?: Record<string, { share?: number; winRate?: number; n?: number }>;
  };
  signalSchatten?: Record<string, { n?: number; trefferquote?: number | null; kantePct?: number | null }>;
  konten?: Record<string, number | string>;
  regime?: { state?: string; vix?: number; aboveSma200?: boolean };
  /** Kante je Regime (Hebel 2, Messung): n und Trefferquote — bewusst kein Geldbetrag (tradeFilter.ts). */
  regimeKante?: Record<string, { n?: number; winRatePct?: number | null }>;
  /** KI-Nachrichten (Stufe 3/4a): gemessene Güte der Urteile — nur Summen aus meta/health.kiBewertung. */
  kiBewertung?: {
    faelleWirksam?: number;
    faelleGesamt?: number;
    quotePct?: number | null;
    nettoAvgPct?: number | null;
    ueberMarktQuotePct?: number | null;
    holdoutQuotePct?: number | null;
    holdoutN?: number;
    faelleWirksamLong?: number;
    gewicht?: number;
  };
  /** Task 19 Teil 2c: Fundamental-Schatten (meta/health.fundamentalSchatten) — Tagesaggregat, kein Tor. */
  fundamentalSchatten?: {
    tag?: string;
    scans?: number;
    usAktien?: number;
    mitProfil?: number;
    gewinnterminMessbar?: number;
    mitVolumen?: number;
    gewinnterminNah?: number;
    illiquide?: number;
    kleinstwert?: number;
    parameter?: { sperrtage?: number; dollarVolMinUsd?: number; marktkapMinMio?: number };
  };
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
    zeilen.push(`- [${e.status}${e.ton ? `, Bedeutung ${e.ton}` : ''}, seit ${e.seitAt.slice(0, 10)}] ${e.these} (${belege})`);
    // Nur Klartext-Wortlaute zitieren — Alt-Sätze aus der Fachsprache-Zeit
    // brächten genau den Jargon in den Prompt, den der Bericht meiden soll.
    const letzter = e.historie?.[e.historie.length - 1];
    if (letzter) {
      zeilen.push(letzter.klar
        ? `  Wechsel am ${letzter.at.slice(0, 10)}: zuvor „${letzter.these}"`
        : `  Wechsel am ${letzter.at.slice(0, 10)} (vorher anders bewertet)`);
    }
  }

  const t = fakten.trading;
  if (t) {
    zeilen.push('', 'HANDELSBILANZ (alle Konten zusammen):');
    zeilen.push(
      `- ${t.trades ?? 0} geschlossene Trades, Trefferquote ${t.winRatePct ?? '--'} %, ` +
        `Profit-Faktor ${t.profitFactor ?? '--'}, Gebührenanteil ${typeof t.feeShare === 'number' ? `${pz(t.feeShare * 100, 0)} %` : '--'}`,
    );
    for (const [k, v] of Object.entries(t.exits ?? {})) {
      zeilen.push(
        `- Ausstieg ${k}: Anteil ${v.share ?? '--'}, Trefferquote ${v.winRate ?? '--'}, n=${v.n ?? 0}`,
      );
    }
    const klassen = Object.entries(t.klassen ?? {}).sort(
      (a, b) => (a[1].kantePct ?? 0) - (b[1].kantePct ?? 0),
    );
    let quellenErklaert = false;
    for (const [k, v] of klassen) {
      zeilen.push(`- Klasse ${k}: n=${v.n ?? 0}, Kante ${v.kantePct ?? '--'} %`);
      // Je Einstiegsweg (Task 17), nur bei VERLUST-Klassen und höchstens
      // QUELLEN_JE_KLASSE Zeilen, schlechteste Kante zuerst, ungemessene
      // Kanten ans Ende: Die Frage ist nicht, OB die Klasse verliert,
      // sondern WELCHER Pfad — ein Kostenhebel am falschen Pfad griffe ins
      // Leere (#544). Vor den Zeilen steht die Deckung: Eine Tabelle, die
      // nur 40 % der Buchungen einem Pfad zuordnet, beantwortet die Frage
      // nicht — und das muss die KI zuerst lesen.
      if (typeof v.kantePct !== 'number' || v.kantePct >= 0) continue;
      const quellen = Object.entries(v.quellen ?? {})
        .filter(([, q]) => (q.n ?? 0) > 0)
        .sort((a, b) => {
          const ka = typeof a[1].kantePct === 'number' ? a[1].kantePct : Number.POSITIVE_INFINITY;
          const kb = typeof b[1].kantePct === 'number' ? b[1].kantePct : Number.POSITIVE_INFINITY;
          return ka - kb;
        })
        .slice(0, QUELLEN_JE_KLASSE);
      if (quellen.length === 0) continue;
      if (!quellenErklaert) {
        zeilen.push(
          '  (Quelle = Einstiegsweg aus dem Steckbrief; ki_probe = nur KI-allein-Einstiege; sync/unbekannt = ohne Steckbrief, ' +
            'nicht zuordenbar. Buchungen = Tranchen der letzten 500 Buchungen je Konto, nur realisiert. ' +
            'Kante/Gebühr je Quelle erst ab der Konten-Schwelle, sonst --.)',
        );
        quellenErklaert = true;
      }
      zeilen.push(
        `  Deckung bekannter Einstiegswege: ${typeof v.deckungPct === 'number' ? pz(v.deckungPct) : '--'} %` +
          ` (letzte 7 Tage: ${typeof v.deckung7tPct === 'number' ? pz(v.deckung7tPct) : '--'} %)`,
      );
      for (const [q, w] of quellen) {
        zeilen.push(
          `  · Quelle ${q}: Buchungen ${w.n ?? 0}, Konten ${w.konten ?? 0}, Kante ${w.kantePct ?? '--'} %, Gebühr ${w.gebuehrPct ?? '--'} %`,
        );
      }
    }
  }

  const s = fakten.signalSchatten;
  if (s) {
    zeilen.push(
      '',
      'SIGNAL-MESSREIHEN (Messungen, KEINE Trades: live = nach wenigen Minuten, live_tag = nach einem Tag, '
        + 'live_halte = nach der tatsächlichen Haltedauer; Kante = Ergebnis je Signal nach Gebühren, wenn man jedem gefolgt wäre):',
    );
    for (const [k, v] of Object.entries(s)) {
      zeilen.push(
        `- ${k}: n=${v.n ?? 0}, Trefferquote ${v.trefferquote ?? '--'}, Kante ${v.kantePct ?? '--'} %`,
      );
    }
  }

  const ki = fakten.kiBewertung;
  if (ki) {
    const z = (v: number | null | undefined): string => (typeof v === 'number' ? pz(v) : '--');
    zeilen.push('', 'KI-NACHRICHTEN (Urteile nach Horizont gegen den Kurs bewertet, netto nach Kosten; Fallanteile, keine Renditen):');
    zeilen.push(
      `- Arm A (steuert das Gewicht): n=${ki.faelleWirksam ?? 0}, Trefferquote ${z(ki.quotePct)} %, ` +
        `Ø netto ${z(ki.nettoAvgPct)} %, Anteil der Fälle über der Symbol-Drift ${z(ki.ueberMarktQuotePct)} %`,
    );
    zeilen.push(
      `- Holdout B (steuert nicht): n=${ki.holdoutN ?? 0}, Trefferquote ${z(ki.holdoutQuotePct)} %; ` +
        `wirksame Long-Urteile gesamt n=${ki.faelleWirksamLong ?? 0}; alle Urteile n=${ki.faelleGesamt ?? 0}; ` +
        `Gewicht der KI-Stimme ×${z(ki.gewicht ?? 1)}`,
    );
  }

  const fs = fakten.fundamentalSchatten;
  // Nur mit echter Deckung (Red-Team H1): Ohne Profil wäre jede Null eine
  // Behauptung über eine Messung, die nicht stattfand.
  if (fs && (fs.mitProfil ?? 0) > 0) {
    const p = fs.parameter ?? {};
    zeilen.push(
      '',
      `FUNDAMENTAL-SCHATTEN (Tagessumme über ${fs.scans ?? 0} US-Scans am ${fs.tag ?? '?'}, blockt nichts — Einstiegs-PRÜFUNGEN je Konto und Scan, ` +
        'die das Kosten-Tor durchließ und die ein Veto getroffen hätte; Prüfungen, keine Einstiege):',
      `- Deckung im letzten US-Scan: ${fs.usAktien ?? 0} US-Aktien, davon ${fs.mitProfil ?? 0} mit Profil, ${fs.gewinnterminMessbar ?? 0} mit künftigem Gewinntermin, ${fs.mitVolumen ?? 0} mit Ø-Volumen`,
      `- Gewinntermin ≤ ${p.sperrtage ?? '?'} Tage: ${fs.gewinnterminNah ?? 0}; Tagesumsatz < ${typeof p.dollarVolMinUsd === 'number' ? Math.round(p.dollarVolMinUsd / 1e6) : '?'} Mio USD: ${fs.illiquide ?? 0}; Marktkap < ${p.marktkapMinMio ?? '?'} Mio USD: ${fs.kleinstwert ?? 0}`,
    );
  }

  const rk = fakten.regimeKante;
  if (rk && Object.keys(rk).length > 0) {
    zeilen.push(
      '',
      'KANTE JE REGIME (realisierte Regelbaum-/Konfluenz-Trades aller Konten, UNTER der Seitwärts-Bremse seit 15.08. gemessen — ' +
        'nur Trefferquote, weil die Bremse die Größe halbiert; ohne_regime = Momentum/Sockel/Hand/Altbestand ohne Bremse):',
    );
    for (const [k, v] of Object.entries(rk)) {
      zeilen.push(`- ${k}: n=${v.n ?? 0}, Trefferquote ${typeof v.winRatePct === 'number' ? pz(v.winRatePct) : '--'} %`);
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
  'Du schreibst den täglichen Lagebericht eines automatischen Trading-Systems für den',
  'Betreiber. Der Betreiber ist KEIN Trader: Schreib so, dass ein kluger Laie ohne',
  'Börsenwissen jeden Satz beim ersten Lesen versteht. Sprich ihn mit „du" an. Du bekommst',
  'ausschließlich eigene Messwerte des Systems: eine Chronik geprüfter Aussagen mit Status,',
  'Bedeutung (gut/problem/hinweis/offen) und Zahlen sowie die zusammengefassten Handelszahlen.',
  '',
  'Deine Aufgabe ist das, was die Zahlen selbst nicht sagen: Welche Befunde hängen',
  'zusammen, was ist die wahrscheinlichste gemeinsame Ursache, und was wäre der nächste',
  'sinnvolle Schritt? Stütze jede Aussage auf eine Zahl, aber runde sie lesbar',
  '(„rund 48 %" statt „48,93 %", „über 60.000 Messungen" statt „n=60293"). Kleine Werte',
  'mit Vorzeichen und einer Nachkommastelle („etwa −0,3 % je Trade"), nie „rund 0 %".',
  '',
  'Zwei Dinge darfst du nie verwechseln:',
  '- TRADES sind echte Käufe mit späterem Verkauf (Handelsbilanz, Klassen). „Kante" heißt',
  '  dort „Gewinn oder Verlust je Trade nach Gebühren, in % des eingesetzten Betrags".',
  '- MESSUNGEN prüfen jedes Kauf- oder Verkaufssignal des Systems, auch ungehandelte, ob der',
  '  Kurs danach in die angezeigte Richtung lief (Signal-Messreihen: live = nach wenigen',
  '  Minuten, live_tag = nach einem Tag, live_halte = nach der tatsächlichen Haltedauer).',
  '  „Kante" heißt dort „Ergebnis je Signal nach Gebühren, wenn man jedem gefolgt wäre".',
  '  Schreib nie „Trades", wenn Messungen gemeint sind.',
  '',
  'Regeln:',
  '- Antworte auf Deutsch, in höchstens 200 Wörtern, als Fließtext ohne Überschriften.',
  '  Kurze Sätze, Alltagswörter, aktive Verben.',
  '- Beginne mit einem Satz, den jeder versteht: Läuft es gerade gut, schlecht, oder ist',
  '  es noch zu früh für ein Urteil — und woran liegt das hauptsächlich? Gut oder schlecht',
  '  bemisst sich am Ergebnis NACH Gebühren, nie am Anteil richtiger Signale.',
  '- Kein Fachjargon. Jedes Wort aus der Eingabe, das ein Laie nicht kennt (z. B. Kante,',
  '  Trefferquote, Profit-Faktor, Regime, VIX, SMA200, Exit, Stop-Loss, Take-Profit, Signal,',
  '  Konfluenz, Schatten, Holdout, Drift, Steckbrief, Long/Short), nur mit Erklärung im selben',
  '  Satz (z. B. „die Verlustbremse (Stop-Loss)") — oder gar nicht.',
  '- Anteile wie 0,42 in der Eingabe bedeuten 42 %. Nenne die Status-Wörter (gilt, gilt_nicht,',
  '  wartet_auf_daten) nicht, sondern ihre Bedeutung.',
  '- Nenne Anlageklassen beim deutschen Namen: ' +
    Object.entries(CLASS_LABELS).map(([k, v]) => `${k} = ${v}`).join(', ') + '.',
  '- Unterscheide klar, was belegt ist und was noch offen ist, weil zu wenige Daten da sind.',
  '  Erfinde nichts hinzu und rechne nichts hoch.',
  '- Wenn die Datenlage für eine Aussage zu dünn ist, sage genau das.',
  '- Sprich über das System, nicht über einzelne Wertpapiere. Gib keine Anlage-',
  '  empfehlung und nenne keine Kauf- oder Verkaufsziele.',
  '- Schließe mit genau einem konkreten nächsten Schritt in einfachen Worten. Erlaubt sind',
  '  nur Dinge, die der Betreiber im Tool selbst tun kann (z. B. den Regler einer Anlageklasse',
  '  in den Einstellungen herunterdrehen) oder ausdrücklich „abwarten, bis mehr Daten da sind".',
  '  Erfinde keine Bedienelemente.',
  '- Die KI kann sich irren: Wenn du unsicher bist, sag es.',
].join('\n');
