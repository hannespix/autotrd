/**
 * Bewegung für die Vorschau — und NUR für die Vorschau (Owner 22.08.: „in
 * der in-tool Anzeige bitte die dynamische Animation verwenden").
 *
 * ── Warum das strikt getrennt bleibt ────────────────────────────────────
 *
 * Dieselben SVGs gehen zwei Wege: auf den Bildschirm und in eine
 * PNG-Datei. Wäre die Bewegung im SVG selbst, könnte die Rasterung einen
 * ZWISCHENSTAND einfangen — eine halb gezeichnete Kurve, Balken auf halber
 * Höhe, eine Zahl bei 40 % Deckkraft. Das Bild sähe nicht „animiert" aus,
 * sondern kaputt, und niemand wüsste warum, weil es nur manchmal passiert.
 *
 * Deshalb bauen die Karten weiterhin statisches SVG, und diese Funktion
 * legt die Bewegung erst beim Anzeigen darüber. Der Export ruft sie nicht
 * auf — er kann es gar nicht vergessen, weil er den unveränderten String
 * benutzt, den `shareStory` liefert.
 *
 * ── Was sich bewegt ─────────────────────────────────────────────────────
 *
 *   Kurven   zeichnen sich von links nach rechts (`pathLength="1"` macht
 *            die Länge unabhängig von der echten Geometrie — sonst müsste
 *            man sie messen, und im String steht sie nicht).
 *   Balken   wachsen aus ihrer Grundlinie heraus. Balken UNTER der Achse
 *            wachsen nach unten; ein gemeinsamer Ursprung liesse die
 *            Verlust-Balken aus der falschen Richtung einfliegen.
 *   Zahlen   blenden auf und steigen leicht — sie sind das Ziel des
 *            Blicks, nicht die Verzierung.
 *
 * Alles ist EINMALIG (`forwards`) und endet im statischen Bild. Eine
 * Dauerschleife im Hintergrund wäre nach dem zweiten Ansehen nur noch
 * Unruhe.
 */

/** Marker, die die Karten-Bauer setzen. Ohne sie passiert nichts. */
export const ANIM_LINIE = 'data-anim="linie"';
export const ANIM_BALKEN = 'data-anim="balken"';
export const ANIM_BALKEN_AB = 'data-anim="balken-ab"';
export const ANIM_ZAHL = 'data-anim="zahl"';

const STIL = `<style>
@keyframes anZeichnen { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes anWachsen { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@keyframes anAuf { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
[data-anim="linie"] {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: anZeichnen 1.1s cubic-bezier(.22,.61,.36,1) .15s forwards;
}
[data-anim="balken"], [data-anim="balken-ab"] {
  transform-box: fill-box;
  transform: scaleY(0);
  animation: anWachsen .7s cubic-bezier(.22,.61,.36,1) forwards;
}
[data-anim="balken"] { transform-origin: bottom; }
[data-anim="balken-ab"] { transform-origin: top; }
[data-anim="zahl"] {
  transform-box: fill-box;
  opacity: 0;
  animation: anAuf .6s cubic-bezier(.22,.61,.36,1) .25s forwards;
}
@media (prefers-reduced-motion: reduce) {
  /* Nicht „schneller", sondern GAR NICHT: Wer Bewegung abbestellt hat,
     meint das ernst. Die Endzustände müssen trotzdem stehen — sonst bliebe
     die Karte unsichtbar, weil die Startwerte auf 0 stehen. */
  [data-anim] { animation: none !important; }
  [data-anim="linie"] { stroke-dashoffset: 0; }
  [data-anim="balken"], [data-anim="balken-ab"] { transform: none; }
  [data-anim="zahl"] { opacity: 1; }
}
</style>`;

/**
 * Bewegung in ein fertiges Karten-SVG legen.
 *
 * Der Stil wird direkt hinter das öffnende `<svg …>` gesetzt; die
 * Verzögerungen staffeln sich über die Reihenfolge der Balken, damit die
 * Karte sich aufbaut statt auf einmal zu erscheinen.
 *
 * Enthält die Karte keinen einzigen Marker, kommt sie unverändert zurück —
 * dann gäbe es nichts zu bewegen, und ein Stil-Block ohne Wirkung wäre nur
 * Gewicht.
 */
export function animiereSvg(svg: string): string {
  if (!svg.includes('data-anim=')) return svg;
  const ende = svg.indexOf('>');
  if (ende < 0) return svg;

  /* Balken der Reihe nach: Jeder bekommt 28 ms mehr Vorlauf als sein
   * Vorgänger, gedeckelt bei 560 ms. Ohne Deckel würde die letzte Zeile
   * einer 30-Balken-Karte fast eine Sekunde nach der ersten starten — aus
   * „baut sich auf" würde „hängt". */
  let n = 0;
  const gestaffelt = svg.replace(/data-anim="(balken|balken-ab)"/g, (treffer) => {
    const ms = Math.min(560, n * 28);
    n += 1;
    return `${treffer} style="animation-delay:${ms}ms"`;
  });
  return `${gestaffelt.slice(0, ende + 1)}${STIL}${gestaffelt.slice(ende + 1)}`;
}
