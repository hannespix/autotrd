/**
 * Das Handels-Universum kommt vom BROKER, nicht aus einer Liste im Repo.
 *
 * ── Warum (Owner-Frage 11.08.) ────────────────────────────────────────────
 *
 * „Können wir nicht einfach alle verfügbaren Alpaca-Symbole in die
 * Beobachtung nehmen?" — Ja, und der Hebel ist größer, als er klingt: Die
 * Momentum-Rangliste sucht heute den stärksten Trend unter 132 handverlesenen
 * Papieren. Dieselbe Rechnung über alle handelbaren Alpaca-Papiere sucht ihn
 * unter mehreren Tausend. Gleicher Aufwand, tausendfacher Suchraum.
 *
 * ── Warum das trotzdem nicht „alles alle fünf Minuten" heißt ──────────────
 *
 * Die Kosten liegen extrem ungleich:
 *
 *   Rangliste, 1× täglich   — 1 Firestore-Write je Symbol und Tag.
 *                             10.000 Symbole ≈ 2 Cent am Tag.
 *   Kursversorgung, 5 min   — ~78 Writes je Symbol und Handelstag.
 *                             10.000 Symbole ≈ 1,40 $/Tag, dazu 39.000
 *                             Yahoo-Anfragen täglich. Yahoo hat dafür kein
 *                             Kontingent und keine Zusage.
 *
 * Momentum braucht Zwölf-Monats-Renditen, keine Live-Kurse. Ein Papier muss
 * erst dann im Fünf-Minuten-Takt beobachtet werden, wenn es in Reichweite
 * eines Trades ist. Deshalb wächst hier NUR die tägliche Ebene; die
 * Kursversorgung wählt weiterhin eine begrenzte Menge — aber jetzt aus dem
 * großen Pool statt aus einer Liste von Hand.
 *
 * ── Was dieses Modul NICHT tut ────────────────────────────────────────────
 *
 * Es ordert nichts und ändert keine Guards. Es beantwortet eine einzige
 * Frage: Welche Papiere kämen überhaupt in Frage?
 */

import { alpacaFetch, vonAlpacaSymbol, type AlpacaSchluessel, type FetchLike } from './alpacaBroker.js';
import type { BrokerMode } from './broker.js';

/**
 * Ein Asset, wie `/v2/assets` es liefert — nur die Felder, die wir lesen.
 *
 * Bewusst mit den Alpaca-Feldnamen (snake_case): Das hier ist die
 * Außengrenze, und eine Umbenennung genau an der Stelle, an der man beim
 * Debuggen mit der API-Antwort vergleicht, kostet mehr, als sie bringt.
 */
export interface AlpacaAssetRoh {
  symbol?: unknown;
  name?: unknown;
  exchange?: unknown;
  class?: unknown;
  status?: unknown;
  tradable?: unknown;
  fractionable?: unknown;
  shortable?: unknown;
  easy_to_borrow?: unknown;
  marginable?: unknown;
}

/** Ein Papier, das wir handeln könnten — in UNSERER Schreibweise. */
export interface UniversumEintrag {
  /** Katalog-Schreibweise (`BRK-B`, `BTC-USD`) — nie die des Brokers. */
  symbol: string;
  name: string;
  /** `us_equity` oder `crypto`. */
  klasse: 'us_equity' | 'crypto';
  fractionable: boolean;
  shortable: boolean;
}

/**
 * Börsen, deren Papiere wir zulassen.
 *
 * Der eigentliche Zweck dieser Liste ist ein AUSSCHLUSS: OTC. Dort notieren
 * die meisten der über zehntausend Alpaca-Symbole, und dort ist der Spread
 * regelmäßig mehrere Prozent breit. Bei einem gemessenen Kostenanteil, der
 * schon heute über dem Nettoergebnis liegt (`feeShare` 2,6 am 10.08.), wäre
 * jeder OTC-Trade beim Einstieg verloren — der Kurs müsste den Spread erst
 * wieder hereinholen, bevor überhaupt Gewinn möglich wird.
 *
 * Dazu kommt die Datenseite: Für einen großen Teil der OTC-Papiere liefert
 * Yahoo keine belastbare Historie. Ein Ranking über Symbole ohne Kurse ist
 * kein breiteres Ranking, sondern ein lückenhaftes.
 */
const BOERSEN = new Set(['NASDAQ', 'NYSE', 'ARCA', 'AMEX', 'BATS', 'NYSEARCA']);

/**
 * Anlageklassen, die wir aufnehmen.
 *
 * `us_option` fehlt mit Absicht: Optionen sind ein eigener Meilenstein mit
 * eigener Risikologik (Verfall, Ausübung, Stillhalter-Pflichten). Sie
 * versehentlich über das Universum hereinzulassen wäre die schlechteste Art,
 * damit anzufangen.
 */
const KLASSEN = new Set(['us_equity', 'crypto']);

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Aus der rohen Broker-Antwort das Universum bilden.
 *
 * Pur gehalten, weil das hier die Auswahl IST: Was diese Funktion verwirft,
 * kann das System nie handeln — und ein zu großzügiger Filter fällt nicht
 * auf, er kostet nur langsam Geld.
 */
export function universumFilter(rohe: readonly AlpacaAssetRoh[]): UniversumEintrag[] {
  const out: UniversumEintrag[] = [];
  const gesehen = new Set<string>();

  for (const a of rohe) {
    if (text(a.status) !== 'active') continue;
    if (a.tradable !== true) continue;

    const klasse = text(a.class);
    if (!KLASSEN.has(klasse)) continue;

    // Krypto handelt nicht an einer Börse im Sinne dieser Liste — Alpaca
    // trägt dort z. B. `CRYPTO` oder `FTXU` ein. Der Börsenfilter zielt auf
    // OTC-Aktien und darf Krypto deshalb nicht mitreißen.
    if (klasse === 'us_equity' && !BOERSEN.has(text(a.exchange).toUpperCase())) continue;

    const roh = text(a.symbol);
    if (!roh) continue;
    const symbol = vonAlpacaSymbol(roh);

    /* Schreibweisen, die wir nicht beherrschen, kommen nicht herein.
     *
     * Nach der Rückübersetzung sind Anteilsklassen (`BRK.B` → `BRK-B`) und
     * Krypto (`BTC/USD` → `BTC-USD`) sauber. Was DANN noch einen Punkt oder
     * Schrägstrich trägt, sind Bezugsrechte, Warrants und Units — Yahoo
     * schreibt die nach eigenen Regeln (`-WT`, `-RT`, `-UN`), die sich nicht
     * durch Zeichentausch herstellen lassen. Ein solches Symbol im Universum
     * wäre kein zusätzlicher Kandidat, sondern eine sichere Kurslücke. */
    if (symbol.includes('.') || symbol.includes('/')) continue;

    if (gesehen.has(symbol)) continue;
    gesehen.add(symbol);

    out.push({
      symbol,
      name: text(a.name) || symbol,
      klasse: klasse === 'crypto' ? 'crypto' : 'us_equity',
      fractionable: a.fractionable === true,
      shortable: a.shortable === true,
    });
  }

  return out.sort((x, y) => x.symbol.localeCompare(y.symbol));
}

/**
 * Alle Assets einer Klasse beim Broker abrufen.
 *
 * Ein einziger Aufruf je Klasse — Alpaca liefert die vollständige Liste ohne
 * Blättern. Die Antwort ist groß (mehrere MB bei US-Aktien); genau deshalb
 * läuft das täglich und nicht bei jedem Scan.
 */
export async function alpacaAssetsListe(
  mode: BrokerMode,
  klasse: 'us_equity' | 'crypto',
  schluessel: AlpacaSchluessel | null = null,
  fetchImpl: FetchLike = fetch,
): Promise<AlpacaAssetRoh[]> {
  const d = await alpacaFetch(
    mode,
    `/v2/assets?status=active&asset_class=${klasse}`,
    schluessel,
    {},
    fetchImpl,
  );
  return Array.isArray(d) ? (d as AlpacaAssetRoh[]) : [];
}

/**
 * Das vollständige Universum: beide Klassen, gefiltert, in unserer
 * Schreibweise.
 *
 * Schlägt EINE Klasse fehl, wirft der Aufruf — bewusst. Ein Universum, dem
 * still die halbe Aktienseite fehlt, sieht aus wie ein richtiges und führt
 * zu einer Rangliste, die nur Krypto kennt. Lieber gar kein neues Universum
 * als ein halbes: Der Aufrufer behält dann schlicht den letzten Stand.
 */
export async function alpacaUniversum(
  mode: BrokerMode,
  schluessel: AlpacaSchluessel | null = null,
  fetchImpl: FetchLike = fetch,
): Promise<UniversumEintrag[]> {
  const [aktien, krypto] = await Promise.all([
    alpacaAssetsListe(mode, 'us_equity', schluessel, fetchImpl),
    alpacaAssetsListe(mode, 'crypto', schluessel, fetchImpl),
  ]);
  return universumFilter([...aktien, ...krypto]);
}
