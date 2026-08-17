/**
 * Wann eine Depot-Übernahme eine MESSZÄSUR ist — und wann nicht.
 *
 * ── Owner-Befund 16.08. ───────────────────────────────────────────────────
 *
 * „Die Reife der Konten wird jedes Mal zurückgesetzt, sobald man die Daten
 * neu vom Broker abruft und neu verbindet. Warum? Kann man das auch anders
 * machen?"
 *
 * Der Befund war richtig, die Ursache aber nicht das Verbinden, sondern der
 * Knopf danach: `adoptBroker` stempelt `wallet.resetAt` und schneidet die
 * Equity-Serie vor dem heutigen Tag ab. Beides ist RICHTIG, wenn die
 * Übernahme die Kapitalbasis verschiebt — eine Kurve, die über einen
 * Basiswechsel hinwegläuft, misst zwei verschiedene Konten in einer Linie
 * (Audit 13.08., K-5c/B-3). Nur: Die Live-Reife zählt ihre Messstrecke an
 * genau dieser Serie. Ein Klick auf „Depot übernehmen" kostete deshalb
 * IMMER 14 Tage — auch dann, wenn er faktisch nichts bewegte.
 *
 * ── Warum das mehr ist als Bequemlichkeit ─────────────────────────────────
 *
 * Der laufende Scan sperrt Einstiege, solange Buch und Depot auseinander
 * liegen (`abgleich_drift`). Der einzige Weg zurück ist die Übernahme. Wer
 * die Messstrecke schützen will, lässt die Drift also stehen — und handelt
 * nicht mehr. Zwei Sicherungen, die sich gegenseitig blockieren, sind eine
 * Falle, keine Sicherung.
 *
 * ── Was hier NICHT gelockert wird ─────────────────────────────────────────
 *
 * Die Anti-Wasch-Garantie bleibt vollständig: Sobald die Übernahme etwas
 * bewegt — eine Position kommt, geht, eine fremde Order wird nachgebucht
 * oder die Kapitalbasis verschiebt sich messbar — fällt der Schnitt wie
 * bisher. Wer ein Minus wegwaschen will, muss etwas verändern, und jede
 * Veränderung stempelt. Entfallen ist nur die Bestrafung für einen Klick
 * OHNE Wirkung.
 */

/** Was eine Übernahme tatsächlich bewegt hat. */
export interface UebernahmeWirkung {
  /** Buch-Positionen, die es beim Broker nicht mehr gibt (gelöscht). */
  geloescht: number;
  /** Broker-Orders, die im Buch fehlten (nachgebucht). */
  importiert: number;
  /** Broker-Positionen, die im Buch NEU sind (Symbol war unbekannt). */
  neuePositionen: number;
  /** Kapitalbasis vor der Übernahme; null, wenn noch keine gesetzt war. */
  basisVorher: number | null;
  /** Kapitalbasis, die die Übernahme setzen würde. */
  basisNachher: number;
}

/**
 * Toleranz der Kapitalbasis, unterhalb derer nicht gestempelt wird.
 *
 * 0,5 % ist keine runde Zahl aus Bequemlichkeit, sondern die Größenordnung
 * der Rundungs- und Kursdrift, die zwischen zwei Abrufen ohne jedes
 * Zutun entsteht: Der Barbestand beim Broker ändert sich mit gebuchten
 * Zinsen und Gebühren, und die Einstandssumme rechnet mit gerundeten
 * Stückzahlen. Wer darunter stempelt, stempelt Rauschen.
 *
 * Nach oben ist sie eng genug, dass eine echte Kapitalbewegung — eine
 * Einzahlung, eine übernommene Position, ein Reset beim Broker — sicher
 * darüber liegt: Bei 100.000 $ Basis sind 0,5 % gerade einmal 500 $.
 */
export const BASIS_TOLERANZ = 0.005;

/**
 * Bewegt diese Übernahme faktisch nichts?
 *
 * Bewusst KONJUNKTIV-frei formuliert: Sie bekommt, was tatsächlich
 * geschrieben würde, nicht was geplant war. Alle vier Bedingungen müssen
 * gelten — ein einziges bewegtes Stück macht die Übernahme zur Zäsur.
 */
export function istNoOpUebernahme(w: UebernahmeWirkung): boolean {
  if (w.geloescht > 0 || w.importiert > 0 || w.neuePositionen > 0) return false;
  // Ohne frühere Basis ist es die ERSTE Übernahme — die ist per Definition
  // eine Zäsur, auch wenn sie zufällig nichts mitbringt.
  if (w.basisVorher === null || !(w.basisVorher > 0)) return false;
  if (!Number.isFinite(w.basisNachher)) return false;
  const drift = Math.abs(w.basisNachher - w.basisVorher) / w.basisVorher;
  return drift < BASIS_TOLERANZ;
}
