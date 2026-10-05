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
import { existsSync, readFileSync } from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore, Timestamp } from 'firebase-admin/firestore';

const modus = readFileSync(new URL('../../ops/rueckbau-modus.txt', import.meta.url), 'utf8').trim();
const sa = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
initializeApp({ projectId: sa.project_id });
const db = getFirestore();

/** Optionale Steuerdateien in `ops/`: eine Zeile je Kurz-Hash. */
const opsListe = (name) => {
  const url = new URL(`../../ops/${name}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, 'utf8').split(/\s+/).filter(Boolean) : [];
};
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

/* Kurz-Hashes der 7 Konten, die vor dem Umstieg (07.09.) die Engine an hatten
 * (6 abgeschaltet + 1 behalten; Quelle: Umstiegs-Log). Am 03.10. laufen genau
 * diese 7 wieder. Sie sind die Liste, die nach dem Rückbau wieder an geht. */
const VOR_UMSTIEG_AN = ['441aa35b', '442ba0ed', '45662a77', '795d6003', '91fd363e', 'b5eb6cb2', 'd733b350'];

/** Alle laufenden Engines anhalten — vorher die Liste in `admin/rueckbau` sichern. */
async function anhalten() {
  const ref = db.doc('admin/rueckbau');
  const laufend = (
    await db.collection('users').where('settings.strategy.engine.running', '==', true).get()
  ).docs.map((d) => d.id);
  const vorher = await ref.get();
  const bisher = vorher.exists ? (vorher.get('engineAnVorRueckbau') ?? []) : [];
  // Vereinigen statt überschreiben: Ein zweiter Lauf (dann ist alles aus)
  // darf die Liste nicht leeren.
  const liste = [...new Set([...bisher, ...laufend])].sort();
  await ref.set(
    { engineAnVorRueckbau: liste, angehaltenAm: new Date().toISOString(), rueckbauAuf: '6f6bb5f' },
    { merge: true },
  );
  const gesichert = (await ref.get()).get('engineAnVorRueckbau') ?? [];
  if (gesichert.length !== liste.length) throw new Error('Sicherung nicht bestätigt — nichts angehalten.');
  console.log(`gesichert in admin/rueckbau: ${gesichert.map(pseudo).sort().join(' ')}`);
  const fremd = gesichert.map(pseudo).filter((h) => !VOR_UMSTIEG_AN.includes(h));
  const fehlt = VOR_UMSTIEG_AN.filter((h) => !gesichert.map(pseudo).includes(h));
  console.log(`Abgleich mit den 7 vor dem Umstieg: zusätzlich=[${fremd.join(' ')}] fehlt=[${fehlt.join(' ')}]`);

  // NUR der Schalter, nichts sonst.
  const batch = db.batch();
  for (const uid of laufend) batch.update(db.doc(`users/${uid}`), { 'settings.strategy.engine.running': false });
  if (laufend.length) await batch.commit();
  const rest = await db.collection('users').where('settings.strategy.engine.running', '==', true).get();
  console.log(`angehalten: ${laufend.length} · laufen danach noch: ${rest.size}`);
  if (rest.size > 0) process.exit(1);
}

const schlafen = (ms) => new Promise((r) => setTimeout(r, ms));
const UMSTIEG_GRUND = 'Umstieg auf den Engine-Takt';
/** Felder, die nur bei Broker-Positionen Sinn haben — im Archiv eines Kontos
 *  OHNE Broker dürfen sie nicht zurück ins Buch, sonst sucht der Scan eine
 *  Order, die es nicht gibt. */
const BROKER_FELDER = ['broker', 'brokerOrderId', 'schutz', 'quelle'];

/** Equity-Docs nach `admin/rueckbau/equity-<uid>/` kopieren, bevor etwas
 *  sie löscht — die Übernahme schneidet die ganze Reihe vor heute ab. */
async function equitySichern(uid, abId = '') {
  const q = db.collection(`users/${uid}/equity`);
  const docs = (abId ? await q.where(FieldPath.documentId(), '>=', abId).get() : await q.get()).docs;
  for (let i = 0; i < docs.length; i += 400) {
    const b = db.batch();
    for (const d of docs.slice(i, i + 400)) b.set(db.doc(`admin/rueckbau/equity-${uid}/${d.id}`), d.data());
    await b.commit();
  }
  const gesichert = await db.collection(`admin/rueckbau/equity-${uid}`).count().get();
  if (gesichert.data().count < docs.length) throw new Error(`Equity-Sicherung ${pseudo(uid)} unvollständig`);
  return docs;
}

/**
 * Bücher auf den alten Stand bringen.
 *  - Konto MIT Broker (nur Papier): alle offenen Orders stornieren, Spiegel
 *    der neuen Engine löschen, dann die alte Depot-Übernahme laufen lassen.
 *  - Konto OHNE Broker: Umstiegs-Archiv zurück nach `positions`.
 * `schreiben=false` gibt nur den Plan aus.
 */
async function wiederherstellen(schreiben) {
  console.log(`Tresor-Schlüssel: ${await tresorLaden()}`);
  const lib = '../lib/functions/src';
  const { brokerVerbindungLesend } = await import(`${lib}/core/orderRouting.js`);
  const { alpacaFetch } = await import(`${lib}/core/alpacaBroker.js`);
  const { adoptBroker } = await import(`${lib}/callable/adoptBroker.js`);
  const { validateStrategy } = await import('../lib/shared/src/index.js');
  const offeneOrders = async (v) => {
    const roh = await alpacaFetch(v.mode, '/v2/orders?status=open&limit=500&nested=false', v.schluessel);
    return Array.isArray(roh) ? roh : [];
  };
  let fehler = 0;
  const ziel = opsListe('rueckbau-ziel.txt');

  for (const u of (await db.collection('users').get()).docs) {
    const uid = u.id;
    if (ziel.length && !ziel.includes(pseudo(uid))) continue;
    const z = [];
    const brokerDoc = await db.doc(`users/${uid}/private/broker`).get();
    const pos = await db.collection(`users/${uid}/positions`).get();
    // Lehnt der ALTE Validator die Strategie ab, überspringt der Scan das Konto still.
    const strategieFehler = validateStrategy(u.get('settings.strategy'));
    if (strategieFehler.length) z.push(`⚠️ Strategie besteht den alten Validator NICHT: ${JSON.stringify(strategieFehler).slice(0, 400)}`);

    if (brokerDoc.exists) {
      const verb = await brokerVerbindungLesend(uid);
      if (!verb) {
        z.push('Broker nicht lesbar — übersprungen');
        fehler++;
      } else if (verb.mode !== 'paper') {
        z.push('Broker LIVE — übersprungen (Rückbau fasst nur Papier an)');
        fehler++;
      } else {
        const offen = await offeneOrders(verb);
        const spiegel = pos.docs.filter((p) => p.get('quelle') === 'engine');
        z.push(`Broker: ${offen.length} offene Order(s) stornieren, ${spiegel.length} Engine-Spiegel löschen, dann Übernahme`);
        if (schreiben) {
          if (offen.length) await alpacaFetch(verb.mode, '/v2/orders', verb.schluessel, { method: 'DELETE' });
          let rest = offen.length ? await offeneOrders(verb) : [];
          for (let i = 0; rest.length && i < 30; i++) {
            await schlafen(2000);
            rest = await offeneOrders(verb);
          }
          if (rest.length) {
            // Ohne leeres Orderbuch keine Übernahme: Ein liegengebliebener
            // Stop würde zur Waise und Exits blockieren.
            z.push(`  ${rest.length} Order(s) nicht storniert — Übernahme NICHT ausgeführt`);
            fehler++;
          } else {
            z.push('  Orderbuch leer');
            const gesichert = await equitySichern(uid);
            z.push(`  ${gesichert.length} Equity-Docs gesichert`);
            const b = db.batch();
            for (const p of spiegel) b.delete(p.ref);
            if (spiegel.length) await b.commit();
            const erg = await adoptBroker.run({ data: {}, auth: { uid, token: {} }, rawRequest: {}, acceptsStreaming: false });
            z.push(`  Übernahme: positionen=${erg.positionen} geloescht=${erg.geloescht} trades=${erg.trades} cash=${r2(erg.cash)} schnitt=${erg.schnitt}`);
          }
        }
      }
    } else {
      const archiv = (await db.collection(`users/${uid}/positionsArchiv`).get()).docs.filter(
        (a) => a.get('archivGrund') === UMSTIEG_GRUND,
      );
      const vorhanden = new Set(pos.docs.map((p) => p.id));
      const zurueck = [];
      for (const a of archiv) {
        if (vorhanden.has(a.id)) {
          z.push(`  ${a.id}: steht schon im Buch — Archiv bleibt, nichts überschrieben`);
          continue;
        }
        const daten = { ...a.data() };
        delete daten.archiviertAm;
        delete daten.archivGrund;
        const entfernt = BROKER_FELDER.filter((f) => f in daten);
        for (const f of entfernt) delete daten[f];
        zurueck.push({ a, daten });
        z.push(`  ${a.id}: qty=${r2(daten.qty)} avgEntry=${r2(daten.avgEntry)} openedAt=${String(daten.openedAt ?? '').slice(0, 10)}${entfernt.length ? ` (entfernt: ${entfernt.join(',')})` : ''}`);
      }
      if (archiv.length) z.unshift(`Archiv → Buch: ${zurueck.length} von ${archiv.length}`);
      if (schreiben && zurueck.length) {
        const b = db.batch();
        for (const { a, daten } of zurueck) {
          b.set(db.doc(`users/${uid}/positions/${a.id}`), daten);
          b.delete(a.ref);
        }
        await b.commit();
        z.push('  zurückgeschrieben');
      }
      /* Die Reihe ab dem Umstieg misst ein Buch OHNE diese Positionen —
       * ein künstlicher Einbruch, dem mit der Rückkehr ein ebenso künstlicher
       * Sprung folgen würde. Nur bei Konten, deren Buch sich hier ändert. */
      if (zurueck.length) {
        const ab = await db.collection(`users/${uid}/equity`).where(FieldPath.documentId(), '>=', UMSTIEG).get();
        z.push(`  Equity ab ${UMSTIEG}: ${ab.size} Docs sichern + löschen`);
        if (schreiben && ab.size) {
          await equitySichern(uid, UMSTIEG);
          const b2 = db.batch();
          for (const d of ab.docs) b2.delete(d.ref);
          await b2.commit();
          z.push('  Equity bereinigt');
        }
      }
    }

    /* Trades der neuen Engine (Marke `engineMode`, schreibt der Altcode nie)
     * würden die alte Reife-, Tuner- und Klassen-Statistik füttern. Laut
     * Bestandsaufnahme gibt es keine — der Schritt ist der Wächter dafür. */
    const engineTrades = await db.collection(`users/${uid}/trades`).where('engineMode', 'in', ['paper', 'live']).get();
    if (engineTrades.size) {
      z.push(`Engine-Trades → tradesArchive: ${engineTrades.size}`);
      if (schreiben) {
        const b3 = db.batch();
        for (const t of engineTrades.docs) {
          if (t.get('engineMode') === 'live') continue; // Echtgeld-Belege nie anfassen
          b3.set(db.doc(`users/${uid}/tradesArchive/${t.id}`), { ...t.data(), archivedAt: new Date().toISOString() });
          b3.delete(t.ref);
        }
        await b3.commit();
      }
    }

    // Equity-Reihe seit dem Umstieg: nur ansehen, Entscheidung nach der Probe.
    const eq = await db.collection(`users/${uid}/equity`).where(FieldPath.documentId(), '>=', '2026-09-01').get();
    if (eq.size) {
      const kurz = (d) => `${d.id}:${r2(d.get('equity'))}/${r2(d.get('balance'))}/${d.get('positionsCount') ?? '?'}${d.get('uebernommen') ? 'U' : ''}`;
      const docs = eq.docs;
      const auswahl = [...docs.slice(0, 8), ...(docs.length > 11 ? [null] : []), ...docs.slice(Math.max(8, docs.length - 3))];
      z.push(`equity ab 01.09. (Datum:Equity/Balance/Pos): ${auswahl.map((d) => (d ? kurz(d) : '…')).join(' ')}`);
      const felder = new Set();
      for (const d of docs) if (d.id >= UMSTIEG) for (const k of Object.keys(d.data())) felder.add(k);
      z.push(`  Felder seit Umstieg: [${[...felder].sort().join(',')}]`);
    }
    if (z.length) console.log(`── ${pseudo(uid)}\n   ${z.join('\n   ')}`);
  }
  console.log(`\nFehler/Übersprungen: ${fehler}`);
  if (fehler) process.exit(1);
}

/** Engines wieder einschalten — genau die Liste aus `admin/rueckbau`. */
async function einschalten() {
  const { isStrategy } = await import('../lib/shared/src/index.js');
  const nochAus = opsListe('rueckbau-noch-aus.txt');
  const liste = ((await db.doc('admin/rueckbau').get()).get('engineAnVorRueckbau') ?? []).filter(
    (uid) => !nochAus.includes(pseudo(uid)),
  );
  console.log(`bleibt vorerst aus: ${nochAus.join(' ') || '-'}`);
  const b = db.batch();
  for (const uid of liste) {
    const u = await db.doc(`users/${uid}`).get();
    const gueltig = isStrategy(u.get('settings.strategy'));
    console.log(`${pseudo(uid)}: access=${u.get('accessLevel') ?? 'approved'} strategieGueltig=${gueltig}`);
    b.update(u.ref, { 'settings.strategy.engine.running': true });
  }
  if (liste.length) await b.commit();
  const an = await db.collection('users').where('settings.strategy.engine.running', '==', true).get();
  console.log(`eingeschaltet: ${liste.length} · laufen jetzt: ${an.size}`);
  await db.doc('admin/rueckbau').set({ eingeschaltetAm: new Date().toISOString() }, { merge: true });
}

/** Nur lesen: offene Orders eines Kontos mit Status, Klasse und Uhr. */
async function ordersDiagnose() {
  await tresorLaden();
  const ziel = readFileSync(new URL('../../ops/rueckbau-ziel.txt', import.meta.url), 'utf8').trim();
  const { brokerVerbindungLesend } = await import('../lib/functions/src/core/orderRouting.js');
  const { alpacaFetch } = await import('../lib/functions/src/core/alpacaBroker.js');
  for (const u of (await db.collection('users').get()).docs) {
    if (pseudo(u.id) !== ziel) continue;
    const v = await brokerVerbindungLesend(u.id);
    const uidSauber = u.id.replace(/[^A-Za-z0-9-]/g, '_');
    const maske = (t) => String(t ?? '').split(uidSauber).join('<uid>').split(u.id).join('<uid>');
    const strat = u.get('settings.strategy') ?? {};
    console.log(`Engine running=${strat?.engine?.running} · risk.abgleich=${JSON.stringify(u.get('risk.abgleich') ?? null).slice(0, 160)}`);
    const pos = await db.collection(`users/${u.id}/positions`).get();
    for (const p of pos.docs) {
      const d = p.data();
      console.log(`  Buch ${p.id}: qty=${d.qty} quelle=${d.quelle ?? '-'} broker=${d.broker ?? '-'} schutz=${maske(JSON.stringify(d.schutz ?? null)).slice(0, 140)}`);
    }
    const uhr = await alpacaFetch(v.mode, '/v2/clock', v.schluessel);
    console.log(`Uhr: is_open=${uhr.is_open} next_open=${uhr.next_open}`);
    const roh = await alpacaFetch(v.mode, '/v2/orders?status=open&limit=500&nested=true', v.schluessel);
    // Was seit Samstag passiert ist: geschlossene Orders der letzten 3 Tage.
    const zu = await alpacaFetch(v.mode, '/v2/orders?status=closed&limit=50&after=2026-10-03T00:00:00Z&direction=asc', v.schluessel);
    for (const o of zu) {
      console.log(`  zu: ${o.symbol} ${o.side} ${o.type} status=${o.status} qty=${o.qty} filled=${o.filled_qty}@${o.filled_avg_price ?? '-'} cid=${maske(o.client_order_id).slice(0, 60)} um=${String(o.updated_at).slice(0, 19)}`);
    }
    const ap = await alpacaFetch(v.mode, '/v2/positions', v.schluessel);
    console.log(`  Alpaca-Positionen: ${ap.map((p) => `${p.symbol}:${p.qty}/frei=${p.qty_available}`).join(' ')}`);
    for (const o of roh) {
      const art = String(o.client_order_id ?? '').startsWith('atd-') ? 'atd' : 'sonst';
      console.log(
        `${o.symbol} ${o.side} ${o.type} class=${o.order_class || '-'} status=${o.status} tif=${o.time_in_force}`
        + ` qty=${o.qty} stop=${o.stop_price} cid=${art}:${maske(o.client_order_id).slice(0, 60)} erstellt=${String(o.created_at).slice(0, 16)}`
        + ` storno_angefragt=${o.canceled_at ?? '-'} legs=${(o.legs ?? []).map((l) => `${l.type}/${l.status}`).join(',') || '-'}`,
      );
    }
  }
}

/** BIL (Geldmarkt-Parkplatz der neuen Engine) über das normale Trade-Callable
 *  verkaufen — dieselben Tore, dasselbe Routing wie ein Klick in der Oberfläche. */
async function bilVerkaufen() {
  await tresorLaden();
  const ziel = opsListe('rueckbau-ziel.txt');
  if (ziel.length !== 1) throw new Error('rueckbau-ziel.txt muss genau ein Konto nennen');
  const { trade } = await import('../lib/functions/src/callable/trade.js');
  for (const u of (await db.collection('users').get()).docs) {
    if (pseudo(u.id) !== ziel[0]) continue;
    const pos = await db.doc(`users/${u.id}/positions/BIL`).get();
    const quote = (await db.doc('market/BIL').get()).get('quote');
    console.log(`BIL im Buch: qty=${pos.get('qty') ?? '-'} broker=${pos.get('broker') ?? '-'} · Kurs ${quote?.price ?? '-'} von ${quote?.updatedAt ?? '-'}`);
    if (!pos.exists) throw new Error('BIL steht nicht im Buch — erst die Übernahme');
    const erg = await trade.run({
      data: { symbol: 'BIL', side: 'sell' },
      auth: { uid: u.id, token: {} },
      rawRequest: {},
      acceptsStreaming: false,
    });
    const t = erg?.trade ?? {};
    // Nicht ausgeführt wirft das Callable (HttpsError) — hier kommt nur Erfolg an.
    console.log(`Verkauf: ok=${erg?.ok} qty=${t.qty ?? '-'} price=${t.price ?? '-'} pnl=${r2(t.pnl)}`);
  }
}

/** Den Schein-Einbruch vom Umstiegstag aus der Equity-Reihe des Ziel-Kontos
 *  nehmen — nur wenn er nachweislich einer ist (nur Cash, Nachbartage >10 % höher). */
async function phantomTag() {
  const ziel = opsListe('rueckbau-ziel.txt');
  for (const u of (await db.collection('users').get()).docs) {
    if (!ziel.includes(pseudo(u.id))) continue;
    const col = db.collection(`users/${u.id}/equity`);
    const [vor, tag, nach] = await Promise.all(['2026-09-06', UMSTIEG, '2026-09-08'].map((d) => col.doc(d).get()));
    const e = (d) => Number(d.get('equity'));
    console.log(`${pseudo(u.id)}: 06.09.=${e(vor)} 07.09.=${e(tag)} (pos=${tag.get('positionsCount')}) 08.09.=${e(nach)}`);
    const phantom = tag.exists && tag.get('positionsCount') === 0 && e(tag) === Number(tag.get('balance'))
      && e(tag) < 0.9 * Math.min(e(vor), e(nach));
    if (!phantom) {
      console.log('  kein eindeutiger Schein-Einbruch — nichts geändert');
      continue;
    }
    await db.doc(`admin/rueckbau/equity-${u.id}/${UMSTIEG}`).set(tag.data());
    await tag.ref.delete();
    console.log(`  ${UMSTIEG} gesichert und entfernt`);
  }
  await inventur();
}

/** Übernahme OHNE Storno: für ein Konto, dessen offene Orders nur noch
 *  eigene Schutz-Stops des alten Codes sind — die erkennt die Übernahme an
 *  der Kennung und hängt sie an die Position, der Schutz bleibt lückenlos. */
async function uebernehmen() {
  await tresorLaden();
  const ziel = opsListe('rueckbau-ziel.txt');
  if (ziel.length !== 1) throw new Error('rueckbau-ziel.txt muss genau ein Konto nennen');
  const { brokerVerbindungLesend } = await import('../lib/functions/src/core/orderRouting.js');
  const { alpacaFetch } = await import('../lib/functions/src/core/alpacaBroker.js');
  const { adoptBroker } = await import('../lib/functions/src/callable/adoptBroker.js');
  for (const u of (await db.collection('users').get()).docs) {
    if (pseudo(u.id) !== ziel[0]) continue;
    const v = await brokerVerbindungLesend(u.id);
    if (!v || v.mode !== 'paper') throw new Error('nur Papier-Konten mit lesbarem Broker');
    const uidSauber = u.id.replace(/[^A-Za-z0-9-]/g, '_');
    const offen = await alpacaFetch(v.mode, '/v2/orders?status=open&limit=500&nested=false', v.schluessel);
    const fremd = offen.filter((o) => !String(o.client_order_id ?? '').startsWith(`${uidSauber}-`));
    console.log(`offene Orders: ${offen.map((o) => `${o.symbol}/${o.type}`).join(' ') || '-'} · fremd: ${fremd.length}`);
    if (fremd.length) throw new Error('fremde offene Orders — erst klären, nichts übernommen');
    const gesichert = await equitySichern(u.id);
    console.log(`${gesichert.length} Equity-Docs gesichert`);
    const erg = await adoptBroker.run({ data: {}, auth: { uid: u.id, token: {} }, rawRequest: {}, acceptsStreaming: false });
    console.log(`Übernahme: positionen=${erg.positionen} geloescht=${erg.geloescht} trades=${erg.trades} cash=${r2(erg.cash)} schnitt=${erg.schnitt}`);
    for (const p of (await db.collection(`users/${u.id}/positions`).get()).docs) {
      console.log(`  Buch ${p.id}: qty=${p.get('qty')} schutz=${p.get('schutz') ? 'verknüpft' : '-'} quelle=${p.get('quelle') ?? '-'}`);
    }
  }
}

if (modus === 'uebernehmen') {
  await uebernehmen();
} else if (modus === 'phantom-tag') {
  await phantomTag();
} else if (modus === 'bil-verkaufen') {
  await bilVerkaufen();
} else if (modus === 'orders-diagnose') {
  await ordersDiagnose();
} else if (modus === 'inventur') {
  await inventur();
} else if (modus === 'anhalten') {
  await anhalten();
} else if (modus === 'wiederherstellen-probe') {
  await wiederherstellen(false);
} else if (modus === 'wiederherstellen') {
  await wiederherstellen(true);
} else if (modus === 'einschalten') {
  await einschalten();
} else {
  console.error(`Unbekannter Modus „${modus}"`);
  process.exit(1);
}
