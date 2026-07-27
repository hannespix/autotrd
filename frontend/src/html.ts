/**
 * html.ts — der eine Escaper.
 *
 * Beide Views bauen Markup per Template-String; alles, was aus der Datenbank
 * kommt (Symbolnamen, Journal-Begründungen, Strategie-Titel), muss vorher
 * entschärft werden. Es gab die Funktion bisher nur im Studio — eine zweite
 * Kopie im Dashboard hätte über kurz oder lang auseinandergelebt, und genau
 * bei Escaping ist „fast gleich" die gefährliche Variante.
 */
export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
