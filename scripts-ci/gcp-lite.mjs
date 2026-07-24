/**
 * Dependency-freie GCP-Auth für CI-Scripte (kein npm ci nötig — wichtig für
 * den Scan-Watchdog, der alle 30 min läuft und in Sekunden fertig sein muss).
 *
 * Implementiert den Standard-JWT-Bearer-Flow mit node:crypto:
 *   - mintAccessToken(): OAuth2-Access-Token (Scope cloud-platform)
 *   - mintIdToken(audience): OIDC-ID-Token für Cloud-Run-Aufrufe
 * Der Private Key verlässt den Prozess nie und wird nie geloggt.
 */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function readServiceAccount() {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!path) throw new Error('GOOGLE_APPLICATION_CREDENTIALS ist nicht gesetzt');
  const sa = JSON.parse(readFileSync(path, 'utf8'));
  if (!sa.client_email || !sa.private_key) {
    throw new Error('Service-Account-JSON ohne client_email/private_key');
  }
  return sa;
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signJwt(sa, claims) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(sa.private_key).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

async function exchange(assertion) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Token-Exchange fehlgeschlagen (${res.status}): ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

/** OAuth2-Access-Token für Google-REST-APIs (Cloud Run, Scheduler, …). */
export async function mintAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJwt(sa, {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });
  const data = await exchange(jwt);
  return data.access_token;
}

/** OIDC-ID-Token, mit dem der SA einen privaten Cloud-Run-Service aufrufen darf. */
export async function mintIdToken(sa, audience) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJwt(sa, {
    iss: sa.client_email,
    target_audience: audience,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });
  const data = await exchange(jwt);
  return data.id_token;
}

/** JSON-Fetch mit Bearer-Token; wirft bei !ok mit kompakter Fehlermeldung. */
export async function gfetch(url, { token, method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function projectFromFirebaserc() {
  return JSON.parse(readFileSync('.firebaserc', 'utf8')).projects.default;
}
