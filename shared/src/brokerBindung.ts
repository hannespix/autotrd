/**
 * Ein Broker-Depot gehört genau einem autotrd-Konto.
 *
 * ── Der Befund, der das ausgelöst hat (Owner-Screenshots 12.08.) ──────────
 *
 * Zwei Listen desselben Alpaca-Paper-Depots. autotrd meldete 10 offene
 * Positionen — korrekt, sein Limit ist 10 —, Alpaca zeigte 17:
 *
 *   NVDA   46,763304  ↔  46,763304     exakt gleich
 *   IEF   142,471896  ↔ 142,471896     exakt gleich
 *   QQQ     9,347495  ↔   9,347495     exakt gleich
 *   VGK    58,086513  ↔  58,086513     exakt gleich
 *   FXI   154         ↔ 206,39283      +52,39
 *   TLT    24         ↔ 164,20144     +140,20
 *   XLI     1         ↔  44,895494     +43,90
 *   MU, INTC, SOXX, SMH, AMD, CAT, LLY  nur bei Alpaca
 *
 * Vier Positionen stimmen bis auf die sechste Nachkommastelle überein — das
 * sind buchstäblich dieselben Trades. Sechs sind beim Broker größer, und die
 * Differenzen sind ebenfalls gebrochene Zahlen (52,39283 FXI), also auch
 * Engine-Käufe mit Cash-Sizing und keine Handeingaben.
 *
 * Erklärung: EIN Alpaca-Depot, ZWEI autotrd-Konten. Der Broker führt ein
 * einziges Depot und addiert alle Käufe; jedes Buch kennt nur seinen Anteil.
 * Der Heartbeat sagt dasselbe: `broker: { verbunden: 2 }`.
 *
 * ── Was daraus folgt ──────────────────────────────────────────────────────
 *
 * Fast jede Sicherung des Systems rechnet auf dem eigenen Buch und wird
 * dadurch wirkungslos, ohne es zu merken:
 *
 *   · Das Positionslimit zählt eigene Positionen — real sind es doppelt so
 *     viele.
 *   · Der Korrelations-Deckel sieht ein Cluster, real sind es zwei.
 *   · Die Kapitaldecke stimmt nicht (84 598 $ Cash-Differenz am 12.08.).
 *   · Ein Verkauf des einen Kontos kann die Position des anderen schließen —
 *     beim Broker gibt es nur EINE Position je Symbol.
 *
 * Der letzte Punkt ist der gefährlichste: Zwei Bücher, die dieselbe
 * Broker-Position für ihre eigene halten, können sich gegenseitig die
 * Stops wegnehmen.
 *
 * ── Warum ein Fingerabdruck und nicht die Kontonummer ────────────────────
 *
 * Verglichen wird ein Hash der Alpaca-Konto-ID, nicht die ID selbst. Sie ist
 * kein Geheimnis wie ein Schlüssel, aber sie identifiziert ein fremdes
 * Konto, und für den Zweck hier — „ist das dasselbe Depot?" — genügt die
 * Gleichheit. Was nicht gespeichert wird, kann auch nicht auslaufen.
 *
 * Der Vergleich muss außerdem über die KONTO-ID laufen und nicht über den
 * API-Schlüssel: Zu einem Alpaca-Konto lassen sich mehrere Schlüsselpaare
 * erzeugen. Ein Riegel auf Schlüsselebene wäre mit zwei Klicks zu umgehen,
 * ohne dass jemand die Absicht hätte.
 */

/** Wer ein Depot belegt — steht unter dem Fingerabdruck des Broker-Kontos. */
export interface Bindung {
  /** autotrd-Konto, das dieses Depot belegt. */
  uid: string;
  /** Seit wann (ISO). */
  at: string;
  /** Betriebsart, in der gebunden wurde — Papier und Echtgeld sind getrennte Depots. */
  mode?: string;
}

export type BindungsBefund =
  | { ok: true; zustand: 'frei' | 'eigen' }
  | { ok: false; zustand: 'fremd'; belegtVon: string; seit: string };

/**
 * Darf `uid` dieses Depot benutzen?
 *
 * Pur und ohne Firestore: Die Entscheidung verweigert fremden Nutzern das
 * Verbinden ihres Kontos, und das ist nichts, was man nur im Live-Betrieb
 * beobachten können sollte.
 *
 * Ein leerer Fingerabdruck gilt als FREI und nicht als Konflikt: Wenn der
 * Broker keine Konto-ID liefert, ist das ein Datenproblem und kein Beleg
 * dafür, dass zwei Konten dasselbe Depot teilen. Blockieren würde hier den
 * Falschen treffen.
 */
export function pruefeBindung(
  fingerabdruck: string | null | undefined,
  uid: string,
  bestand: Bindung | null | undefined,
): BindungsBefund {
  if (!fingerabdruck || !uid) return { ok: true, zustand: 'frei' };
  if (!bestand || !bestand.uid) return { ok: true, zustand: 'frei' };
  if (bestand.uid === uid) return { ok: true, zustand: 'eigen' };
  return { ok: false, zustand: 'fremd', belegtVon: bestand.uid, seit: bestand.at };
}

/**
 * Klartext für die Ablehnung.
 *
 * Nennt bewusst NICHT die fremde uid: Der Nutzer, der hier abgewiesen wird,
 * hat kein Recht zu erfahren, welches andere Konto das Depot belegt — und
 * in der überwiegenden Zahl der Fälle ist es sein eigenes zweites Konto,
 * dann weiß er es ohnehin.
 */
export function bindungsMeldung(seit: string): string {
  return (
    'Dieses Broker-Depot ist bereits mit einem anderen autotrd-Konto verbunden ' +
    `(seit ${seit.slice(0, 10)}). Ein Depot kann nur zu einem Konto gehören: ` +
    'Der Broker führt eine einzige Position je Symbol, zwei Bücher darüber ' +
    'würden sich gegenseitig Positionen und Stops wegnehmen. ' +
    'Trenne die Verbindung im anderen Konto oder lege bei Alpaca ein zweites Depot an.'
  );
}

/**
 * Bindungen, deren Konto nachweislich kein Broker-Dokument mehr hat.
 *
 * ── Warum es das braucht ──────────────────────────────────────────────────
 *
 * Owner-Direktive 12.08.: „Pro User muss mindestens ein Alpaca-Account
 * verknüpfbar sein — unkompliziert, mit möglichst wenig Verwaltungsaufwand."
 *
 * Ohne diese Räumung wäre der Riegel oben das Gegenteil davon. Wird ein
 * Konto gelöscht, zurückgesetzt oder seine Verbindung außerhalb von
 * `trenneBroker` entfernt, bliebe die Bindung stehen — und das Depot wäre
 * dauerhaft belegt. Niemand könnte es je wieder verbinden, auch der
 * ursprüngliche Besitzer nicht. Jeder solche Fall landete als Handarbeit
 * beim Betreiber.
 *
 * ── Die entscheidende Vorsicht ────────────────────────────────────────────
 *
 * `hatVerbindung` ist bewusst dreiwertig: `true` (lebt), `false` (geprüft,
 * kein Broker-Dokument) und FEHLEND (nicht geprüft). Nur `false` gibt frei.
 *
 * Der Unterschied ist kein Detail. Der Scan sieht nur freigeschaltete,
 * laufende Konten — ein pausiertes, gesperrtes oder gerade zurücksetzendes
 * Konto taucht dort nicht auf. Würde „nicht gesehen" als „nicht vorhanden"
 * gelesen, verlöre genau dieses Konto sein Depot an den Nächsten, der es
 * verbindet. Ein Datenverlust aus einer Nichtinformation ist schlimmer als
 * eine Bindung, die eine Runde länger steht.
 */
export function verwaisteBindungen(
  bindungen: Record<string, Bindung> | undefined | null,
  hatVerbindung: Record<string, boolean> | undefined | null,
): string[] {
  if (!bindungen) return [];
  const befund = hatVerbindung ?? {};
  const waisen: string[] = [];
  for (const [fp, bindung] of Object.entries(bindungen)) {
    // Eine Bindung ohne uid kann niemandem gehören — die blockiert nur.
    if (!bindung?.uid) {
      waisen.push(fp);
      continue;
    }
    if (befund[bindung.uid] === false) waisen.push(fp);
  }
  // Sortiert, damit zwei Läufe mit demselben Bestand dieselbe Liste liefern
  // und ein Vergleich im Log oder Test nicht an der Reihenfolge scheitert.
  return waisen.sort();
}
