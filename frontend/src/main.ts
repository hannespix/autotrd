/**
 * Einstieg: Auth-Gate → Login (Frosted Aurora) → Dashboard (M3-Port).
 */

import './theme.css';
import { hasFirebaseConfig } from './firebase.js';
import {
  authErrorMessage,
  loginEmail,
  loginGoogle,
  registerEmail,
  resetPassword,
  watchAuth,
} from './auth.js';
import { ensureProfile, listenerCount } from './data.js';
import { muxIsLeader } from './mux.js';
import { mountDashboard, unmountDashboard } from './dashboard.js';
import { mountLegalFooter } from './legal.js';

// Leak-/Mux-Nachweis (M9-Abnahme): aktive Firestore-Listener zählbar machen
// + Leader-Status des Fensters (BroadcastChannel-Multiplexing)
(window as unknown as {
  __autotrd: { listenerCount: () => number; muxIsLeader: () => boolean };
}).__autotrd = { listenerCount, muxIsLeader };

// Theme früh setzen (localStorage), Default dunkel
document.documentElement.dataset.theme = localStorage.getItem('autotrd-theme') ?? 'dark';

const app = document.querySelector<HTMLDivElement>('#app')!;

function renderSetupHint(): void {
  app.innerHTML = `
    <main class="center">
      <section class="card auth-card" aria-labelledby="t">
        <h1 id="t">autotrd</h1>
        <p>Firebase-Web-Config fehlt. Für die lokale Entwicklung:</p>
        <ol style="padding-left:1.2rem">
          <li>Firebase-Projekt anlegen (siehe docs/SETUP.md)</li>
          <li><code>.env.example</code> → <code>frontend/.env.local</code> kopieren und
              die <code>VITE_FIREBASE_*</code>-Werte eintragen</li>
          <li><code>npm run dev -w frontend</code> neu starten</li>
        </ol>
      </section>
    </main>`;
}

function renderLogin(): void {
  app.innerHTML = `
    <main class="center">
      <section class="card auth-card" aria-labelledby="t">
        <h1 id="t">AUTO<span class="c-gn">TRD</span></h1>
        <p class="sub">Paper-Daytrading · kein Finanzrat</p>
        <form id="loginForm" novalidate>
          <label for="email">E-Mail</label>
          <input id="email" name="email" class="inp" type="email" autocomplete="email" required />
          <label for="password">Passwort</label>
          <input id="password" name="password" class="inp" type="password" autocomplete="current-password" minlength="6" required />
          <p id="err" class="error" role="alert" hidden></p>
          <p id="info" class="hint" role="status" hidden></p>
          <div class="row">
            <button type="submit" class="btn btn-g">Anmelden</button>
            <button type="button" id="registerBtn" class="btn btn-n">Registrieren</button>
          </div>
          <button type="button" id="resetBtn" class="btn btn-n" style="width:100%;margin-top:8px;font-size:11px">Passwort vergessen?</button>
        </form>
        <div class="divider" role="separator">oder</div>
        <button type="button" id="googleBtn" class="btn btn-n" style="width:100%">Mit Google anmelden</button>
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
  document.querySelector('#registerBtn')!.addEventListener('click', () => {
    err.hidden = true;
    const { email, password } = fields();
    registerEmail(email, password).catch(showError);
  });
  document.querySelector('#googleBtn')!.addEventListener('click', () => {
    err.hidden = true;
    loginGoogle().catch(showError);
  });
  document.querySelector('#resetBtn')!.addEventListener('click', () => {
    err.hidden = true;
    const info = document.querySelector<HTMLParagraphElement>('#info')!;
    const { email } = fields();
    if (!email) {
      err.textContent = 'Bitte oben die E-Mail-Adresse eintragen.';
      err.hidden = false;
      return;
    }
    resetPassword(email)
      .then(() => {
        info.textContent = 'Passwort-Reset-Mail ist unterwegs (Spam-Ordner prüfen).';
        info.hidden = false;
      })
      .catch(showError);
  });
}

if (!hasFirebaseConfig()) {
  renderSetupHint();
} else {
  watchAuth((user) => {
    unmountDashboard();
    if (user) {
      // Profil serverseitig sicherstellen (idempotent), dann Dashboard
      ensureProfile().catch((e) => console.warn('ensureProfile', e));
      mountDashboard(app, user.uid, user.email ?? user.uid);
    } else {
      renderLogin();
    }
  });
}
