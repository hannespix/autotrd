/**
 * M1-Shell: Login-Screen (E-Mail+Passwort, Google) → leere Dashboard-Shell.
 * Das eigentliche Dashboard (Frosted Aurora, Charts) wird in M3 aus
 * reference/scripts/static/index.html portiert — hier absichtlich minimal.
 */

import './style.css';
import { DEFAULT_STRATEGY } from '@autotrd/shared';
import { hasFirebaseConfig } from './firebase.js';
import { authErrorMessage, loginEmail, loginGoogle, logout, registerEmail, watchAuth } from './auth.js';

const app = document.querySelector<HTMLDivElement>('#app')!;

function renderSetupHint(): void {
  app.innerHTML = `
    <main class="center">
      <section class="card" aria-labelledby="t">
        <h1 id="t">autotrd</h1>
        <p>Firebase-Web-Config fehlt. Für die lokale Entwicklung:</p>
        <ol>
          <li>Firebase-Projekt anlegen (siehe MILESTONES M1)</li>
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
      <section class="card" aria-labelledby="t">
        <h1 id="t">autotrd</h1>
        <p class="sub">Paper-Daytrading · kein Finanzrat</p>
        <form id="loginForm" novalidate>
          <label for="email">E-Mail</label>
          <input id="email" name="email" type="email" autocomplete="email" required />
          <label for="password">Passwort</label>
          <input id="password" name="password" type="password" autocomplete="current-password" minlength="6" required />
          <p id="err" class="error" role="alert" hidden></p>
          <div class="row">
            <button type="submit" class="primary">Anmelden</button>
            <button type="button" id="registerBtn">Registrieren</button>
          </div>
        </form>
        <div class="divider" role="separator">oder</div>
        <button type="button" id="googleBtn" class="wide">Mit Google anmelden</button>
      </section>
    </main>`;

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
}

function renderShell(email: string): void {
  app.innerHTML = `
    <header class="topbar">
      <span class="brand">autotrd</span>
      <span class="spacer"></span>
      <span class="user" title="${email}">${email}</span>
      <button type="button" id="logoutBtn">Abmelden</button>
    </header>
    <main class="center">
      <section class="card">
        <h2>Dashboard</h2>
        <p>Angemeldet. Realtime-Marktdaten folgen mit Milestone M2,
           das volle Frosted-Aurora-Dashboard mit M3.</p>
        <p class="sub">Paper-Startkapital (Default):
           $${DEFAULT_STRATEGY.broker.initialCapital.toLocaleString('en-US')}</p>
      </section>
    </main>`;
  document.querySelector('#logoutBtn')!.addEventListener('click', () => {
    logout().catch(() => {
      /* Abmelden schlägt praktisch nie fehl; Zustand regelt watchAuth */
    });
  });
}

if (!hasFirebaseConfig()) {
  renderSetupHint();
} else {
  watchAuth((user) => {
    if (user) {
      renderShell(user.email ?? user.uid);
    } else {
      renderLogin();
    }
  });
}
