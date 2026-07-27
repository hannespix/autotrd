/**
 * Listener-Buchhaltung — eine Zahl für BEIDE Datenschichten.
 *
 * Der E2E-Test prüft nach Panel-Wechseln, dass die Zahl wieder auf ihren
 * Ausgangswert fällt: Ein geleakter Listener kostet nicht nur Speicher,
 * sondern bei Firestore auch dauerhaft Lesevorgänge und bei Supabase einen
 * offenen Realtime-Kanal. Solange der Zähler in `data.ts` lebte, hätte die
 * Prüfung nach der Umstellung auf Supabase stillschweigend nichts mehr
 * gemessen — deshalb liegt er jetzt hier, wo ihn beide Schichten hochzählen.
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
