/**
 * Live-Reife eines Kontos aus seinen gespeicherten Kennzahlen.
 *
 * Eine Datei, damit Scan und `brokerStatus` dieselbe Zahl sehen. Zwei
 * Rechenwege wären zwei Wahrheiten — und bei der Frage, ob echtes Geld
 * fließen darf, ist das keine Option.
 *
 * ── Warum ein unreifes Live-Konto WEITERHANDELT ───────────────────────────
 *
 * Das ist die wichtigste Entscheidung in dieser Datei, und sie ist nicht
 * offensichtlich. Naheliegend wäre: Schalter auf „live", Reife fehlt, also
 * Konto stilllegen. Genau das wäre falsch — und zwar zirkulär falsch.
 *
 * Reife entsteht durch Handeln. Ein Konto, das wegen fehlender Reife nicht
 * handelt, sammelt keine Trades, keine Messstrecke und keinen Profitfaktor.
 * Es würde nie reif und der Schalter nie wirksam. Der Nutzer legt ihn um und
 * bringt sein System damit zum Stillstand — das Gegenteil dessen, was er
 * wollte.
 *
 * Deshalb: `resolveBrokerMode` liefert für ein unreifes Live-Konto `paper`,
 * und der Scan behandelt es wie jedes andere Papierkonto. Es handelt weiter,
 * sammelt weiter Kennzahlen — und in dem Moment, in dem alle Kriterien
 * stehen, greift der Schalter von selbst. Genau die Owner-Maxime: „trotzdem
 * schon theoretisch startklar sein. jederzeit."
 */

import { getFirestore } from 'firebase-admin/firestore';
import { liveReife, type ReifeBefund } from '../../../shared/src/index.js';

export type BrokerMode = 'paper' | 'live';

/**
 * Einzige Stelle, die den effektiven Broker-Modus bestimmt.
 *
 * DREI Bedingungen, alle nötig — jede eine eigene Fehlerquelle:
 *
 *  1. `strategy.broker.mode === 'live'` — der Schalter des Nutzers.
 *  2. env `ALPACA_ALLOW_LIVE === '1'` — die Freigabe des Betreibers, an einem
 *     Ort, an den keine Oberfläche herankommt.
 *  3. **Live-Reife** (seit 04.08.) — die Zahlen müssen es hergeben.
 *
 * Punkt 3 setzt die Owner-Maxime um: „so lange testen mit paper wallet wie
 * notwendig. bis man sicher nur noch Gewinn schreibt, dann erst den Schalter
 * umlegen, aber trotzdem schon theoretisch startklar sein." Der Schalter ist
 * jederzeit bedienbar — er greift nur nicht, solange die Messung dagegen
 * spricht.
 *
 * `reife` ist OPTIONAL, und zwar mit Bedacht in diese Richtung: Ein Aufrufer,
 * der die Kennzahlen nicht kennt, bekommt den bisherigen Doppel-Guard und
 * damit unverändertes Verhalten. Fehlende Kennzahlen dürfen nie dazu führen,
 * dass eine Prüfung stillschweigend WEGFÄLLT — sie können hier nur dazu
 * führen, dass eine dritte Prüfung nicht hinzukommt. Wer live handelt, reicht
 * sie durch (siehe `scanMarket`); wer nur den Modus anzeigt, nicht.
 *
 * Der Parameter ist bewusst strukturell (`{ broker: { mode? } }`) statt der
 * vollen `Strategy`: Seit dem Audit-Fix K-1 prüft auch das Order-Routing
 * diese Kette — dort liegt nur der rohe Feldwert aus dem User-Dokument vor,
 * kein validiertes Strategie-Objekt. Jede `Strategy` erfüllt die Form.
 */
export function resolveBrokerMode(
  strategy: { broker: { mode?: BrokerMode | undefined } },
  reife?: ReifeBefund,
): BrokerMode {
  const wantLive = strategy.broker.mode === 'live';
  if (!wantLive || process.env.ALPACA_ALLOW_LIVE !== '1') return 'paper';
  // Reife bekannt und negativ ⇒ Downgrade. Der Nutzer merkt es an der
  // Broker-Karte, nicht an einer stillen Überraschung im Kontoauszug.
  if (reife && !reife.bereit) return 'paper';
  return 'live';
}

/**
 * Reife-Befund für ein Konto.
 *
 * Fehler beim Lesen werden NICHT durchgereicht, sondern zu einem negativen
 * Befund: Wer die Kennzahlen nicht kennt, darf kein echtes Geld freigeben.
 * Ein kaputtes Statistik-Dokument macht ein Konto vorsichtiger, nicht
 * mutiger.
 */
export async function reifeFuerKonto(uid: string): Promise<ReifeBefund> {
  const db = getFirestore();
  try {
    const userRef = db.collection('users').doc(uid);
    const [stats, equity] = await Promise.all([
      userRef.collection('stats').doc('main').get(),
      userRef
        .collection('equity')
        .count()
        .get()
        .then((s) => s.data().count)
        .catch(() => 0),
    ]);
    const trades = (stats.get('trades') as number | undefined) ?? 0;
    const kosten = stats.get('costs') as { fees?: number; grossPnl?: number } | undefined;
    const fees = kosten?.fees ?? 0;
    const brutto = kosten?.grossPnl ?? 0;
    return liveReife({
      trades,
      profitFactor: (stats.get('profitFactor') as number | null | undefined) ?? null,
      // Bezug auf den BETRAG des Bruttoergebnisses: Bei einem Bruttoverlust
      // wäre das Verhältnis sonst negativ und läse sich wie „die Gebühren
      // haben Geld eingebracht".
      feeShare: Math.abs(brutto) > 0 ? fees / Math.abs(brutto) : null,
      netPnl: trades > 0 ? brutto - fees : null,
      // Messstrecke = Länge der Equity-Serie. Ein Reset löscht sie, und das
      // ist gewollt: Wer eine schlechte Strecke wegwirft, behält nicht deren
      // Reife.
      tageStrecke: equity,
    });
  } catch {
    return liveReife({ trades: 0, profitFactor: null, feeShare: null, netPnl: null });
  }
}
