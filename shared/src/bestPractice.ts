/**
 * MU3 „Bewährte Einstellungen" — kollektives Lernen sichtbar machen.
 *
 * Owner-Idee (06.08.): Die Einstellungen des Kontos mit der besten
 * Performance täglich speichern und jedem User zur MANUELLEN Übernahme
 * anbieten. Die Design-Entscheidungen dazu (MILESTONES, Sektion MU):
 *
 * 1. Den Besten kürt NICHT die Konto-Equity, sondern die ENGINE-Attribution
 *    (nur Trades mit source='engine'). Der Owner hat den Einwand selbst
 *    benannt: Ein Konto kann wegen eines manuellen Glückstreffers vorne
 *    liegen — dann adelt die Equity die falschen Einstellungen.
 *
 * 2. Glücks-Schutz: Ein Kandidat braucht ≥30 Engine-Trades UND ≥14 Tage
 *    Messzeitraum UND eine positive Netto-Kante. Der Tages-Beste unter
 *    einer Handvoll Konten ist sonst überwiegend Varianz, nicht Können.
 *
 * 3. Gespeichert werden engine/signals/indicators — OHNE Watchlist, OHNE
 *    Broker/Kapital (kontextgebunden), OHNE running (ein Snapshot darf
 *    fremde Engines weder starten noch stoppen) und OHNE jede User-Kennung.
 *
 * 4. Übernahme IMMER manuell mit Vorschau-Diff. KEINE Automatik: Wenn alle
 *    Konten auf den Besten springen, stirbt die Vielfalt — und mit ihr das
 *    kollektive Lernen, das aus unterschiedlichen Einstellungen seine
 *    Information zieht.
 */

import type { Strategy } from './strategy.js';

// ── Engine-Bilanz (die Messgröße, die den Besten kürt) ──────────────────────

/** Ein geschlossener Engine-Trade — das Minimum für Kante und Zeitraum. */
export interface EngineTrade {
  /** Ergebnis NACH Gebühren. */
  pnl: number;
  /** ISO-Zeitpunkt des Schließens. */
  at: string;
  /** Positionswert beim Schließen (Stück × Preis). */
  notional?: number;
  /** Gebührensatz je Seite — steht am Trade, weil er sich ändern kann. */
  feeRate?: number;
}

export interface EngineBilanz {
  /** Geschlossene Engine-Trades. */
  n: number;
  /** Netto-P&L über alle Engine-Trades. */
  pnl: number;
  /** Geschätzte Gebühren (beide Seiten) — nur aus vollständigen Trades. */
  fees: number;
  /** Summiertes Handelsvolumen — Nenner der Kante. */
  notional: number;
  /**
   * Netto-Rendite je gehandeltem Dollar in Prozent. Dieselbe Größe wie in
   * `attribution()`: die eine Zahl, die sagt, ob die Einstellungen ihre
   * eigene Reibung verdienen. `null` ohne Volumen-Angaben.
   */
  kantePct: number | null;
  /** Spanne vom ältesten zum jüngsten Engine-Trade in Tagen. */
  zeitraumTage: number;
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Bilanz der Engine-Trades eines Kontos — pure Aggregation, kein Firestore. */
export function engineBilanz(trades: EngineTrade[]): EngineBilanz {
  let pnl = 0;
  let fees = 0;
  let notional = 0;
  let aeltester = Number.POSITIVE_INFINITY;
  let juengster = Number.NEGATIVE_INFINITY;
  let n = 0;
  for (const t of trades) {
    if (typeof t.pnl !== 'number' || !Number.isFinite(t.pnl)) continue;
    n += 1;
    pnl += t.pnl;
    const ms = Date.parse(t.at);
    if (Number.isFinite(ms)) {
      aeltester = Math.min(aeltester, ms);
      juengster = Math.max(juengster, ms);
    }
    // Volumen und Gebühren nur bei vollständigen Angaben — ein Trade ohne
    // Satz würde den Nenner verfälschen und die Kante zu gut aussehen lassen.
    if (typeof t.notional === 'number' && t.notional > 0 && typeof t.feeRate === 'number') {
      notional += t.notional;
      fees += t.notional * t.feeRate * 2;
    }
  }
  const zeitraumTage =
    Number.isFinite(aeltester) && Number.isFinite(juengster) && juengster >= aeltester
      ? r2((juengster - aeltester) / 86_400_000)
      : 0;
  return {
    n,
    pnl: r2(pnl),
    fees: r2(fees),
    notional: r2(notional),
    kantePct: notional > 0 ? Math.round((pnl / notional) * 1_000_000) / 10_000 : null,
    zeitraumTage,
  };
}

// ── Glücks-Schutz (die Schwellen, die Varianz von Können trennen) ───────────

export const BEWAEHRT_MIN_TRADES = 30;
export const BEWAEHRT_MIN_TAGE = 14;

export interface KandidatUrteil {
  geeignet: boolean;
  /** Klartext, was (noch) fehlt — leer, wenn geeignet. */
  fehlt: string[];
}

/**
 * Erfüllt diese Bilanz die Mindestbelege? Die Gründe sind Klartext, weil
 * die Karte im Frontend sie wörtlich anzeigt: „Was fehlt noch?" ist die
 * ehrliche Antwort, solange kein Konto die Schwellen reißt.
 */
export function pruefeKandidat(b: EngineBilanz): KandidatUrteil {
  const fehlt: string[] = [];
  if (b.n < BEWAEHRT_MIN_TRADES) {
    fehlt.push(`${b.n}/${BEWAEHRT_MIN_TRADES} Engine-Trades`);
  }
  if (b.zeitraumTage < BEWAEHRT_MIN_TAGE) {
    fehlt.push(`${Math.floor(b.zeitraumTage)}/${BEWAEHRT_MIN_TAGE} Tage Messzeitraum`);
  }
  if (b.kantePct === null) {
    fehlt.push('Kante nicht messbar (Volumen-Angaben fehlen)');
  } else if (b.kantePct <= 0) {
    fehlt.push(`Kante ${b.kantePct} % — positiv muss sie sein`);
  }
  return { geeignet: fehlt.length === 0, fehlt };
}

/**
 * Ordnung unter Bilanzen: höhere Netto-Kante gewinnt, bei Gleichstand die
 * breitere Datenbasis (mehr Trades). Verglichen wird die KANTE und nicht der
 * P&L-Betrag, weil die Konten verschieden groß sind — ein großes Konto
 * würde sonst mit mittelmäßigen Einstellungen jeden Vergleich gewinnen.
 */
export function besserAls(a: EngineBilanz, b: EngineBilanz | null | undefined): boolean {
  if (!b) return true;
  const ka = a.kantePct ?? Number.NEGATIVE_INFINITY;
  const kb = b.kantePct ?? Number.NEGATIVE_INFINITY;
  if (ka !== kb) return ka > kb;
  return a.n > b.n;
}

// ── Snapshot-Inhalt (was nach meta/bestPractice wandert) ────────────────────

/** Anonymisierter Einstellungs-Auszug: engine/signals/indicators, sonst nichts. */
export interface BewaehrteEinstellungen {
  engine: Record<string, unknown>;
  signals: Record<string, unknown>;
  indicators: Record<string, unknown>;
}

/**
 * Aus einer (unvalidierten) Strategie den Snapshot-Auszug ziehen.
 *
 * `running` wird entfernt: Der Snapshot beschreibt, WIE der Beste handelt —
 * nicht, OB gerade jemand den Schalter umgelegt hat. Watchlist und Broker
 * bleiben komplett draußen (kontextgebunden bzw. Kapital). Fehlt einer der
 * drei Blöcke, gibt es keinen halben Snapshot, sondern `null` — halbe
 * Einstellungen sähen aus wie ganze.
 */
export function extrahiereEinstellungen(strategy: unknown): BewaehrteEinstellungen | null {
  if (!strategy || typeof strategy !== 'object') return null;
  const s = strategy as Record<string, unknown>;
  const engine = s['engine'];
  const signals = s['signals'];
  const indicators = s['indicators'];
  if (!engine || typeof engine !== 'object') return null;
  if (!signals || typeof signals !== 'object') return null;
  if (!indicators || typeof indicators !== 'object') return null;
  const { running: _running, ...engineOhneRunning } = engine as Record<string, unknown>;
  return {
    engine: engineOhneRunning,
    signals: { ...(signals as Record<string, unknown>) },
    indicators: { ...(indicators as Record<string, unknown>) },
  };
}

// ── Übernahme (Frontend-Seite: Diff + Merge, beides pur und testbar) ────────

export interface EinstellungsDiff {
  /** Punkt-Pfad, z. B. 'engine.stopLossPct' oder 'indicators.rsi.window'. */
  pfad: string;
  /** Eigener Wert (undefined = Feld fehlt bei mir). */
  eigen: unknown;
  /** Wert des Besten (undefined = Feld fehlt dort). */
  bewaehrt: unknown;
}

function istPlainObjekt(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sammleDiff(
  pfad: string,
  eigen: unknown,
  bewaehrt: unknown,
  raus: EinstellungsDiff[],
): void {
  if (istPlainObjekt(eigen) && istPlainObjekt(bewaehrt)) {
    const keys = new Set([...Object.keys(eigen), ...Object.keys(bewaehrt)]);
    for (const k of [...keys].sort()) {
      sammleDiff(pfad ? `${pfad}.${k}` : k, eigen[k], bewaehrt[k], raus);
    }
    return;
  }
  // Primitive (und der Objekt-gegen-Primitiv-Fall): nur echte Unterschiede.
  if (JSON.stringify(eigen) !== JSON.stringify(bewaehrt)) {
    raus.push({ pfad, eigen, bewaehrt });
  }
}

/**
 * Feld-für-Feld-Unterschiede zwischen den eigenen Einstellungen und dem
 * Snapshot — die Vorschau VOR der Übernahme. `engine.running` taucht nie
 * auf (im Snapshot entfernt, beim eigenen Auszug hier ebenfalls gestrichen).
 */
export function vergleicheEinstellungen(
  eigene: unknown,
  bewaehrt: BewaehrteEinstellungen,
): EinstellungsDiff[] {
  const eigenAuszug = extrahiereEinstellungen(eigene);
  const raus: EinstellungsDiff[] = [];
  sammleDiff('engine', eigenAuszug?.engine ?? {}, bewaehrt.engine, raus);
  sammleDiff('signals', eigenAuszug?.signals ?? {}, bewaehrt.signals, raus);
  sammleDiff('indicators', eigenAuszug?.indicators ?? {}, bewaehrt.indicators, raus);
  return raus;
}

/**
 * Die Übernahme selbst: engine/signals/indicators werden ERSETZT (nicht
 * gemischt — sonst überleben eigene Altwerte, die der Beste gar nicht hat),
 * `running` bleibt der eigene Schalter, Watchlist und Broker bleiben
 * unangetastet.
 *
 * Zu den Casts: Der Snapshot kommt aus Firestore und ist strukturell
 * ungetypt. Das Ergebnis läuft IMMER durch `validateStrategy` und das
 * `saveStrategy`-Callable — also durch dieselbe Server-Validierung wie jede
 * Handeingabe; ein kaputter Snapshot wird dort abgelehnt statt gespeichert.
 */
export function uebernehmeEinstellungen(
  eigene: Strategy,
  bewaehrt: BewaehrteEinstellungen,
): Strategy {
  return {
    ...eigene,
    engine: {
      ...(bewaehrt.engine as unknown as Strategy['engine']),
      running: eigene.engine.running,
    },
    signals: { ...(bewaehrt.signals as unknown as Strategy['signals']) },
    indicators: { ...(bewaehrt.indicators as unknown as Strategy['indicators']) },
  };
}
