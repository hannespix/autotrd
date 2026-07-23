/**
 * M1-Shell: Login-Screen (E-Mail+Passwort, Google) → leere Dashboard-Shell.
 * Das eigentliche Dashboard (Frosted Aurora, Charts) wird in M3 aus
 * reference/scripts/static/index.html portiert — hier absichtlich minimal.
 */

import './style.css';
import { DEFAULT_STRATEGY, resolveName, type Quote } from '@autotrd/shared';
import { doc, onSnapshot } from 'firebase/firestore';
import { db, hasFirebaseConfig } from './firebase.js';
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

/** Aktive market/**-Listener — beim Logout/Re-Render sauber lösen (keine Leaks). */
let tileUnsubs: Array<() => void> = [];

function clearTileWatchers(): void {
  for (const u of tileUnsubs) u();
  tileUnsubs = [];
}

function renderShell(email: string): void {
  const symbols = DEFAULT_STRATEGY.watchlist;
  app.innerHTML = `
    <header class="topbar">
      <span class="brand">autotrd</span>
      <span class="spacer"></span>
      <span class="user" title="${email}">${email}</span>
      <button type="button" id="logoutBtn">Abmelden</button>
    </header>
    <main class="center">
      <div class="stack">
        <section class="tiles" id="tiles" aria-label="Watchlist"></section>
        <section class="card">
          <h2>Dashboard</h2>
          <p>Kurse aktualisieren sich live aus <code>market/**</code>
             (zentraler 5-min-Scan). Das volle Frosted-Aurora-Dashboard
             folgt mit Milestone M3.</p>
          <p class="sub">Paper-Startkapital (Default):
             $${DEFAULT_STRATEGY.broker.initialCapital.toLocaleString('en-US')}</p>
        </section>
      </div>
    </main>`;

  const grid = document.querySelector<HTMLElement>('#tiles')!;
  for (const sym of symbols) {
    const tile = document.createElement('article');
    tile.className = 'tile';
    tile.innerHTML = `
      <div class="tile-head">
        <span class="tile-sym"></span>
        <span class="delta"></span>
      </div>
      <div class="tile-name muted"></div>
      <div class="tile-price">—</div>
      <div class="tile-time muted"></div>`;
    tile.querySelector('.tile-sym')!.textContent = sym;
    tile.querySelector('.tile-name')!.textContent = resolveName(sym);
    grid.appendChild(tile);

    const unsub = onSnapshot(doc(db(), 'market', sym), (snap) => {
      const quote = snap.get('quote') as Quote | undefined;
      if (!quote) return;
      const price = tile.querySelector<HTMLElement>('.tile-price')!;
      const delta = tile.querySelector<HTMLElement>('.delta')!;
      const time = tile.querySelector<HTMLElement>('.tile-time')!;
      price.textContent = quote.price.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      const pct = quote.changePct;
      delta.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)} %`;
      delta.classList.toggle('up', pct >= 0);
      delta.classList.toggle('down', pct < 0);
      time.textContent = `Stand ${new Date(quote.updatedAt).toLocaleTimeString('de-DE', {
        hour: '2-digit',
        minute: '2-digit',
      })}`;
    });
    tileUnsubs.push(unsub);
  }

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
    clearTileWatchers();
    if (user) {
      renderShell(user.email ?? user.uid);
    } else {
      renderLogin();
    }
  });
}
