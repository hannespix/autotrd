/**
 * snapshotEquity — täglicher Equity-Snapshot + Kennzahlen (M12 Teil 1).
 *
 * Läuft täglich nach US-Börsenschluss (auch am Wochenende — Krypto handelt
 * durch) und schreibt je User:
 *   - users/{uid}/equity/{YYYY-MM-DD}: Equity (Cash + bewertete Positionen,
 *     Shorts gespiegelt), idempotent per Datums-Doc-ID — ein Rerun am selben
 *     Tag überschreibt statt doppelt zu zählen.
 *   - users/{uid}/stats/main: Sharpe 30/90, HWM/MaxDD, WinRate, ProfitFactor,
 *     Expectancy, Attribution je Symbol/Asset-Klasse — das Dashboard liest
 *     später GENAU EIN Doc statt die Trade-Historie zu aggregieren.
 *
 * `walletId: 'main'` ist der Vorgriff auf die M12-Multi-Wallet-Migration:
 * heute gibt es genau ein Paper-Wallet je User; nach der Migration hängt
 * dieselbe Logik je Wallet-Doc.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  MIN_ACCOUNTS_PUBLIC,
  aggregateTradingHealth,
  attribution,
  berateKlassen,
  besserAls,
  BEWAEHRT_MIN_TAGE,
  BEWAEHRT_MIN_TRADES,
  classify,
  engineBilanz,
  extrahiereEinstellungen,
  pruefeKandidat,
  costProfile,
  exitBreakdown,
  exitBreakdownSeit,
  EXIT_FENSTER_TAGE,
  dailyReturns,
  drawdown,
  positionValue,
  reglerSchritt,
  schreibeChronik,
  sharpe,
  tradeStats,
  tradingVerdict,
  werteSchattenAus,
  type AccountContribution,
  type BewaehrteEinstellungen,
  type ClosedTrade,
  type EngineBilanz,
  type EngineTrade,
  type EquityPoint,
  type KlassenBefund,
  type KlassenErgebnis,
  type ErkenntnisChronik,
  type ErkenntnisFakten,
  type Position,
  type SchattenKlasse,
} from '../../../shared/src/index.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';
import { accrueMarginInterest } from '../core/broker.js';

/** ~ein halbes Handelsjahr Serie — reicht für Sharpe 90 + MaxDD-Fenster. */
const EQUITY_WINDOW = 120;
/** Jüngste Trades für WinRate/Attribution (geschlossene werden rausgefiltert). */
const TRADES_WINDOW = 500;

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Ein Kontostand aus einem einzigen Lesezeitpunkt. */
export interface Kontostand {
  balance: number;
  positionen: { id: string; pos: Position }[];
}

/**
 * Saldo UND Positionen aus EINEM Stand lesen (Audit-Befund 11.08.).
 *
 * ── Was vorher passierte ──────────────────────────────────────────────────
 *
 * Der Saldo kam aus dem Konten-Query vom Beginn des Laufs, die Positionen aus
 * einem frischen Lesevorgang. Dazwischen liegen die Zinsbuchung und alle
 * vorher abgearbeiteten Konten — und Krypto handelt rund um die Uhr, der
 * 17:15-Lauf ist also kein ruhiger Moment. Fiel ein Kauf in dieses Fenster,
 * zählte das Geld doppelt: das Cash aus dem alten Stand UND die frisch
 * gekaufte Position.
 *
 * Das ist keine Kosmetik. Dieselbe Zahl wird zur Bezugsgröße der Notbremse
 * (`risk.vortagEquity`) — eine zu hohe Bezugsgröße lässt die Bremse am
 * nächsten Tag zu früh auslösen und sperrt ein gesundes Konto.
 *
 * Die Read-only-Transaktion garantiert genau das, was fehlte: einen
 * gemeinsamen Lesezeitpunkt für beide Abfragen, ohne Sperren zu nehmen. Der
 * zusätzliche Read je Konto fällt EINMAL am Tag an.
 *
 * `rueckfall` greift nur, wenn das Wallet-Feld beim frischen Lesen fehlt
 * oder unbrauchbar ist — dann ist der alte Stand (abzüglich der eben
 * gebuchten Zinsen) immer noch besser als gar kein Snapshot.
 */
export async function leseKontostand(
  db: FirebaseFirestore.Firestore,
  ref: FirebaseFirestore.DocumentReference,
  rueckfall: number,
): Promise<Kontostand> {
  return db.runTransaction(
    async (tx) => {
      const u = await tx.get(ref);
      const p = await tx.get(ref.collection('positions'));
      const frisch = u.get('wallet.paperBalance') as unknown;
      return {
        // Der frische Saldo enthält die eben gebuchten Zinsen bereits — hier
        // NICHT noch einmal abziehen. Nur der Rückfall bringt seinen Abzug
        // selbst mit.
        balance: typeof frisch === 'number' && Number.isFinite(frisch) ? frisch : rueckfall,
        positionen: p.docs.map((d) => ({ id: d.id, pos: d.data() as Position })),
      };
    },
    { readOnly: true },
  );
}

export interface SnapshotResult {
  users: number;
  snapped: number;
  /** Summe der heute gebuchten Margin-Zinsen über alle Konten. */
  marginInterest: number;
}

/** Snapshot + Kennzahlen für alle User; Fehler je User isoliert (ein kaputtes Konto stoppt nicht den Rest). */
export async function snapshotAll(now = new Date()): Promise<SnapshotResult> {
  const db = getFirestore();
  const date = now.toISOString().slice(0, 10);
  const users = await db.collection('users').select('wallet', 'settings').get();

  // Schatten-Kante je Klasse (MG4) — einmal je Lauf, nicht je User: Die
  // Signale entstehen im gemeinsamen Scan und sind für alle dieselben.
  // Ohne sie könnte eine Klasse mit Gewicht 0 nie zurückkehren; mit ihr
  // steht auch für eine stillgelegte Klasse eine Zahl im Bericht.
  let schattenGlobal: Record<string, { n: number; kantePct: number | null }> = {};
  /**
   * Klassen, über die der Schatten überhaupt schon etwas weiß — aus BEIDEN
   * Reihen. Nur zum Auffüllen der Liste (s. u.), nie als Beleg.
   */
  let schattenKlassenBekannt: string[] = [];
  try {
    const doc = await db.doc('meta/classShadow').get();
    /* ── Welche Reihe entscheiden darf (17.08.) ────────────────────────────
     *
     * `klassenHalte` und nicht `klassen`. Der Unterschied ist das
     * Zeitfenster: Die alte Reihe misst die Kursbewegung von einem Scan zum
     * nächsten — fünf Minuten — und zieht die vollen Roundtrip-Kosten ab.
     * Live gilt für Krypto seit dem 15.08. eine Mindesthalte von 48 Stunden.
     * Eine Kante über fünf Minuten gegen Kosten für einen 48-Stunden-Trade
     * zu rechnen, ist kein strenger Maßstab, sondern ein falscher: Die
     * Klasse kann ihn nicht bestehen, und zwar unabhängig davon, wie gut
     * ihre Signale sind.
     *
     * Die neue Reihe startet leer. Solange sie unter der Beweisschwelle
     * liegt, gibt es hier keinen Schatten-Beleg — und `rateKlasse` lässt das
     * Gewicht dann, wie es ist. Das ist die STRENGERE Seite: Der Rückweg
     * öffnet sich später als vorher, nie früher.
     */
    const roh = (doc.get('klassenHalte') as Record<string, SchattenKlasse> | undefined) ?? {};
    const rohAlt = (doc.get('klassen') as Record<string, SchattenKlasse> | undefined) ?? {};
    schattenGlobal = Object.fromEntries(
      Object.entries(roh).map(([k, v]) => {
        const a = werteSchattenAus(v);
        return [k, { n: a.n, kantePct: a.kantePct }];
      }),
    );
    schattenKlassenBekannt = [...new Set([...Object.keys(roh), ...Object.keys(rohAlt)])];
  } catch (err) {
    logger.warn('Schatten-Kante nicht lesbar — Empfehlung nur aus echten Trades', err);
  }

  // Klassen-Kante ÜBER ALLE KONTEN (MG5, Owner-Go 09.08.) — der Beleg, der
  // ein Konto von der Erfahrung des Bestands profitieren lässt, statt es
  // dieselben 30 Trades Lehrgeld noch einmal zahlen zu lassen.
  //
  // Bewusst der Stand von GESTERN: `meta/health` wird erst am Ende dieses
  // Laufs neu geschrieben, aus den Beiträgen, die die Schleife unten
  // sammelt. Eine Klassen-Kante über hunderte Trades bewegt sich über Nacht
  // nicht nennenswert — und die Alternative wäre, alle Konten zweimal zu
  // lesen, nur um einen Tag früher dieselbe Antwort zu bekommen.
  let klassenGlobal: Record<string, { n: number; kantePct: number | null; konten: number }> = {};
  try {
    const doc = await db.doc('meta/health').get();
    const roh = (doc.get('trading.klassen') as Record<string, KlassenBefund> | undefined) ?? {};
    klassenGlobal = Object.fromEntries(
      Object.entries(roh).map(([k, v]) => [
        k,
        { n: v.n ?? 0, kantePct: v.kantePct ?? null, konten: v.konten ?? 0 },
      ]),
    );
  } catch (err) {
    logger.warn('Globale Klassen-Kante nicht lesbar — Empfehlung nur aus eigenen Trades', err);
  }

  // Kurs-Cache: market/{sym}.quote.price einmal je Symbol lesen, nicht je User.
  const priceCache = new Map<string, number | null>();
  async function lastPrice(sym: string): Promise<number | null> {
    if (!priceCache.has(sym)) {
      try {
        const doc = await db.collection('market').doc(sym).get();
        const p = (doc.get('quote') as { price?: number } | undefined)?.price;
        priceCache.set(sym, typeof p === 'number' && p > 0 ? p : null);
      } catch {
        priceCache.set(sym, null);
      }
    }
    return priceCache.get(sym) ?? null;
  }

  let snapped = 0;
  let zinsSumme = 0;
  // Untergrenze des rollierenden Exit-Fensters (Task 115) — EINMAL je Lauf,
  // damit alle Konten und das Aggregat dasselbe Fenster meinen.
  const fensterSeit = new Date(now.getTime() - EXIT_FENSTER_TAGE * 24 * 60 * 60 * 1000).toISOString();
  const beitraege: AccountContribution[] = [];
  // MU3 „Bewährte Einstellungen": Über die Schleife hinweg den Besten nach
  // ENGINE-Attribution suchen — und, solange keiner die Belege erfüllt, den
  // besten Anwärter samt Klartext, was ihm noch fehlt (die Karte zeigt das).
  let bester: { bilanz: EngineBilanz; einstellungen: BewaehrteEinstellungen } | null = null;
  let anwaerter: { bilanz: EngineBilanz; fehlt: string[] } | null = null;
  for (const userDoc of users.docs) {
    try {
      const roh = userDoc.get('wallet.paperBalance') as number | undefined;
      if (typeof roh !== 'number' || !Number.isFinite(roh)) continue; // kein Wallet → kein Snapshot

      // Margin-Zinsen VOR dem Snapshot buchen (Hebel, 28.07.): Sonst zeigte
      // die Equity-Kurve einen Tag lang ein Konto, das seine Kreditkosten
      // noch nicht getragen hat — genau die Schönfärberei, die margin.ts
      // ausschließen soll. Idempotent je Tag, ein Rerun bucht nichts.
      const zins = await accrueMarginInterest(userDoc.id, date).catch(() => 0);
      if (zins > 0) {
        zinsSumme += zins;
        logger.info(`Margin-Zinsen ${userDoc.id}: ${zins.toFixed(2)} $`);
      }

      /* Saldo UND Positionen aus EINEM Stand (Audit-Befund 11.08.).
       *
       * Vorher kam der Saldo aus dem Konten-Query vom Beginn des Laufs und
       * die Positionen aus einem frischen Lesevorgang. Dazwischen liegen die
       * Zinsbuchung und alle vorher abgearbeiteten Konten — und Krypto
       * handelt rund um die Uhr, der 17:15-Lauf ist also kein ruhiger
       * Moment. Fiel ein Kauf in dieses Fenster, zählte das Geld doppelt:
       * das Cash aus dem alten Stand UND die frisch gekaufte Position.
       *
       * Das ist keine Kosmetik. Dieselbe Zahl wird gleich unten als
       * `risk.vortagEquity` zur Bezugsgröße der Notbremse — eine zu hohe
       * Bezugsgröße lässt die Bremse am nächsten Tag zu früh auslösen und
       * sperrt ein gesundes Konto.
       *
       * Read-only-Transaktion: Sie garantiert genau das, was hier fehlte —
       * einen gemeinsamen Lesezeitpunkt — ohne Sperren zu nehmen. Der
       * zusätzliche Read je Konto fällt EINMAL am Tag an.
       */
      const stand = await leseKontostand(db, userDoc.ref, roh - zins);
      const balance = stand.balance;

      let positionsValue = 0;
      for (const { id, pos } of stand.positionen) {
        positionsValue += positionValue(pos, await lastPrice(pos.symbol ?? id));
      }
      positionsValue = r2(positionsValue);
      const equity = r2(balance + positionsValue);

      await userDoc.ref.collection('equity').doc(date).set({
        walletId: 'main',
        date,
        equity,
        balance: r2(balance),
        positionsValue,
        positionsCount: stand.positionen.length,
        updatedAt: now.toISOString(),
      });

      /* Notbremse für den nächsten Tag armieren (M12).
       *
       * Zwei Dinge in einem Schreibvorgang: Der heutige Schlussstand wird
       * zur Bezugsgröße von morgen, und ein ausgelöster Breaker wird
       * gelöscht — ein neuer Tag beginnt ohne Sperre.
       *
       * Warum die Zahl ans USER-Dokument und nicht in die equity-Collection:
       * Der Scan liest das User-Dokument ohnehin (alle 5 Minuten, je Konto).
       * Ein zusätzlicher Read in die Tagesserie käme bei 288 Scans am Tag
       * teuer, und die Bremse braucht genau eine Zahl, nicht die Serie.
       */
      await userDoc.ref
        .set(
          {
            risk: {
              vortagEquity: equity,
              vortagEquityAm: date,
              breakerAusgeloestAm: null,
              breakerGrund: null,
              breakerVerlustPct: null,
            },
          },
          { merge: true },
        )
        .catch((err: unknown) => logger.warn(`Breaker-Armierung ${userDoc.id}`, err));

      // Serie (jüngste EQUITY_WINDOW Snapshots, inkl. dem gerade geschriebenen)
      const serieSnap = await userDoc.ref
        .collection('equity')
        .orderBy('date', 'desc')
        .limit(EQUITY_WINDOW)
        .get();
      const serie: EquityPoint[] = serieSnap.docs
        .map((d) => ({ date: d.get('date') as string, equity: d.get('equity') as number }))
        .reverse();
      const returns = dailyReturns(serie);
      const dd = drawdown(serie);

      const tradesSnap = await userDoc.ref
        .collection('trades')
        .orderBy('at', 'desc')
        .limit(TRADES_WINDOW)
        .get();
      const closed: ClosedTrade[] = [];
      // Engine-Trades separat (MU3): Die Best-Practice-Kür zählt NUR
      // source='engine' — ein manueller Glückstreffer soll keine
      // Einstellungen adeln, mit denen er nichts zu tun hatte.
      const engineTrades: EngineTrade[] = [];
      for (const t of tradesSnap.docs) {
        const pnl = t.get('pnl') as number | undefined;
        const symbol = t.get('symbol') as string | undefined;
        if (typeof pnl === 'number' && Number.isFinite(pnl) && symbol) {
          // qty × price ist der Positionswert beim Schließen. Die Gebühr
          // kommt seit dem 13.08. bevorzugt ECHT aus dem fee-Feld (steht
          // seit 04.08. an jedem Trade); entryPrice liefert die
          // Einstiegs-Basis. feeRate bleibt für den Altbestand — alte
          // Trades ohne alles fallen aus dem Kostenprofil heraus, statt es
          // mit Annahmen zu verfälschen (roundtripGebuehr, portfolio.ts).
          const qty = t.get('qty') as number | undefined;
          const price = t.get('price') as number | undefined;
          const feeRate = t.get('feeRate') as number | undefined;
          const fee = t.get('fee') as number | undefined;
          const entryPrice = t.get('entryPrice') as number | undefined;
          const riskExit = t.get('riskExit') as string | undefined;
          const volumen = {
            ...(typeof qty === 'number' && typeof price === 'number'
              ? { notional: qty * price }
              : {}),
            ...(typeof feeRate === 'number' ? { feeRate } : {}),
            ...(typeof fee === 'number' ? { fee } : {}),
            ...(typeof qty === 'number' && typeof entryPrice === 'number' && entryPrice > 0
              ? { entryNotional: qty * entryPrice }
              : {}),
          };
          /* Feldname MUSS zur Buchung passen: broker.ts schreibt den
           * Schlusszeitpunkt als `executedAt` — die erste Fassung las hier
           * `at` (den Namen des ClosedTrade-FELDS, nicht des Dokuments) und
           * bekam IMMER undefined. Folge: Das 7-Tage-Fenster war seit seiner
           * Einführung strukturell leer — am 14.08. standen 6 frische
           * Abschlüsse in den Kumulativ-Zahlen (PF 0,96→1,18) bei
           * trades7t = 0. Der Wächter in exitFensterMessung pinnt den
           * Feldnamen jetzt gegen die Schreibstelle. */
          const at = t.get('executedAt') as string | undefined;
          closed.push({
            symbol,
            pnl,
            assetClass: classify(symbol),
            ...(riskExit ? { riskExit } : {}),
            // Schlusszeitpunkt mitgeben — ohne ihn gibt es keine
            // zeitgefensterte Exit-Sicht (Task 115).
            ...(typeof at === 'string' ? { at } : {}),
            ...volumen,
          });
          if (t.get('source') === 'engine' && typeof at === 'string') {
            engineTrades.push({ pnl, at, ...volumen });
          }
        }
      }
      const ts = tradeStats(closed);
      const attr = attribution(closed);
      // MT1: Woran sterben die Trades, und wie viel davon frisst die Reibung?
      // Beides war bis 27.07. nirgends ablesbar und musste von Hand
      // zurückgerechnet werden.
      const exits = exitBreakdown(closed);
      // Dieselbe Verteilung NUR über die letzten 7 Tage (Task 115): Die
      // kumulative Sicht kann eine Verhaltensänderung — etwa den Exit-Umbau
      // vom 09.08. — erst zeigen, wenn sie Hunderte Alt-Trades überstimmt
      // hat. Das Fenster zeigt sie sofort.
      const exits7t = exitBreakdownSeit(closed, fensterSeit);
      const costs = costProfile(closed);

      // ── Klassen-Regler (MG2/MG3/MG4b) ─────────────────────────────────────
      // Die Empfehlung entsteht IMMER — auch ohne Auto-Regler. Sie ist die
      // Grundlage der Karte in den Einstellungen; wer sie nur ansehen und
      // von Hand übernehmen will, soll dieselbe Zahl sehen, nach der die
      // Automatik entscheiden würde.
      const gewichte =
        (userDoc.get('settings.strategy.engine.classWeights') as
          | Record<string, number>
          | undefined) ?? {};
      const ergebnisse: Record<string, KlassenErgebnis> = {};
      for (const [klasse, slice] of Object.entries(attr.byClass)) {
        ergebnisse[klasse] = {
          n: slice.n,
          kantePct: slice.kantePct ?? null,
          ...(schattenGlobal[klasse] ? { schatten: schattenGlobal[klasse] } : {}),
          ...(klassenGlobal[klasse] ? { global: klassenGlobal[klasse] } : {}),
        };
      }
      // Klassen, die NUR im Schatten oder NUR im Gesamtbestand vorkommen,
      // gehören zwingend dazu: Genau das sind die abgeschalteten und die,
      // in denen dieses Konto noch nie gehandelt hat. Fehlten sie hier,
      // wäre der Rückweg wieder zu — der Fehler, den MG4 behoben hat — und
      // fremde Erfahrung käme nur dort an, wo sie am wenigsten fehlt.
      // Aufgefüllt wird aus BEIDEN Schatten-Reihen (17.08.): Eine Klasse, von
      // der nur die alte Fünf-Minuten-Reihe weiß, muss trotzdem in der Karte
      // auftauchen — sonst verschwände sie aus der Anzeige, sobald sie keine
      // eigenen Trades mehr hat. Einen BELEG bekommt sie dadurch nicht: Ohne
      // Eintrag in `schattenGlobal` bleibt `schatten` leer, und `rateKlasse`
      // spricht dann „zu_wenig_daten" und lässt das Gewicht stehen.
      for (const klasse of schattenKlassenBekannt) {
        const s = schattenGlobal[klasse];
        ergebnisse[klasse] ??= { n: 0, kantePct: null, ...(s ? { schatten: s } : {}) };
      }
      for (const [klasse, g] of Object.entries(klassenGlobal)) {
        ergebnisse[klasse] ??= { n: 0, kantePct: null, global: g };
        ergebnisse[klasse].global ??= g;
      }
      const rat = berateKlassen(ergebnisse, gewichte);

      // Seit 09.08. AN, außer ausdrücklich abgewählt (s. strategy.ts). Ein
      // fehlendes Feld bedeutet dasselbe wie bei einem frisch angelegten
      // Konto — sonst hinge die Wirkung davon ab, ob jemand das
      // Options-Modal schon einmal gespeichert hat.
      const autoAn = userDoc.get('settings.strategy.engine.classAutoTune') !== false;
      const bewegt: Array<{
        klasse: string;
        von: number;
        nach: number;
        empfehlung: string;
        quelle: string;
        kantePct: number | null;
        n: number;
        grund: string;
      }> = [];
      if (autoAn) {
        const neu: Record<string, number> = { ...gewichte };
        for (const r of rat.raete) {
          const schritt = reglerSchritt(r);
          if (Math.abs(schritt - r.gewicht) < 1e-9) continue;
          neu[r.klasse] = schritt;
          bewegt.push({
            klasse: r.klasse,
            von: r.gewicht,
            nach: schritt,
            empfehlung: r.empfehlung,
            // Woher der Beleg kam, gehört ins Journal: Ein Gewicht, das auf
            // fremde Trades hin gefallen ist, muss später als solches
            // erkennbar sein — sonst sucht jemand die Begründung in den
            // eigenen Zahlen und findet sie nicht.
            quelle: r.quelle,
            kantePct: r.kantePct,
            n: r.n,
            grund: r.grund,
          });
        }
        if (bewegt.length > 0) {
          await userDoc.ref.set(
            { settings: { strategy: { engine: { classWeights: neu } } } },
            { merge: true },
          );
          // Journal — wie beim Auto-Tuner (MT5). Ein Gewicht, das sich von
          // selbst bewegt, muss erklärbar bleiben; sonst steht irgendwann
          // eine Zahl im System, die niemand mehr zuordnen kann.
          const log = db.batch();
          for (const b of bewegt) {
            log.set(userDoc.ref.collection('classLog').doc(`${date}_${b.klasse}`), {
              at: now.toISOString(),
              date,
              ...b,
            });
          }
          await log.commit();
          logger.info(
            `Klassen-Regler ${userDoc.id}: ${bewegt.map((b) => `${b.klasse} ${b.von}→${b.nach}`).join(', ')}`,
          );
        }
      }

      await userDoc.ref.collection('stats').doc('main').set({
        walletId: 'main',
        equityDays: serie.length,
        sharpe30: sharpe(returns.slice(-30)),
        sharpe90: sharpe(returns.slice(-90)),
        hwm: dd.hwm,
        maxDDPct: dd.maxDDPct,
        currentDDPct: dd.currentDDPct,
        trades: ts.n,
        wins: ts.wins,
        winRatePct: ts.winRatePct,
        profitFactor: ts.profitFactor,
        expectancy: ts.expectancy,
        avgWin: ts.avgWin,
        avgLoss: ts.avgLoss,
        bySymbol: attr.bySymbol,
        byClass: attr.byClass,
        exits,
        exits7t,
        exits7tSeit: fensterSeit,
        costs,
        // Empfehlung je Anlageklasse (MG2): Kante, Urteil, Vorschlag und
        // Klartext-Begründung — fertig für die Karte, damit die Oberfläche
        // nicht dieselbe Logik ein zweites Mal implementieren muss.
        classAdvice: {
          raete: rat.raete,
          aenderungen: rat.aenderungen,
          fazit: rat.fazit,
          autoTune: autoAn,
          bewegt,
          at: now.toISOString(),
        },
        updatedAt: now.toISOString(),
      });
      // Beitrag zum öffentlichen Gesamtbild — die Kennzahlen fallen hier
      // ohnehin an. Was daraus veröffentlicht wird, entscheidet
      // `aggregateTradingHealth`: Quoten immer, Beträge erst ab genug Konten.
      beitraege.push({
        stats: {
          n: ts.n,
          wins: ts.wins,
          profitFactor: ts.profitFactor,
          expectancy: ts.expectancy,
          avgWin: ts.avgWin,
          avgLoss: ts.avgLoss,
        },
        exits,
        exits7t,
        costs: { n: costs.n, fees: costs.fees, grossPnl: costs.grossPnl },
        // Klassen-Aufschlüsselung mit ins Aggregat: Ohne sie sagt das
        // Gesamtbild nur, DASS zu teuer gehandelt wird — nicht wo.
        byClass: attr.byClass,
      });

      // MU3: Engine-Bilanz dieses Kontos gegen die bisherige Kür halten.
      const bilanz = engineBilanz(engineTrades);
      if (bilanz.n > 0) {
        const urteil = pruefeKandidat(bilanz);
        if (urteil.geeignet) {
          const einstellungen = extrahiereEinstellungen(userDoc.get('settings.strategy'));
          if (einstellungen === null) {
            logger.warn(`bestPractice: ${userDoc.id} geeignet, aber Strategie unvollständig`);
          } else if (besserAls(bilanz, bester?.bilanz)) {
            bester = { bilanz, einstellungen };
          }
        } else if (bester === null && besserAls(bilanz, anwaerter?.bilanz)) {
          anwaerter = { bilanz, fehlt: urteil.fehlt };
        }
      }

      snapped += 1;
    } catch (err) {
      logger.warn(`snapshotEquity: User ${userDoc.id} übersprungen`, err);
    }
  }

  // ── Handelsqualität öffentlich machen (Owner-Frage 28.07.) ────────────────
  // Bis hierher trug `meta/health` nur BETRIEBS-Zahlen: gescannt, gescheitert,
  // Anzahl Trades. Damit sieht man, ob die Maschine läuft — nicht, ob sie
  // etwas taugt. Die Diagnose „sterben alle Trades am Signal?" stand
  // ausschließlich in `users/{uid}/stats/main` und war von außen unsichtbar;
  // am 27.07. musste ein Mensch sie mit dem Taschenrechner zurückrechnen.
  const health = aggregateTradingHealth(beitraege);
  await db.doc('meta/health').set(
    {
      equitySnapshot: {
        at: now.toISOString(),
        date,
        users: users.size,
        snapped,
        marginInterest: Math.round(zinsSumme * 100) / 100,
      },
      trading: {
        ...health,
        verdict: tradingVerdict(health),
        at: now.toISOString(),
        // Wovon `exits7t` das Fenster ist — ohne den Stempel wäre die Zahl
        // im Dokument nicht interpretierbar.
        exits7tSeit: fensterSeit,
      },
    },
    { merge: true },
  );

  // ── MU3 „Bewährte Einstellungen" (Owner-Idee 06.08.) ──────────────────────
  // Der Tagesstand ERSETZT das Dokument bewusst komplett (kein merge): Ein
  // Gewinner von gestern, der heute die Belege nicht mehr erfüllt, darf
  // nicht als „bewährt" stehen bleiben. Anonymisiert — keine User-Kennung,
  // keine Watchlist, kein Kapital; nur engine/signals/indicators + Kennzahlen.
  //
  // ANONYMITÄTSSCHWELLE (Audit 13.08., Härtung): `meta/**` ist öffentlich
  // lesbar, und bei zwei, drei Konten ist „das beste Konto" schlicht eine
  // PERSON, deren komplette Strategie-Konfiguration dann unauthentifiziert
  // aussteht. `meta/health` hält dafür längst MIN_ACCOUNTS_PUBLIC ein —
  // dieselbe Schwelle gilt jetzt auch hier. Der Komplett-Ersatz oben sorgt
  // dafür, dass ein früher veröffentlichter Stand dabei auch VERSCHWINDET.
  const beitragende = beitraege.filter((b) => (b.stats?.n ?? 0) > 0).length;
  try {
    await db.doc('meta/bestPractice').set({
      at: now.toISOString(),
      date,
      kriterien: { minTrades: BEWAEHRT_MIN_TRADES, minTage: BEWAEHRT_MIN_TAGE },
      ...(bester && beitragende < MIN_ACCOUNTS_PUBLIC
        ? {
            stand: 'zurueckgehalten',
            grund:
              `Weniger als ${MIN_ACCOUNTS_PUBLIC} beitragende Konten — eine ` +
              'veröffentlichte Bestleistung wäre keine Statistik, sondern eine Person.',
          }
        : bester
          ? { stand: 'gekuert', kennzahlen: bester.bilanz, einstellungen: bester.einstellungen }
          : {
              stand: 'kein_kandidat',
              ...(anwaerter
                ? { anwaerter: { kennzahlen: anwaerter.bilanz, fehlt: anwaerter.fehlt } }
                : {}),
            }),
    });
    logger.info(
      bester && beitragende < MIN_ACCOUNTS_PUBLIC
        ? `bestPractice: zurückgehalten — nur ${beitragende} beitragende(s) Konto/Konten (< ${MIN_ACCOUNTS_PUBLIC})`
        : bester
          ? `bestPractice: gekürt — Kante ${bester.bilanz.kantePct} %, n=${bester.bilanz.n}, ${bester.bilanz.zeitraumTage} Tage`
          : 'bestPractice: kein Konto erfüllt die Belege (Snapshot dokumentiert den Anwärter)',
    );
  } catch (err) {
    logger.warn('bestPractice-Snapshot fehlgeschlagen', err);
  }

  // ── Erkenntnis-Chronik (Owner-Go 08.08.: „Zweites Gehirn") ────────────────
  // Der Heartbeat wird alle fünf Minuten überschrieben, das verdict täglich —
  // hier wird daraus Wissen, das BLEIBT: datierte Thesen mit Beleg, seit-wann
  // und protokollierten Widerlegungen. Deterministisch, kein LLM; die Ableitung
  // selbst ist pur (shared/erkenntnisse.ts) und dort getestet. Nach dem
  // health-Write gelesen, damit auch die SCAN-Seite (signalSchatten,
  // strukturSuche) im selben Faktenstand steckt.
  try {
    const healthDoc = await db.doc('meta/health').get();
    const chronikRef = db.doc('meta/erkenntnisse');
    const vorher = (await chronikRef.get()).data() as ErkenntnisChronik | undefined;
    const signalSchatten = healthDoc.get('signalSchatten') as
      | ErkenntnisFakten['signalSchatten']
      | undefined;
    const strukturLauf = healthDoc.get('strukturSuche') as
      | ErkenntnisFakten['strukturSuche']
      | undefined;
    const fakten: ErkenntnisFakten = {
      trading: {
        trades: health.trades,
        feeShare: health.feeShare,
        exits: health.exits,
        klassen: health.klassen,
      },
      ...(signalSchatten ? { signalSchatten } : {}),
      ...(strukturLauf ? { strukturSuche: strukturLauf } : {}),
    };
    const chronik = schreibeChronik(vorher, fakten, now.toISOString());
    await chronikRef.set(chronik);
    const zaehl = Object.values(chronik.eintraege).reduce(
      (a, e) => ((a[e.status] = (a[e.status] ?? 0) + 1), a),
      {} as Record<string, number>,
    );
    logger.info(
      `Erkenntnisse: ${zaehl.gilt ?? 0} gelten, ${zaehl.gilt_nicht ?? 0} gelten nicht, ${zaehl.wartet_auf_daten ?? 0} warten auf Daten`,
    );
  } catch (err) {
    logger.warn('Erkenntnis-Chronik fehlgeschlagen — Snapshot bleibt gültig', err);
  }

  logger.info(`snapshotEquity: ${snapped}/${users.size} User gesnapshottet (${date})`);
  return { users: users.size, snapped, marginInterest: Math.round(zinsSumme * 100) / 100 };
}

/** Täglich 17:15 ET (nach US-Schluss); 7 Tage — Krypto bewegt Equity auch am Wochenende. */
export const snapshotEquity = onSchedule(
  {
    schedule: '15 17 * * *',
    timeZone: 'America/New_York',
    retryCount: 0,
    // Der Lauf liest je User Positionen + Trades und je Symbol den Kurs; der
    // 60-s-Default würde mit wachsender Nutzerzahl irgendwann mitten in der
    // Schleife abbrechen — und ein halb geschriebener Snapshot-Tag verzerrt
    // Sharpe und Drawdown dauerhaft, weil die Serie eine Lücke bekäme.
    timeoutSeconds: 180,
  },
  async () => {
    await snapshotAll();
  },
);

/** Manueller Trigger — NUR im Emulator (Abnahme-Verifikation). */
export const snapshotNow = onRequest(EMULATOR_TRIGGER_OPTS, async (_req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'snapshotNow ist nur im Emulator verfügbar' });
    return;
  }
  res.status(200).json(await snapshotAll());
});
