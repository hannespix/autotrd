#!/usr/bin/env node
/**
 * Admin-Bootstrap: gibt einem Konto (per E-Mail) das Admin-Recht der App.
 *
 * Owner-Auftrag 02.08.: „habe du das für meinen User erledigen?" — der
 * allererste Admin lässt sich nicht über das adminUsers-Callable ernennen
 * (das verlangt einen bestehenden Admin, Henne-Ei), und der Console-Weg ist
 * fehleranfällig. Dieses Script läuft im Admin-Bootstrap-Workflow mit dem
 * Deploy-Service-Account und setzt `admin: true` auf users/{uid}:
 *
 *   1. UID zur E-Mail über die Identity-Toolkit-Admin-API auflösen.
 *   2. users/{uid} per Firestore-REST patchen — mit existierender
 *      Dokument-Vorbedingung, damit nie ein verwaistes Doc entsteht.
 *
 * Auslösbar nur über workflow_dispatch (Repo-Schreibrecht nötig) — dieselbe
 * Vertrauensstufe wie die Deploys selbst. Danach laufen Ernennungen über
 * die Admin-Karte in der App.
 *
 * Aufruf: node scripts-ci/set-admin.mjs <email>
 */

import {
  gfetch,
  mintAccessToken,
  projectFromFirebaserc,
  readServiceAccount,
} from './gcp-lite.mjs';

const email = (process.argv[2] ?? '').trim().toLowerCase();
if (!email || !email.includes('@')) {
  console.error('Aufruf: node scripts-ci/set-admin.mjs <email>');
  process.exit(1);
}

const project = projectFromFirebaserc();
const token = await mintAccessToken(readServiceAccount());

// 1. E-Mail → UID (Admin-Endpunkt; findet auch unbestätigte Konten)
const lookup = await gfetch(
  `https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:lookup`,
  { token, method: 'POST', body: { email: [email] } },
);
const uid = lookup.users?.[0]?.localId;
if (!uid) {
  console.error(`Kein Auth-Konto für ${email} gefunden — Tippfehler?`);
  process.exit(1);
}

// 2. admin=true aufs bestehende User-Doc (Audit-Stempel wie im Callable)
const doc = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/users/${uid}`;
const mask =
  'updateMask.fieldPaths=admin&updateMask.fieldPaths=adminChangedAt&updateMask.fieldPaths=adminChangedBy';
await gfetch(`${doc}?${mask}&currentDocument.exists=true`, {
  token,
  method: 'PATCH',
  body: {
    fields: {
      admin: { booleanValue: true },
      adminChangedAt: { stringValue: new Date().toISOString() },
      adminChangedBy: { stringValue: 'admin-bootstrap' },
    },
  },
});

// UID nur gekürzt ins Log — das Log ist repo-öffentlich einsehbar.
console.log(`admin=true gesetzt: ${email} (${uid.slice(0, 6)}…)`);
