/**
 * Einstieg: Auth-Gate → Login (Frosted Aurora) → Dashboard (M3-Port).
 */

import './theme.css';
import { hasFirebaseConfig } from './firebase.js';
import {
  authErrorMessage,
  loginEmail,
  loginGoogle,
  logout,
  registerEmail,
  resetPassword,
  watchAuth,
} from './auth.js';
import { ensureProfile, listenerCount } from './data.js';
import { t } from './i18n.js';
import { muxIsLeader } from './mux.js';
import { mountDashboard, unmountDashboard } from './dashboard.js';
import { mountLegalFooter, openLegal } from './legal.js';
import { RISIKO_VERSION } from '@autotrd/shared';
import { initPwa } from './pwa.js';

// Leak-/Mux-Nachweis (M9-Abnahme): aktive Firestore-Listener zählbar machen
// + Leader-Status des Fensters (BroadcastChannel-Multiplexing)
(window as unknown as {
  __autotrd: { listenerCount: () => number; muxIsLeader: () => boolean };
}).__autotrd = { listenerCount, muxIsLeader };

/* Theme so früh wie möglich (kein Falsch-Blitz beim Laden): Eine manuelle
 * Wahl ('light'/'dark' aus Optionen → Anzeige) gilt; sonst folgt die App der
 * SYSTEMEINSTELLUNG (Owner 15.08. — Standard ist 'system'). Die laufende
 * Umschaltung bei Systemwechsel übernimmt dashboard.ts; ohne matchMedia
 * bleibt Dunkel der Rückfall wie bisher. */
const themeWahl = localStorage.getItem('autotrd-theme');
document.documentElement.dataset.theme =
  themeWahl === 'light' || themeWahl === 'dark'
    ? themeWahl
    : window.matchMedia?.('(prefers-color-scheme: dark)')?.matches === false
      ? 'light'
      : 'dark';

// PWA: Service Worker (nur Prod) + Install-Chip
initPwa();

const app = document.querySelector<HTMLDivElement>('#app')!;

function renderSetupHint(): void {
  app.innerHTML = `
    <main class="center">
      <section class="card auth-card" aria-labelledby="t">
        <h1 id="t">autotrd</h1>
        <p>${t('mn.setupFehlt')}</p>
        <ol style="padding-left:1.2rem">
          <li>${t('mn.setupProjekt')}</li>
          <li><code>.env.example</code> → <code>frontend/.env.local</code> ${t('mn.setupKopieren')}</li>
          <li><code>npm run dev -w frontend</code> ${t('mn.setupNeustart')}</li>
        </ol>
      </section>
    </main>`;
}

/**
 * Das Risiko-Tor: Wer angemeldet ist, aber noch kein Profil hat, weil die
 * Bestätigung fehlt (Owner 22.08.).
 *
 * Das passiert genau einmal und nur bei NEUEN Konten — etwa wenn jemand
 * über Google hereinkommt, ohne vorher zugestimmt zu haben. Ohne diese
 * Seite stünde er in einem halb angemeldeten Zustand: eingeloggt, aber
 * ohne Konto, und ohne zu erfahren warum.
 *
 * Die Seite ist bewusst eine SACKGASSE mit genau einem Ausgang. Ein
 * „später"-Knopf wäre die Ausnahme, die den Zweck aufhebt: Ein Konto ohne
 * Zustimmung ist genau das Konto, das zum Problem wird.
 */
function renderRisikoTor(): void {
  app.innerHTML = `
    <main class="center">
      <section class="card auth-card" aria-labelledby="rt">
        <h1 id="rt">AUTO<span class="c-gn">TRD</span></h1>
        <p class="sub">${t('login.risikoTorTitel')}</p>
        <p class="hint" id="rtText"></p>
        <label class="risiko-zeile" for="rtOk">
          <input type="checkbox" id="rtOk" />
          <span id="rtHaken"></span>
        </label>
        <p id="rtErr" class="error" role="alert" hidden></p>
        <div class="row">
          <button type="button" id="rtGo" class="btn btn-g">${t('login.risikoTorWeiter')}</button>
          <button type="button" id="rtOut" class="btn btn-n">${t('opt.abmelden')}</button>
        </div>
      </section>
    </main>`;
  mountLegalFooter(app.querySelector('main')!);
  document.querySelector<HTMLParagraphElement>('#rtText')!.textContent = t('login.risikoTorText');

  const haken = document.querySelector<HTMLSpanElement>('#rtHaken')!;
  haken.textContent = `${t('login.risikoHaken')} `;
  const link = document.createElement('a');
  link.href = '#';
  link.textContent = t('login.risikoLink');
  link.addEventListener('click', (ev) => {
    ev.preventDefault();
    openLegal('disclaimer');
  });
  haken.append(link);

  const fehler = document.querySelector<HTMLParagraphElement>('#rtErr')!;
  document.querySelector('#rtGo')!.addEventListener('click', () => {
    fehler.hidden = true;
    if (!document.querySelector<HTMLInputElement>('#rtOk')!.checked) {
      fehler.textContent = t('login.risikoFehlt');
      fehler.hidden = false;
      return;
    }
    ensureProfile(RISIKO_VERSION)
      .then(() => route())
      .catch((e: unknown) => {
        fehler.textContent = String((e as { message?: string })?.message ?? e);
        fehler.hidden = false;
      });
  });
  document.querySelector('#rtOut')!.addEventListener('click', () => {
    void logout();
  });
}

function renderLogin(): void {
  app.innerHTML = `
    <main class="center">
      <section class="card auth-card" aria-labelledby="t">
        <h1 id="t">AUTO<span class="c-gn">TRD</span></h1>
        <p class="sub">${t('login.sub')}</p>
        <form id="loginForm" novalidate>
          <label for="email">${t('login.email')}</label>
          <input id="email" name="email" class="inp" type="email" autocomplete="email" required />
          <label for="password">${t('login.passwort')}</label>
          <input id="password" name="password" class="inp" type="password" autocomplete="current-password" minlength="6" required />
          <p id="err" class="error" role="alert" hidden></p>
          <p id="info" class="hint" role="status" hidden></p>
          <!-- Risiko-Bestätigung (Owner 22.08.). Sie gilt nur für NEUE
               Konten; wer schon eins hat, meldet sich normal an und wird
               nicht gefragt. Das Häkchen ist die Anzeige — verlangt wird
               die Zustimmung serverseitig bei der Profil-Anlage. -->
          <label class="risiko-zeile" for="risikoOk">
            <input type="checkbox" id="risikoOk" />
            <span id="risikoText"></span>
          </label>
          <div class="row">
            <button type="submit" class="btn btn-g">${t('login.anmelden')}</button>
            <button type="button" id="registerBtn" class="btn btn-n">${t('login.registrieren')}</button>
          </div>
          <button type="button" id="resetBtn" class="btn btn-n" style="width:100%;margin-top:8px;font-size:11px">${t('login.passwortVergessen')}</button>
        </form>
        <div class="divider" role="separator">${t('login.oder')}</div>
        <button type="button" id="googleBtn" class="btn btn-n" style="width:100%">${t('login.mitGoogle')}</button>
      </section>
    </main>`;
  mountLegalFooter(app.querySelector('main')!);

  const form = document.querySelector<HTMLFormElement>('#loginForm')!;
  const err = document.querySelector<HTMLParagraphElement>('#err')!;
  const showError = (e: unknown): void => {
    err.textContent = authErrorMessage(e);
    err.hidden = false;
  };
  const fields = (): { email: string; password: string } => ({
    email: form.email.value.trim(),
    password: form.password.value,
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    err.hidden = true;
    const { email, password } = fields();
    loginEmail(email, password).catch(showError);
  });
  /* Der Hinweis trägt einen echten Link auf den Risikohinweis — „gelesen"
   * bestätigen zu lassen, ohne ihn erreichbar zu machen, wäre eine leere
   * Geste. */
  const risikoText = document.querySelector<HTMLSpanElement>('#risikoText')!;
  risikoText.textContent = `${t('login.risikoHaken')} `;
  const risikoLink = document.createElement('a');
  risikoLink.href = '#';
  risikoLink.textContent = t('login.risikoLink');
  risikoLink.addEventListener('click', (ev) => {
    ev.preventDefault();
    openLegal('disclaimer');
  });
  risikoText.append(risikoLink);

  const risikoOk = (): boolean =>
    document.querySelector<HTMLInputElement>('#risikoOk')!.checked;

  document.querySelector('#registerBtn')!.addEventListener('click', () => {
    err.hidden = true;
    if (!risikoOk()) {
      err.textContent = t('login.risikoFehlt');
      err.hidden = false;
      return;
    }
    const { email, password } = fields();
    registerEmail(email, password).catch(showError);
  });
  document.querySelector('#googleBtn')!.addEventListener('click', () => {
    err.hidden = true;
    /* Auch hier kann ein NEUES Konto entstehen — der Weg über Google ist
     * kein anderer Rechtsvorgang. Wer schon ein Konto hat, wird vom Server
     * ohnehin durchgelassen; das Häkchen kostet ihn einen Klick, und der
     * ist billiger als ein Konto ohne Zustimmung. */
    if (!risikoOk()) {
      err.textContent = t('login.risikoFehlt');
      err.hidden = false;
      return;
    }
    loginGoogle().catch(showError);
  });
  document.querySelector('#resetBtn')!.addEventListener('click', () => {
    err.hidden = true;
    const info = document.querySelector<HTMLParagraphElement>('#info')!;
    const { email } = fields();
    if (!email) {
      err.textContent = t('login.emailFehlt');
      err.hidden = false;
      return;
    }
    resetPassword(email)
      .then(() => {
        info.textContent = t('login.resetUnterwegs');
        info.hidden = false;
      })
      .catch(showError);
  });
}

// Es gibt nur noch eine Ansicht: das Dashboard. Bis 28.07. hing hier ein
// zweiter Zweig für das Strategie-Studio unter '#/strategy'. Das Studio ist
// weg, weil von Hand gebaute Regelbäume als EINZIGES am Selbstoptimierer
// vorbeiliefen — er liest und schreibt `settings.strategy`, Bäume fasst er
// nicht an. Eine gezeichnete Strategie war damit für immer eingefroren und
// beanspruchte trotzdem ihre Symbole exklusiv, verdrängte also genau den
// Pfad, der sich täglich verbessert. Der Regelbaum selbst bleibt — als
// Suchraum für den Optimierer statt als Zeichenfläche.
let currentUser: { uid: string; email: string | null } | null = null;

function route(): void {
  unmountDashboard();
  if (!currentUser) {
    renderLogin();
    return;
  }
  mountDashboard(app, currentUser.uid, currentUser.email ?? currentUser.uid);
}

if (!hasFirebaseConfig()) {
  renderSetupHint();
} else {
  window.addEventListener('hashchange', () => {
    if (currentUser) route();
  });
  watchAuth((user) => {
    currentUser = user ? { uid: user.uid, email: user.email } : null;
    if (user) {
      /* Profil serverseitig sicherstellen (idempotent), dann Dashboard.
       *
       * Die Fassung des Risikohinweises geht IMMER mit: Für ein
       * Bestandskonto kehrt der Server vorher um, für ein neues ist sie
       * Bedingung. Schlägt genau das fehl, gibt es kein Profil — dann
       * legt `renderRisikoTor` die Bestätigung vor, statt den Nutzer in
       * einem halb angemeldeten Zustand stehen zu lassen. */
      ensureProfile(RISIKO_VERSION).catch((e: unknown) => {
        if (String((e as { message?: string })?.message ?? '').includes('risikoBestaetigung')) {
          renderRisikoTor();
          return;
        }
        console.warn('ensureProfile', e);
      });
    }
    route();
  });
}
