/**
 * Rückbau-Werkzeug (03.10.) — läuft NUR auf dem Branch `rueckbau-daten`,
 * wird nie gemergt und danach gelöscht.
 *
 * Modus steht in `ops/rueckbau-modus.txt`. Bisher nur `inventur`: liest
 * Firestore und Alpaca, schreibt NICHTS.
 *
 * Das Repo ist öffentlich, also auch das Actions-Log. Darum stehen dort
 * keine E-Mails und keine uids, sondern nur ein Kurz-Hash der uid. Schlüssel
 * und Secrets werden nie ausgegeben.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore, Timestamp } from 'firebase-admin/firestore';

const modus = readFileSync(new URL('../../ops/rueckbau-modus.txt', import.meta.url), 'utf8').trim();
const sa = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
initializeApp({ projectId: sa.project_id });
const db = getFirestore();

const pseudo = (uid) => createHash('sha256').update(uid).digest('hex').slice(0, 8);
const r2 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) / 100 : x);

/** Tresor-Schlüssel aus dem Secret Manager holen — Wert nie ausgeben. */
async function tresorLaden() {
  const { mintAccessToken } = await import('../../scripts-ci/gcp-lite.mjs');
  const token = await mintAccessToken(sa);
  const url = `https://secretmanager.googleapis.com/v1/projects/${sa.project_id}/secrets/BROKER_MASTER_KEY/versions/latest:access`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return `nicht lesbar (HTTP ${res.status})`;
  const d = await res.json();
  const wert = Buffer.from(d?.payload?.data ?? '', 'base64').toString('utf8').trim();
  if (!wert) return 'leer';
  process.env.BROKER_MASTER_KEY = wert;
  return 'geladen';
}

const UMSTIEG = '2026-09-07';

async function inventur() {
  const tresor = await tresorLaden();
  console.log(`Tresor-Schlüssel: ${tresor}`);

  const lib = '../lib/functions/src/core';
  const { brokerVerbindungLesend } = await import(`${lib}/orderRouting.js`);
  const { alpacaKonto, alpacaPositionen, alpacaFetch } = await import(`${lib}/alpacaBroker.js`);
  const { istVerschluesselt, vaultBereit } = await import(`${lib}/keyVault.js`);
  console.log(`vaultBereit: ${vaultBereit()}`);

  const users = await db.collection('users').get();
  console.log(`Nutzer gesamt: ${users.size}\n`);
  const summe = { running: 0, broker: 0, brokerLesbar: 0, live: 0, archiv: 0, engineSpiegel: 0 };

  for (const u of users.docs) {
    const uid = u.id;
    const d = u.data();
    const zeilen = [];
    const strat = d?.settings?.strategy ?? {};
    const running = strat?.engine?.running === true;
    if (running) summe.running++;
    zeilen.push(
      `access=${d.accessLevel ?? 'approved'} running=${running} paperBalance=${r2(d?.wallet?.paperBalance)}`
      + ` strategieSchluessel=[${Object.keys(strat).sort().join(',')}]`,
    );

    const [pos, archiv, eq, trades] = await Promise.all([
      db.collection(`users/${uid}/positions`).get(),
      db.collection(`users/${uid}/positionsArchiv`).get(),
      db.collection(`users/${uid}/equity`).where(FieldPath.documentId(), '>=', UMSTIEG).get().catch(() => null),
      db.collection(`users/${uid}/trades`).get().catch(() => null),
    ]);
    const engPos = pos.docs.filter((p) => p.get('quelle') === 'engine');
    summe.engineSpiegel += engPos.length;
    const umstiegArchiv = archiv.docs.filter((a) => String(a.get('archivGrund') ?? '').includes('Umstieg'));
    summe.archiv += umstiegArchiv.length;
    zeilen.push(
      `positions=${pos.size} (engine=${engPos.length}) [${pos.docs.map((p) => `${p.id}:${r2(p.get('qty'))}`).join(' ')}]`,
    );
    if (archiv.size) {
      zeilen.push(
        `positionsArchiv=${archiv.size} (Umstieg=${umstiegArchiv.length}) [${umstiegArchiv.map((a) => a.id).join(' ')}]`,
      );
    }
    zeilen.push(`equity ab ${UMSTIEG}: ${eq ? eq.size : '?'} Docs`);
    if (trades) {
      // Alt-Trades tragen `at` als Timestamp; alles andere stammt nicht aus dem Altcode.
      const grenze = Timestamp.fromDate(new Date(`${UMSTIEG}T00:00:00Z`));
      const typ = { ts: 0, tsNeu: 0, anders: 0 };
      const fremdeFelder = new Set();
      for (const t of trades.docs) {
        const at = t.get('at');
        if (at instanceof Timestamp) {
          typ.ts++;
          if (at.toMillis() >= grenze.toMillis()) typ.tsNeu++;
        } else {
          typ.anders++;
          for (const k of Object.keys(t.data())) fremdeFelder.add(k);
        }
      }
      zeilen.push(
        `trades=${trades.size} (at=Timestamp ${typ.ts}, davon ab Umstieg ${typ.tsNeu}; ohne Timestamp ${typ.anders})`
        + (typ.anders ? ` Felder=[${[...fremdeFelder].sort().slice(0, 20).join(',')}]` : ''),
      );
    }

    const brokerDoc = await db.doc(`users/${uid}/private/broker`).get();
    if (brokerDoc.exists) {
      summe.broker++;
      const mode = brokerDoc.get('mode') === 'live' ? 'live' : 'paper';
      if (mode === 'live') summe.live++;
      const geheim = brokerDoc.get('secretKey');
      const v1 = typeof geheim === 'string' && istVerschluesselt(geheim);
      const verb = await brokerVerbindungLesend(uid);
      zeilen.push(`broker: mode=${mode} verschluesselt=${v1} lesbar=${verb !== null}${mode === 'live' ? '  ⚠️ LIVE' : ''}`);
      if (verb) {
        summe.brokerLesbar++;
        try {
          const k = await alpacaKonto(verb.mode, verb.schluessel);
          zeilen.push(`  alpaca: status=${k.status} cash=${r2(k.cash)} equity=${r2(k.equity)}`);
          const ap = await alpacaPositionen(verb.mode, verb.schluessel);
          zeilen.push(`  alpaca-Positionen (${ap.length}): ${ap.map((p) => `${p.symbol}:${r2(p.qty)}${p.seite === 'short' ? 'S' : ''}`).join(' ')}`);
          const roh = await alpacaFetch(verb.mode, '/v2/orders?status=open&limit=500&nested=false', verb.schluessel);
          const orders = Array.isArray(roh) ? roh : [];
          const art = (cid) => (cid.startsWith('atd-') ? 'atd' : /^[A-Za-z0-9]{6,}-/.test(cid) && !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(cid) ? 'alt' : 'sonst');
          const zaehl = { atd: 0, alt: 0, sonst: 0 };
          for (const o of orders) zaehl[art(String(o.client_order_id ?? ''))]++;
          zeilen.push(
            `  offene Orders: ${orders.length} (atd=${zaehl.atd} alt=${zaehl.alt} sonst=${zaehl.sonst}) `
            + orders.map((o) => `${o.symbol}/${o.side}/${o.type}/${o.status}`).join(' '),
          );
        } catch (err) {
          zeilen.push(`  alpaca-Fehler: ${String(err?.message ?? err).slice(0, 160)}`);
        }
      }
    }
    console.log(`── ${pseudo(uid)}\n   ${zeilen.join('\n   ')}`);
  }

  console.log('\nSumme:', JSON.stringify(summe));
  for (const p of ['meta/engineConfig', 'meta/health', 'admin/rueckbau']) {
    const s = await db.doc(p).get();
    console.log(`${p}: ${s.exists ? `vorhanden, Felder=[${Object.keys(s.data() ?? {}).slice(0, 25).join(',')}]` : 'fehlt'}`);
  }
}

if (modus === 'inventur') {
  await inventur();
} else {
  console.error(`Unbekannter Modus „${modus}"`);
  process.exit(1);
}
