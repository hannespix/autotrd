/**
 * strukturSuche — die Struktursuche läuft täglich (MO Teil 2, Schritt 3).
 *
 * Nach autoTune (17:45 ET) prüft dieser Lauf je User mit laufender Engine
 * EINEN mutierten Regelbaum-Kandidaten gegen den amtierenden Baum. Schritt 1
 * lieferte die Statistik (shared/src/overfit.ts), Schritt 2 den Suchraum
 * (shared/src/rules/mutate.ts) — hier steht nur noch die Anbindung: Bars aus
 * den ohlcDaily-Jahres-Chunks, Walk-Forward-Fensterung, das Urteil, das
 * Journal und die Beförderung.
 *
 * ── Die Grenzen (dieselbe Härte wie bei autoTune) ───────────────────────────
 *
 *  1. **Nur Schatten.** Eine Beförderung schreibt AUSSCHLIESSLICH die
 *     Shadow-Strategie users/{uid}/strategies/struktursuche (mode 'shadow').
 *     Sie handelt ein virtuelles 10k-Konto im Scan mit, blockt den
 *     Classic-Pfad nicht (strategyOwned zählt nur paper) und rührt weder
 *     Wallet noch Echtgeld an. Ob ein Baum je echtes Kapital führt,
 *     entscheidet weiterhin ein Mensch über promoteStrategy.
 *  2. **Höchstens eine Änderung je Durchgang.** Ein Kandidat pro Tag, und
 *     eine Beförderung ersetzt den Amtierenden GENAU einmal — sonst wüsste
 *     hinterher niemand, welche Mutation geholfen hat.
 *  3. **Die Bremsen sind nicht verhandelbar.** Beförderung nur, wenn (a) der
 *     Kandidat den Amtierenden im SUCHFENSTER schlägt, (b) sein Such-Sharpe
 *     die Deflation um die KUMULATIVE Versuchszahl überlebt (DSR ≥ 95 %) und
 *     (c) er im Testfenster NACH dem Suchfenster verdient. nVersuche wird
 *     nie zurückgesetzt: Je länger die Suche läuft, desto höher liegt die
 *     Latte — konservativ, genau wie Bailey/López de Prado es meinen.
 *  4. **Nichts ohne Begründung.** Jede Prüfung landet im Journal des
 *     State-Docs — mit DSR, Latte, Vorsprung und beiden Stichprobengrößen.
 *
 * Der Schalter `settings.autoTune !== false` gilt auch hier: Wer den
 * Selbstoptimierer abstellt, stellt die Struktursuche mit ab — es ist EIN
 * Konzept („das System verbessert sich selbst"), kein zweiter Schalter.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  WALK_FORWARD_WARMUP,
  beurteileBefoerderung,
  mutiereSpec,
  sharpeAusRenditen,
  startPopulation,
  teileWalkForward,
  type MutationsErgebnis,
  type Strategy,
  type StrategyDoc,
  type StrategySpec,
} from '../../../shared/src/index.js';
import { backtestSpec, type BacktestBar, type BedingungsZeile } from '../core/backtest.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';

/** Reservierte Strategie-Doc-ID der Suche (users/{uid}/strategies/…). */
export const STRUKTUR_STRATEGIE_ID = 'struktursuche';

/**
 * Den Suchzustand schreiben — aber nur, wenn ihn seit dem Lesen niemand
 * angefasst hat.
 *
 * ── Audit-Befund 11.08. ───────────────────────────────────────────────────
 *
 * Zwischen `stateRef.get()` und `stateRef.set(zustand)` liegt die gesamte
 * Rechnung dieses Kontos: eine Mutation bauen, Kandidat und Amtierenden über
 * bis zu zwölf Symbole backtesten. Das dauert. Geschrieben wurde dann das
 * KOMPLETTE Dokument aus dem alten Stand plus den eigenen Änderungen.
 *
 * Neben dem täglichen Scheduler gibt es `strukturNow` als HTTP-Trigger.
 * Zwei Läufe gleichzeitig sind also kein Gedankenspiel, und der langsamere
 * gewinnt — samt seiner Sicht auf Generation, Versuchszähler und Journal.
 *
 * Der teure Fall ist die Beförderung: Lauf A schreibt die neue
 * Schatten-Strategie und den Zustand dazu, Lauf B überschreibt den Zustand
 * mit der alten Generation. Danach fährt der Schatten einen Baum, den der
 * Zustand nicht kennt — und das A/B-Duell misst zwei verschiedene Dinge
 * gegeneinander, ohne dass es jemandem auffiele.
 *
 * `nVersuche` ist der zweite stille Verlierer: Er ist die Latte, gegen die
 * `beurteileBefoerderung` prüft (Selektion kostet Signifikanz). Fällt er
 * zurück, wird die Latte zu niedrig — und die Suche befördert leichter, als
 * sie darf.
 */
export async function schreibeZustandWennFrisch(
  db: FirebaseFirestore.Firestore,
  ref: FirebaseFirestore.DocumentReference,
  zustand: SuchZustand,
  gelesenUpdatedAt: string | undefined,
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const frisch = await tx.get(ref);
    const jetzt = frisch.get('updatedAt') as unknown;
    const jetztStr = typeof jetzt === 'string' ? jetzt : undefined;
    // Strikter Vergleich, kein „neuer als": Ein anderer Lauf hat auf einer
    // anderen Ausgangslage gerechnet, egal in welche Richtung die Uhr zeigt.
    if (jetztStr !== gelesenUpdatedAt) return false;
    tx.set(ref, zustand);
    return true;
  });
}
/** Bewertungsfenster: ~3 Jahre Tages-Bars (Suche 70 % / Test 30 %). */
const MAX_BARS = 750;
/** Darunter trägt teileWalkForward ohnehin kein Urteil (120 Suche + 60 Test). */
const MIN_BARS = 180;
/** Seeds je Durchgang, bis eine Mutation die Guards übersteht. */
const MAX_MUTATION_SEEDS = 40;
/** Journal-Einträge im State-Doc; ältere fallen raus. */
const JOURNAL_KEEP = 60;
/** Frisches Schatten-Konto je Beförderung — gleiche Basis wie M11. */
const SHADOW_START = 10_000;
/** Watchlist-Deckel (Client-Limit) — mehr Symbole lädt der Lauf nicht. */
const MAX_SYMBOLE = 12;

export interface RenditePunkt {
  date: string;
  r: number;
}

/**
 * Gleichgewichteter 1/N-Portfolio-Schnitt mehrerer Rendite-Serien: je Datum
 * der Mittelwert über die Symbole, die an dem Tag eine Rendite haben. Das
 * ist die Serie, die auch ein echtes Watchlist-Depot erlebt hätte — Sharpe
 * über zusammengehängte Einzelserien wäre dagegen statistisch Unsinn
 * (die Übergänge zwischen Symbolen sind keine Renditen).
 */
export function mittleRenditen(serien: ReadonlyArray<ReadonlyArray<RenditePunkt>>): number[] {
  const je = new Map<string, { s: number; n: number }>();
  for (const serie of serien) {
    for (const p of serie) {
      const e = je.get(p.date) ?? { s: 0, n: 0 };
      e.s += p.r;
      e.n += 1;
      je.set(p.date, e);
    }
  }
  return [...je.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, e]) => e.s / e.n);
}

export interface SpecBewertung {
  suchRenditen: number[];
  testRenditen: number[];
  suchSharpe: number | null;
  testSharpe: number | null;
}

/**
 * Eine Spec über alle Symbole bewerten: je Symbol Walk-Forward-Split,
 * Backtest getrennt auf Such- und Testfenster, Renditen ab dem ersten
 * handelbaren Übergang (Warmup erzeugt konstruktionsbedingt Nullen), dann
 * der 1/N-Schnitt. null = kein Symbol trägt einen Split — Datenlage zu dünn.
 */
export function bewerteSpec(
  spec: StrategySpec,
  barsJeSymbol: ReadonlyMap<string, BacktestBar[]>,
): SpecBewertung | null {
  const such: RenditePunkt[][] = [];
  const test: RenditePunkt[][] = [];
  for (const bars of barsJeSymbol.values()) {
    const split = teileWalkForward(bars);
    if (!split) continue;
    const rs = backtestSpec(spec, split.such, { mitRenditen: true }).renditen ?? [];
    const rt = backtestSpec(spec, split.test, { mitRenditen: true }).renditen ?? [];
    // renditen[i] gehört zum Übergang Bar i → i+1; der erste handelbare
    // Übergang ist (warmup−1) → warmup. Davor stünden nur Nullen, die den
    // Sharpe künstlich glätten würden.
    such.push(
      rs
        .slice(WALK_FORWARD_WARMUP - 1)
        .map((r, i) => ({ date: split.such[WALK_FORWARD_WARMUP + i]!.date, r })),
    );
    test.push(
      rt
        .slice(split.testBeginn - 1)
        .map((r, i) => ({ date: split.test[split.testBeginn + i]!.date, r })),
    );
  }
  if (such.length === 0) return null;
  const suchRenditen = mittleRenditen(such);
  const testRenditen = mittleRenditen(test);
  return {
    suchRenditen,
    testRenditen,
    suchSharpe: sharpeAusRenditen(suchRenditen),
    testSharpe: sharpeAusRenditen(testRenditen),
  };
}

/**
 * Nächste gültige Mutation ab `seedStart` — Seeds, deren Ergebnis ein Guard
 * verwirft, werden übersprungen (deterministisch reproduzierbar; gleicher
 * Zustand ⇒ gleicher Kandidat). null = 40 Seeds ohne gültige Mutation.
 */
export function naechsteMutation(
  spec: StrategySpec,
  seedStart: number,
): { erg: MutationsErgebnis; naechsterSeed: number } | null {
  for (let s = seedStart; s < seedStart + MAX_MUTATION_SEEDS; s++) {
    const erg = mutiereSpec(spec, s);
    if (erg) return { erg, naechsterSeed: s + 1 };
  }
  return null;
}

/** Journal-Eintrag im State-Doc — jede Prüfung nennt ihre Zahlen. */
interface JournalEintrag {
  at: string;
  art: 'start' | 'kandidat';
  beschreibung: string;
  befoerdert: boolean;
  vorsprung: number | null;
  suchSharpe: number | null;
  testSharpe: number | null;
  /** DSR-Wahrscheinlichkeit (p-Wert der Nullhypothese ≈ 1 − dsr). */
  dsr: number | null;
  /** E[max SR] aus nVersuche Zufallsversuchen — die Latte. */
  latte: number | null;
  nVersuche: number;
  nSuch: number;
  nTest: number;
  gruende: string[];
}

/** State-Doc users/{uid}/tuning/struktur. */
interface SuchZustand {
  amtierend: StrategySpec;
  amtierendSeit: string;
  /** KUMULATIV, wird nie zurückgesetzt — die DSR-Latte wächst mit jedem Versuch. */
  nVersuche: number;
  /** Nächster Mutations-Seed — macht die Suche über Tage reproduzierbar. */
  seedZaehler: number;
  /** Zahl der Beförderungen; Generation 0 ist der Startpunkt. */
  generation: number;
  journal: JournalEintrag[];
  /**
   * Feuer-Statistik der Blätter des AMTIERENDEN Baums (M11-Rest,
   * „MACD-Cross feuerte 41×, 12× am Signal-Tag") — summiert über die
   * Watchlist-Symbole, je Lauf frisch. Macht die Blackbox lesbar: Ein Blatt
   * mit 0 Feuerungen ist toter Ballast, eines das immer feuert entscheidet
   * nichts — beides Kandidaten für die nächste Mutation.
   */
  bedingungen?: { at: string; zeilen: BedingungsZeile[] };
  updatedAt: string;
}

/** Blatt-Statistik des Baums über alle Symbole summieren (Label = Schlüssel). */
function zaehleBedingungen(
  spec: StrategySpec,
  barsJeSymbol: ReadonlyMap<string, BacktestBar[]>,
): BedingungsZeile[] {
  const summe = new Map<string, BedingungsZeile>();
  for (const bars of barsJeSymbol.values()) {
    for (const z of backtestSpec(spec, bars, { mitBedingungen: true }).bedingungen ?? []) {
      const k = `${z.seite}|${z.label}`;
      const e = summe.get(k) ?? { seite: z.seite, label: z.label, gefeuert: 0, amSignalTag: 0 };
      e.gefeuert += z.gefeuert;
      e.amSignalTag += z.amSignalTag;
      summe.set(k, e);
    }
  }
  return [...summe.values()];
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
/** Firestore verweigert NaN/Infinity — alles Nicht-Endliche wird ehrlich null. */
const fin = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? round3(v) : null;

function barsAusJahren(
  jahre: Array<Record<string, { close?: number }>>,
): BacktestBar[] {
  const nachDatum = new Map<string, number>();
  for (const jahr of jahre) {
    for (const [datum, ohlc] of Object.entries(jahr)) {
      const c = ohlc?.close;
      if (typeof c === 'number' && Number.isFinite(c) && c > 0) nachDatum.set(datum, c);
    }
  }
  return [...nachDatum.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, close]) => ({ date, close }))
    .slice(-MAX_BARS);
}

/** Tages-Bars aus den ohlcDaily-Jahres-Chunks (nur Reads, kein Netz). */
async function ladeBars(
  db: FirebaseFirestore.Firestore,
  symbol: string,
): Promise<BacktestBar[]> {
  const snap = await db.collection('market').doc(symbol).collection('ohlcDaily').get();
  if (snap.empty) return [];
  return barsAusJahren(
    snap.docs.map((d) => (d.get('days') ?? {}) as Record<string, { close?: number }>),
  );
}

/**
 * Amtierenden Baum als Schatten-Strategie publizieren. Der Scan nimmt sie
 * automatisch mit (status published + compiled + symbols) und führt das
 * virtuelle Konto — frisch bei jeder Beförderung, damit die Equity-Kurve
 * GENAU die Generation misst, die sie trägt, nicht ein Erbe der vorigen.
 */
async function schreibeSchattenStrategie(
  userRef: FirebaseFirestore.DocumentReference,
  zustand: SuchZustand,
  symbols: string[],
  now: Date,
): Promise<void> {
  const ref = userRef.collection('strategies').doc(STRUKTUR_STRATEGIE_ID);
  const alt = await ref.get();
  const iso = now.toISOString();
  const doc: StrategyDoc = {
    name: `Struktursuche G${zustand.generation}`,
    draft: zustand.amtierend,
    compiled: { ...zustand.amtierend, version: zustand.generation + 1, publishedAt: iso },
    status: 'published',
    symbols,
    mode: 'shadow',
    shadow: { balance: SHADOW_START, positions: {}, equity: SHADOW_START, startedAt: iso, updatedAt: iso },
    lastDirs: {},
    createdAt: (alt.exists ? (alt.get('createdAt') as string | undefined) : undefined) ?? iso,
    updatedAt: iso,
  };
  await ref.set(doc);
}

export interface StrukturRunResult {
  users: number;
  /** Konten, deren Suche in diesem Lauf initialisiert wurde (Generation 0). */
  gestartet: number;
  /** Bewertete Kandidaten (einer je Konto und Tag). */
  geprueft: number;
  befoerdert: number;
}

export async function strukturAlle(now = new Date()): Promise<StrukturRunResult> {
  const db = getFirestore();
  const snap = await db
    .collection('users')
    .where('settings.strategy.engine.running', '==', true)
    .get();

  // Watchlists überlappen stark — Bars je Symbol EINMAL je Lauf lesen.
  const barsCache = new Map<string, BacktestBar[]>();
  let gestartet = 0;
  let geprueft = 0;
  let befoerdert = 0;

  for (const userDoc of snap.docs) {
    try {
      if (userDoc.get('settings.autoTune') === false) continue; // Owner hat abgestellt
      const strategy = userDoc.get('settings.strategy') as Strategy | undefined;
      const watchlist = (strategy?.watchlist ?? []).slice(0, MAX_SYMBOLE);
      if (!strategy || watchlist.length === 0) continue;

      const barsJeSymbol = new Map<string, BacktestBar[]>();
      for (const sym of watchlist) {
        let bars = barsCache.get(sym);
        if (!bars) {
          bars = await ladeBars(db, sym);
          barsCache.set(sym, bars);
        }
        if (bars.length >= MIN_BARS) barsJeSymbol.set(sym, bars);
      }
      if (barsJeSymbol.size === 0) continue; // Chunks wachsen täglich — morgen wieder

      const stateRef = userDoc.ref.collection('tuning').doc('struktur');
      const stateDoc = await stateRef.get();

      if (!stateDoc.exists) {
        // ── Initialisierung: bester Baum der Startpopulation wird amtierend.
        // Generation 0 ist ein STARTPUNKT, keine Beförderung — aber sie geht
        // sofort in den Schatten, damit das A/B-Duell vom ersten Tag an misst.
        const population = startPopulation(strategy);
        let bester: { spec: StrategySpec; bew: SpecBewertung } | null = null;
        for (const spec of population) {
          const bew = bewerteSpec(spec, barsJeSymbol);
          if (
            bew !== null &&
            bew.suchSharpe !== null &&
            (bester === null || (bester.bew.suchSharpe ?? -Infinity) < bew.suchSharpe)
          ) {
            bester = { spec, bew };
          }
        }
        if (!bester) continue;
        const zustand: SuchZustand = {
          amtierend: bester.spec,
          amtierendSeit: now.toISOString(),
          // Auch die Auswahl des Startpunkts ist Selektion — sie zählt in die Latte.
          nVersuche: population.length,
          seedZaehler: 0,
          generation: 0,
          journal: [
            {
              at: now.toISOString(),
              art: 'start',
              beschreibung: `Startpopulation (${population.length} Bäume) bewertet — bester Baum übernimmt als Generation 0`,
              befoerdert: false,
              vorsprung: null,
              suchSharpe: fin(bester.bew.suchSharpe),
              testSharpe: fin(bester.bew.testSharpe),
              dsr: null,
              latte: null,
              nVersuche: population.length,
              nSuch: bester.bew.suchRenditen.length,
              nTest: bester.bew.testRenditen.length,
              gruende: [],
            },
          ],
          bedingungen: { at: now.toISOString(), zeilen: zaehleBedingungen(bester.spec, barsJeSymbol) },
          updatedAt: now.toISOString(),
        };
        /* `create` statt `set`: Es scheitert, wenn das Dokument inzwischen
         * existiert. Zwei gleichzeitige Läufe legten sonst beide eine
         * Generation 0 an — der zweite überschriebe den Startpunkt des
         * ersten, und die Schatten-Strategie zeigte auf einen dritten Baum. */
        try {
          await stateRef.create(zustand);
        } catch {
          logger.info(`strukturSuche ${userDoc.id}: Startpunkt existiert bereits — übersprungen`);
          continue;
        }
        await schreibeSchattenStrategie(userDoc.ref, zustand, watchlist, now);
        gestartet += 1;
        continue; // der erste Kandidat kommt morgen — eine Änderung je Durchgang
      }

      // ── Tages-Kandidat: genau EINE Mutation gegen den Amtierenden ─────────
      const zustand = stateDoc.data() as SuchZustand;
      // Stand beim Lesen — daran erkennt der Schreibvorgang, ob ihn ein
      // zweiter Lauf inzwischen überholt hat.
      const gelesenUpdatedAt = typeof zustand.updatedAt === 'string' ? zustand.updatedAt : undefined;
      const mut = naechsteMutation(zustand.amtierend, zustand.seedZaehler);
      if (!mut) {
        // 40 Seeds ohne gültige Mutation (praktisch nur bei randvollem Baum):
        // Seeds verbrauchen und morgen mit frischen weitermachen.
        zustand.seedZaehler += MAX_MUTATION_SEEDS;
        zustand.updatedAt = now.toISOString();
        await schreibeZustandWennFrisch(db, stateRef, zustand, gelesenUpdatedAt);
        continue;
      }
      const bewK = bewerteSpec(mut.erg.spec, barsJeSymbol);
      const bewA = bewerteSpec(zustand.amtierend, barsJeSymbol);
      if (!bewK || !bewA) continue; // ohne Bewertung kein Versuch verbraucht

      zustand.seedZaehler = mut.naechsterSeed;
      zustand.nVersuche += 1;
      geprueft += 1;

      const vorsprung =
        bewK.suchSharpe !== null && bewA.suchSharpe !== null
          ? bewK.suchSharpe - bewA.suchSharpe
          : null;
      const urteil = beurteileBefoerderung({
        suchRenditen: bewK.suchRenditen,
        testRenditen: bewK.testRenditen,
        nVersuche: zustand.nVersuche,
      });
      const gruende = [...urteil.gruende];
      if (!(vorsprung !== null && vorsprung > 0)) {
        gruende.push(
          vorsprung === null
            ? 'Vorsprung nicht rechenbar (Sharpe einer Seite entartet)'
            : `Kein Vorsprung im Suchfenster (${vorsprung.toFixed(3)} ggü. amtierend)`,
        );
      }
      const bef = urteil.befoerdern && vorsprung !== null && vorsprung > 0;

      zustand.journal.push({
        at: now.toISOString(),
        art: 'kandidat',
        beschreibung: `${mut.erg.op}: ${mut.erg.beschreibung}`,
        befoerdert: bef,
        vorsprung: fin(vorsprung),
        suchSharpe: fin(bewK.suchSharpe),
        testSharpe: fin(urteil.testSharpe ?? bewK.testSharpe),
        dsr: fin(urteil.suche?.dsr),
        latte: fin(urteil.suche?.sr0),
        nVersuche: zustand.nVersuche,
        nSuch: bewK.suchRenditen.length,
        nTest: bewK.testRenditen.length,
        gruende,
      });
      zustand.journal = zustand.journal.slice(-JOURNAL_KEEP);

      if (bef) {
        zustand.amtierend = mut.erg.spec;
        zustand.amtierendSeit = now.toISOString();
        zustand.generation += 1;
      }
      // Statistik NACH einer etwaigen Beförderung — sie beschreibt den Baum,
      // der ab jetzt amtiert, nicht den gerade abgelösten.
      zustand.bedingungen = {
        at: now.toISOString(),
        zeilen: zaehleBedingungen(zustand.amtierend, barsJeSymbol),
      };
      zustand.updatedAt = now.toISOString();
      /* Erst der Zustand, dann der Schatten (Audit-Befund 11.08.). Andersherum
       * — so stand es hier — führe ein überholter Lauf die Schatten-Strategie
       * auf einen Baum, den anschließend niemand mehr im Zustand hat. */
      if (!(await schreibeZustandWennFrisch(db, stateRef, zustand, gelesenUpdatedAt))) {
        logger.info(`strukturSuche ${userDoc.id}: überholt — Ergebnis verworfen`);
        continue;
      }
      if (bef) {
        befoerdert += 1;
        await schreibeSchattenStrategie(userDoc.ref, zustand, watchlist, now);
        logger.info(
          `strukturSuche ${userDoc.id}: Generation ${zustand.generation} — ${mut.erg.beschreibung}`,
        );
      }
    } catch (err) {
      logger.warn(`strukturSuche: User ${userDoc.id} übersprungen`, err);
    }
  }

  await db
    .doc('meta/health')
    .set(
      {
        strukturSuche: {
          at: now.toISOString(),
          date: now.toISOString().slice(0, 10),
          users: snap.size,
          gestartet,
          geprueft,
          befoerdert,
        },
      },
      { merge: true },
    )
    .catch(() => undefined);
  logger.info(
    `strukturSuche: ${geprueft} Kandidaten, ${befoerdert} Beförderungen, ${gestartet} Starts bei ${snap.size} Usern`,
  );
  return { users: snap.size, gestartet, geprueft, befoerdert };
}

/** Täglich 18:10 ET — nach autoTune (17:45), Markt längst zu. */
export const strukturSuche = onSchedule(
  {
    schedule: '10 18 * * *',
    timeZone: 'America/New_York',
    retryCount: 0,
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async () => {
    await strukturAlle();
  },
);

/** Manueller Trigger — NUR im Emulator (Abnahme-Verifikation). */
export const strukturNow = onRequest(EMULATOR_TRIGGER_OPTS, async (_req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'strukturNow ist nur im Emulator verfügbar' });
    return;
  }
  res.status(200).json(await strukturAlle());
});
