/**
 * Symbol-Monogramme (Owner-Frage 20.08.: „Logos je Symbol?").
 *
 * Echte Marken-Logos bräuchten eine externe Quelle mit Kosten, Limits und
 * einem Datenschutz-Haken: Lädt der Browser Logos direkt von Dritt-CDNs,
 * verrät jeder Aufruf dem Anbieter IP + „interessiert sich für Papier X".
 * Die ehrliche Sofort-Stufe ist das Monogramm — runder Chip, ein bis zwei
 * Zeichen, deterministische Farbe je Symbol: dieselbe Wiedererkennung beim
 * Scannen von Listen, null Fremdquellen, passt zum ruhigen Look (dieselbe
 * Linie wie die Emoji-Entrümpelung). Server-gecachte Logos können später
 * als Stufe 2 obendrauf, ohne dass sich die Einbau-Orte ändern.
 *
 * Die Palette ist bewusst OHNE Gewinn-Grün und Verlust-Rot: Ein zufällig
 * rotes NVDA-Monogramm neben einer grünen P&L-Zahl wäre eine Falschaussage.
 */

const TOENE = 6;

/** Deterministischer Farb-Slot 0…5 — dasselbe Symbol, immer derselbe Ton. */
export function symbolTon(symbol: string): number {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  return h % TOENE;
}

/** Ein bis zwei Zeichen fürs Monogramm — nur A–Z/0–9: „^NDX" ⇒ „ND". */
export function symbolMonogramm(symbol: string): string {
  const rein = symbol.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return rein.slice(0, 2) || '·';
}

/**
 * Basis-URL des Logo-Proxys (Functions „logo") — dasselbe vorhersagbare
 * Cloud-Run-Muster wie healthz. Stimmt der Host nicht, schlagen die Bilder
 * fehl und die Monogramme bleiben stehen — die Kette ist fail-safe.
 */
const LOGO_BASIS = 'https://logo-6xru5z43xa-uc.a.run.app';

/**
 * Fertiges Chip-HTML — inhärent escaped: Monogramm ist [A-Z0-9]{1,2}, die
 * Bild-URL entsteht aus dem gefilterten Symbol ([A-Za-z0-9.^-]) plus
 * encodeURIComponent. Das echte Logo (Owner 20.08., Reddit-Screenshot)
 * liegt ÜBER dem Monogramm; lädt es nicht, entfernt die Fehler-Delegation
 * das Bild und das Monogramm bleibt sichtbar.
 */
export function symbolAvatar(symbol: string, klein = false): string {
  const rein = symbol.replace(/[^A-Za-z0-9.^-]/g, '').toUpperCase();
  return (
    `<span class="sym-av f${symbolTon(symbol)}${klein ? ' sm' : ''}" aria-hidden="true">` +
    `${symbolMonogramm(symbol)}` +
    `<img class="sym-logo" loading="lazy" alt="" src="${LOGO_BASIS}/?symbol=${encodeURIComponent(rein)}">` +
    `</span>`
  );
}

/**
 * Einmalig beim Boot: kaputte Logo-Bilder still entfernen (Capture-Phase,
 * error-Events bubbeln nicht) — darunter steht immer das Monogramm.
 */
export function installiereLogoFallback(): void {
  document.addEventListener(
    'error',
    (e) => {
      const ziel = e.target;
      if (ziel instanceof HTMLImageElement && ziel.classList.contains('sym-logo')) ziel.remove();
    },
    true,
  );
}
