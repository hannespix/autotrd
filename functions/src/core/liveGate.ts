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
