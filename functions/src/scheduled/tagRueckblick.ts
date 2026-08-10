/**
 * tagRueckblick — die Tages-Horizont-Kante aus gespeicherter Historie.
 *
 * ── Wozu ──────────────────────────────────────────────────────────────────
 *
 * Der Engpass des Profitabilitäts-Programms ist ein Mess-, kein
 * Handelsproblem. Stand 09.08. live:
 *
 *   live     (Ausstieg am Signal)   roh +0,0217 %   netto −0,3269 %   n=523
 *   live_tag (einen Tag halten)     roh +1,3755 %   netto +0,8755 %   n=2
 *
 * Die Rohkante des Tages-Haltens ist das 63-Fache und die einzige, die die
 * Kosten trägt — aber `live_tag` braucht ein 24 h gereiftes Signal und wächst
 * damit ~250-mal langsamer. Bei n=2 ist der Exit-Umbau nicht beurteilbar.
 *
 * Dieser Lauf holt die Belege aus `market/{sym}/ohlcDaily` nach. Die
 * Zeitlogik liegt NICHT hier, sondern geprüft in shared/tagRueckblick.ts —
 * hier stehen nur Datenbeschaffung, Rotation und Buchführung.
 *
 * ── Was er NICHT kann ─────────────────────────────────────────────────────
 *
 * Er misst den Tages-Horizont, nicht den Vergleich zum 5-Minuten-Ausstieg:
 * Dafür bräuchte es Intraday-Kurse zu jedem historischen Signal, und die
 * liegen nicht Jahre zurück vor. Die Frage, die er beantwortet, ist die
 * entscheidende: Trägt die Kante über einen Tag die Kosten? Der Vergleich
 * gegen den laufenden Stil steht ohnehin live in `signalSchatten.live`.
 */
import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  DEFAULT_STRATEGY,
  type SchattenKlasse,
  allSymbols,
  classify,
  feeRateForClass,
  werteTagRueckblick,
  type TagesKurs,
} from '../../../shared/src/index.js';
import { computeSignal } from '../core/engine.js';
import { DEEP_BACKFILL_V } from '../core/marketData.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';

/**
 * Stand der Rückschau am Symbol-Doc.
 *
 * Erhöhen NUR, wenn sich die RECHNUNG ändert (anderes Fenster, andere
 * Gates) — dann muss das Aggregat zurückgesetzt und alles neu bewertet
 * werden, sonst mischen sich zwei Messungen in einer Zahl.
 */
export const TAG_RUECKBLICK_V = 1;

/**
 * Symbole je Lauf.
 *
 * Der Kostentreiber ist nicht Firestore, sondern die Indikator-Rechnung: je
 * Basistag ein Durchlauf über das 250er-Fenster. Bei `MAX_BASISTAGE` sind das
 * rund 750 Durchläufe je Symbol — für 12 Symbole zusammen deutlich unter
 * einer Sekunde reiner Rechenzeit. Der Deckel schützt also vor allem die
 * Firestore-Lesungen und hält den Lauf berechenbar.
 */
const SYMBOLE_PRO_LAUF = 12;

/**
 * Wie weit zurück bewertet wird — so weit die Historie reicht.
 *
 * Hier standen erst 750 Tage (drei Jahre), mit der Begründung, ältere
 * Marktregime sagten wenig über den heutigen Signalsatz. Die Messung hat dem
 * widersprochen. An SPY, am 09.08. gegen echte Kurse (functions/test/
 * tagRueckblickKosten.test.ts):
 *
 *   Fenster  750:  87 ms   n= 79   netto +0,0332 %   Treffer 44,3 %   ab 2022-07
 *   Fenster 1500:  65 ms   n=103   netto +0,0349 %   Treffer 43,7 %   ab 2019-08
 *   Fenster 3000: 135 ms   n=196   netto +0,0842 %   Treffer 47,4 %   ab 2013-08
 *   Fenster 6000: 241 ms   n=327   netto +0,0958 %   Treffer 50,1 %   ab 2001-09
 *
 * Die Kante wird über 25 Jahre GRÖSSER, nicht kleiner — und das über Dotcom-
 * Nachbeben, 2008, 2020 und 2022 hinweg. Genau die Regime-Vielfalt, die der
 * Verdacht „das ist nur Aufwärtsdrift" braucht, um geprüft zu werden.
 *
 * Kosten sind kein Gegenargument: 241 ms je Symbol, hochgerechnet rund 40 s
 * für den ganzen Katalog bei 540 s Zeitbudget. Die Stichprobe wächst
 * unterlinear (8× Fenster ⇒ 4× n), weil die meisten Tage `hold` sind.
 */
const MAX_BASISTAGE = 6000;

/** Tages-Reihe eines Symbols aus den Jahres-Chunks — aufsteigend, entdoppelt. */
export function reiheAusJahren(
  jahre: Array<Record<string, { close?: number }>>,
): TagesKurs[] {
  const nachDatum = new Map<string, number>();
  for (const jahr of jahre) {
    for (const [datum, ohlc] of Object.entries(jahr)) {
      const c = ohlc?.close;
      if (typeof c === 'number' && Number.isFinite(c) && c > 0) nachDatum.set(datum, c);
    }
  }
  return [...nachDatum.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, close]) => ({ date, close }));
}

export interface TagRueckblickLauf {
  symbole: number;
  bewertet: number;
  uebersprungen: number;
  fehlerhaft: number;
  offen: number;
}

export async function runTagRueckblick(now = new Date()): Promise<TagRueckblickLauf> {
  const db = getFirestore();
  const heuteIso = now.toISOString().slice(0, 10);
  const katalog = allSymbols();

  const marktDocs = await db.collection('market').get();
  const stand = new Map(marktDocs.docs.map((d) => [d.id, d.get('tagRueckblickV') as unknown]));
  /*
   * NUR Symbole mit aktueller Tages-Historie (Nachtrag 09.08.).
   *
   * Ohne diese Bedingung hätte der erste Lauf nach dem Granularitäts-Fix
   * Schaden angerichtet: `DEEP_BACKFILL_V` ging auf 3, weil `range=max`
   * MONATSKERZEN geliefert hatte. Bis alle Symbole neu geholt sind, dauert es
   * mehrere Läufe. Wer noch auf V2 steht, trägt Monatsbars — die Rückschau
   * würde daran jeden Basistag am Lücken-Gate verwerfen, NULL Beiträge
   * liefern und das Symbol trotzdem als bewertet markieren. Es käme dann nie
   * wieder an die Reihe, und die Kante bliebe für immer unvollständig, ohne
   * dass irgendwo ein Fehler stünde.
   */
  const historie = new Map(marktDocs.docs.map((d) => [d.id, d.get('deepBackfillV') as unknown]));
  const offen = katalog.filter(
    (s) => stand.get(s) !== TAG_RUECKBLICK_V && historie.get(s) === DEEP_BACKFILL_V,
  );
  if (offen.length === 0) return { symbole: 0, bewertet: 0, uebersprungen: 0, fehlerhaft: 0, offen: 0 };

  // Rotierend, damit ein dauerhaft scheiterndes Symbol nicht für immer den
  // Kopf der Schlange blockiert (dieselbe Falle wie bei der Intraday-
  // Bewertung am 27.07. und beim Chart-Backfill).
  const stateRef = db.doc('meta/tagRueckblick');
  const vorher = await stateRef.get();
  const cursor = (vorher.get('cursor') as number | undefined) ?? 0;

  let gesamt = (vorher.get('gesamt') as SchattenKlasse | undefined) ?? undefined;
  const klassen: Record<string, SchattenKlasse> =
    (vorher.get('klassen') as Record<string, SchattenKlasse> | undefined) ?? {};
  const gespeicherteRichtung = vorher.get('nachRichtung') as
    { buy?: SchattenKlasse; sell?: SchattenKlasse } | undefined;
  const nachRichtung: { buy: SchattenKlasse | undefined; sell: SchattenKlasse | undefined } = {
    buy: gespeicherteRichtung?.buy,
    sell: gespeicherteRichtung?.sell,
  };

  let bewertet = 0;
  let uebersprungen = 0;
  let fehlerhaft = 0;
  const fertig: string[] = [];

  for (let i = 0; i < Math.min(SYMBOLE_PRO_LAUF, offen.length); i++) {
    const sym = offen[(cursor + i) % offen.length]!;
    try {
      const snap = await db.collection('market').doc(sym).collection('ohlcDaily').get();
      if (snap.empty) { uebersprungen += 1; continue; }
      const volle = reiheAusJahren(
        snap.docs.map((d) => (d.get('days') ?? {}) as Record<string, { close?: number }>),
      );
      // Nur das jüngste Fenster bewerten — und zwar MIT Vorlauf, damit die
      // ersten Basistage nicht an zu wenig Historie scheitern.
      const reihe = volle.slice(-(MAX_BASISTAGE + 260));
      const kl = classify(sym);
      const kosten = feeRateForClass(kl) * 2;

      const e = werteTagRueckblick(
        reihe,
        (closes, preis) =>
          computeSignal(closes, preis, DEFAULT_STRATEGY.indicators, DEFAULT_STRATEGY.signals, null)
            .direction,
        kosten,
        heuteIso,
      );

      /*
       * Zweiter Riegel gegen grobe Kerzen (Nachtrag 09.08.).
       *
       * Der Versions-Filter oben sollte das schon abfangen. Dieser hier greift
       * unabhängig vom Marker und trifft die Sache direkt: Wenn kein einziger
       * Basistag durchkam UND das Lücken-Gate zugeschlagen hat, ist die Reihe
       * nicht täglich — egal was am Symbol-Doc steht. Dann NICHT markieren,
       * sondern beim nächsten Lauf erneut versuchen.
       *
       * Ein Symbol ohne Beiträge, bei dem auch keine Lücke gemeldet wurde, ist
       * dagegen sauber bewertet — es hatte schlicht nur `hold`-Signale. Das
       * darf und muss markiert werden, sonst dreht sich die Rotation ewig.
       */
      if (e.bewertet === 0 && e.ausfaelle.luecke > 0) {
        uebersprungen += 1;
        logger.info(`Tages-Rückblick ${sym}: keine Tagesreihe (${e.ausfaelle.luecke} Lücken)`);
        continue;
      }

      // Aggregat und Marker gehören in EINEN Batch: Bricht der Lauf dazwischen
      // ab, zählte der nächste dasselbe Symbol ein zweites Mal — und die
      // Doppelzählung wäre in der Summe nicht mehr erkennbar.
      //
      // Und die Summen werden erst NACH dem Commit übernommen. Der erste
      // Entwurf addierte davor; scheitert dann der Commit, steckt der Beitrag
      // im Speicher, der Marker aber nicht in der Datenbank — das nächste
      // Symbol schriebe die Summe samt fremdem Beitrag fort, dessen Symbol
      // später erneut bewertet wird. Genau die Doppelzählung, die der Batch
      // verhindern soll, nur eine Ebene höher.
      const neuGesamt = e.klasse.n > 0 ? summiere(gesamt, e.klasse) : gesamt;
      const neuKlasse = e.klasse.n > 0 ? summiere(klassen[kl], e.klasse) : klassen[kl];
      // Getrennt nach Richtung — die Zahl, die Drift von Kante scheidet.
      const neuBuy = summiere(nachRichtung.buy, e.nachRichtung.buy);
      const neuSell = summiere(nachRichtung.sell, e.nachRichtung.sell);

      const batch = db.batch();
      batch.set(db.collection('market').doc(sym), { tagRueckblickV: TAG_RUECKBLICK_V }, { merge: true });
      batch.set(
        stateRef,
        {
          gesamt: neuGesamt ?? { n: 0, summePct: 0, treffer: 0 },
          klassen: neuKlasse ? { ...klassen, [kl]: neuKlasse } : klassen,
          nachRichtung: { buy: neuBuy, sell: neuSell },
          cursor: (cursor + i + 1) % Math.max(1, offen.length),
          at: now.toISOString(),
          version: TAG_RUECKBLICK_V,
          fenster: MAX_BASISTAGE,
        },
        { merge: true },
      );
      await batch.commit();

      gesamt = neuGesamt;
      if (neuKlasse) klassen[kl] = neuKlasse;
      nachRichtung.buy = neuBuy;
      nachRichtung.sell = neuSell;

      bewertet += e.bewertet;
      fertig.push(sym);
    } catch (err) {
      fehlerhaft += 1;
      logger.warn(`Tages-Rückblick ${sym}`, err); // nächster Lauf versucht es erneut
    }
  }

  return {
    symbole: fertig.length,
    bewertet,
    uebersprungen,
    fehlerhaft,
    offen: offen.length - fertig.length,
  };
}

/** Zwei Aggregate zusammenlegen — feldweise, ohne `addiereSchatten` je Beitrag. */
export function summiere(a: SchattenKlasse | undefined, b: SchattenKlasse): SchattenKlasse {
  const k = a ?? { n: 0, summePct: 0, treffer: 0 };
  return {
    n: k.n + b.n,
    summePct: Math.round((k.summePct + b.summePct) * 10_000) / 10_000,
    treffer: k.treffer + b.treffer,
    summeRohPct: Math.round(((k.summeRohPct ?? 0) + (b.summeRohPct ?? 0)) * 10_000) / 10_000,
    nRoh: (k.nRoh ?? 0) + (b.nRoh ?? 0),
  };
}

/**
 * Täglich 18:30 ET — nach momentumRun (18:00), der die ohlcDaily-Lücken füllt.
 * Die Reihenfolge zählt: Ohne Historie hätte dieser Lauf nichts zu bewerten.
 */
export const tagRueckblick = onSchedule(
  {
    schedule: '30 18 * * *',
    timeZone: 'America/New_York',
    retryCount: 0,
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async () => {
    const r = await runTagRueckblick();
    logger.info('Tages-Rückblick', r);
  },
);

/** Manueller Trigger — NUR im Emulator (Abnahme-Verifikation). */
export const tagRueckblickNow = onRequest(EMULATOR_TRIGGER_OPTS, async (_req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'tagRueckblickNow ist nur im Emulator verfügbar' });
    return;
  }
  res.status(200).json(await runTagRueckblick());
});
