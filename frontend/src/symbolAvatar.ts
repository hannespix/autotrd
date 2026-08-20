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
 * Logo-Lager: EIN Abruf je Symbol pro Sitzung, Ergebnis als blob-URL.
 *
 * Owner-Befund 20.08. („Logos kurz da, dann durch Buchstaben ersetzt"):
 * Die Listen bauen sich im Kurs-Takt per innerHTML neu — direkte
 * <img src=Proxy>-Elemente wurden dabei mitten im Laden abgeräumt, der
 * abgebrochene Request feuerte `error`, die Delegation entfernte das Bild,
 * und das Spiel begann von vorn. Deshalb hängt am Chip-HTML KEIN
 * Netzwerk-Bild mehr: `schmueckeAvatare()` holt jedes Logo genau einmal,
 * lagert es als blob-URL und setzt es nach jedem Re-Render aus dem Lager
 * ein — ohne Netzwerk, ohne Abbruch, ohne Flackern.
 */
const logoLager = new Map<string, string | null>();
const logoLaeuft = new Map<string, Promise<void>>();
const fehlversuche = new Map<string, number>();

/** Das fertige Logo GEZIELT in alle Chips genau dieses Symbols einsetzen. */
function schmueckeSymbol(sym: string): void {
  const url = logoLager.get(sym);
  if (!url) return;
  const auswahl = `.sym-av[data-logo-sym="${CSS.escape(sym)}"]`;
  for (const chip of document.querySelectorAll<HTMLElement>(auswahl)) {
    if (chip.querySelector('.sym-logo')) continue;
    const img = document.createElement('img');
    img.className = 'sym-logo';
    img.alt = '';
    img.src = url;
    chip.appendChild(img);
  }
}

function ladeLogo(sym: string): void {
  if (logoLaeuft.has(sym)) return;
  logoLaeuft.set(
    sym,
    (async () => {
      try {
        const res = await fetch(`${LOGO_BASIS}/?symbol=${encodeURIComponent(sym)}`);
        if (!res.ok) {
          logoLager.set(sym, null);
          return;
        }
        const blob = await res.blob();
        if (!blob.type.startsWith('image/') || blob.size < 50) {
          logoLager.set(sym, null);
          return;
        }
        logoLager.set(sym, URL.createObjectURL(blob));
        // GEZIELT nachrüsten — bewusst KEIN globaler Pass: Der rief sich
        // über die then-Ketten vielfach selbst und verstopfte bei vielen
        // Symbolen den Haupt-Thread (Owner-Vorfall 21.08.: „Tool hängt").
        schmueckeSymbol(sym);
      } catch {
        // Netz-Blip: bis zu drei Versuche über spätere Pässe, dann Ruhe.
        const n = (fehlversuche.get(sym) ?? 0) + 1;
        fehlversuche.set(sym, n);
        if (n >= 3) logoLager.set(sym, null);
      } finally {
        logoLaeuft.delete(sym);
      }
    })(),
  );
}

/**
 * Nach jedem Listen-Render aufrufen. Render-Stürme werden auf EINEN Pass
 * je Frame koalesziert; je Symbol läuft höchstens ein Abruf, und fertige
 * Abrufe rüsten ihre Chips gezielt nach — nie über einen globalen Pass.
 */
let passGeplant = false;

export function schmueckeAvatare(): void {
  if (passGeplant) return;
  passGeplant = true;
  requestAnimationFrame(() => {
    passGeplant = false;
    for (const chip of document.querySelectorAll<HTMLElement>('.sym-av[data-logo-sym]')) {
      if (chip.querySelector('.sym-logo')) continue;
      const sym = chip.dataset['logoSym'];
      if (!sym) continue;
      const url = logoLager.get(sym);
      if (url) {
        const img = document.createElement('img');
        img.className = 'sym-logo';
        img.alt = '';
        img.src = url;
        chip.appendChild(img);
      } else if (url === undefined) {
        ladeLogo(sym);
      }
    }
  });
}

/**
 * Fertiges Chip-HTML — inhärent escaped: Monogramm ist [A-Z0-9]{1,2}, das
 * data-Attribut trägt nur [A-Z0-9.^-]. Liegt das Logo schon im Lager,
 * kommt es sofort mit (blob-URL, kein Netzwerk); sonst rüstet
 * schmueckeAvatare() nach.
 */
export function symbolAvatar(symbol: string, klein = false): string {
  const rein = symbol.replace(/[^A-Za-z0-9.^-]/g, '').toUpperCase();
  const url = logoLager.get(rein);
  const bild = url ? `<img class="sym-logo" alt="" src="${url}">` : '';
  return (
    `<span class="sym-av f${symbolTon(symbol)}${klein ? ' sm' : ''}" data-logo-sym="${rein}" aria-hidden="true">` +
    `${symbolMonogramm(symbol)}${bild}</span>`
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
