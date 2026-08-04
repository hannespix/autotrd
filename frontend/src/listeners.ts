/**
 * Listener-Buchhaltung — eine Zahl für BEIDE Datenschichten.
 *
 * Der E2E-Test prüft nach Panel-Wechseln, dass die Zahl wieder auf ihren
 * Ausgangswert fällt: Ein geleakter Listener kostet nicht nur Speicher,
 * sondern bei Firestore dauerhaft Lesevorgänge — er schreibt also jeden
 * Monat Rechnung, ohne dass ihn jemand bemerkt. Der Zähler liegt bewusst
 * in dieser eigenen Datei und nicht in `data.ts`, damit ihn auch Module
 * hochzählen können, die `data.ts` selbst nicht importieren.
 */

let active = 0;

export function listenerCount(): number {
  return active;
}

/**
 * Ein Abo anmelden. Der zurückgegebene Abmelder ist gegen Doppelaufruf
 * geschützt — sonst würde ein zweimal aufgerufenes `unsubscribe()` den
 * Zähler unter den Ausgangswert drücken und der Leak-Test wäre nutzlos.
 */
export function trackListener(unsub: () => void): () => void {
  active += 1;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    active -= 1;
    unsub();
  };
}
