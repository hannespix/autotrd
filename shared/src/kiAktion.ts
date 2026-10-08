/**
 * KI-Kaskade Stufe 2b (05.10.): aus KI-Urteilen werden Handlungen — mit
 * FESTEN Regeln. Die KI hat nur geurteilt (Stufe 2a, `kiUrteile`); was
 * daraus folgt, entscheidet dieses Modul, pur und prüfbar.
 *
 * ── Die Regeln (Owner-Entscheidung 05.10., Empfehlung angenommen) ─────────
 *
 *   Positiv, eindeutig, gegengeprüft, nicht eingepreist, frisch (≤ 2 h),
 *   Kurs seither < 1,5 ATR gelaufen
 *       → Kaufstimme mit vollem Konfluenz-Gewicht (reicht allein), aber in
 *         PROBEGRÖSSE: Ein Einstieg, der nur wegen der KI zustande kommt,
 *         handelt halb so groß und nie mit Hebel. Je Urteil, Konto und
 *         Symbol genau EINE Handlung. Stufe 3 skaliert später 0,25×–2× nach
 *         gemessener Wirkung — bis dahin ist die Hälfte die ehrliche Wette.
 *   Negativ, eindeutig, gegengeprüft
 *       → sperrt neue Long-Einstiege (richtungsbewusstes Veto);
 *       → gehaltene Long-Position: belegt „nicht eingepreist" und gemessen
 *         < 1,5 ATR gefallen → VERKAUFEN; sonst Stop auf 0,5 ATR nachziehen,
 *         statt am womöglich schon erreichten Tief zu verkaufen.
 *   Unklar (Gegenprobe lief, hat nicht bestätigt, Stärke ≥ 0,6)
 *       → nur Stop nachziehen, mit 1 ATR Abstand. Eine bloße Sichtung ohne
 *         Gegenprobe löst nichts aus.
 *   Spiegelbildlich für Shorts. (Schärfungen nach Red-Team 06.10.)
 *
 * ── Was hier nie passiert ─────────────────────────────────────────────────
 *
 *   - Kein Ausstieg wird ERSCHWERT: Die KI kann Ausstiege nur auslösen oder
 *     den Stop in Schutzrichtung verschieben, nie lockern.
 *   - Keine Schutzregel wird umgangen: Einstiege laufen weiter durch alle
 *     Tore des Scans (Kosten, Regime, Cluster, PDT, Abgleich …). Nur das
 *     BLINDE Lexikon-Veto weicht, wenn die gegengeprüfte KI ausdrücklich in
 *     Handelsrichtung urteilt — das Lexikon kennt keine Richtung, die KI
 *     schon.
 *   - Kein Lookahead: Entscheidungen nutzen nur Urteile, deren `decidedAt`
 *     vor dem Scan liegt, und den Kurs beim ersten Sehen als Bezug.
 */

import type { SignalDirection } from './strategy.js';

/** So lange wirkt ein Urteil (ab dem ersten Sehen der Meldung). Danach ist die Nachricht alt. */
export const KI_GUELTIG_STUNDEN = 6;
/**
 * So lange darf ein Urteil einen EINSTIEG tragen (ab dem ersten Sehen). Eine
 * Nachricht wirkt in den ersten Stunden; wer sechs Stunden später auf sie
 * kauft, läuft dem Kurs hinterher (Red-Team 06.10., H3). Veto und Positions-
 * Schutz gelten weiter die vollen KI_GUELTIG_STUNDEN.
 */
export const KI_EINSTIEG_MAX_MIN = 120;
/**
 * Ein KI-Urteil hebt das blinde Lexikon-Veto nur auf, wenn seine Meldung
 * zeitlich zum harten Ereignis passt — sonst urteilt die KI über ein ANDERES
 * Ereignis (Red-Team 06.10., H2: 10 Uhr Upgrade positiv, 13 Uhr Gewinn-
 * warnung im Yahoo-Feed — das Veto darf dann nicht fallen).
 */
export const KI_GLEICHES_EREIGNIS_MIN = 60;
/** Größe eines Einstiegs, der NUR wegen der KI zustande kommt. */
export const KI_PROBE_FAKTOR = 0.5;
/** Ab so vielen ATR Bewegung seit dem ersten Sehen gilt die Nachricht als eingepreist. */
export const KI_EINGEPREIST_ATR = 1.5;
/** Abstand des nachgezogenen Stops in ATR (gegengeprüftes Urteil). */
export const KI_STOP_ATR = 0.5;
/** Abstand bei einem UNKLAREN Urteil — weiter, weil ungesichert (Red-Team M5). */
export const KI_UNKLAR_STOP_ATR = 1;
/** Ab dieser Stärke zieht ein unklares (geprüft, nicht bestätigtes) Urteil den Stop nach. */
export const KI_UNKLAR_MIN_STAERKE = 0.6;

export interface KiSignal {
  newsId: string;
  symbol: string;
  richtung: 'positiv' | 'negativ' | 'neutral';
  handlungsfaehig: boolean;
  staerke: number;
  eingepreist: 'nein' | 'teilweise' | 'ja' | 'unklar' | null;
  decidedAt: string;
  /** Erstes Sehen der Meldung (Alters-Bezug; fehlt es, gilt decidedAt). */
  firstSeenAt: string;
  /** Veröffentlichung laut Anbieter (Abgleich mit dem harten Ereignis). */
  publishedAt: string | null;
  /** Lief die skeptische Gegenprobe (stufe 'pruefung')? */
  geprueft: boolean;
  /** Kurs beim ersten Sehen der Meldung (Bezug für „schon gelaufen?"). */
  kursGesehen: number | null;
}

const zahl = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Rang eines Urteils bei der Auswahl je Symbol. Zwei Lehren aus dem
 * Red-Team vom 06.10.:
 *   N2 — Eine jüngere UNGEPRÜFTE Sichtung verdrängt kein gegengeprüftes
 *        Urteil (sonst löschte eine belanglose Meldung ein KI-Veto).
 *   R1 — Unter den GEPRÜFTEN gewinnt das jüngste, bestätigt oder nicht.
 *        Die erste Fassung bevorzugte „bestätigt" über alles und hielt so
 *        ein älteres positives Urteil fest, während eine neuere, geprüfte
 *        Gegen-Meldung den Stop hätte nachziehen müssen — und kaufte
 *        sogar dagegen. Neuere geprüfte Evidenz löst ältere ab, auch eine
 *        geprüft NEUTRALE.
 */
function rang(s: KiSignal): number {
  if (s.geprueft) return 2;
  return s.richtung === 'neutral' ? 0 : 1;
}

/**
 * Aus rohen `kiUrteile`-Dokumenten je Symbol das maßgebliche gültige Urteil —
 * pur. Gültig heißt: `decidedAt` vor `jetztMs` (kein Blick in die Zukunft)
 * und die Meldung nicht älter als `KI_GUELTIG_STUNDEN` ab dem ersten Sehen.
 * Maßgeblich ist das Urteil mit dem höchsten Rang (bestätigt > geprüft >
 * gesichtet > neutral), bei gleichem Rang das jüngste; Gleichstand wird
 * deterministisch aufgelöst (Stärke, dann newsId), nicht über die
 * Abfrage-Reihenfolge.
 */
export function kiSignaleAus(urteile: readonly unknown[], jetztMs: number): Map<string, KiSignal> {
  const out = new Map<string, KiSignal>();
  for (const roh of urteile) {
    const u = (roh ?? {}) as Record<string, unknown>;
    const symbol = typeof u['symbol'] === 'string' ? u['symbol'] : '';
    const richtung = u['richtung'];
    const decided = Date.parse(String(u['decidedAt'] ?? ''));
    if (!symbol || !Number.isFinite(decided)) continue;
    if (richtung !== 'positiv' && richtung !== 'negativ' && richtung !== 'neutral') continue;
    const gesehenRoh = Date.parse(String(u['firstSeenAt'] ?? ''));
    const gesehenMs = Number.isFinite(gesehenRoh) ? Math.min(gesehenRoh, decided) : decided;
    if (decided > jetztMs || jetztMs - gesehenMs > KI_GUELTIG_STUNDEN * 3_600_000) continue;
    const pruefung = (u['pruefung'] ?? {}) as Record<string, unknown>;
    const gesehen = ((pruefung['kurskontext'] ?? {}) as Record<string, unknown>)['gesehen'] as Record<string, unknown> | null | undefined;
    const ein = u['eingepreist'];
    const pub = Date.parse(String(u['publishedAt'] ?? ''));
    const p = zahl(gesehen?.['p']);
    const kandidat: KiSignal = {
      newsId: String(u['newsId'] ?? ''),
      symbol,
      richtung,
      handlungsfaehig: u['handlungsfaehig'] === true,
      staerke: zahl(u['staerke']) ?? 0,
      eingepreist: ein === 'nein' || ein === 'teilweise' || ein === 'ja' || ein === 'unklar' ? ein : null,
      decidedAt: new Date(decided).toISOString(),
      firstSeenAt: new Date(gesehenMs).toISOString(),
      publishedAt: Number.isFinite(pub) ? new Date(pub).toISOString() : null,
      geprueft: u['stufe'] === 'pruefung',
      kursGesehen: p !== null && p > 0 ? p : null,
    };
    const bisher = out.get(symbol);
    if (bisher) {
      const d = rang(kandidat) - rang(bisher)
        || Date.parse(kandidat.decidedAt) - Date.parse(bisher.decidedAt)
        || kandidat.staerke - bisher.staerke
        || (kandidat.newsId > bisher.newsId ? 1 : kandidat.newsId < bisher.newsId ? -1 : 0);
      if (d <= 0) continue;
    }
    out.set(symbol, kandidat);
  }
  return out;
}

/** Wie weit ist der Kurs seit dem ersten Sehen IN Nachrichten-Richtung gelaufen (in %, gegen die Richtung negativ)? */
function gelaufenPct(s: KiSignal, preis: number): number | null {
  if (s.kursGesehen === null || !(preis > 0) || s.richtung === 'neutral') return null;
  const d = ((preis - s.kursGesehen) / s.kursGesehen) * 100;
  return s.richtung === 'positiv' ? d : -d;
}

const atrOk = (atrPct: number | null | undefined): number | null =>
  typeof atrPct === 'number' && Number.isFinite(atrPct) && atrPct > 0 ? atrPct : null;

/** Trägt das Urteil eine Handlung — gegengeprüft und nicht schon eingepreist? */
function traegt(s: KiSignal | undefined): s is KiSignal {
  return !!s && s.handlungsfaehig && s.richtung !== 'neutral' && s.eingepreist !== 'ja';
}

/** Vermerk der letzten KI-Handlung je Konto und Symbol (`users/{uid}.kiGenutzt.<symbol>`). */
export interface KiGenutzt {
  newsId: string;
  at: string;
}

/**
 * Hat die KI auf diesem Konto für dieses Symbol kürzlich gehandelt? Ja, wenn
 * es dieselbe Meldung war (egal wann) oder die letzte KI-Handlung keine
 * KI_GUELTIG_STUNDEN zurückliegt. Unlesbare Vermerke zählen als „genutzt" —
 * im Zweifel keine zweite Handlung.
 */
export function kiKuerzlichGenutzt(g: unknown, newsId: string, jetztMs: number): boolean {
  if (g === null || g === undefined) return false;
  const v = g as Partial<KiGenutzt>;
  if (v.newsId === newsId) return true;
  const at = Date.parse(String(v.at ?? ''));
  if (!Number.isFinite(at)) return true;
  return jetztMs - at < KI_GUELTIG_STUNDEN * 3_600_000;
}

/**
 * Einstiegsstimme der KI — nur OHNE offene Position (Ausstiege laufen über
 * `kiPositionsAktion`). Gewicht = die geforderte Konfluenz: Die KI kann
 * allein einen Einstieg tragen, der dann aber in Probegröße handelt
 * (`kiGroessenFaktor`).
 *
 * Nach dem Red-Team vom 06.10. (H3) nur, wenn ALLES davon stimmt:
 *   - die Meldung ist frisch (≤ KI_EINSTIEG_MAX_MIN seit dem ersten Sehen),
 *   - der Kurs beim Sehen UND die ATR sind bekannt — sonst lässt sich nicht
 *     prüfen, ob man dem Kurs schon hinterherläuft,
 *   - der Kurs ist seither noch keine KI_EINGEPREIST_ATR in Nachrichten-
 *     richtung gelaufen,
 *   - die KI hat auf diesem Konto für dieses Symbol in den letzten
 *     KI_GUELTIG_STUNDEN noch NICHT gehandelt (`genutzt`). Ein Ereignis,
 *     eine Handlung — sonst stiege dieselbe Meldung nach jedem Stop wieder
 *     ein. Je Symbol und Zeit statt je newsId (Red-Team R3): Folgeartikel
 *     („Why XYZ is soaring") tragen eine neue newsId, aber dasselbe Ereignis.
 */
export function kiStimme(
  s: KiSignal | undefined,
  requiredConfluence: number,
  hatPosition: boolean,
  preis: number,
  atrPct: number | null | undefined,
  jetztMs: number,
  genutzt?: KiGenutzt | null,
  gewicht = 1,
): { dir: 'buy' | 'sell'; weight: number } | null {
  if (hatPosition || !traegt(s)) return null;
  if (kiKuerzlichGenutzt(genutzt, s.newsId, jetztMs)) return null;
  if (jetztMs - Date.parse(s.firstSeenAt) > KI_EINSTIEG_MAX_MIN * 60_000) return null;
  const atr = atrOk(atrPct);
  const gelaufen = gelaufenPct(s, preis);
  // BEIDSEITIG (Red-Team R2): Ist der Kurs seither 1,5 ATR GEGEN die
  // Meldung gelaufen, widerspricht der Markt — kein Griff ins fallende Messer.
  if (atr === null || gelaufen === null || Math.abs(gelaufen) >= KI_EINGEPREIST_ATR * atr) return null;
  const weight = kiStimmGewicht(requiredConfluence, gewicht);
  if (weight === 0) return null;
  return { dir: s.richtung === 'positiv' ? 'buy' : 'sell', weight };
}

/**
 * Stimmgewicht aus geforderter Konfluenz und gemessenem Faktor (Stufe 3):
 * Faktor 1 = die volle Konfluenz (die KI kann allein tragen, wie in 2b);
 * darunter anteilig abgerundet — bei 0,5 braucht sie einen Indikator dazu,
 * bei 0,25 schweigt sie ganz (0). Über 1 bleibt es bei der Konfluenz: Mehr
 * Stimmen als gefordert würden technische GEGENstimmen überrollen, und das
 * ist nicht „mehr Vertrauen", sondern ein anderes Regelwerk.
 */
export function kiStimmGewicht(requiredConfluence: number, gewicht: number): number {
  const voll = Math.max(1, Math.ceil(requiredConfluence));
  const f = Number.isFinite(gewicht) && gewicht > 0 ? gewicht : 1;
  return Math.min(voll, Math.floor(voll * f));
}

/** Indikator-Stimmen (ohne Prognose) in Richtung `dir`. */
function indikatorenDafuer(votes: Readonly<Record<string, string | undefined>> | null | undefined, dir: 'buy' | 'sell'): number {
  return Object.entries(votes ?? {}).filter(([k, v]) => k !== 'forecast' && v === dir).length;
}

/**
 * Lexikon-Rückfall (Owner 05.10.): Ist das KI-Budget des Tages erschöpft,
 * zählt das Lexikon-Sentiment mit HALBEM Gewicht der KI-Stimme — nie allein
 * genug für einen Einstieg, nie Grund für einen Ausstieg, und es hebt kein
 * Veto auf. Nur, wenn für das Symbol kein gültiges KI-Urteil vorliegt.
 *
 * Und nur, wenn mindestens ein INDIKATOR in dieselbe Richtung zeigt
 * (Red-Team M2): Die Prognose-Stimme ist auf minConfluence−1 gedeckelt —
 * Prognose plus Lexikon ergäbe sonst einen Einstieg ganz ohne Technik.
 */
export function lexikonStimme(
  sentSign: -1 | 0 | 1 | null | undefined,
  requiredConfluence: number,
  hatPosition: boolean,
  kiSignal: KiSignal | undefined,
  budgetErschoepft: boolean,
  votes: Readonly<Record<string, string | undefined>> | null | undefined,
): { dir: 'buy' | 'sell'; weight: number } | null {
  if (!budgetErschoepft || hatPosition || kiSignal || !sentSign) return null;
  const halb = Math.floor(Math.max(1, Math.ceil(requiredConfluence)) / 2);
  if (halb < 1) return null;
  const dir = sentSign > 0 ? 'buy' : 'sell';
  if (indikatorenDafuer(votes, dir) < 1) return null;
  return { dir, weight: Math.min(halb, Math.max(1, Math.ceil(requiredConfluence)) - 1) };
}

/**
 * Konfluenz mit mehreren Zusatzstimmen neu entscheiden — dieselbe Regel wie
 * die Engine (votes ≥ required ∧ votes > Gegenseite), pure.
 */
export function mitStimmen(
  sig: { direction: SignalDirection; buyVotes: number; sellVotes: number; requiredConfluence: number },
  stimmen: ReadonlyArray<{ dir: 'buy' | 'sell'; weight: number } | null>,
): { direction: SignalDirection; buy: number; sell: number } {
  const da = stimmen.filter((s): s is { dir: 'buy' | 'sell'; weight: number } => s !== null);
  if (da.length === 0) return { direction: sig.direction, buy: sig.buyVotes, sell: sig.sellVotes };
  const buy = sig.buyVotes + da.reduce((n, s) => n + (s.dir === 'buy' ? s.weight : 0), 0);
  const sell = sig.sellVotes + da.reduce((n, s) => n + (s.dir === 'sell' ? s.weight : 0), 0);
  if (buy >= sig.requiredConfluence && buy > sell) return { direction: 'buy', buy, sell };
  if (sell >= sig.requiredConfluence && sell > buy) return { direction: 'sell', buy, sell };
  return { direction: 'hold', buy, sell };
}

/**
 * Größenfaktor eines Einstiegs: Probegröße, wenn die Richtung OHNE die KI
 * nicht zustande gekommen wäre. Bestätigt die KI nur, was die Technik ohnehin
 * sagt, bleibt die Größe unverändert.
 */
export function kiGroessenFaktor(
  richtungOhneKi: SignalDirection,
  richtungMitKi: SignalDirection,
  gewicht = 1,
): number {
  if (!(richtungMitKi !== 'hold' && richtungOhneKi !== richtungMitKi)) return 1;
  // Probegröße × gemessenes Gewicht (Stufe 3), nie über die volle Größe und
  // nie unter ein Viertel: Eine bewährte KI handelt voll, eine schlechte
  // bleibt winzig. Bestätigt die KI nur die Technik, bleibt die Größe 1 —
  // das Gewicht vergrößert keine Positionen, die auch ohne KI entstünden.
  const f = Number.isFinite(gewicht) && gewicht > 0 ? gewicht : 1;
  return Math.min(1, Math.max(0.25, Math.round(KI_PROBE_FAKTOR * f * 100) / 100));
}

/**
 * Richtungsbewusstes Veto: Ein gegengeprüftes Urteil GEGEN die Einstiegs-
 * richtung sperrt den Einstieg — auch wenn es schon eingepreist ist (dann
 * trägt es keinen Ausstieg mehr, aber ein Einstieg gegen frische schlechte
 * Nachrichten bleibt falsch).
 */
export function kiVeto(s: KiSignal | undefined, seite: 'long' | 'short'): boolean {
  if (!s || !s.handlungsfaehig) return false;
  return seite === 'long' ? s.richtung === 'negativ' : s.richtung === 'positiv';
}

/**
 * Hebt die KI das blinde Lexikon-Veto auf? Nur, wenn sie gegengeprüft in
 * Handelsrichtung urteilt — dann weiß sie, was das Lexikon nicht weiß: in
 * welche Richtung das harte Ereignis wirkt. UND nur, wenn ihre Meldung
 * zeitlich zum harten Ereignis passt (± KI_GLEICHES_EREIGNIS_MIN): Die
 * beiden stammen aus verschiedenen Feeds; ohne diesen Abgleich hebe ein
 * Urteil über ein ANDERES Ereignis das Veto auf (Red-Team H2).
 */
export function kiUebersteuertNewsVeto(
  s: KiSignal | undefined,
  seite: 'long' | 'short',
  hartesEreignisSec: number | null | undefined,
): boolean {
  if (!s || !s.handlungsfaehig) return false;
  if (!(seite === 'long' ? s.richtung === 'positiv' : s.richtung === 'negativ')) return false;
  if (typeof hartesEreignisSec !== 'number' || !Number.isFinite(hartesEreignisSec) || hartesEreignisSec <= 0) return false;
  const kiMs = Date.parse(s.publishedAt ?? s.firstSeenAt);
  return Number.isFinite(kiMs) && Math.abs(kiMs - hartesEreignisSec * 1000) <= KI_GLEICHES_EREIGNIS_MIN * 60_000;
}

export type KiPositionsAktion =
  | { art: 'verkauf'; grund: 'ki_news' }
  | { art: 'stop'; stop: number; grund: 'ki_eingepreist' | 'ki_unklar' };

/**
 * Der nachgezogene KI-Stop an der Position (`Position.kiStop`).
 *
 * BEWUSST ein eigenes Feld statt `stopLoss` zu überschreiben: Ein
 * gespeichertes `stopLoss`-Level ERSETZT in `riskExitReason` den Prozent-
 * bzw. ATR-Stop. Stünde der KI-Stop dort, könnte er einen engeren
 * Prozent-Stop still LOCKERN (Kurs knapp über dem 4-%-Stop, KI-Stop 0,5 ATR
 * darunter). Als zusätzliche Marke kann er Ausstiege nur früher auslösen —
 * nie später, egal wie die übrigen Stops stehen.
 */
export interface KiStop {
  level: number;
  grund: 'ki_eingepreist' | 'ki_unklar';
  newsId: string;
  gesetztAt: string;
}

/**
 * Was ein Urteil GEGEN eine gehaltene Position auslöst — pur.
 *
 * Gegengeprüft, belegt nicht eingepreist und noch nicht gelaufen → raus
 * (Owner-Empfehlung 05.10.: „eindeutig negativ und noch nicht eingepreist →
 * sofort verkaufen"). Gegengeprüft, aber gelaufen, eingepreist oder nicht
 * belegbar → nicht am Tief verkaufen, sondern den Stop auf 0,5 ATR
 * nachziehen. Unklar (Gegenprobe lief, nicht bestätigt) → Stop auf 1 ATR.
 *
 * Der KI-Stop bewegt sich NUR in Schutzrichtung (Long: nach oben, Short:
 * nach unten) und liegt immer auf der sicheren Seite des aktuellen Kurses.
 *
 * Nur Positionen, die VOR dem Urteil eröffnet wurden: Wer danach einstieg,
 * kannte die Lage schon (die Engine über das KI-Veto, ein Mensch per Hand)
 * — ihm die Entscheidung mit derselben Nachricht wieder abzunehmen, wäre
 * ein Urteil über eine Kenntnis, die beim Einstieg schon eingepreist war.
 */
export function kiPositionsAktion(
  s: KiSignal | undefined,
  pos: { side?: 'long' | 'short' | undefined; openedAt?: string | undefined; kiStop?: { level: number } | null | undefined },
  preis: number,
  atrPct: number | null | undefined,
): KiPositionsAktion | null {
  if (!s || !(preis > 0)) return null;
  const eroeffnet = Date.parse(String(pos.openedAt ?? ''));
  if (Number.isFinite(eroeffnet) && eroeffnet >= Date.parse(s.decidedAt)) return null;
  const short = pos.side === 'short';
  const gegen = short ? s.richtung === 'positiv' : s.richtung === 'negativ';
  if (!gegen) return null;
  const atr = atrOk(atrPct);

  const stopAktion = (grund: 'ki_eingepreist' | 'ki_unklar', abstandAtr: number): KiPositionsAktion | null => {
    if (atr === null) return null;
    const neu = short ? preis * (1 + (abstandAtr * atr) / 100) : preis * (1 - (abstandAtr * atr) / 100);
    const alt = pos.kiStop?.level;
    const enger = typeof alt !== 'number' || !Number.isFinite(alt) || !(alt > 0) ? true : short ? neu < alt : neu > alt;
    return enger ? { art: 'stop', stop: Math.round(neu * 1e6) / 1e6, grund } : null;
  };

  if (s.handlungsfaehig) {
    /* VERKAUF nur, wenn er sich belegen lässt (Red-Team M1): ausdrücklich
     * „nicht eingepreist" UND gemessen noch keine 1,5 ATR gelaufen. Fehlt
     * der Kurs beim Sehen oder die ATR, oder ist die Lage nur „teilweise"/
     * „unklar" eingepreist, wird nicht blind am womöglich schon erreichten
     * Tief verkauft, sondern der Stop nachgezogen. */
    const gelaufen = gelaufenPct(s, preis);
    const belegtFrisch = s.eingepreist === 'nein' && atr !== null && gelaufen !== null
      && Math.abs(gelaufen) < KI_EINGEPREIST_ATR * atr;
    return belegtFrisch ? { art: 'verkauf', grund: 'ki_news' } : stopAktion('ki_eingepreist', KI_STOP_ATR);
  }
  /* Unklar = die Gegenprobe LIEF und hat nicht bestätigt (Red-Team M5): Eine
   * bloße Sichtung — ungeprüft wegen Budget, Alter oder unlesbarer Antwort —
   * löst gar nichts aus. Weiterer Abstand, weil ungesichert. */
  return s.geprueft && s.staerke >= KI_UNKLAR_MIN_STAERKE ? stopAktion('ki_unklar', KI_UNKLAR_STOP_ATR) : null;
}

/**
 * Stammt ein Steckbrief von einem KI-/Lexikon-PROBE-Einstieg? Nur Proben
 * tragen `ki`/`lex` in der Signatur (Teil 3 des Schlüssels). Der Auto-Tuner
 * nimmt sie aus seinem Live-Vergleich: Die Schattenkonten handeln ohne KI —
 * ein Einstieg, den es dort nicht geben kann, verzerrt sonst den Vergleich
 * (Red-Team M3).
 */
export function istKiProbeBucket(bucket: unknown): boolean {
  if (typeof bucket !== 'string') return false;
  const sig = bucket.split('|')[2] ?? '';
  return sig.split('+').some((t) => t === 'ki' || t === 'lex');
}
