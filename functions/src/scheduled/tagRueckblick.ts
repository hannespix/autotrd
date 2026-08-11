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
 * Erhöhen, wenn sich die RECHNUNG ändert (anderes Fenster, andere Gates,
 * andere Aufteilung) — sonst mischen sich zwei Messungen in einer Zahl.
 *
 *   V1 (09.08.) Fenster 750 Basistage, nur Gesamt-Aggregat.
 *   V2 (10.08.) Fenster 6000 Basistage plus Trennung nach Richtung.
 *   V3 (10.08.) mehrere Halte-Horizonte (1/2/3/5/10 Handelstage) je Basistag.
 *   V4 (11.08.) Halte-Horizonte zusätzlich JE ANLAGEKLASSE und Richtung.
 *
 * Warum V4 einen vollen Neulauf rechtfertigt, obwohl die Rechnung selbst
 * unverändert ist: Die neue Kreuzung wird von Symbol zu Symbol aufaddiert.
 * Ohne Versionssprung fortgesetzt, enthielte sie nur die Symbole, die nach
 * dem Deploy noch drankamen — und sähe dabei aus wie eine Aussage über den
 * ganzen Katalog. Genau die Verwechslung, gegen die `symbole` eingeführt
 * wurde. Ein Lauf schafft den Katalog inzwischen in einem Stück (132 Symbole
 * am 10.08.), der Neulauf kostet also eine Nacht.
 *
 * Der Sprung auf V2 ist ein Nachtrag: Beim Vertiefen des Fensters hatte ich
 * die Version stehen lassen. Die 12 in der Nacht bewerteten Index-Symbole
 * wären dadurch nie neu gerechnet worden — ihre 534 Beobachtungen aus dem
 * 750er-Fenster hätten sich still mit den neuen aus dem 6000er-Fenster
 * vermischt, und die Kante wäre ein Mittel aus zwei verschiedenen Messungen
 * gewesen. Genau davor warnt dieser Kommentar seit V1.
 */
export const TAG_RUECKBLICK_V = 4;

/**
 * Wie lange ein Lauf höchstens rechnet — statt eines festen Symbol-Deckels.
 *
 * Vorher standen hier 12 Symbole je Lauf. Der Deckel war der eigentliche
 * Engpass des ganzen Vorhabens: Der Lauf ist täglich, der Katalog hat 164
 * Symbole — die Kante über den ganzen Katalog hätte also VIERZEHN Nächte
 * gebraucht. Und bei jedem Versions-Sprung (V1→V2→V3 allein am 10.08.)
 * beginnt die Zählung von vorn. Der Beleg wäre nie fertig geworden.
 *
 * Es gibt keinen Grund dafür. Der Lauf liest gespeicherte Historie und rechnet
 * — keine Kurs-Abrufe, keine Fremd-API. Gemessen (functions/test/
 * tagRueckblickKosten.test.ts, SPY über 25 Jahre): 299 ms je Symbol für alle
 * fünf Horizonte. Für den ganzen Katalog rund 50 s reine Rechenzeit, plus je
 * Symbol eine Lesung der Jahres-Chunks und ein Batch-Commit — zusammen deutlich
 * unter zwei Minuten bei 540 s Zeitbudget der Function.
 *
 * Der Zeitdeckel ersetzt den Zähldeckel, weil er das misst, worauf es ankommt:
 * Ein fester Symbol-Deckel ist entweder zu klein (dauert Wochen) oder bietet
 * keinen Schutz, wenn ein Symbol einmal ungewöhnlich lange braucht. 400 s
 * lassen 140 s Luft bis zum Timeout — genug für den laufenden Commit und das
 * Abschluss-Log.
 *
 * Bricht der Lauf am Budget ab, macht der nächste an der Rotationsstelle
 * weiter; die Marker je Symbol sorgen dafür, dass nichts doppelt zählt.
 */
const ZEITBUDGET_MS = 400_000;

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

/** Ein Horizont-Topf: alle Signale, plus die beiden Richtungen getrennt. */
export type HorizontStand = {
  klasse?: SchattenKlasse;
  buy?: SchattenKlasse;
  sell?: SchattenKlasse;
};

/**
 * Ein Symbol-Ergebnis in einen Horizont-Bestand einrechnen.
 *
 * Herausgezogen, weil es seit V4 an ZWEI Stellen passiert: einmal für den
 * globalen Bestand, einmal für den der Anlageklasse. Zwei Kopien derselben
 * Schleife wären zwei Gelegenheiten, sie verschieden zu ändern — und der
 * Fehler fiele nicht auf, weil beide Zahlen für sich plausibel aussähen.
 * Mit einer gemeinsamen Funktion gilt die Invariante strukturell: Die Summe
 * über alle Klassen ist der globale Bestand.
 */
export function summiereHorizonte(
  alt: Record<string, HorizontStand>,
  neu: Record<number, { klasse: SchattenKlasse; nachRichtung: { buy: SchattenKlasse; sell: SchattenKlasse } }>,
): Record<string, HorizontStand> {
  const out: Record<string, HorizontStand> = { ...alt };
  for (const [tage, h] of Object.entries(neu)) {
    const a = alt[tage];
    out[tage] = {
      klasse: summiere(a?.klasse, h.klasse),
      buy: summiere(a?.buy, h.nachRichtung.buy),
      sell: summiere(a?.sell, h.nachRichtung.sell),
    };
  }
  return out;
}

/** Beide Bestände zusammen — global und je Anlageklasse. */
export interface HorizontBestand {
  global: Record<string, HorizontStand>;
  jeKlasse: Record<string, Record<string, HorizontStand>>;
}

/**
 * Einen Symbol-Beitrag in BEIDE Bestände einrechnen.
 *
 * Warum das eine eigene Funktion ist und nicht zwei Zeilen in der Schleife:
 * Genau diese Komposition ist die Fehlerquelle. Ein vergessener Vorbestand
 * (`summiereHorizonte({}, …)` statt `summiereHorizonte(jeKlasse[klasse] ?? {}, …)`)
 * ließe jedes Symbol den Topf seiner Klasse überschreiben — am Ende stünde
 * dort nur das zuletzt bewertete Symbol, während der globale Bestand
 * vollständig wäre. Beide Zahlen sähen für sich plausibel aus.
 *
 * Ein Test, der die Verteilung selbst nachbaut, findet das nicht. Deshalb
 * geht der Lauf durch diese Funktion, und der Test prüft sie.
 */
export function verteileBeitrag(
  bestand: HorizontBestand,
  klasse: string,
  e: Record<number, { klasse: SchattenKlasse; nachRichtung: { buy: SchattenKlasse; sell: SchattenKlasse } }>,
): HorizontBestand {
  return {
    global: summiereHorizonte(bestand.global, e),
    jeKlasse: {
      ...bestand.jeKlasse,
      [klasse]: summiereHorizonte(bestand.jeKlasse[klasse] ?? {}, e),
    },
  };
}

export async function runTagRueckblick(
  now = new Date(),
  /** Monotone Uhr in ms — als Parameter, damit der Budget-Abbruch prüfbar ist. */
  uhr: () => number = () => Date.now(),
): Promise<TagRueckblickLauf> {
  const db = getFirestore();
  const startMs = uhr();
  const heuteIso = now.toISOString().slice(0, 10);
  const katalog = allSymbols();

  /* `.select(…)` statt des ganzen Dokuments (Audit-Befund 11.08.) —
   * dieselbe Begründung wie in `momentumRun`: Gebraucht werden ZWEI Felder,
   * geholt wurde alles, und mit dem Alpaca-Universum wäre das ein
   * Speicher-Ausfall.
   *
   * Beide Felder müssen dabeistehen. `deepBackfillV` weiter unten ist keine
   * Kür, sondern das Gate, das Symbole mit veralteter Historie draußen hält;
   * fehlt es hier, ist es `undefined` und der Lauf findet gar nichts mehr zu
   * tun. Der Budget-Test hat genau das gefunden. */
  const marktDocs = await db
    .collection('market')
    .select('tagRueckblickV', 'deepBackfillV')
    .get();
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

  /*
   * Bei einem Versionswechsel wird das Aggregat VERWORFEN, nicht fortgesetzt.
   *
   * Die Symbol-Marker sorgen dafür, dass alle Symbole neu bewertet werden;
   * würde die alte Summe stehen bleiben, zählte jedes Symbol zweimal — einmal
   * mit der alten Rechnung, einmal mit der neuen. Das Ergebnis sähe wie eine
   * größere Stichprobe aus und wäre ein Mischmasch aus zwei Messungen.
   */
  const fortsetzen = (vorher.get('version') as number | undefined) === TAG_RUECKBLICK_V;
  let gesamt = fortsetzen ? (vorher.get('gesamt') as SchattenKlasse | undefined) : undefined;
  const klassen: Record<string, SchattenKlasse> = fortsetzen
    ? ((vorher.get('klassen') as Record<string, SchattenKlasse> | undefined) ?? {})
    : {};
  const gespeicherteRichtung = fortsetzen
    ? (vorher.get('nachRichtung') as { buy?: SchattenKlasse; sell?: SchattenKlasse } | undefined)
    : undefined;
  const nachRichtung: { buy: SchattenKlasse | undefined; sell: SchattenKlasse | undefined } = {
    buy: gespeicherteRichtung?.buy,
    sell: gespeicherteRichtung?.sell,
  };
  /**
   * Die Kurve über die Haltedauer: Handelstage → Kante, je Richtung getrennt.
   *
   * Das ist die eigentliche Frage hinter dem Exit-Umbau — nicht „ist ein Tag
   * besser als fünf Minuten", sondern „wie lange halten ist optimal". Sie
   * kostet fast nichts extra: Teuer ist die Indikator-Rechnung am Basistag,
   * und die hängt nicht an der Haltedauer.
   */
  const gespeicherteHorizonte = fortsetzen
    ? (vorher.get('horizonte') as Record<string, HorizontStand> | undefined)
    : undefined;
  const horizonte: Record<string, HorizontStand> = { ...(gespeicherteHorizonte ?? {}) };
  /**
   * Dieselbe Kurve, aber JE ANLAGEKLASSE — die Frage hinter Meilenstein #94.
   *
   * ── Warum die bisherigen Zahlen nicht reichten (Befund 10.08.) ───────────
   *
   * Der erste Katalog-Lauf zeigte Krypto bei −1,06 % netto und −0,56 % roh
   * (n = 3.023) — als einzige Klasse negativ, und zwar schon VOR Kosten. Die
   * naheliegende Antwort wäre „Klasse raus". Nur ist sie aus dieser Zahl
   * nicht ableitbar: `klassen` mischt Kauf- und Verkaufssignale.
   *
   * Global gemessen tragen ausschließlich die Kaufsignale (+0,65 % auf einen
   * Tag), während Verkaufssignale mit jedem Tag Haltedauer schlechter werden
   * (+0,05 % auf einen Tag, −0,78 % auf zehn). Wenn sich das in einer Klasse
   * wiederholt, ist die richtige Konsequenz NICHT, die Klasse abzuschalten,
   * sondern nur die Richtung, die verliert — und der Unterschied ist erheblich:
   * Krypto ist die einzige Klasse, die auch nachts handelt, und wäre damit
   * das einzige, was außerhalb der US-Handelszeiten überhaupt möglich ist.
   *
   * Die Kreuzung kostet nichts Zusätzliches: Beide Aufteilungen fallen im
   * selben Durchlauf ohnehin an, sie wurden bisher nur getrennt aufaddiert.
   */
  const gespeicherteKlassenHorizonte = fortsetzen
    ? (vorher.get('klassenHorizonte') as Record<string, Record<string, HorizontStand>> | undefined)
    : undefined;
  const klassenHorizonte: Record<string, Record<string, HorizontStand>> = {
    ...(gespeicherteKlassenHorizonte ?? {}),
  };
  /*
   * Wie viele Symbole in der Summe stecken.
   *
   * Ohne diesen Zähler ist die Kante nicht lesbar: `n` zählt Basistage, und
   * 534 Beobachtungen aus zwölf Index-Symbolen sehen genauso aus wie 534 aus
   * dem halben Katalog — sagen aber etwas völlig anderes. Eine Kante, die nur
   * auf Indizes gemessen wurde, darf nicht als Katalog-Beleg gelesen werden.
   */
  let symbolZahl = fortsetzen ? ((vorher.get('symbole') as number | undefined) ?? 0) : 0;

  let bewertet = 0;
  let uebersprungen = 0;
  let fehlerhaft = 0;
  const fertig: string[] = [];

  for (let i = 0; i < offen.length; i++) {
    // Vor dem Symbol prüfen, nicht danach: Ein angefangenes Symbol soll fertig
    // rechnen und committen dürfen — ein Abbruch mitten im Batch wäre die
    // einzige Stelle, an der Marker und Summe auseinanderlaufen könnten.
    if (uhr() - startMs > ZEITBUDGET_MS) {
      logger.info(`Tages-Rückblick: Zeitbudget erreicht nach ${i} Symbolen`);
      break;
    }
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
      // Die Kurve über die Haltedauer — Schlüssel als String, weil Firestore
      // keine Zahlen als Map-Schlüssel kennt.
      // Beide Bestände in EINEM Schritt — die Komposition ist geprüft
      // (`functions/test/klassenHorizonte.test.ts`), weil genau sie die
      // Fehlerquelle ist: Ein vergessener Vorbestand fiele nirgends auf.
      const beitrag = verteileBeitrag(
        { global: horizonte, jeKlasse: klassenHorizonte },
        kl,
        e.horizonte,
      );
      const neuHorizonte = beitrag.global;
      const neuKlassenHorizonte = beitrag.jeKlasse;

      const batch = db.batch();
      batch.set(db.collection('market').doc(sym), { tagRueckblickV: TAG_RUECKBLICK_V }, { merge: true });
      /*
       * VOLLES `set`, kein `merge` — anders als beim Symbol-Marker.
       *
       * `merge` verschmilzt Maps feldweise. Beim Versionswechsel würde die
       * frisch geleerte `klassen`-Map die alten Schlüssel deshalb NICHT
       * löschen: Bewertet der neue Lauf zuerst `crypto`, stünde hinterher
       * `{ indices: <alt, Fenster 750>, crypto: <neu, Fenster 6000> }` da —
       * die alte Messung überlebte in einer Zahl, die neu aussieht.
       *
       * Dieses Dokument gehört ganz diesem Lauf; alle seine Felder werden hier
       * geschrieben. Ein volles `set` ist damit die ehrlichere Operation.
       */
      batch.set(stateRef, {
        gesamt: neuGesamt ?? { n: 0, summePct: 0, treffer: 0 },
        klassen: neuKlasse ? { ...klassen, [kl]: neuKlasse } : klassen,
        nachRichtung: { buy: neuBuy, sell: neuSell },
        horizonte: neuHorizonte,
        klassenHorizonte: neuKlassenHorizonte,
        symbole: symbolZahl + 1,
        cursor: (cursor + i + 1) % Math.max(1, offen.length),
        at: now.toISOString(),
        version: TAG_RUECKBLICK_V,
        fenster: MAX_BASISTAGE,
      });
      await batch.commit();

      gesamt = neuGesamt;
      if (neuKlasse) klassen[kl] = neuKlasse;
      nachRichtung.buy = neuBuy;
      nachRichtung.sell = neuSell;
      for (const [tage, h] of Object.entries(neuHorizonte)) horizonte[tage] = h;
      for (const [k, v] of Object.entries(neuKlassenHorizonte)) klassenHorizonte[k] = v;
      symbolZahl += 1;

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
