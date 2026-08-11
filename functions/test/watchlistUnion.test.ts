/**
 * Audit-Befund 11.08.: `settings.strategy` war clientseitig direkt schreibbar.
 *
 * ── Der Befund ────────────────────────────────────────────────────────────
 *
 * Die Firestore-Regel für `users/{uid}` prüfte
 *
 *     request.resource.data.diff(resource.data).affectedKeys().hasOnly(['settings'])
 *
 * also nur, DASS ausschließlich `settings` betroffen ist. `affectedKeys()`
 * sieht die Top-Level-Schlüssel; alles darunter war frei. Damit konnte jeder
 * angemeldete Nutzer `settings.strategy` direkt setzen und `saveStrategy`
 * umgehen — das Callable, das als einziges Schema, Watchlist-Länge,
 * Katalog-Zugehörigkeit, `broker.mode` und die E-Mail-Bestätigung prüft.
 *
 * Der Regel-Fix steht in `firestore.rules` und wird in
 * `rules-test/firestore.rules.test.ts` gegen den Emulator geprüft.
 *
 * ── Warum es hier eine ZWEITE Linie gibt ──────────────────────────────────
 *
 * Weil eine Regel nur auf neue Schreibvorgänge wirkt. Was vor dem Fix im
 * Dokument stand, steht weiter da, und der Scan las es roh:
 *
 *     engSnap.docs.flatMap((d) => d.get('settings.strategy.watchlist') ?? [])
 *
 * Zwei Folgen, die beide nichts mit Sicherheit im engeren Sinn zu tun haben
 * und trotzdem wehtun:
 *
 *  1. VERDRÄNGUNG. `selectScanSymbols` bedient die Watchlists VOR Ranking,
 *     Defaults und Katalog. Das Scan-Kontingent ist 40 Symbole groß. Ein
 *     einziges Konto mit 500 Einträgen füllt es komplett — für alle anderen
 *     Konten bleibt nichts, und ihre Signale entstehen gar nicht erst.
 *  2. FANTASIE-SYMBOLE. `isTradable` prüft die KLASSE, nicht den Katalog.
 *     `classify('MUELLXYZ')` liefert `stocks_us`, also gilt das Kürzel als
 *     handelbar und ginge an die Kursquelle. Aufrufe, die nur kosten.
 *
 * Dasselbe Muster wie `clampStrategyRisk`: Die Ausführung verlässt sich nicht
 * darauf, dass das Dokument in Ordnung ist.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { watchlistUnion } from '../src/scheduled/scanMarket.js';
import { allSymbols, MAX_WATCHLIST } from '../../shared/src/index.js';

const KATALOG = new Set(allSymbols());
/** Das Scan-Kontingent aus scanMarket (MAX_SCAN_SYMBOLS) — hier als Maß. */
const MAX_SCAN_KONTINGENT = 40;

/** Echte Katalog-Symbole, damit der Test nicht an einer Attrappe hängt. */
const ECHTE = allSymbols().slice(0, MAX_WATCHLIST + 10);

describe('watchlistUnion — der Normalfall bleibt, wie er war', () => {
  it('nimmt die Watchlist eines Kontos unverändert', () => {
    expect(watchlistUnion([['AAPL', 'MSFT']], KATALOG)).toEqual(['AAPL', 'MSFT']);
  });

  it('führt mehrere Konten zusammen', () => {
    expect(watchlistUnion([['AAPL'], ['MSFT'], ['NVDA']], KATALOG)).toEqual([
      'AAPL',
      'MSFT',
      'NVDA',
    ]);
  });

  it('behält Doppelnennungen — das Set macht selectScanSymbols', () => {
    // Bewusst KEINE Deduplizierung hier: Die Reihenfolge ist die Priorität,
    // und `selectScanSymbols` arbeitet ohnehin über ein Set. Zwei Stellen,
    // die dasselbe tun, ist genau das Muster, das diese Woche vier Fehler
    // erzeugt hat.
    expect(watchlistUnion([['AAPL'], ['AAPL']], KATALOG)).toEqual(['AAPL', 'AAPL']);
  });

  it('ein Konto ohne Watchlist stört die anderen nicht', () => {
    expect(watchlistUnion([undefined, ['AAPL'], null, ['MSFT']], KATALOG)).toEqual([
      'AAPL',
      'MSFT',
    ]);
  });
});

describe('watchlistUnion — die Verdrängung', () => {
  it(`klemmt je Konto auf MAX_WATCHLIST (${MAX_WATCHLIST})`, () => {
    const zuViele = Array.from({ length: 500 }, (_, i) => ECHTE[i % ECHTE.length] as string);
    expect(watchlistUnion([zuViele], KATALOG)).toHaveLength(MAX_WATCHLIST);
  });

  it('klemmt PRO KONTO, nicht auf die Union', () => {
    // Der Unterschied ist wesentlich: Zehn Konten mit je zwanzig Symbolen
    // sind legitim und ergeben zusammen mehr als MAX_WATCHLIST. Eine Klemme
    // auf die Union würde die späteren Konten stumm abschneiden — und zwar
    // die, die zufällig hinten in der Abfrage standen.
    const zwanzig = ECHTE.slice(0, MAX_WATCHLIST);
    const drei = watchlistUnion([zwanzig, zwanzig, zwanzig], KATALOG);
    expect(drei).toHaveLength(MAX_WATCHLIST * 3);
  });

  it('ein überlanges Konto verdrängt die anderen nicht mehr', () => {
    // Der Kern des Befundes, in einer Zeile: Vorher standen die 500 Einträge
    // des ersten Kontos vor allem anderen und füllten das Kontingent (40).
    const gierig = Array.from({ length: 500 }, (_, i) => ECHTE[i % ECHTE.length] as string);
    const union = watchlistUnion([gierig, ['SPY']], KATALOG);
    expect(union).toContain('SPY');
    expect(union.indexOf('SPY')).toBeLessThan(MAX_SCAN_KONTINGENT);
  });
});

describe('watchlistUnion — was gar nicht erst in den Scan darf', () => {
  it('wirft Symbole raus, die nicht im Katalog stehen', () => {
    expect(watchlistUnion([['AAPL', 'MUELLXYZ', 'MSFT']], KATALOG)).toEqual(['AAPL', 'MSFT']);
  });

  it('auch dann, wenn isTradable sie durchließe', () => {
    // Der eigentliche Grund für den Katalog-Filter: `isTradable` prüft die
    // Klasse. Ein unbekanntes Kürzel wird `stocks_us` und gilt damit als
    // handelbar — der Filter dahinter fängt es NICHT.
    expect(watchlistUnion([['ZZZZ']], KATALOG)).toEqual([]);
  });

  it('ignoriert Einträge, die keine Zeichenketten sind', () => {
    const kaputt = ['AAPL', 42, null, { symbol: 'MSFT' }, ['NVDA'], 'MSFT'] as unknown[];
    expect(watchlistUnion([kaputt], KATALOG)).toEqual(['AAPL', 'MSFT']);
  });

  it('ignoriert ein Feld, das gar keine Liste ist', () => {
    expect(watchlistUnion(['AAPL', 42, { watchlist: ['AAPL'] }], KATALOG)).toEqual([]);
  });

  it('verworfene Einträge verbrauchen kein Kontingent', () => {
    // Sonst hätte ein Konto mit MAX_WATCHLIST Müll-Symbolen am Anfang seine
    // echten Symbole verloren — ein stiller Verlust, der wie „hat halt nichts
    // in der Watchlist" aussähe.
    const vorne = Array.from({ length: MAX_WATCHLIST }, () => 'MUELLXYZ');
    expect(watchlistUnion([[...vorne, 'AAPL']], KATALOG)).toEqual(['AAPL']);
  });

  it('leere Eingabe ergibt leere Union', () => {
    expect(watchlistUnion([], KATALOG)).toEqual([]);
  });
});

/* Die reine Funktion allein reicht nicht.
 *
 * Sabotage-Probe: den Produktionsaufruf zurück auf das alte
 * `engSnap.docs.flatMap(…)` gesetzt — alle fünfzehn Tests oben blieben grün.
 * Sie prüfen die ENTSCHEIDUNG, nicht ihren Einsatz. Dieselbe Lücke ging bei
 * `pruefeFassung` und bei der Klassen-Kreuzung schon einmal auf; sie ist bei
 * einer zweiten Verteidigungslinie besonders teuer, weil eine Linie, die
 * niemand ruft, wie Schutz aussieht und keiner ist.
 *
 * Geprüft wird der Quelltext, weil die Stelle in einer Firestore-Abfrage
 * steckt: Ein Test, der sie nachbaut, prüfte am Ende die Nachbildung. */
describe('Quelltext: der Scan liest die Watchlists durch watchlistUnion', () => {
  const pfad = join(import.meta.dirname, '..', 'src', 'scheduled', 'scanMarket.ts');

  it('die Union entsteht nicht mehr direkt aus den Dokumenten', () => {
    const text = readFileSync(pfad, 'utf8');
    // Zwischen der Abfrage und der Klassen-Auswertung liegt die
    // Zuweisung an `watchlists` — dort muss die Funktion stehen.
    const ab = text.indexOf(".select('settings.strategy.watchlist'");
    expect(ab, 'Watchlist-Abfrage nicht gefunden').toBeGreaterThan(0);
    const bis = text.indexOf('aktiveKlassenAusGewichten(', ab);
    const block = text.slice(ab, bis);
    expect(block).toContain('watchlistUnion(');
    expect(block).not.toContain('flatMap');
  });
});

describe('watchlistUnion — die Voreinstellungen greifen', () => {
  it('ohne übergebenen Katalog gilt der echte', () => {
    // Der Produktionsaufruf übergibt weder Katalog noch Grenze. Wären die
    // Voreinstellungen falsch, liefen alle Tests oben ins Leere.
    expect(watchlistUnion([['AAPL', 'MUELLXYZ']])).toEqual(['AAPL']);
  });

  it('und die echte Längengrenze', () => {
    const zuViele = Array.from({ length: 200 }, (_, i) => ECHTE[i % ECHTE.length] as string);
    expect(watchlistUnion([zuViele])).toHaveLength(MAX_WATCHLIST);
  });
});
