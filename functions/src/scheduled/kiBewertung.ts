/**
 * kiBewertung — KI-Kaskade Stufe 3 (08.10.): bewertet KI-Urteile nach ihrem
 * Horizont gegen den Markt, netto nach Kosten, und schreibt daraus das
 * Gewicht der KI-Stimme, den Wochenbericht und den Untätigkeits-Alarm.
 *
 * Läuft werktags 16:45 ET — nach dem Tagesschluss und nach evalForecasts.
 * Regeln (Begründung in shared/src/kiBewertung.ts):
 *   - Gate: End-Tag realisiert UND strikt vor heute. Nie mit Lücken bewerten.
 *   - Jedes Urteil bekommt genau EINE Bewertung (`bewertung`-Feld am
 *     Dokument); Zähler in meta/kiStats per increment im selben Batch
 *     (dieselbe Disziplin wie evalForecasts: Marker und Aggregat zusammen).
 *   - Gewicht nur aus `wirksam` (hätte in Stufe 2b handeln dürfen).
 *   - meta/kiStats ist öffentlich (meta/**): nur Summen, keine Konten.
 */
import { FieldPath, FieldValue, getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  bewerteKiWirkung,
  bewerteUrteil,
  bucketsFuer,
  fallKennzahlen,
  fallSchluessel,
  isoWocheEt,
  KI_BEWERTUNG_V,
  KI_GEWICHT_BUCKET,
  KI_HOLDOUT_BUCKET,
  kiGewicht,
  kostenRateFuer,
  naechsterAktivitaetsZustand,
  wochenNachricht,
  type AktivitaetZustand,
  type KiFallStat,
  type KiUrteilRoh,
  type KiWirkungTag,
} from '../../../shared/src/index.js';
import { getMarketSnapshot } from '../core/marketData.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';

/** Fenster, in dem offene Urteile gesucht werden — älter ist längst verfallen oder bewertet. */
export const KI_BEWERTUNG_FENSTER_TAGE = 45;
const BATCH_LIMIT = 300;

export interface KiBewertungResult {
  gelesen: number;
  offen: number;
  bewertet: number;
  /** Bewertet, aber nicht gezählt — Geschwister desselben Falls (Symbol, Bezugstag). */
  doppelt: number;
  verfallen: number;
  uebersprungen: number;
  gewicht: number;
  wirkungAlarm: boolean;
  wocheGemeldet: boolean;
}

/** Zähler verwerfen, wenn die Rechnung eine andere Fassung hat (wie pruefeFassung bei den Prognosen). */
export function zaehlerVerwerfen(kiV: unknown): boolean {
  return typeof kiV === 'number' && kiV !== KI_BEWERTUNG_V;
}

const leer = (): KiFallStat => ({ n: 0, treffer: 0, nettoSum: 0, bruttoSum: 0, nMarkt: 0, trefferMarkt: 0, ueberMarktSum: 0 });

export async function runKiBewertung(now = new Date()): Promise<KiBewertungResult> {
  const db = getFirestore();
  const today = now.toISOString().slice(0, 10);
  const statsRef = db.doc('meta/kiStats');

  const vorher = await statsRef.get();
  if (zaehlerVerwerfen(vorher.get('kiV'))) {
    logger.warn(`kiBewertung: Fassung ${String(vorher.get('kiV'))} ≠ ${KI_BEWERTUNG_V} — Zähler werden verworfen`);
    await statsRef.set({ kiV: KI_BEWERTUNG_V, faelle: {}, verworfenAt: now.toISOString() }, { merge: true });
  } else if (!vorher.exists) {
    await statsRef.set({ kiV: KI_BEWERTUNG_V }, { merge: true });
  }

  /* Zwei Quellen (Red-Team 08.10., B4): Die indizierte Abfrage über
   * `bewertet == false` (Urteile tragen das Feld seit Stufe 3 bei der Anlage)
   * und — bis der Altbestand durch ist — ein Fenster über `decidedAt` für
   * Dokumente OHNE das Feld. Ohne den Index-Pfad lieferte das Fenster bei
   * mehr als 300 Urteilen in 45 Tagen immer dieselben ältesten, schon
   * markierten Dokumente, und neue kamen erst mit Wochen Verzug dran. */
  const coll = db.collection('kiUrteile');
  let indiziert: FirebaseFirestore.QuerySnapshot | null = null;
  try {
    indiziert = await coll.where('bewertet', '==', false).orderBy('decidedAt', 'asc').limit(BATCH_LIMIT).get();
  } catch (err) {
    logger.warn('kiBewertung: Index (bewertet, decidedAt) noch nicht bereit — nur Fenster', err);
  }
  const seit = new Date(now.getTime() - KI_BEWERTUNG_FENSTER_TAGE * 86_400_000).toISOString();
  const fenster = await coll.where('decidedAt', '>=', seit).orderBy('decidedAt', 'asc').limit(BATCH_LIMIT).get();

  const offenNachSymbol = new Map<string, Array<{ ref: FirebaseFirestore.DocumentReference; u: KiUrteilRoh; alt: boolean }>>();
  const gesehen = new Set<string>();
  const aufnehmen = (d: FirebaseFirestore.QueryDocumentSnapshot, alt: boolean): void => {
    if (gesehen.has(d.id)) return;
    gesehen.add(d.id);
    if (d.get('bewertung')) return; // genau eine Bewertung je Urteil
    const u = d.data() as KiUrteilRoh;
    const symbol = typeof u.symbol === 'string' ? u.symbol : null;
    if (!symbol) return;
    const list = offenNachSymbol.get(symbol) ?? [];
    list.push({ ref: d.ref, u, alt });
    offenNachSymbol.set(symbol, list);
  };
  for (const d of indiziert?.docs ?? []) aufnehmen(d, false);
  // Altbestand: nur Dokumente ohne das Feld — die mit `bewertet` kennt der Index.
  for (const d of fenster.docs) if (d.get('bewertet') === undefined) aufnehmen(d, true);
  const gelesen = (indiziert?.size ?? 0) + fenster.size;

  let offen = 0;
  let bewertet = 0;
  let doppelt = 0;
  let verfallen = 0;
  let uebersprungen = 0;
  // Fälle dieses Laufs (Symbol|Bezugstag) — Geschwister zählen nicht doppelt.
  const faelleImLauf = new Set<string>();
  const fallSchonGezaehlt = async (key: string): Promise<boolean> => {
    if (faelleImLauf.has(key)) return true;
    const snap = await coll.where('fall', '==', key).limit(1).get();
    return !snap.empty;
  };

  for (const [symbol, liste] of offenNachSymbol) {
    let schluesse: Array<{ date: string; close: number }>;
    try {
      const s = await getMarketSnapshot(symbol, '3mo');
      schluesse = s.bars.map((b) => ({ date: b.date, close: b.close }));
    } catch (err) {
      // Ohne Kurse weiß der Lauf nichts — nicht verfallen, nächstes Mal erneut (Lehre aus evalForecasts B1).
      logger.warn(`kiBewertung: keine Kurse für ${symbol}`, err);
      offen += liste.length;
      continue;
    }
    const kosten = kostenRateFuer(symbol);
    const batch = db.batch();
    const delta = new Map<string, KiFallStat>();
    let schreibt = false;
    for (const { ref, u, alt } of liste) {
      const r = bewerteUrteil(u, schluesse, kosten, today);
      if (r.stand === 'offen') {
        offen += 1;
        // Altbestand bekommt das Feld, damit ihn ab jetzt der Index findet.
        if (alt) {
          batch.update(ref, { bewertet: false });
          schreibt = true;
        }
        continue;
      }
      schreibt = true;
      const key = fallSchluessel(u);
      const istDoppelt = r.stand === 'bewertet' && key !== null && (await fallSchonGezaehlt(key));
      batch.update(ref, {
        bewertet: true,
        ...(key !== null && r.stand === 'bewertet' && !istDoppelt ? { fall: key } : {}),
        bewertung: { ...r, v: KI_BEWERTUNG_V, at: now.toISOString(), ...(istDoppelt ? { doppelt: true } : {}) },
      });
      if (r.stand === 'verfallen') verfallen += 1;
      else if (r.stand === 'uebersprungen') uebersprungen += 1;
      else if (istDoppelt) doppelt += 1;
      else {
        bewertet += 1;
        if (key !== null) faelleImLauf.add(key);
        for (const b of bucketsFuer(u)) {
          const d = delta.get(b) ?? leer();
          d.n += 1;
          d.treffer += r.treffer ? 1 : 0;
          d.nettoSum += r.nettoPct;
          d.bruttoSum += r.bruttoPct;
          if (r.ueberMarktPct !== null) {
            // Benchmark (Stufe 4a): netto über der Markt-Drift in Urteilsrichtung.
            d.nMarkt = (d.nMarkt ?? 0) + 1;
            d.trefferMarkt = (d.trefferMarkt ?? 0) + (r.ueberMarktPct > 0 ? 1 : 0);
            d.ueberMarktSum = (d.ueberMarktSum ?? 0) + r.ueberMarktPct;
          }
          delta.set(b, d);
        }
      }
    }
    if (!schreibt) continue;
    if (delta.size > 0) {
      const args: unknown[] = [new FieldPath('updatedAt'), now.toISOString()];
      for (const [b, d] of delta) {
        args.push(new FieldPath('faelle', b, 'n'), FieldValue.increment(d.n));
        args.push(new FieldPath('faelle', b, 'treffer'), FieldValue.increment(d.treffer));
        args.push(new FieldPath('faelle', b, 'nettoSum'), FieldValue.increment(Math.round(d.nettoSum * 1e4) / 1e4));
        args.push(new FieldPath('faelle', b, 'bruttoSum'), FieldValue.increment(Math.round(d.bruttoSum * 1e4) / 1e4));
        args.push(new FieldPath('faelle', b, 'nMarkt'), FieldValue.increment(d.nMarkt ?? 0));
        args.push(new FieldPath('faelle', b, 'trefferMarkt'), FieldValue.increment(d.trefferMarkt ?? 0));
        args.push(new FieldPath('faelle', b, 'ueberMarktSum'), FieldValue.increment(Math.round((d.ueberMarktSum ?? 0) * 1e4) / 1e4));
      }
      (batch.update as (...a: unknown[]) => unknown)(statsRef, ...args);
    }
    await batch.commit();
  }

  // Gewicht aus dem Stand NACH den Inkrementen — nur aus dem Gewichts-Bucket
  // (tatsächlich abgegebene Long-Stimmen).
  const stand = await statsRef.get();
  const faelle = (stand.get('faelle') as Record<string, Partial<KiFallStat>> | undefined) ?? {};
  const gewicht = kiGewicht(faelle[KI_GEWICHT_BUCKET]);

  // Untätigkeits-Alarm: Tagesdelta der Scan-Zähler (`wirkung`, per increment
  // aus dem Scan) gegen den gestrigen Stand, letzte fünf Handelstage halten.
  const wirkung = (stand.get('wirkung') as { lageScans?: number; aktionen?: number } | undefined) ?? {};
  const wirkungStand = (stand.get('wirkungStand') as { lageScans?: number; aktionen?: number } | undefined) ?? {};
  const tagDelta: KiWirkungTag = {
    tag: today,
    lageScans: Math.max(0, (wirkung.lageScans ?? 0) - (wirkungStand.lageScans ?? 0)),
    aktionen: Math.max(0, (wirkung.aktionen ?? 0) - (wirkungStand.aktionen ?? 0)),
  };
  const tageAlt = ((stand.get('wirkungTage') as KiWirkungTag[] | undefined) ?? []).filter((t) => t.tag !== today);
  const tage = [...tageAlt, tagDelta].sort((a, b) => (a.tag < b.tag ? -1 : 1)).slice(-5);
  const urteil = bewerteKiWirkung(tage);
  const healthRef = db.doc('meta/health');
  const health = await healthRef.get();
  const zustand: AktivitaetZustand = naechsterAktivitaetsZustand(
    health.get('kiWirkung') as AktivitaetZustand | undefined,
    urteil,
    now.toISOString(),
  );

  // Wochenbericht an die Admins — einmal je ISO-Woche, freitags nach dem Schluss.
  const woche = isoWocheEt(now.getTime());
  const wochentagEt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(now);
  let wocheGemeldet = false;
  if (wochentagEt === 'Fri' && stand.get('wocheGemeldet') !== woche) {
    const text = wochenNachricht(woche, faelle[KI_GEWICHT_BUCKET], faelle['gesamt'], gewicht, faelle[KI_HOLDOUT_BUCKET]);
    const admins = await db.collection('users').where('admin', '==', true).get();
    for (const a of admins.docs) {
      await a.ref.collection('nachrichten').add({ von: 'admin', text, at: now.toISOString() }).catch(() => undefined);
    }
    wocheGemeldet = true;
  }

  await statsRef.set(
    {
      kiV: KI_BEWERTUNG_V,
      gewicht,
      at: now.toISOString(),
      letzterLauf: { gelesen, offen, bewertet, doppelt, verfallen, uebersprungen },
      wirkungStand: { lageScans: wirkung.lageScans ?? 0, aktionen: wirkung.aktionen ?? 0, at: now.toISOString() },
      wirkungTage: tage,
      ...(wocheGemeldet ? { wocheGemeldet: woche } : {}),
    },
    { merge: true },
  );
  await healthRef
    .set(
      {
        kiBewertung: {
          at: now.toISOString(),
          bewertet,
          offen,
          verfallen,
          gewicht,
          faelleWirksam: faelle[KI_GEWICHT_BUCKET]?.n ?? 0,
          faelleGesamt: faelle['gesamt']?.n ?? 0,
          // Stufe 4a: Güte des Gewichts-Buckets und der Holdout-Kontrolle (nur Summen).
          quotePct: fallKennzahlen(faelle[KI_GEWICHT_BUCKET]).quotePct,
          nettoAvgPct: fallKennzahlen(faelle[KI_GEWICHT_BUCKET]).nettoAvgPct,
          ueberMarktQuotePct: fallKennzahlen(faelle[KI_GEWICHT_BUCKET]).ueberMarktQuotePct,
          holdoutN: faelle[KI_HOLDOUT_BUCKET]?.n ?? 0,
          holdoutQuotePct: fallKennzahlen(faelle[KI_HOLDOUT_BUCKET]).quotePct,
          faelleWirksamLong: faelle['wirksam_long']?.n ?? 0,
        },
        kiWirkung: zustand,
      },
      { merge: true },
    )
    .catch((err) => logger.warn('kiBewertung: Herzschlag nicht geschrieben', err));

  // warn, nicht error: Nichts ist kaputt — es wird nur nicht gehandelt (B5).
  if (zustand.aktiv && (health.get('kiWirkung') as AktivitaetZustand | undefined)?.aktiv !== true) {
    logger.warn(`KIWIRKUNG: ${zustand.text}`);
  }
  logger.info(
    `kiBewertung: ${bewertet} bewertet, ${doppelt} doppelt, ${verfallen} verfallen, ${offen} offen, ${uebersprungen} übersprungen, Gewicht ×${gewicht}`,
  );
  return { gelesen, offen, bewertet, doppelt, verfallen, uebersprungen, gewicht, wirkungAlarm: zustand.aktiv, wocheGemeldet };
}

export const kiBewertung = onSchedule(
  {
    schedule: '45 16 * * 1-5',
    timeZone: 'America/New_York',
    retryCount: 0,
    timeoutSeconds: 300,
    memory: '512MiB',
  },
  async () => {
    await runKiBewertung();
  },
);

/** Emulator-Trigger für die lokale Abnahme. */
export const kiBewertungNow = onRequest(EMULATOR_TRIGGER_OPTS, async (_req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'kiBewertungNow ist nur im Emulator verfügbar' });
    return;
  }
  res.json(await runKiBewertung());
});

